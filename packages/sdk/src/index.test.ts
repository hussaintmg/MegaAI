/**
 * End-to-end: one sentence in, a delivered project out — fully offline on
 * the mock provider, in-memory state, temp workspace.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMegaAI, Events, GitEngine, MockProvider } from './index.js';

function tempDirs(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'megaai-e2e-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('submitGoal runs an ecommerce goal end to end on the mock provider', async () => {
  const { root, cleanup } = tempDirs();
  try {
    const megaai = createMegaAI({
      persistent: false,
      quiet: true,
      configOptions: { cwd: root, env: {} as NodeJS.ProcessEnv },
      configOverrides: { policy: { autoApprove: true }, security: { allowShell: true } },
    });
    await megaai.start();

    const eventTypes = new Set<string>();
    megaai.bus.on('*', (event) => eventTypes.add(event.type));

    const result = await megaai.submitGoal(
      'Build a complete ecommerce store with catalog, cart, checkout and auth',
    );

    assert.equal(result.project.status, 'completed');
    assert.equal(result.tasks.every((task) => task.state === 'completed'), true);
    assert.ok(result.tasks.length >= 10, `expected a real plan, got ${result.tasks.length} tasks`);

    // Files actually exist in the workspace.
    assert.ok(existsSync(join(result.workspaceDir, 'MEGAAI_REPORT.md')));
    assert.ok(existsSync(join(result.workspaceDir, 'package.json')));
    assert.ok(existsSync(join(result.workspaceDir, 'src', 'auth', 'auth.js')));
    const report = readFileSync(join(result.workspaceDir, 'MEGAAI_REPORT.md'), 'utf8');
    assert.match(report, /completed/);

    // The delivery was versioned: the workspace is a git repo with a commit.
    const git = new GitEngine();
    assert.equal(git.isRepo(result.workspaceDir), true);
    const history = await git.log(result.workspaceDir);
    assert.ok(history.some((entry) => entry.message.startsWith('MegaAI delivery:')));

    // The testing agent really executed the suite (shell was enabled).
    const shellRuns = megaai.bus
      .history('actions.executed', 1000)
      .filter((event) => (event.payload as { tool?: string; ok?: boolean }).tool === 'shell.exec');
    assert.ok(shellRuns.length >= 1, 'expected the test suite to actually run via shell.exec');
    assert.equal(shellRuns.every((event) => (event.payload as { ok: boolean }).ok), true);

    // The whole pipeline emitted its lifecycle events.
    for (const expected of [
      Events.GoalReceived,
      Events.ProjectCreated,
      Events.WorkflowStarted,
      Events.ApprovalRequested,
      Events.StepFinished,
      Events.AgentSpawned,
      Events.ActionExecuted,
      Events.CompletionFinished,
      Events.ProjectCompleted,
      Events.GoalCompleted,
    ]) {
      assert.ok(eventTypes.has(expected), `expected event ${expected}`);
    }

    // Learning recorded one outcome per task.
    const stats = await megaai.meta.stats();
    assert.equal(stats.totalRuns, result.tasks.length);

    // Memory now knows about the work.
    const hits = await megaai.memory.search('checkout', { refId: result.project.id });
    assert.ok(hits.length > 0);

    await megaai.stop();
  } finally {
    cleanup();
  }
});

test('provider fallback: primary rate-limits mid-project, backup finishes it', async () => {
  const { root, cleanup } = tempDirs();
  try {
    const flaky = new MockProvider({ kind: 'flaky', rateLimitAfter: 2 });
    const megaai = createMegaAI({
      persistent: false,
      quiet: true,
      configOptions: { cwd: root, env: {} as NodeJS.ProcessEnv },
      configOverrides: {
        policy: { autoApprove: true },
        ai: {
          fallbackChain: ['flaky', 'mock'],
          providers: { flaky: { enabled: true }, mock: { enabled: true } },
        },
      },
      extraProviders: [flaky],
    });
    await megaai.start();

    const result = await megaai.submitGoal('Ship a tiny generic utility project');
    assert.equal(result.project.status, 'completed');

    // The flaky provider served its two requests, then the chain recovered on mock.
    assert.equal(flaky.requestsServed() >= 2, true);
    const status = megaai.sessions.providerStatus();
    assert.equal(status.find((p) => p.kind === 'flaky')?.exhausted, true);
    const usage = megaai.sessions.usage();
    assert.equal(usage.requests, result.tasks.length);

    await megaai.stop();
  } finally {
    cleanup();
  }
});

test('model-backed planning: the mock plans the project, and it runs to completion', async () => {
  const { root, cleanup } = tempDirs();
  try {
    const megaai = createMegaAI({
      persistent: false,
      quiet: true,
      configOptions: { cwd: root, env: {} as NodeJS.ProcessEnv },
      configOverrides: { policy: { autoApprove: true }, meta: { planner: 'model' } },
    });
    await megaai.start();

    const decisions: Array<Record<string, unknown>> = [];
    megaai.bus.on(Events.DecisionMade, (event) => decisions.push(event.payload as Record<string, unknown>));

    const result = await megaai.submitGoal('Build a small internal tool');
    assert.equal(result.project.status, 'completed');
    // The plan came from the model path (mock), not the templates.
    const planDecision = decisions.find((d) => d.kind === 'plan');
    assert.equal(planDecision?.source, 'model');
    assert.equal(planDecision?.domain, 'model-generated');
    assert.ok(result.tasks.length >= 5);

    await megaai.stop();
  } finally {
    cleanup();
  }
});

test('without auto-approve the run waits for a human decision', async () => {
  const { root, cleanup } = tempDirs();
  try {
    const megaai = createMegaAI({
      persistent: false,
      quiet: true,
      configOptions: { cwd: root, env: {} as NodeJS.ProcessEnv },
    });
    await megaai.start();

    // A human resolves every gate as it arrives (plan approval, and the
    // approval-gated deploy). Count them to prove the run really waited.
    let approvals = 0;
    megaai.bus.on<{ approval: { id: string } }>(Events.ApprovalRequested, (event) => {
      approvals += 1;
      megaai.orchestrator.approve(event.payload.approval.id, true, 'test-human');
    });

    const goalPromise = megaai.submitGoal('Build a small api for notes');
    // The plan gate blocks before any task runs.
    const requested = await megaai.bus.waitFor(Events.ApprovalRequested, { timeoutMs: 5_000 });
    assert.ok(requested);

    const result = await goalPromise;
    assert.equal(result.project.status, 'completed');
    assert.ok(approvals >= 2, `expected plan + deploy approvals, saw ${approvals}`);
    await megaai.stop();
  } finally {
    cleanup();
  }
});
