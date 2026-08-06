import test from 'node:test';
import assert from 'node:assert/strict';
import type { MeshTask } from '@megaai/mesh';
import {
  createGuiHandler,
  escapeSendKeys,
  guiScriptCommand,
  openCoderInEditorSteps,
  openEditorSteps,
  planGuiSteps,
  psLiteral,
  renderGuiScript,
} from './gui.js';
import type { TaskContext } from './agent.js';

test("a path with an apostrophe does not end the PowerShell string", () => {
  assert.equal(psLiteral("C:\\Users\\O'Brien\\site"), "'C:\\Users\\O''Brien\\site'");
  // The one that matters: anything that would otherwise be read as code.
  assert.equal(psLiteral('$(rm -rf /); #'), "'$(rm -rf /); #'");
});

test('SendKeys control characters are escaped into the characters they look like', () => {
  // `npm run build && npm test` types as a Ctrl+A, an Alt and two Shifts
  // without this, into a focused editor.
  assert.equal(escapeSendKeys('a+b^c%d~e'), 'a{+}b{^}c{%}d{~}e');
  assert.equal(escapeSendKeys('run(x)[y]{z}'), 'run{(}x{)}{[}y{]}{{}z{}}');
  assert.equal(escapeSendKeys('codex'), 'codex', 'and ordinary text is left alone');
});

test('opening the editor waits for the window instead of typing into thin air', () => {
  const steps = openEditorSteps({ projectDir: 'C:/projects/site' });
  assert.deepEqual(steps.map((step) => step.do), ['launch', 'wait', 'focus']);
  const script = renderGuiScript(steps);
  assert.match(script, /Start-Process -FilePath 'code' -ArgumentList @\('C:\/projects\/site'\)/);
  assert.match(script, /no window whose title contains "Visual Studio Code" ever appeared/);
});

test('a focus that never lands throws, rather than typing into whatever is in front', () => {
  const script = renderGuiScript([{ do: 'focus', titleContains: 'Codex' }]);
  assert.match(script, /throw/);
  assert.match(script, /AppActivate/);
});

test('Codex is opened as a real application in the editor, and the brief is pasted', () => {
  const steps = openCoderInEditorSteps({
    projectDir: 'C:/projects/site',
    command: 'codex',
    promptFile: 'C:/temp/brief.txt',
  });
  assert.deepEqual(
    steps.map((step) => step.do),
    ['launch', 'wait', 'focus', 'keys', 'wait', 'type', 'keys', 'wait', 'paste', 'keys'],
  );
  const script = renderGuiScript(steps);
  assert.match(script, /SendWait\('\^`'\)/, 'Ctrl+backtick opens the integrated terminal');
  assert.match(script, /SendWait\('codex'\)/);
  // The brief is read from disk at run time — never embedded in the script.
  assert.match(script, /ReadAllText\('C:\/temp\/brief\.txt', \[System\.Text\.Encoding\]::UTF8\)/);
  assert.match(script, /Set-Clipboard -Value \$text/);
  assert.match(script, /SendWait\('\^v'\)/);
});

test('a click moves the pointer first and presses both halves of the button', () => {
  const script = renderGuiScript([{ do: 'click', x: 400, y: 250 }, { do: 'click', button: 'right', double: true }]);
  assert.match(script, /SetCursorPos\(400, 250\)/);
  assert.match(script, /Send-Click 0x0002 0x0004/);
  assert.match(script, /Send-Click 0x0008 0x0010/);
  assert.equal(script.match(/Send-Click 0x0008 0x0010/g)?.length, 2, 'a double click is two clicks');
});

test('the script says it finished, so a silent failure is not read as success', () => {
  const script = renderGuiScript([{ do: 'wait', ms: 10 }]);
  assert.match(script, /megaai-gui: done/);
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
});

test('it is run STA, because the clipboard does not work otherwise', () => {
  const command = guiScriptCommand('C:/temp/x.ps1');
  assert.equal(command.file, 'powershell.exe');
  assert.ok(command.args.includes('-STA'));
  assert.ok(command.args.includes('-NoProfile'));
  assert.deepEqual(command.args.slice(-2), ['-File', 'C:/temp/x.ps1']);
});

test('a coder task with no brief is refused before anything moves', () => {
  const planned = planGuiSteps(
    { kind: 'gui', action: 'coder', projectDir: 'C:/p', command: 'codex' },
    'C:/temp/b.txt',
  );
  assert.equal(planned.steps.length, 0);
  assert.match(planned.error ?? '', /has to carry the brief/);
});

/* ---------------- as a task ---------------- */

function contextFor(payload: Record<string, unknown>): TaskContext {
  const task = { id: 't1', title: 'open it', payload } as unknown as MeshTask;
  return { task, signal: new AbortController().signal, checkpoint: async () => {}, log: () => {} };
}

test('the brief and the script are written, then PowerShell is run on them', async () => {
  const written = new Map<string, string>();
  const calls: Array<{ file: string; args: string[] }> = [];
  const handler = createGuiHandler({
    scratchDir: 'C:/temp',
    platform: 'win32',
    uniqueSuffix: () => 'abc',
    writeFile: (path, contents) => void written.set(path, contents),
    run: async (file, args) => {
      calls.push({ file, args });
      return { exitCode: 0, output: 'megaai-gui: done\n' };
    },
  });

  const outcome = await handler(
    contextFor({ kind: 'gui', action: 'coder', projectDir: 'C:/p', command: 'codex', prompt: '# Build the API\n\nDo it well.' }),
  );

  assert.equal(outcome.kind, 'done');
  assert.equal(written.get('C:/temp/gui-abc.prompt.txt'), '# Build the API\n\nDo it well.');
  assert.match(written.get('C:/temp/gui-abc.ps1') ?? '', /Set-Clipboard/);
  assert.equal(calls[0]?.file, 'powershell.exe');
  assert.ok(calls[0]?.args.includes('C:/temp/gui-abc.ps1'));
});

test('a script that fails says where the script is, so it can be run by hand', async () => {
  const handler = createGuiHandler({
    scratchDir: 'C:/temp',
    platform: 'win32',
    uniqueSuffix: () => 'abc',
    writeFile: () => {},
    run: async () => ({ exitCode: 1, output: 'no window whose title contains "Visual Studio Code" ever appeared' }),
  });
  const outcome = await handler(contextFor({ kind: 'gui', action: 'editor', projectDir: 'C:/p' }));
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /C:\/temp\/gui-abc\.ps1/);
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /ever appeared/);
});

test('exit 0 with no completion line is still a failure', async () => {
  // PowerShell exits 0 after a `throw` in some hosting configurations, and a
  // half-driven editor reported as success is worse than a clean failure.
  const handler = createGuiHandler({
    scratchDir: '/tmp',
    platform: 'win32',
    uniqueSuffix: () => 'a',
    writeFile: () => {},
    run: async () => ({ exitCode: 0, output: 'something went wrong' }),
  });
  const outcome = await handler(contextFor({ kind: 'gui', action: 'editor', projectDir: 'C:/p' }));
  assert.equal(outcome.kind, 'failed');
});

test('anywhere but Windows it says so instead of failing three layers down', async () => {
  const handler = createGuiHandler({
    scratchDir: '/tmp',
    platform: 'linux',
    writeFile: () => {},
    run: async () => ({ exitCode: 0, output: '' }),
  });
  const outcome = await handler(contextFor({ kind: 'gui', action: 'editor', projectDir: '/p' }));
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.kind === 'failed' ? outcome.error : '', /implemented for Windows/);
});
