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
import { githubConfig, resolveRef } from '@/lib/github';
import { loadSettingsDoc, PROVIDER_KINDS } from '@/lib/settings';

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
      checks.push({
        name: 'Workflow branch',
        ok: true,
        detail: config.branch ? `${ref} (from GITHUB_BRANCH)` : `${ref} (repository default)`,
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

  // AI providers
  try {
    const settings = await loadSettingsDoc();
    const configured = PROVIDER_KINDS.filter((kind) => settings.providers[kind]?.apiKeyEnc);
    checks.push(
      configured.length > 0
        ? { name: 'AI providers', ok: true, detail: `keys stored for: ${configured.join(', ')}` }
        : {
            name: 'AI providers',
            ok: false,
            detail: 'no provider key saved yet — runs will fall back to the offline mock engine',
          },
    );
    checks.push({ name: 'Fallback order', ok: true, detail: settings.fallbackChain.join(' → ') });
  } catch (err) {
    checks.push({ name: 'AI providers', ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  return NextResponse.json({ ok: checks.every((c) => c.ok), checks });
}
