import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalManager, PolicyEngine } from '@megaai/policy';
import { createToolRegistry } from '@megaai/tools';
import { ActionEngine, parseProposal } from './index.js';

test('parseProposal reads the action protocol and tolerates prose', () => {
  const parsed = parseProposal(
    `Here you go:\n\`\`\`json\n{"summary":"did things","actions":[{"tool":"fs.write","input":{"path":"a.txt","content":"x"},"reason":"r"}]}\n\`\`\``,
  );
  assert.equal(parsed.summary, 'did things');
  assert.equal(parsed.actions.length, 1);
  assert.equal(parsed.actions[0]?.tool, 'fs.write');

  const plain = parseProposal('Just an analysis, no JSON at all.');
  assert.equal(plain.actions.length, 0);
  assert.match(plain.summary, /analysis/);

  const malformed = parseProposal('{"summary":"ok","actions":[{"tool":42},{"input":{}}]}');
  assert.equal(malformed.actions.length, 0);
});

test('unknown tools, disallowed tools and missing permissions are blocked as results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-act-'));
  try {
    const engine = new ActionEngine({
      registry: createToolRegistry(),
      policy: new PolicyEngine(),
      can: (_actor, permission) => permission === 'fs.read',
    });
    const results = await engine.execute(
      [
        { tool: 'no.such.tool', input: {} },
        { tool: 'fs.write', input: { path: 'a.txt', content: 'x' } }, // lacks fs.write grant
        { tool: 'fs.list', input: {} }, // allowed (fs.read)
      ],
      { actor: 'agent:test', ctx: { workspaceRoot: dir } },
    );
    assert.equal(results[0]?.ok, false);
    assert.match(results[0]?.error ?? '', /unknown tool/);
    assert.equal(results[1]?.ok, false);
    assert.match(results[1]?.error ?? '', /lacks permission/);
    assert.equal(results[2]?.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('policy approval gates actions; auto-approve lets them through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-act2-'));
  try {
    const policy = PolicyEngine.fromConfig({
      deniedPermissions: [],
      approvalRequiredPermissions: ['fs.write'],
    });
    const engine = new ActionEngine({
      registry: createToolRegistry(),
      policy,
      approvals: new ApprovalManager({ autoApprove: true }),
    });
    const results = await engine.execute(
      [{ tool: 'fs.write', input: { path: 'approved.txt', content: 'yes' } }],
      { actor: 'agent:test', ctx: { workspaceRoot: dir } },
    );
    assert.equal(results[0]?.ok, true);
    assert.ok(existsSync(join(dir, 'approved.txt')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agent tool allowlist restricts what an actor may call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-act3-'));
  try {
    const engine = new ActionEngine({ registry: createToolRegistry(), policy: new PolicyEngine() });
    const results = await engine.execute([{ tool: 'fs.delete', input: { path: 'x' } }], {
      actor: 'agent:docs',
      allowedTools: ['fs.write', 'fs.read'],
      ctx: { workspaceRoot: dir },
    });
    assert.equal(results[0]?.ok, false);
    assert.match(results[0]?.error ?? '', /not allowed for this agent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
