import test from 'node:test';
import assert from 'node:assert/strict';
import { ManualClock } from '@megaai/utils';
import { MemoryDatabase } from '@megaai/database';
import { AuditLog, PermissionManager, permissionMatches, RateLimiter, SecretVault } from './index.js';

test('permission wildcards match hierarchically', () => {
  assert.equal(permissionMatches('fs.*', 'fs.write'), true);
  assert.equal(permissionMatches('fs.*', 'net.fetch'), false);
  assert.equal(permissionMatches('*', 'anything.at.all'), true);
  assert.equal(permissionMatches('fs.write', 'fs.write'), true);
});

test('PermissionManager grants, checks and denies', () => {
  const permissions = new PermissionManager();
  permissions.grant('agent:coding', 'fs.*');
  assert.equal(permissions.check('agent:coding', 'fs.write'), true);
  assert.equal(permissions.check('agent:coding', 'shell.exec'), false);
  assert.throws(() => permissions.require('agent:coding', 'shell.exec'), /lacks permission/);
  permissions.grant('*', 'time.read');
  assert.equal(permissions.check('anyone', 'time.read'), true);
});

test('SecretVault redacts values and never lists them', () => {
  const vault = new SecretVault();
  vault.set('API_KEY', 'sk-super-secret-value');
  const redacted = vault.redact('header: Bearer sk-super-secret-value; done');
  assert.equal(redacted.includes('sk-super-secret-value'), false);
  assert.equal(redacted.includes('[redacted:API_KEY]'), true);
  assert.deepEqual(vault.names(), ['API_KEY']);
});

test('RateLimiter enforces a sliding window', () => {
  const clock = new ManualClock(0);
  const limiter = new RateLimiter(2, 1000, clock);
  assert.equal(limiter.consume().allowed, true);
  assert.equal(limiter.consume().allowed, true);
  const blocked = limiter.consume();
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterMs > 0);
  clock.advance(1001);
  assert.equal(limiter.consume().allowed, true);
});

test('AuditLog records and lists newest first', async () => {
  const clock = new ManualClock(1000);
  const audit = new AuditLog(new MemoryDatabase(), undefined, clock);
  await audit.record({ actor: 'a', action: 'first', outcome: 'ok' });
  clock.advance(10);
  await audit.record({ actor: 'a', action: 'second', outcome: 'denied' });
  const entries = await audit.recent();
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.action, 'second');
});
