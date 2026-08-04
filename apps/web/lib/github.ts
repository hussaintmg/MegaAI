/**
 * GitHub Actions dispatch — the platform's execution arm. Submitting a goal
 * triggers the `run-goal.yml` workflow, whose runner boots the full MegaAI
 * engine, executes the goal with the stored provider keys, and reports back
 * through the executor API.
 */

export function githubConfig(): { repo: string; token: string; ref: string } | { error: string } {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GH_DISPATCH_TOKEN || process.env.GITHUB_TOKEN;
  if (!repo) return { error: 'GITHUB_REPO is not configured (e.g. hussaintmg/megaai)' };
  if (!token) return { error: 'GITHUB_TOKEN is not configured (fine-grained PAT with Actions read/write)' };
  return { repo, token, ref: process.env.GITHUB_BRANCH || 'main' };
}

export async function dispatchRunGoal(goalId: string): Promise<void> {
  const config = githubConfig();
  if ('error' in config) throw new Error(config.error);
  const res = await fetch(
    `https://api.github.com/repos/${config.repo}/actions/workflows/run-goal.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'megaai-platform',
      },
      body: JSON.stringify({ ref: config.ref, inputs: { goal_id: goalId } }),
    },
  );
  if (res.status !== 204) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub dispatch failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
}
