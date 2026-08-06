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

test('a reply cut off mid-file keeps every action that survived', () => {
  // What a real run produced: the model was writing a Next.js scaffold, hit
  // the output ceiling partway through the third file, and the reply ended in
  // the middle of a string. Strict parsing returned nothing, the agent
  // reported success, and the delivery was two marketing files.
  const truncated = `{
  "thoughts": "Scaffolding the app",
  "summary": "Created the project skeleton",
  "actions": [
    { "tool": "fs.write", "input": { "path": "package.json", "content": "{}" }, "reason": "manifest" },
    { "tool": "fs.write", "input": { "path": "app/layout.tsx", "content": "export default function L() {}" } },
    { "tool": "fs.write", "input": { "path": "app/page.tsx", "content": "export default function P() { return <div>hel`;

  const proposal = parseProposal(truncated);
  assert.equal(proposal.unparsed, undefined, 'the reply is recovered, not discarded');
  assert.equal(proposal.repaired, true);
  assert.equal(proposal.actions.length, 2, 'both complete files survive; the half-written one is dropped');
  assert.deepEqual(
    proposal.actions.map((a) => a.input.path),
    ['package.json', 'app/layout.tsx'],
  );
});

test('raw newlines inside a file body do not destroy the whole reply', () => {
  // Models emit source code inside a JSON string and do not always escape the
  // newlines. One of them used to invalidate every other file in the reply.
  const raw = `{"summary":"wrote a page","actions":[{"tool":"fs.write","input":{"path":"app/page.tsx","content":"export default function Page() {
  return <h1>Cars</h1>;
}"}}]}`;
  const proposal = parseProposal(raw);
  assert.equal(proposal.unparsed, undefined);
  assert.equal(proposal.actions.length, 1);
  assert.equal(proposal.actions[0]?.input.path, 'app/page.tsx');
  assert.match(String(proposal.actions[0]?.input.content), /return <h1>Cars<\/h1>;/);
  assert.match(String(proposal.actions[0]?.input.content), /\n/, 'the newline is preserved, not swallowed');
});

test('a reply with nothing usable is reported as unparsed, not as an empty success', () => {
  const proposal = parseProposal('I will now create the files for you. Stand by!');
  assert.equal(proposal.unparsed, true);
  assert.deepEqual(proposal.actions, []);

  const alsoBad = parseProposal('');
  assert.equal(alsoBad.unparsed, true);
});

test('a well-formed reply is untouched and not marked repaired', () => {
  const proposal = parseProposal(
    '```json\n{"thoughts":"t","summary":"s","actions":[{"tool":"fs.write","input":{"path":"a.txt","content":"hi"},"reason":"r"}]}\n```',
  );
  assert.equal(proposal.repaired, undefined);
  assert.equal(proposal.unparsed, undefined);
  assert.equal(proposal.summary, 's');
  assert.equal(proposal.actions[0]?.reason, 'r');
});

test('a repaired reply that lost its summary describes what survived', () => {
  // The summary key is usually last, so truncation eats it. Pasting the raw
  // JSON into the summary is what put `{ "thoughts": ...` in the report.
  const proposal = parseProposal(
    '{"thoughts":"t","actions":[{"tool":"fs.write","input":{"path":"a.txt","content":"hi"}},{"tool":"fs.write","input":{"path":"b.txt","con',
  );
  assert.equal(proposal.repaired, true);
  assert.equal(proposal.actions.length, 1);
  assert.match(proposal.summary, /truncated; recovered 1 action/);
  assert.doesNotMatch(proposal.summary, /"thoughts"/, 'raw JSON never reaches the report');
});

test('file blocks deliver code without escaping anything', () => {
  // The reason this format exists: a `.tsx` file full of newlines, quotes and
  // backslashes goes through untouched, where a JSON string would have needed
  // every one of them escaped correctly or lost the whole reply.
  const reply = `{"summary":"scaffolded the hero"}

===FILE app/page.tsx===
'use client';
import { motion } from 'framer-motion';

export default function Page() {
  const label = "It's a \\"3D\\" car";
  return <motion.h1 animate={{ opacity: 1 }}>{label}</motion.h1>;
}
===END===

===FILE lib/data.ts===
export const cars = [{ id: 'gt', name: 'GT' }];
===END===
`;
  const proposal = parseProposal(reply);
  assert.equal(proposal.unparsed, undefined);
  assert.equal(proposal.summary, 'scaffolded the hero');
  assert.equal(proposal.actions.length, 2);
  assert.deepEqual(proposal.actions.map((a) => a.input.path), ['app/page.tsx', 'lib/data.ts']);
  const page = String(proposal.actions[0]?.input.content);
  assert.match(page, /^'use client';/);
  assert.match(page, /const label = "It's a \\"3D\\" car";/);
  assert.match(page, /<motion\.h1 animate=\{\{ opacity: 1 \}\}>/);
  assert.doesNotMatch(page, /===END===/);
  assert.equal(String(proposal.actions[1]?.input.content), "export const cars = [{ id: 'gt', name: 'GT' }];");
});

test('a reply cut off inside a block keeps the files that finished', () => {
  const reply = `{"summary":"writing pages"}

===FILE app/page.tsx===
export default function Page() { return null; }
===END===

===FILE app/about/page.tsx===
export default function About() {
  return <main>half a fi`;
  const proposal = parseProposal(reply);
  assert.equal(proposal.actions.length, 1, 'the finished file survives; the cut-off one is dropped');
  assert.equal(proposal.actions[0]?.input.path, 'app/page.tsx');
  assert.equal(proposal.repaired, true, 'and the truncation is flagged');
});

test('blocks survive even when the JSON preamble is unusable', () => {
  const reply = `Here are the files you asked for! {not json at all

===FILE README.md===
# Velocity 3D
===END===
`;
  const proposal = parseProposal(reply);
  assert.equal(proposal.unparsed, undefined, 'the files are the work — do not throw them away');
  assert.equal(proposal.actions.length, 1);
  assert.equal(proposal.actions[0]?.input.content, '# Velocity 3D');
});

test('a block wins over the same path declared in the JSON', () => {
  const reply = `{"summary":"s","actions":[{"tool":"fs.write","input":{"path":"a.ts","content":"stale"}},{"tool":"git.commit","input":{"message":"m"}}]}

===FILE a.ts===
export const fresh = 1;
===END===
`;
  const proposal = parseProposal(reply);
  assert.equal(proposal.actions.length, 2, 'the duplicate fs.write is dropped, git.commit is kept');
  assert.equal(proposal.actions[0]?.input.content, 'export const fresh = 1;');
  assert.equal(proposal.actions[1]?.tool, 'git.commit');
});

test('a JSON body containing braces is not confused by a later block', () => {
  const reply = `{"summary":"wrote config","actions":[]}

===FILE next.config.mjs===
const nextConfig = { reactStrictMode: true, images: { domains: ['a.test'] } };
export default nextConfig;
===END===
`;
  const proposal = parseProposal(reply);
  assert.equal(proposal.summary, 'wrote config');
  assert.match(String(proposal.actions[0]?.input.content), /images: \{ domains: \['a\.test'\] \}/);
});
