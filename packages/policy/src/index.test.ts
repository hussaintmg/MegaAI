import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { ApprovalManager, inWindow, PolicyEngine } from './index.js';

test('deny beats approval beats allow', () => {
  const engine = new PolicyEngine();
  engine.addRule({ id: 'deny-shell', description: 'no shell', effect: 'deny', permissions: ['shell.*'] });
  engine.addRule({ id: 'gate-deploy', description: 'deploys need a human', effect: 'require-approval', permissions: ['deploy'] });

  const denied = engine.evaluate({ actor: 'agent:coding', permission: 'shell.exec' });
  assert.equal(denied.allowed, false);
  assert.deepEqual(denied.matchedRules, ['deny-shell']);

  const gated = engine.evaluate({ actor: 'agent:devops', permission: 'deploy' });
  assert.equal(gated.allowed, true);
  assert.equal(gated.requiresApproval, true);

  const plain = engine.evaluate({ actor: 'agent:coding', permission: 'fs.write' });
  assert.equal(plain.allowed, true);
  assert.equal(plain.requiresApproval, false);
});

test('rules can be scoped to actors and time windows', () => {
  const engine = new PolicyEngine();
  engine.addRule({
    id: 'night-freeze',
    description: 'no deploys at night',
    effect: 'deny',
    permissions: ['deploy'],
    window: { fromHour: 22, toHour: 6 },
  });
  const night = new Date();
  night.setHours(23, 0, 0, 0);
  const day = new Date();
  day.setHours(11, 0, 0, 0);
  assert.equal(engine.evaluate({ actor: 'x', permission: 'deploy', timestamp: night.getTime() }).allowed, false);
  assert.equal(engine.evaluate({ actor: 'x', permission: 'deploy', timestamp: day.getTime() }).allowed, true);
  assert.equal(inWindow({ fromHour: 22, toHour: 6 }, night.getTime()), true);
});

test('maintenance mode blocks everything', () => {
  const engine = new PolicyEngine();
  engine.setMaintenanceMode(true);
  const decision = engine.evaluate({ actor: 'x', permission: 'fs.read' });
  assert.equal(decision.allowed, false);
  assert.match(decision.reasons.join(' '), /maintenance/);
});

test('fromConfig builds deny and approval rules', () => {
  const engine = PolicyEngine.fromConfig({
    deniedPermissions: ['net.fetch'],
    approvalRequiredPermissions: ['deploy'],
  });
  assert.equal(engine.evaluate({ actor: 'x', permission: 'net.fetch' }).allowed, false);
  assert.equal(engine.evaluate({ actor: 'x', permission: 'deploy' }).requiresApproval, true);
});

test('approvals resolve manually and automatically', async () => {
  const clock = new ManualClock(0);
  const manual = new ApprovalManager({}, undefined, clock);
  const approval = manual.request('workflow:x', 'run step x');
  const waiting = manual.waitFor(approval.id);
  manual.resolve(approval.id, false, 'tester');
  const resolved = await waiting;
  assert.equal(resolved.status, 'rejected');
  assert.equal(resolved.resolvedBy, 'tester');
  assert.equal(manual.pending().length, 0);

  const auto = new ApprovalManager({ autoApprove: true }, undefined, clock);
  const autoApproval = auto.request('action:y', 'auto path');
  const outcome = await auto.waitFor(autoApproval.id);
  assert.equal(outcome.status, 'approved');
  assert.equal(outcome.resolvedBy, 'auto-approve');
});
