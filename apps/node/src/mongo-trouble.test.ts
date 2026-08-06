import test from 'node:test';
import assert from 'node:assert/strict';
import { explainMongoFailure } from './mongo-trouble.js';

const URI = 'mongodb+srv://me:secret@cluster0.w07tsso.mongodb.net/?retryWrites=true';

test('the SRV lookup failure names the real cause and the two-minute fix', () => {
  // Seen on a real Windows 11 laptop. "querySrv ECONNREFUSED" is a true
  // sentence that tells almost nobody what to do, and the fix takes two
  // minutes once you know it is DNS.
  const trouble = explainMongoFailure(
    new Error('querySrv ECONNREFUSED _mongodb._tcp.cluster0.w07tsso.mongodb.net'),
    URI,
  );

  assert.match(trouble.summary, /DNS would not answer the SRV lookup/);
  assert.match(trouble.summary, /cluster0\.w07tsso\.mongodb\.net/);
  assert.match(trouble.fixes[0] ?? '', /without \+srv/, 'the non-SRV connection string is the fix');
  assert.match(trouble.fixes.join(' '), /8\.8\.8\.8/);
  assert.equal(trouble.transient, true, 'the network may simply come back');
});

test('the password never reaches the explanation, only the host does', () => {
  const trouble = explainMongoFailure(new Error('querySrv ECONNREFUSED _mongodb._tcp.x'), URI);
  assert.ok(!trouble.summary.includes('secret'));
  assert.ok(!trouble.fixes.join(' ').includes('secret'));
});

test('a wrong password is not something waiting will fix', () => {
  const trouble = explainMongoFailure(new Error('bad auth : Authentication failed.'), URI);
  assert.equal(trouble.transient, false);
  assert.match(trouble.fixes.join(' '), /percent-encoded/, 'the usual cause is an @ or : in the password');
  assert.match(trouble.fixes.join(' '), /megaai-node set/);
});

test('a timeout points at the IP allowlist, which is what it usually is', () => {
  // The driver's real words, verified against a genuinely unreachable cluster.
  const trouble = explainMongoFailure(new Error('Server selection timed out after 8000 ms'), URI);
  assert.match(trouble.fixes[0] ?? '', /Network Access/);
  assert.equal(trouble.transient, true);
});

test('an unrecognised error is passed through rather than dressed up', () => {
  const trouble = explainMongoFailure(new Error('something nobody has seen before'), URI);
  assert.equal(trouble.summary, 'something nobody has seen before');
  assert.ok(trouble.fixes.length > 0, 'and still says where to look');
});

test('a thrown non-Error is handled too, since drivers throw all sorts', () => {
  const trouble = explainMongoFailure('just a string', URI);
  assert.equal(trouble.summary, 'just a string');
});
