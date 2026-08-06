/**
 * What happens to a delivery after the agents stop.
 *
 * The screenshot and the live URL were both left to an agent's judgement: a
 * vision-testing agent had to decide to call `app.preview`, and a devops agent
 * had to decide to call `deploy.execute`. When either skipped it — or when the
 * task failed for an unrelated reason — the run finished with no picture and
 * no link, and nothing said why.
 *
 * The two things the person waiting actually wants are not negotiable, so they
 * are not delegated. This runs after every goal, reports what it found, and
 * says plainly when it could not do something.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Directories that are never an app root. */
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'out', '.megaai', 'coverage']);

/**
 * Find the app: the shallowest directory holding a package.json with a build
 * or start script. Agents do not always scaffold at the workspace root.
 */
export function findAppRoot(workspaceDir, depth = 2) {
  const candidates = [workspaceDir];
  const walk = (dir, level) => {
    if (level > depth) return;
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      candidates.push(full);
      walk(full, level + 1);
    }
  };
  try {
    walk(workspaceDir, 1);
  } catch {
    // An unreadable workspace is handled by the caller.
  }

  for (const dir of candidates) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      const scripts = pkg.scripts ?? {};
      if (scripts.build || scripts.start || scripts.dev) return { dir, pkg };
    } catch {
      // A malformed manifest is not an app root.
    }
  }
  return undefined;
}

/** The routes worth photographing: '/' plus whatever pages exist. */
export function guessRoutes(appDir, limit = 4) {
  const routes = ['/'];
  const appRouter = join(appDir, 'app');
  if (existsSync(appRouter)) {
    for (const entry of readdirSync(appRouter)) {
      if (routes.length >= limit) break;
      if (entry.startsWith('_') || entry === 'api' || SKIP.has(entry)) continue;
      try {
        if (!statSync(join(appRouter, entry)).isDirectory()) continue;
      } catch {
        continue;
      }
      // A route is a directory holding a page file.
      if (['page.tsx', 'page.jsx', 'page.ts', 'page.js'].some((f) => existsSync(join(appRouter, entry, f)))) {
        routes.push(`/${entry}`);
      }
    }
  }
  return routes;
}

/**
 * Build it, photograph it, and — with a token — put it online.
 *
 * Every step reports through `log`, including the ones that could not run, so
 * a missing screenshot is never just an absence.
 */
export async function finalizeDelivery(options) {
  const { workspaceDir, vercelToken, log = () => {}, previewRunner, deploy } = options;
  const outcome = { preview: undefined, deployment: undefined, appRoot: undefined };

  const app = findAppRoot(workspaceDir);
  if (!app) {
    log('finalize', 'No runnable app was found in the delivery — nothing to preview or deploy.');
    return outcome;
  }
  outcome.appRoot = app.dir;
  const relative = app.dir === workspaceDir ? '.' : app.dir.slice(workspaceDir.length + 1);
  const routes = guessRoutes(app.dir);
  log('finalize', `Found an app in "${relative}" — building and photographing ${routes.join(', ')}`);

  if (previewRunner) {
    try {
      const start = app.pkg.scripts?.start ? ['npm', 'run', 'start'] : ['npm', 'run', 'dev'];
      const preview = await previewRunner.run(
        { dir: relative, install: true, build: Boolean(app.pkg.scripts?.build), start, port: 3000, routes },
        workspaceDir,
      );
      outcome.preview = preview;
      const shots = preview.pages.filter((page) => page.screenshot).length;
      if (preview.ok) {
        log('preview', `The app builds and runs — ${shots} screenshot(s) taken across ${preview.pages.length} route(s).`);
      } else {
        const failed = preview.steps.find((step) => !step.ok);
        log(
          'preview',
          failed
            ? `The app did not run: "${failed.name}" failed. ${failed.output.slice(-600)}`
            : `The app ran but some routes failed: ${preview.pages.filter((p) => !p.ok).map((p) => `${p.route} (${p.status ?? 'no response'})`).join(', ')}`,
        );
      }
    } catch (err) {
      log('preview', `Could not preview the app: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!deploy) return outcome;
  if (!vercelToken) {
    log('deploy', 'No Vercel token is saved, so there is no live URL. Add one under Settings → Deployment.');
    return outcome;
  }

  // Only deploy something that actually built: a live URL pointing at a broken
  // build is worse than none, because it looks like the job is done.
  if (outcome.preview && !outcome.preview.ok && outcome.preview.steps.some((step) => step.name === 'build' && !step.ok)) {
    log('deploy', 'Skipped the deployment because the app does not build — fix the build first.');
    return outcome;
  }

  try {
    const files = deploy.collect(app.dir);
    if (files.length === 0) {
      log('deploy', 'There were no files to deploy.');
      return outcome;
    }
    log('deploy', `Deploying ${files.length} files to Vercel…`);
    const result = await deploy.run({
      token: vercelToken,
      projectName: deploy.projectName,
      files,
      framework: app.pkg.dependencies?.next ? 'nextjs' : null,
    });
    outcome.deployment = {
      url: result.url,
      target: 'vercel',
      simulated: false,
      ...(result.inspectorUrl ? { inspectorUrl: result.inspectorUrl } : {}),
      ...(result.error ? { error: result.error } : {}),
    };
    log('deploy', result.ok ? `Live at ${result.url}` : `The deployment did not go live: ${result.error}`);
  } catch (err) {
    log('deploy', `Deployment failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return outcome;
}
