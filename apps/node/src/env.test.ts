import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEnv, envFilePath, maskValue, parseEnv, upsertEnv } from './env.js';

test('a MongoDB connection string survives being parsed', () => {
  // It is full of : @ / ? & and usually arrives wrapped in quotes from the
  // Atlas page. None of that should need thinking about.
  const entries = parseEnv('MEGAAI_MONGODB_URI="mongodb+srv://me:p@ss@cluster0.abc.mongodb.net/?retryWrites=true&w=majority"');
  assert.deepEqual(entries, [
    { key: 'MEGAAI_MONGODB_URI', value: 'mongodb+srv://me:p@ss@cluster0.abc.mongodb.net/?retryWrites=true&w=majority' },
  ]);
});

test('comments, blank lines and junk are skipped rather than becoming settings', () => {
  const entries = parseEnv(['# a comment', '', '   ', 'NOT A KEY=x', '=novalue', 'GOOD=yes'].join('\n'));
  assert.deepEqual(entries, [{ key: 'GOOD', value: 'yes' }]);
});

test('single quotes come off too, and an unquoted value keeps its inner quotes', () => {
  assert.equal(parseEnv("A='hello'")[0]?.value, 'hello');
  assert.equal(parseEnv('B=say "hi"')[0]?.value, 'say "hi"');
});

test('a real environment variable always wins over the saved file', () => {
  // Otherwise you could not point one run somewhere else without editing a
  // file and remembering to change it back.
  const env: NodeJS.ProcessEnv = { MEGAAI_MONGODB_URI: 'mongodb://from-the-shell' };
  const applied = applyEnv('MEGAAI_MONGODB_URI=mongodb://from-the-file\nMEGAAI_NODE_NAME=Laptop', env);
  assert.deepEqual(applied, ['MEGAAI_NODE_NAME']);
  assert.equal(env['MEGAAI_MONGODB_URI'], 'mongodb://from-the-shell');
  assert.equal(env['MEGAAI_NODE_NAME'], 'Laptop');
});

test('an empty variable counts as unset — PowerShell leaves those behind', () => {
  const env: NodeJS.ProcessEnv = { MEGAAI_NODE_NAME: '' };
  applyEnv('MEGAAI_NODE_NAME=Laptop', env);
  assert.equal(env['MEGAAI_NODE_NAME'], 'Laptop');
});

test('setting one value keeps the others', () => {
  let text = upsertEnv('', 'MEGAAI_MONGODB_URI', 'mongodb://one');
  text = upsertEnv(text, 'MEGAAI_NODE_NAME', 'Laptop');
  text = upsertEnv(text, 'MEGAAI_MONGODB_URI', 'mongodb://two');

  const entries = parseEnv(text);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.key === 'MEGAAI_MONGODB_URI')?.value, 'mongodb://two');
  assert.equal(entries.find((entry) => entry.key === 'MEGAAI_NODE_NAME')?.value, 'Laptop');
});

test('an empty value removes the setting rather than storing emptiness', () => {
  const text = upsertEnv(upsertEnv('', 'A', '1'), 'A', '');
  assert.deepEqual(parseEnv(text), []);
});

test('a connection string is never shown back in full — it carries the password', () => {
  const masked = maskValue('MEGAAI_MONGODB_URI', 'mongodb+srv://me:hunter2@cluster0.abc.mongodb.net/db');
  assert.ok(!masked.includes('hunter2'));
  assert.match(masked, /^mongodb\+/, 'enough of the front to recognise which one it is');
  assert.equal(maskValue('MEGAAI_NODE_NAME', 'Laptop'), 'Laptop', 'and nothing harmless is hidden');
});

test('the file sits next to the rest of the machine state, in the platform way', () => {
  assert.equal(envFilePath('C:\\Users\\me\\AppData\\Local\\MegaAI', 'win32'), 'C:\\Users\\me\\AppData\\Local\\MegaAI\\.env');
  assert.equal(envFilePath('/home/me/.megaai', 'linux'), '/home/me/.megaai/.env');
});
