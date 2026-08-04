import test from 'node:test';
import assert from 'node:assert/strict';
import { Events } from '@megaai/types';
import { ManualClock } from '@megaai/utils';
import { createEventBus } from '@megaai/events';
import {
  CapturedChannel,
  CommEngine,
  createCommTool,
  NotificationEngine,
  WebhookChannel,
} from './index.js';

test('captured channel records messages and the engine routes to it', async () => {
  const clock = new ManualClock(1000);
  const comm = new CommEngine(clock);
  const captured = new CapturedChannel('captured', clock);
  comm.register(captured);

  const receipt = await comm.send('captured', { to: 'client', text: 'hello' });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.channel, 'captured');
  assert.equal(captured.messages.length, 1);
  assert.equal(captured.messages[0]?.text, 'hello');

  await assert.rejects(comm.send('nope', { text: 'x' }), /No channel/);
  await assert.rejects(comm.send('captured', { text: '   ' }), /must not be empty/);
  assert.throws(() => comm.register(captured), /already registered/);
});

test('webhook channel enforces its host allowlist at construction', () => {
  assert.throws(
    () => new WebhookChannel('hook', 'https://evil.test/x', { allowedHosts: ['hooks.slack.com'] }),
    /not on the comm allowlist/,
  );
  // Allowlisted host constructs fine.
  const ok = new WebhookChannel('hook', 'https://hooks.slack.com/services/T/B/x', {
    allowedHosts: ['slack.com'],
  });
  assert.equal(ok.kind, 'webhook');
});

test('notification engine turns lifecycle events into operator messages', async () => {
  const bus = createEventBus();
  const comm = new CommEngine();
  const captured = new CapturedChannel();
  comm.register(captured);
  const notifications = new NotificationEngine({
    bus,
    comm,
    channel: 'captured',
    events: [Events.GoalCompleted, Events.GoalFailed],
  });
  notifications.start();

  bus.emit(Events.GoalCompleted, { goal: 'Build a store' });
  bus.emit(Events.GoalFailed, { goal: 'Broken thing', status: 'failed' });
  bus.emit('some.other.event', { ignored: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(captured.messages.length, 2);
  assert.match(captured.messages[0]?.text ?? '', /completed/i);
  assert.match(captured.messages[1]?.text ?? '', /did not fully complete/i);

  notifications.stop();
  bus.emit(Events.GoalCompleted, { goal: 'after stop' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(captured.messages.length, 2); // no more after stop
});

test('notification engine is a no-op for an unknown or "none" channel', () => {
  const bus = createEventBus();
  const comm = new CommEngine();
  comm.register(new CapturedChannel());
  const off = new NotificationEngine({ bus, comm, channel: 'none', events: [Events.GoalCompleted] });
  off.start();
  bus.emit(Events.GoalCompleted, { goal: 'x' });
  assert.equal(off.notificationsSent(), 0);
});

test('comm.send tool carries the comm.send permission and delivers', async () => {
  const comm = new CommEngine();
  const captured = new CapturedChannel();
  comm.register(captured);
  const tool = createCommTool(comm, 'captured');
  assert.deepEqual(tool.permissions, ['comm.send']);
  const receipt = (await tool.execute(
    { to: 'client', subject: 'Update', text: 'Your project is ready.' },
    { workspaceRoot: '/tmp' },
  )) as { ok: boolean };
  assert.equal(receipt.ok, true);
  assert.equal(captured.messages[0]?.subject, 'Update');
  await assert.rejects(tool.execute({}, { workspaceRoot: '/tmp' }), /text.*must be a string/);
});
