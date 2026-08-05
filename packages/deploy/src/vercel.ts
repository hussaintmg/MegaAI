/**
 * Real Vercel deployments over the REST API.
 *
 * The old `vercel` target shelled out to the Vercel CLI, which is neither
 * installed on the runner nor on the shell allowlist — so every "deployment"
 * simulated and the estimated URL it reported led nowhere. The API takes the
 * source files inline, so a deployment needs nothing but a token and `fetch`,
 * and it hands back a URL that actually resolves.
 *
 * https://vercel.com/docs/rest-api/reference/endpoints/deployments
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { MegaError } from '@megaai/types';

const API = 'https://api.vercel.com';

/** Never uploaded: build output and dependencies Vercel installs itself. */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  '.vercel',
  'dist',
  'build',
  'out',
  'coverage',
  '.megaai',
]);

const MAX_FILES = 500;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;

export interface VercelFile {
  file: string;
  data: string;
  encoding: 'base64';
  sha: string;
  size: number;
}

export interface VercelDeployment {
  id: string;
  url: string;
  inspectorUrl?: string;
  readyState: string;
  ok: boolean;
  error?: string;
  files: number;
}

/** Collect the source files of a delivery, ready to upload. */
export function collectDeployFiles(root: string): VercelFile[] {
  const out: VercelFile[] = [];
  let total = 0;

  const walk = (dir: string): void => {
    if (out.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) return;
    for (const entry of readdirSync(dir).sort()) {
      if (IGNORED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) continue;
      const buffer = readFileSync(full);
      out.push({
        file: relative(root, full).split(sep).join('/'),
        data: buffer.toString('base64'),
        encoding: 'base64',
        sha: createHash('sha1').update(buffer).digest('hex'),
        size: buffer.length,
      });
      total += stat.size;
      if (out.length >= MAX_FILES) return;
    }
  };

  walk(root);
  return out;
}

async function api(
  path: string,
  token: string,
  init: RequestInit = {},
  teamId?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`${API}${path}`);
  if (teamId) url.searchParams.set('teamId', teamId);
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // A non-JSON body (a gateway error page) leaves the status to speak.
  }
  return { status: response.status, body };
}

function explain(status: number, body: Record<string, unknown>): string {
  const error = body.error as { message?: string; code?: string } | undefined;
  if (error?.message) return `${error.code ? `${error.code}: ` : ''}${error.message}`;
  if (status === 401 || status === 403) return `the Vercel token was rejected (${status})`;
  return `Vercel returned HTTP ${status}`;
}

export interface VercelDeployOptions {
  token: string;
  projectName: string;
  files: VercelFile[];
  teamId?: string;
  /** 'nextjs', 'vite', … or null to let Vercel detect it. */
  framework?: string | null;
  /** How long to wait for the build, in ms. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Create a production deployment and wait for it to build.
 *
 * Waiting matters: the API returns a URL the moment the files are accepted,
 * and reporting that immediately would hand back a link to a build that is
 * still running — or that failed.
 */
export async function deployToVercel(options: VercelDeployOptions): Promise<VercelDeployment> {
  const { token, projectName, files, teamId, framework = 'nextjs' } = options;
  if (!token) throw new MegaError('INVALID_INPUT', 'a Vercel token is required to deploy');
  if (files.length === 0) throw new MegaError('INVALID_INPUT', 'there are no files to deploy');

  const globalFetch = options.fetchImpl;
  const call = globalFetch
    ? async (path: string, init: RequestInit = {}) => {
        const url = new URL(`${API}${path}`);
        if (teamId) url.searchParams.set('teamId', teamId);
        const response = await globalFetch(url, {
          ...init,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
        });
        let body: Record<string, unknown> = {};
        try {
          body = (await response.json()) as Record<string, unknown>;
        } catch {
          /* status speaks */
        }
        return { status: response.status, body };
      }
    : (path: string, init: RequestInit = {}) => api(path, token, init, teamId);

  const created = await call('/v13/deployments?forceNew=1&skipAutoDetectionConfirmation=1', {
    method: 'POST',
    body: JSON.stringify({
      name: projectName,
      files: files.map((f) => ({ file: f.file, data: f.data, encoding: f.encoding })),
      target: 'production',
      projectSettings: framework === null ? {} : { framework },
    }),
  });
  if (created.status >= 400) {
    throw new MegaError('INTERNAL', `Vercel deployment was rejected — ${explain(created.status, created.body)}`);
  }

  const id = String(created.body.id ?? '');
  const url = String(created.body.url ?? '');
  const inspectorUrl = typeof created.body.inspectorUrl === 'string' ? created.body.inspectorUrl : undefined;
  if (!id || !url) {
    throw new MegaError('INTERNAL', 'Vercel accepted the upload but returned no deployment id');
  }

  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  let readyState = String(created.body.readyState ?? 'QUEUED');
  let waited = 0;

  while (readyState !== 'READY' && readyState !== 'ERROR' && readyState !== 'CANCELED') {
    if (waited > (options.timeoutMs ?? 10 * 60_000) || Date.now() > deadline) {
      return {
        id,
        url: `https://${url}`,
        inspectorUrl,
        readyState,
        ok: false,
        error: `the build was still ${readyState} after ${Math.round(waited / 1000)}s`,
        files: files.length,
      };
    }
    await sleep(4_000);
    waited += 4_000;
    const polled = await call(`/v13/deployments/${id}`);
    if (polled.status >= 400) {
      return { id, url: `https://${url}`, inspectorUrl, readyState, ok: false, error: explain(polled.status, polled.body), files: files.length };
    }
    readyState = String(polled.body.readyState ?? readyState);
  }

  return {
    id,
    url: `https://${url}`,
    inspectorUrl,
    readyState,
    ok: readyState === 'READY',
    ...(readyState === 'READY'
      ? {}
      : { error: `the Vercel build finished as ${readyState} — open the inspector for its log` }),
    files: files.length,
  };
}
