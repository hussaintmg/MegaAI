import test from 'node:test';
import assert from 'node:assert/strict';
import { checkProjectDir, loadNodeConfig } from './config.js';

test('with nothing configured it still knows what to do', () => {
  const config = loadNodeConfig({ HOME: '/home/me' }, 'linux', 'workstation');
  assert.equal(config.name, 'workstation');
  assert.equal(config.kind, 'laptop');
  assert.deepEqual(config.capabilities, ['shell', 'browser', 'gpu', 'whatsapp']);
  assert.equal(config.queueFile, '/home/me/.megaai/queue.json');
  assert.equal(config.mongoUri, undefined);
  // Running one laptop off a local queue is a choice, not a fault. Listing it
  // among the warnings made it read as something broken.
  assert.deepEqual(config.notices, []);
});

test('a connection string turns the local file into the shared queue', () => {
  const config = loadNodeConfig(
    { HOME: '/home/me', MEGAAI_MONGODB_URI: 'mongodb+srv://cluster/megaai' },
    'linux',
    'workstation',
  );
  assert.equal(config.mongoUri, 'mongodb+srv://cluster/megaai');
  assert.equal(config.notices.length, 0);
});

test('Windows keeps its state where Windows programs keep state', () => {
  const config = loadNodeConfig({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'DESKTOP-7');
  assert.equal(config.stateFile, 'C:\\Users\\me\\AppData\\Local\\MegaAI\\node.json');
  assert.equal(config.workspaceDir, 'C:\\Users\\me\\AppData\\Local\\MegaAI\\projects');
});

test('turning the heat threshold down moves the restart point with it', () => {
  // Lowering only hotC would mean "stop above 60, resume below 72" — a machine
  // that stops once and never starts again.
  const config = loadNodeConfig({ HOME: '/h', MEGAAI_HOT_C: '60' }, 'linux', 'x');
  assert.equal(config.thresholds.hotC, 60);
  assert.equal(config.thresholds.coolC, 55);
});

test('a setting that is not a number is ignored out loud, not obeyed', () => {
  const config = loadNodeConfig({ HOME: '/h', MEGAAI_MAX_TASKS: 'lots' }, 'linux', 'x');
  assert.equal(config.thresholds.fullConcurrency, undefined);
  assert.match(config.notices.join(' '), /MEGAAI_MAX_TASKS is "lots", which is not a number/);
});

test('a setting far outside anything sensible is clamped, and says so', () => {
  const config = loadNodeConfig({ HOME: '/h', MEGAAI_MAX_TASKS: '64', MEGAAI_HOT_C: '5' }, 'linux', 'x');
  assert.equal(config.thresholds.fullConcurrency, 8);
  assert.equal(config.thresholds.hotC, 50);
  assert.match(config.notices.join(' '), /above the sensible maximum/);
  assert.match(config.notices.join(' '), /below the sensible minimum/);
});

test('a capability nothing understands is called out rather than accepted', () => {
  const config = loadNodeConfig({ HOME: '/h', MEGAAI_CAPABILITIES: 'shell, printer' }, 'linux', 'x');
  assert.deepEqual(config.capabilities, ['shell', 'printer']);
  assert.match(config.notices.join(' '), /printer, which nothing asks for/);
});

/* ---------------- where work is allowed to happen ---------------- */

test('a path the shell mangled is refused, not quietly created somewhere', () => {
  // Seen for real: `--project C:\Automation\projects\velocity` arrived as
  // `Automationprojectsvelocity` after a shell ate the backslashes. resolve()
  // turned it into a folder under the current directory, mkdir made it, and
  // the task was queued against a path nobody meant — every step succeeding.
  const check = checkProjectDir('Automationprojectsvelocity', '/repo/megaai', '/repo/megaai');
  assert.equal(check.ok, false);
  assert.match(check.error ?? '', /must be a full path/);
  assert.match(check.error ?? '', /backslashes were probably eaten/);
  assert.match(check.error ?? '', /forward slashes/, 'and it says what to do instead');
});

test('MegaAI refuses to be pointed at itself', () => {
  for (const inside of ['/repo/megaai', '/repo/megaai/apps/node', '/repo/megaai/workspace/site']) {
    const check = checkProjectDir(inside, '/repo/megaai', '/tmp');
    assert.equal(check.ok, false, `${inside} is inside the checkout`);
    assert.match(check.error ?? '', /rewriting MegaAI while it is running/);
  }
});

test('a folder next to the checkout is fine — only inside is the problem', () => {
  const check = checkProjectDir('/repo/megaai-projects/velocity', '/repo/megaai', '/tmp');
  assert.equal(check.ok, true);
  assert.equal(check.resolved, '/repo/megaai-projects/velocity');
});

test('forward slashes are accepted, which is the way round Windows shells survive', () => {
  const check = checkProjectDir('/c/Automation/projects/velocity', '/repo/megaai', '/tmp');
  assert.equal(check.ok, true);
});
