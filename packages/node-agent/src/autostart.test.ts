import test from 'node:test';
import assert from 'node:assert/strict';
import { autostartPlan, systemdUnit, windowsTaskXml } from './autostart.js';

const OPTIONS = {
  execPath: 'C:\\Program Files\\nodejs\\node.exe',
  scriptPath: 'C:\\Users\\me\\MegaAI\\apps\\node\\dist\\index.js',
  args: ['--platform-url', 'https://megaai.example.com'],
  userId: 'DESKTOP-7\\me',
  platform: 'win32' as NodeJS.Platform,
};

test('the Windows task runs on battery — the default would silently not', () => {
  // Task Scheduler sets both of these to true unless told otherwise, so an
  // agent installed the ordinary way stops the moment you unplug and there is
  // nothing on screen to explain it. Battery is the resource guard's job.
  const xml = windowsTaskXml(OPTIONS);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
});

test('it starts at logon, stays hidden, and comes back if it crashes', () => {
  const xml = windowsTaskXml(OPTIONS);
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<Hidden>true<\/Hidden>/);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>10<\/Count>/);
  // The default kills a task after three days; this one is meant to keep going.
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  // Logging in again while it runs must not start a second agent.
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
});

test('paths with spaces are quoted, and the XML is escaped', () => {
  const xml = windowsTaskXml({ ...OPTIONS, scriptPath: 'C:\\Users\\me\\My Projects\\agent.js', args: ['--tag', 'a&b'] });
  assert.match(xml, /<Command>C:\\Program Files\\nodejs\\node\.exe<\/Command>/);
  assert.match(xml, /&quot;C:\\Users\\me\\My Projects\\agent\.js&quot; --tag a&amp;b/);
  assert.match(xml, /<UserId>DESKTOP-7\\me<\/UserId>/);
});

test('installing on Windows registers the task and starts it now', () => {
  const plan = autostartPlan({ ...OPTIONS, stateDir: 'C:\\Users\\me\\AppData\\Local\\MegaAI' });
  assert.equal(plan.files[0]?.path, 'C:\\Users\\me\\AppData\\Local\\MegaAI\\megaai-node-agent.xml');
  assert.deepEqual(plan.commands[0], {
    command: 'schtasks.exe',
    // /F so re-running the installer after an upgrade replaces the task
    // instead of failing on "already exists".
    args: ['/Create', '/TN', 'MegaAI Node Agent', '/XML', 'C:\\Users\\me\\AppData\\Local\\MegaAI\\megaai-node-agent.xml', '/F'],
  });
  assert.deepEqual(plan.commands[1]?.args, ['/Run', '/TN', 'MegaAI Node Agent']);
  assert.ok(plan.removeCommand, 'anything installed has to be removable');
  assert.match(plan.summary, /log in/);
});

test('linux gets a user service that outlives the desktop session', () => {
  const plan = autostartPlan({ ...OPTIONS, platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/home/me/megaai/agent.js' });
  assert.match(plan.files[0]?.contents ?? '', /Restart=always/);
  assert.match(plan.files[0]?.contents ?? '', /ExecStart=\/usr\/bin\/node \/home\/me\/megaai\/agent\.js/);
  // Without lingering it dies at logout — exactly when it should be working.
  assert.ok(plan.commands.some((c) => c.command === 'loginctl' && c.args.includes('enable-linger')));
});

test('the service is niced so it never wins a scheduling fight with you', () => {
  assert.match(systemdUnit({ ...OPTIONS, platform: 'linux', execPath: '/usr/bin/node', scriptPath: '/a/b.js' }), /Nice=10/);
});
