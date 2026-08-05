/**
 * GET /api/diagnostics — a self-check the operator can run from the Settings
 * page: database, GitHub wiring (token, repo, ref, workflow present), executor
 * secret, and whether any AI provider key is configured. Each check reports a
 * concrete next step when it fails, so setup problems are visible instead of
 * only surfacing as a failed goal.
 */

import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { githubConfig, refNote, resolveRef } from '@/lib/github';
import { loadSettingsDoc, PROVIDER_KINDS } from '@/lib/settings';
import { decryptSecret } from '@/lib/crypto';
import { probeProvider } from '@/lib/probe';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function GET() {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'admin only' }, { status: 403 });

  const checks: Check[] = [];

  // Database
  try {
    const db = await getDb();
    await db.command({ ping: 1 });
    checks.push({ name: 'MongoDB', ok: true, detail: `connected to "${db.databaseName}"` });
  } catch (err) {
    checks.push({
      name: 'MongoDB',
      ok: false,
      detail: `${err instanceof Error ? err.message : String(err)} — check MONGODB_URI and that Atlas Network Access allows 0.0.0.0/0`,
    });
  }

  // Executor secret (shared with the Actions runner)
  checks.push(
    process.env.EXECUTOR_TOKEN
      ? { name: 'Executor token', ok: true, detail: 'set — must match the EXECUTOR_TOKEN repository secret' }
      : { name: 'Executor token', ok: false, detail: 'EXECUTOR_TOKEN is not set in Vercel' },
  );

  // GitHub: token, repo, ref, workflow file
  const config = githubConfig();
  if ('error' in config) {
    checks.push({ name: 'GitHub config', ok: false, detail: config.error });
  } else {
    checks.push({ name: 'GitHub config', ok: true, detail: `repo ${config.repo}` });
    try {
      const ref = await resolveRef(config);
      const note = refNote();
      checks.push({
        name: 'Workflow branch',
        // A substituted ref still works, but the operator should know their
        // GITHUB_BRANCH is stale — surface it as something to fix.
        ok: !note,
        detail: note ?? (config.branch ? `${ref} (from GITHUB_BRANCH)` : `${ref} (repository default)`),
      });
      const res = await fetch(
        `https://api.github.com/repos/${config.repo}/actions/workflows/run-goal.yml`,
        {
          headers: {
            authorization: `Bearer ${config.token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'megaai-platform',
          },
        },
      );
      checks.push(
        res.ok
          ? { name: 'run-goal workflow', ok: true, detail: 'found and dispatchable' }
          : {
              name: 'run-goal workflow',
              ok: false,
              detail:
                res.status === 404
                  ? 'not found — the branch needs .github/workflows/run-goal.yml, and the token needs Actions: read and write'
                  : `GitHub returned HTTP ${res.status}`,
            },
      );
    } catch (err) {
      checks.push({
        name: 'GitHub access',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // AI providers — asked directly, not just counted. A stored-but-broken key
  // is the difference between a real delivery and placeholder scaffolding.
  try {
    const settings = await loadSettingsDoc();
    const stored = PROVIDER_KINDS.filter((kind) => settings.providers[kind]?.apiKeyEnc);

    // A saved key does nothing on its own: it also has to be switched on and
    // present in the fallback order. Both are silent when wrong — the run just
    // reports that the *other* provider never answered.
    for (const kind of stored) {
      const provider = settings.providers[kind]!;
      if (provider.enabled === false) {
        checks.push({
          name: `Provider: ${kind}`,
          ok: false,
          detail: 'a key is stored but the ON switch is off — this provider will never be used',
        });
      } else if (!settings.fallbackChain.includes(kind)) {
        checks.push({
          name: `Provider: ${kind}`,
          ok: false,
          detail: `a key is stored but "${kind}" is missing from the fallback order (${settings.fallbackChain.join(', ')}) — add it there or it will never be tried`,
        });
      }
    }
    for (const kind of settings.fallbackChain) {
      if (kind !== 'mock' && PROVIDER_KINDS.includes(kind as (typeof PROVIDER_KINDS)[number]) && !stored.includes(kind as (typeof PROVIDER_KINDS)[number])) {
        checks.push({
          name: `Provider: ${kind}`,
          ok: false,
          detail: 'listed in the fallback order but no key is saved for it — it will be skipped',
        });
      }
    }

    const configured = stored.filter(
      (kind) => settings.providers[kind]?.enabled !== false && settings.fallbackChain.includes(kind),
    );
    if (configured.length === 0) {
      checks.push({
        name: 'AI providers',
        ok: false,
        detail:
          stored.length > 0
            ? 'every saved key is switched off or missing from the fallback order — every run will fall through to the offline mock and deliver placeholder files'
            : 'no provider key saved — every run will fall through to the offline mock and deliver placeholder files',
      });
    } else {
      const probes = await Promise.all(
        configured.map((kind) =>
          probeProvider(kind, decryptSecret(settings.providers[kind]!.apiKeyEnc), settings.providers[kind]!.model),
        ),
      );
      for (const probe of probes) {
        checks.push({ name: `Provider: ${probe.kind}`, ok: probe.ok, detail: probe.detail });
      }
      if (!probes.some((p) => p.ok)) {
        checks.push({
          name: 'AI providers',
          ok: false,
          detail: 'no provider answered — runs will fall through to the offline mock and deliver placeholder files',
        });
      }
    }
    checks.push({ name: 'Fallback order', ok: true, detail: settings.fallbackChain.join(' → ') });
  } catch (err) {
    checks.push({ name: 'AI providers', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
}
