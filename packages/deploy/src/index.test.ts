import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '@megaai/utils';
import { createDeployTools, DeployEngine } from './index.js';

function ws(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-deploy-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('plan is pure and target-specific', () => {
  const engine = new DeployEngine();
  const docker = engine.plan('/tmp/my-app', { target: 'docker' });
  assert.equal(docker.target, 'docker');
  assert.equal(docker.simulated, false);
  assert.ok(docker.commands.some((c) => c.command === 'docker'));

  const vercel = engine.plan('/tmp/my-app', { target: 'vercel' });
  assert.match(vercel.estimatedUrl, /vercel\.app$/);

  const sim = engine.plan('/tmp/My App!', { target: 'simulated' });
  assert.equal(sim.simulated, true);
  assert.match(sim.appName, /my-app/);
  assert.throws(() => engine.plan('/tmp/x', { target: 'nope' as never }), /Unknown deploy target/);
});

test('simulated execute returns a URL, records a file, runs no commands', async () => {
  const { dir, cleanup } = ws();
  try {
    const engine = new DeployEngine({ clock: new ManualClock(1234) });
    const result = await engine.execute(dir, { appName: 'shop' });
    assert.equal(result.target, 'simulated');
    assert.equal(result.simulated, true);
    assert.equal(result.url, 'https://shop.megaai.app');
    assert.equal(result.deployedAt, 1234);
    assert.equal(result.steps.length, 0);
    assert.ok(existsSync(join(dir, '.megaai-deploy.json')));
    assert.match(readFileSync(join(dir, '.megaai-deploy.json'), 'utf8'), /shop\.megaai\.app/);
  } finally {
    cleanup();
  }
});

test('real target runs the injected runner and fails the deploy on a bad step', async () => {
  const { dir, cleanup } = ws();
  try {
    const calls: string[] = [];
    const okEngine = new DeployEngine({
      runner: async (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });
    const result = await okEngine.execute(dir, { target: 'docker', appName: 'svc' });
    assert.equal(result.simulated, false);
    assert.equal(result.steps.length, 2);
    assert.ok(calls[0]?.startsWith('docker build'));

    const failEngine = new DeployEngine({
      runner: async () => ({ exitCode: 1, stdout: '', stderr: 'boom' }),
    });
    await assert.rejects(failEngine.execute(dir, { target: 'docker' }), /deploy step "docker" failed/);
  } finally {
    cleanup();
  }
});

test('tools split plan (safe) from execute (deploy permission)', async () => {
  const { dir, cleanup } = ws();
  try {
    const [plan, execute] = createDeployTools(new DeployEngine());
    assert.deepEqual(plan!.permissions, ['deploy.plan']);
    assert.deepEqual(execute!.permissions, ['deploy']);
    const planned = (await plan!.execute({ target: 'static' }, { workspaceRoot: dir })) as { estimatedUrl: string };
    assert.match(planned.estimatedUrl, /megaai\.app$/);
    const done = (await execute!.execute({}, { workspaceRoot: dir })) as { url: string; simulated: boolean };
    assert.equal(done.simulated, true);
    assert.ok(done.url);
    await assert.rejects(plan!.execute({ target: 'bogus' }, { workspaceRoot: dir }), /target must be one of/);
  } finally {
    cleanup();
  }
});
