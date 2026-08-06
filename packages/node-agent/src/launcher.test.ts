import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BUILTIN_CODERS } from '@megaai/coders';
import { createProcessLauncher, detectCoders, planSpawn, resolveCommand, resolveShimTarget } from './launcher.js';

const WINDOWS = {
  platform: 'win32' as NodeJS.Platform,
  pathValue: 'C:\\Windows\\system32;C:\\Users\\me\\AppData\\Roaming\\npm',
  pathExt: '.COM;.EXE;.BAT;.CMD',
  join: (...parts: string[]) => parts.join('\\'),
  delimiter: ';',
};

test('on Windows the npm shim is found — this is the ENOENT everyone hits', () => {
  // `claude` on Windows is `claude.cmd`. spawn() without a shell looks for a
  // file called exactly "claude", finds nothing, and reports ENOENT as if the
  // agent were not installed at all.
  const disk = new Set(['C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd']);
  assert.equal(
    resolveCommand('claude', { ...WINDOWS, exists: (p) => disk.has(p) }),
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
  );
});

test('a real .exe earlier on the path wins, in PATHEXT order', () => {
  const disk = new Set(['C:\\Windows\\system32\\where.exe', 'C:\\Users\\me\\AppData\\Roaming\\npm\\where.cmd']);
  assert.equal(resolveCommand('where', { ...WINDOWS, exists: (p) => disk.has(p) }), 'C:\\Windows\\system32\\where.exe');
});

test('nothing installed resolves to nothing, rather than a command that will fail later', () => {
  assert.equal(resolveCommand('codex', { ...WINDOWS, exists: () => false }), undefined);
});

test('on posix the plain file is used, and an explicit path is trusted', () => {
  const options = { platform: 'linux' as NodeJS.Platform, pathValue: '/usr/bin:/usr/local/bin', delimiter: ':', join: (...p: string[]) => p.join('/') };
  assert.equal(resolveCommand('claude', { ...options, exists: (p) => p === '/usr/local/bin/claude' }), '/usr/local/bin/claude');
  assert.equal(resolveCommand('/opt/claude/bin/claude', { ...options, exists: (p) => p === '/opt/claude/bin/claude' }), '/opt/claude/bin/claude');
});

test('detection reports exactly which agents this machine has', () => {
  const disk = new Set([
    'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
    'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd',
  ]);
  const found = detectCoders(BUILTIN_CODERS, { ...WINDOWS, exists: (p) => disk.has(p) });
  assert.deepEqual(found.installed, ['claude', 'opencode']);
  assert.equal(found.paths['codex'], undefined, 'and does not claim one that is not there');
});

/* ---------------- running one ---------------- */

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  unref(): void {}
}

function fakeSpawn() {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  let child: FakeChild | undefined;
  const spawnProcess = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    if (command === 'taskkill.exe') {
      // Standing in for what taskkill actually does to the tree.
      queueMicrotask(() => child?.emit('close', 1));
      return new FakeChild() as never;
    }
    child = new FakeChild();
    return child as never;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawnProcess, calls, get child() { return child; } };
}

test('stdout and stderr are merged — the quota message lands on either one', async () => {
  const fake = fakeSpawn();
  const launcher = createProcessLauncher({
    platform: 'win32',
    spawnProcess: fake.spawnProcess,
    resolve: () => 'C:\\npm\\claude.cmd',
  });

  const running = launcher('claude', ['-p', 'do it'], 'C:\\projects\\site');
  await Promise.resolve();
  fake.child?.stdout.emit('data', 'writing app/page.tsx\n');
  fake.child?.stderr.emit('data', 'Claude usage limit reached\n');
  fake.child?.emit('close', 1);

  const outcome = await running;
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.output, /writing app\/page\.tsx/);
  assert.match(outcome.output, /usage limit reached/);
  assert.equal(fake.calls[0]?.command, 'C:\\npm\\claude.cmd', 'the resolved shim is spawned, not the bare name');
  assert.equal(fake.calls[0]?.options['cwd'], 'C:\\projects\\site');
  assert.equal(fake.calls[0]?.options['detached'], false, 'detaching on Windows only loses the handle');
});

test('a turn that goes silent is killed as a tree, not just at the top', async () => {
  const fake = fakeSpawn();
  const launcher = createProcessLauncher({
    platform: 'win32',
    spawnProcess: fake.spawnProcess,
    resolve: () => 'C:\\npm\\codex.cmd',
    silenceTimeoutMs: 5,
  });

  const outcome = await launcher('codex', ['exec', 'x'], 'C:\\p');
  const kill = fake.calls.find((call) => call.command === 'taskkill.exe');
  // Killing only the shim leaves npm, node and the build it started running —
  // and a laptop with the fan at full speed until you notice.
  assert.ok(kill, 'the whole tree has to go');
  assert.deepEqual(kill?.args, ['/PID', '4242', '/T', '/F']);
  assert.match(outcome.output, /stopped this turn: it printed nothing/);
});

test('a CLI that will not start is reported, not thrown into the queue', async () => {
  const fake = fakeSpawn();
  const launcher = createProcessLauncher({ platform: 'linux', spawnProcess: fake.spawnProcess, resolve: () => '/usr/bin/claude' });
  const running = launcher('claude', ['-p', 'x'], '/home/me/site');
  await Promise.resolve();
  fake.child?.emit('error', new Error('spawn EACCES'));
  const outcome = await running;
  assert.equal(outcome.exitCode, 127);
  assert.match(outcome.output, /could not start \/usr\/bin\/claude: spawn EACCES/);
});

test('a very long build is kept to its tail rather than held whole in memory', async () => {
  const fake = fakeSpawn();
  const launcher = createProcessLauncher({
    platform: 'linux',
    spawnProcess: fake.spawnProcess,
    resolve: () => '/usr/bin/claude',
    maxOutputChars: 100,
  });
  const running = launcher('claude', [], '/p');
  await Promise.resolve();
  fake.child?.stdout.emit('data', 'x'.repeat(500));
  fake.child?.stdout.emit('data', '\nusage limit reached\n');
  fake.child?.emit('close', 0);
  const outcome = await running;
  assert.ok(outcome.output.length <= 100);
  assert.match(outcome.output, /usage limit reached/, 'and the tail is the part that matters');
});

/* ---------------- the .cmd Node will no longer run ---------------- */

/** What npm actually writes for a scoped package's binary. */
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
].join('\r\n');

test('the shim gives up the script it was always going to run', () => {
  const target = resolveShimTarget(NPM_SHIM, 'C:\\Users\\me\\AppData\\Roaming\\npm');
  assert.deepEqual(target, {
    path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
    kind: 'js',
  });
});

test('a shim that runs a native binary is not handed to node', () => {
  // OpenCode ships an .exe rather than JavaScript. Putting node in front of it
  // would break the one agent still standing when the others ran out of quota.
  const shim = [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
    'endLocal & goto #_undefined_# 2>NUL || "%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe" %*',
  ].join('\r\n');

  const target = resolveShimTarget(shim, 'C:\\npm');
  assert.deepEqual(target, { path: 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe', kind: 'exe' });

  const plan = planSpawn('C:\\npm\\opencode.cmd', ['run', 'x'], {
    platform: 'win32',
    readShim: () => shim,
    nodePath: 'C:\\node.exe',
    dirname: () => 'C:\\npm',
  });
  assert.equal(plan.file, 'C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe');
  assert.deepEqual(plan.args, ['run', 'x'], 'and its arguments are not shifted along by a script path');
});

test('a .cmd is unwrapped into node + script rather than spawned', () => {
  // Since the fix for CVE-2024-27980, Node refuses to spawn a .cmd without a
  // shell — and a shell cannot carry a multi-line handoff brief. Running the
  // script directly sidesteps both.
  const plan = planSpawn('C:\\npm\\claude.cmd', ['-p', 'a brief\nwith newlines & "quotes"'], {
    platform: 'win32',
    readShim: () => NPM_SHIM,
    nodePath: 'C:\\node.exe',
    dirname: () => 'C:\\npm',
  });

  assert.equal(plan.file, 'C:\\node.exe');
  assert.equal(plan.args[0], 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
  assert.equal(plan.args[2], 'a brief\nwith newlines & "quotes"', 'the brief survives untouched');
  assert.equal(plan.note, undefined);
});

test('a real .exe is spawned as found — only batch files need unwrapping', () => {
  const plan = planSpawn('C:\\tools\\codex.exe', ['exec'], { platform: 'win32', readShim: () => NPM_SHIM });
  assert.equal(plan.file, 'C:\\tools\\codex.exe');
  assert.deepEqual(plan.args, ['exec']);
});

test('nothing is unwrapped anywhere but Windows', () => {
  const plan = planSpawn('/usr/local/bin/claude', ['-p', 'x'], { platform: 'linux', readShim: () => NPM_SHIM });
  assert.equal(plan.file, '/usr/local/bin/claude');
});

test('a shim that cannot be read says what will happen instead of failing blankly', () => {
  const plan = planSpawn('C:\\npm\\claude.cmd', [], { platform: 'win32', readShim: () => undefined });
  assert.equal(plan.file, 'C:\\npm\\claude.cmd', 'it still tries');
  assert.match(plan.note ?? '', /EINVAL/);
  assert.match(plan.note ?? '', /CVE-2024-27980/, 'so the cause is findable rather than mysterious');
});

test('a shim in an unfamiliar format is left alone rather than guessed at', () => {
  assert.equal(resolveShimTarget('@echo off\r\nsomething-else.exe %*', 'C:\\npm'), undefined);
});
