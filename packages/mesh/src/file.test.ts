import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { FileMeshStore } from './file.js';
import { Mesh } from './index.js';

function disk(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed));
  const order: string[] = [];
  return {
    files,
    order,
    options: {
      read: async (file: string) => {
        const found = files.get(file);
        if (found === undefined) {
          const error = new Error('ENOENT') as NodeJS.ErrnoException;
          error.code = 'ENOENT';
          throw error;
        }
        return found;
      },
      write: async (file: string, contents: string) => {
        order.push(`write ${file}`);
        files.set(file, contents);
      },
      move: async (from: string, to: string) => {
        order.push(`rename ${from}`);
        const contents = files.get(from);
        files.delete(from);
        if (contents !== undefined) files.set(to, contents);
      },
      ensureDir: async () => {},
    },
  };
}

test('the queue survives closing the lid, with everything still in it', async () => {
  const d = disk();
  const clock = new ManualClock(0);
  const store = new FileMeshStore('/state/queue.json', d.options);
  await store.open();

  const mesh = new Mesh({ store, clock });
  await mesh.register({ id: 'laptop', name: 'Laptop', kind: 'laptop', capabilities: ['shell'] });
  const task = await mesh.enqueue({ title: 'nightly rebuild', requires: ['shell'] });
  const claimed = await mesh.claimNext('laptop');
  await mesh.progress(claimed!.id, 'laptop', { step: 'installed dependencies' });
  await store.flush();

  // A new process, the same file.
  const reopened = new FileMeshStore('/state/queue.json', d.options);
  await reopened.open();
  const after = await reopened.getTask(task.id);
  assert.equal(after?.title, 'nightly rebuild');
  assert.deepEqual(after?.checkpoint, { step: 'installed dependencies' }, 'progress is kept, not just the task');
  assert.equal((await reopened.listNodes()).length, 1);
});

test('it is written aside and renamed over, so a power cut cannot truncate it', async () => {
  const d = disk();
  const store = new FileMeshStore('/state/queue.json', d.options);
  await store.open();
  await new Mesh({ store, clock: new ManualClock(0) }).enqueue({ title: 'a', requires: [] });
  await store.flush();
  assert.deepEqual(d.order, ['write /state/queue.json.tmp', 'rename /state/queue.json.tmp']);
});

test('a queue file that will not parse is reported, not swallowed and not fatal', async () => {
  const notices: string[] = [];
  const d = disk({ '/state/queue.json': '{"tasks":[' });
  const store = new FileMeshStore('/state/queue.json', { ...d.options, onError: (m) => notices.push(m) });
  await store.open();

  assert.deepEqual(await store.listTasks(), []);
  assert.match(notices[0] ?? '', /could not be read/);
  assert.match(notices[0] ?? '', /starting from an empty one/);
});

test('a first run with no file is normal, and says nothing', async () => {
  const notices: string[] = [];
  const d = disk();
  const store = new FileMeshStore('/state/queue.json', { ...d.options, onError: (m) => notices.push(m) });
  await store.open();
  assert.deepEqual(notices, []);
});

test('saves do not overtake each other', async () => {
  // Two writes in flight can land in either order, and the older one winning
  // would quietly undo the newer state.
  const d = disk();
  const store = new FileMeshStore('/state/queue.json', d.options);
  await store.open();
  const mesh = new Mesh({ store, clock: new ManualClock(0) });

  await Promise.all([
    mesh.enqueue({ title: 'a', requires: [] }),
    mesh.enqueue({ title: 'b', requires: [] }),
    mesh.enqueue({ title: 'c', requires: [] }),
  ]);
  await store.flush();

  const reopened = new FileMeshStore('/state/queue.json', d.options);
  await reopened.open();
  assert.deepEqual((await reopened.listTasks()).map((task) => task.title).sort(), ['a', 'b', 'c']);
});
