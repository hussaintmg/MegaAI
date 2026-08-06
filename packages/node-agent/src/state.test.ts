import test from 'node:test';
import assert from 'node:assert/strict';
import { StateFile, defaultStateDir } from './state.js';

/** A filesystem in a Map, so the write-then-rename can be watched. */
function disk(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const order: string[] = [];
  return {
    files,
    order,
    options: {
      read: async (file: string) => {
        const found = files.get(file);
        if (found === undefined) throw new Error('ENOENT');
        return found;
      },
      write: async (file: string, contents: string) => {
        order.push(`write ${file}`);
        files.set(file, contents);
      },
      move: async (from: string, to: string) => {
        order.push(`rename ${from} -> ${to}`);
        const contents = files.get(from);
        files.delete(from);
        if (contents !== undefined) files.set(to, contents);
      },
      ensureDir: async () => {},
    },
  };
}

test('state goes where the platform expects it', () => {
  assert.equal(
    defaultStateDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'),
    'C:\\Users\\me\\AppData\\Local\\MegaAI',
  );
  assert.equal(defaultStateDir({ XDG_STATE_HOME: '/home/me/.local/state' }, 'linux'), '/home/me/.local/state/megaai');
  assert.equal(defaultStateDir({ HOME: '/home/me' }, 'linux'), '/home/me/.megaai');
});

test('the node keeps its identity across restarts', async () => {
  const d = disk();
  const first = new StateFile('/state/node.json', d.options);
  const created = await first.load();
  assert.match(created.nodeId, /^node/);
  await first.save({ nodeId: created.nodeId });

  // A brand new process, same file. Coming back as a *different* node would
  // strand everything the old one was holding until its leases lapsed.
  const second = new StateFile('/state/node.json', d.options);
  assert.equal((await second.load()).nodeId, created.nodeId);
});

test('the file is written to one side and renamed over — a power cut cannot half-write it', async () => {
  const d = disk();
  const state = new StateFile('/state/node.json', d.options);
  await state.save({ gear: 'background' });
  assert.deepEqual(d.order, ['write /state/node.json.tmp', 'rename /state/node.json.tmp -> /state/node.json']);
});

test('a truncated file loses the sessions, not the agent', async () => {
  const d = disk({ '/state/node.json': '{"nodeId":"node-lap' });
  const state = new StateFile('/state/node.json', d.options);
  const loaded = await state.load();
  // Refusing to start because the bookkeeping got cut short would be worse
  // than re-introducing the coding agents to the project.
  assert.match(loaded.nodeId, /^node/);
  assert.deepEqual(loaded.sessions, {});
});

test('sessions are remembered per agent and per project', async () => {
  const d = disk();
  const state = new StateFile('/state/node.json', d.options);
  await state.rememberSession('claude', 'C:\\projects\\velocity', 'sess-1');
  await state.rememberSession('claude', 'C:\\projects\\shop', 'sess-2');
  await state.rememberSession('codex', 'C:\\projects\\velocity', 'sess-3');

  const reloaded = await new StateFile('/state/node.json', d.options).load();
  assert.deepEqual(reloaded.sessions, {
    claude: { 'C:\\projects\\velocity': 'sess-1', 'C:\\projects\\shop': 'sess-2' },
    codex: { 'C:\\projects\\velocity': 'sess-3' },
  });
});

test('nonsense in the sessions map is dropped rather than handed to a CLI', async () => {
  const d = disk({ '/state/node.json': JSON.stringify({ nodeId: 'node-1', sessions: { claude: { a: 5, b: 'ok' }, codex: 'nope' } }) });
  const loaded = await new StateFile('/state/node.json', d.options).load();
  assert.deepEqual(loaded.sessions, { claude: { b: 'ok' } });
});
