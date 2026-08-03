import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, loadConfig, validateConfig } from './index.js';

test('default config is valid', () => {
  validateConfig(defaultConfig());
});

test('environment variables override defaults', () => {
  const config = loadConfig({
    env: {
      MEGAAI_LOG_LEVEL: 'debug',
      MEGAAI_SERVER_PORT: '5555',
      ANTHROPIC_API_KEY: 'sk-test-123',
    } as NodeJS.ProcessEnv,
  });
  assert.equal(config.logging.level, 'debug');
  assert.equal(config.server.port, 5555);
  assert.equal(config.ai.providers.anthropic?.apiKey, 'sk-test-123');
});

test('explicit overrides win over everything', () => {
  const config = loadConfig({
    env: {} as NodeJS.ProcessEnv,
    overrides: { policy: { autoApprove: true }, ai: { maxTokens: 2048 } },
  });
  assert.equal(config.policy.autoApprove, true);
  assert.equal(config.ai.maxTokens, 2048);
});

test('invalid configuration fails fast with reasons', () => {
  assert.throws(
    () => loadConfig({ env: {} as NodeJS.ProcessEnv, overrides: { server: { port: 99_999_9 } } }),
    /server\.port/,
  );
  assert.throws(
    () =>
      loadConfig({
        env: {} as NodeJS.ProcessEnv,
        overrides: { ai: { fallbackChain: ['nonexistent-provider'] } },
      }),
    /unknown provider/,
  );
});

test('relative dirs resolve against cwd', () => {
  const config = loadConfig({ env: {} as NodeJS.ProcessEnv, cwd: '/tmp' });
  assert.ok(config.system.dataDir.startsWith('/tmp'));
  assert.ok(config.system.workspaceRoot.startsWith('/tmp'));
});
