/**
 * GitHub Actions dispatch — the platform's execution arm. Submitting a goal
 * triggers the `run-goal.yml` workflow, whose runner boots the full MegaAI
 * engine, executes the goal with the stored provider keys, and reports back
 * through the executor API.
 *
 * The ref is resolved from the repository itself when `GITHUB_BRANCH` is not
 * set, so the platform works whatever the default branch is called — assuming
 * `main` breaks every dispatch on repos that use a different default.
 */

export interface GithubConfig {
  repo: string;
  token: string;
  /** Explicit branch override; when absent the repo's default branch is used. */
  branch?: string;
}

export function githubConfig(): GithubConfig | { error: string } {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GH_DISPATCH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo) return { error: 'GITHUB_REPO is not configured (e.g. hussaintmg/megaai)' };
  if (!token) return { error: 'GITHUB_TOKEN is not configured (fine-grained PAT with Actions read/write)' };
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    return { error: `GITHUB_REPO must be "owner/repo", got "${repo}"` };
  }
  return { repo, token, branch: process.env.GITHUB_BRANCH || undefined };
}

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'megaai-platform',
  };
}

// Cached per server instance — the default branch rarely changes and this
// saves an API call on every dispatch.
const globalForRef = globalThis as unknown as { _megaaiDefaultBranch?: string; _megaaiRefNote?: string };

/** The note explaining the last ref decision, when it was not the obvious one. */
export function refNote(): string | undefined {
  return globalForRef._megaaiRefNote;
}

async function defaultBranch(config: GithubConfig): Promise<string> {
  if (globalForRef._megaaiDefaultBranch) return globalForRef._megaaiDefaultBranch;
  const res = await fetch(`https://api.github.com/repos/${config.repo}`, { headers: ghHeaders(config.token) });
  if (!res.ok) {
    const hint =
      res.status === 404
        ? 'repository not found — check GITHUB_REPO and that the token can see it'
        : res.status === 401 || res.status === 403
          ? 'token rejected — check GITHUB_TOKEN and its Actions/repo permissions'
          : `HTTP ${res.status}`;
    throw new Error(`Could not read ${config.repo}: ${hint}`);
  }
  const repo = (await res.json()) as { default_branch?: string };
  const branch = repo.default_branch || 'main';
  globalForRef._megaaiDefaultBranch = branch;
  return branch;
}

async function branchExists(config: GithubConfig, branch: string): Promise<boolean> {
  const res = await fetch(
    `https://api.github.com/repos/${config.repo}/branches/${encodeURIComponent(branch)}`,
    { headers: ghHeaders(config.token) },
  );
  return res.ok;
}

/**
 * The branch to run workflows from: the configured override when it actually
 * exists, otherwise the repository's default branch.
 *
 * A stale `GITHUB_BRANCH` (say `main` on a repo whose default is named
 * something else) used to fail every dispatch with a bare 422. Self-healing
 * here beats making the operator hunt through environment variables — the
 * substitution is reported so it is still visible in diagnostics.
 */
export async function resolveRef(config: GithubConfig): Promise<string> {
  if (!config.branch) {
    globalForRef._megaaiRefNote = undefined;
    return defaultBranch(config);
  }
  if (await branchExists(config, config.branch)) {
    globalForRef._megaaiRefNote = undefined;
    return config.branch;
  }
  const fallback = await defaultBranch(config);
  globalForRef._megaaiRefNote =
    `GITHUB_BRANCH is set to "${config.branch}", which does not exist in ${config.repo} — ` +
    `using the default branch "${fallback}" instead. Remove GITHUB_BRANCH to silence this.`;
  return fallback;
}

export async function dispatchRunGoal(goalId: string): Promise<void> {
  const config = githubConfig();
  if ('error' in config) throw new Error(config.error);
  const ref = await resolveRef(config);
  const res = await fetch(
    `https://api.github.com/repos/${config.repo}/actions/workflows/run-goal.yml/dispatches`,
    {
      method: 'POST',
      headers: ghHeaders(config.token),
      body: JSON.stringify({ ref, inputs: { goal_id: goalId } }),
    },
  );
  if (res.status === 204) return;

  const body = await res.text().catch(() => '');
  if (res.status === 404) {
    throw new Error(
      `GitHub could not find the run-goal.yml workflow on "${ref}" in ${config.repo}. ` +
        'Make sure the branch has .github/workflows/run-goal.yml, and that the token has Actions: read and write.',
    );
  }
  if (res.status === 422) {
    throw new Error(
      `GitHub rejected the dispatch on ref "${ref}" (422). That branch probably does not exist — ` +
        'set GITHUB_BRANCH to an existing branch, or leave it unset to use the default branch. ' +
        body.slice(0, 200),
    );
  }
  throw new Error(`GitHub dispatch failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
}
