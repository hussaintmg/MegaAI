import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileDatabase, MemoryDatabase } from './index.js';

test('memory database kv and collections round-trip', async () => {
  const db = new MemoryDatabase();
  await db.kv('settings').set('theme', 'dark');
  assert.equal(await db.kv('settings').get('theme'), 'dark');
  const users = db.collection<{ id: string; name: string }>('users');
  await users.put({ id: 'u1', name: 'Ada' });
  await users.put({ id: 'u2', name: 'Grace' });
  assert.equal((await users.get('u1'))?.name, 'Ada');
  assert.equal((await users.find((user) => user.name === 'Grace')).length, 1);
  assert.equal(await users.delete('u1'), true);
  assert.equal((await users.all()).length, 1);
});

test('collections return copies, not live references', async () => {
  const db = new MemoryDatabase();
  const docs = db.collection<{ id: string; tags: string[] }>('docs');
  await docs.put({ id: 'd1', tags: ['a'] });
  const fetched = await docs.get('d1');
  fetched?.tags.push('mutated');
  assert.deepEqual((await docs.get('d1'))?.tags, ['a']);
});

test('json file database persists across instances', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-db-'));
  try {
    const first = new JsonFileDatabase(dir);
    await first.kv('state').set('answer', 42);
    await first.collection<{ id: string; done: boolean }>('todos').put({ id: 't1', done: true });

    const second = new JsonFileDatabase(dir);
    assert.equal(await second.kv('state').get('answer'), 42);
    assert.equal((await second.collection<{ id: string; done: boolean }>('todos').get('t1'))?.done, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keys can be listed by prefix', async () => {
  const db = new MemoryDatabase();
  const kv = db.kv('ns');
  await kv.set('a:1', 1);
  await kv.set('a:2', 2);
  await kv.set('b:1', 3);
  assert.deepEqual((await kv.keys('a:')).sort(), ['a:1', 'a:2']);
});
