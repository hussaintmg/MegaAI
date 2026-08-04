import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_AGENT_DESCRIPTORS, createBuiltinAgents } from './builtin.js';

test('vision and ml-engineer are registered as built-in agent kinds', () => {
  const kinds = BUILTIN_AGENT_DESCRIPTORS.map((d) => d.kind);
  assert.ok(kinds.includes('vision'));
  assert.ok(kinds.includes('ml-engineer'));

  const vision = BUILTIN_AGENT_DESCRIPTORS.find((d) => d.kind === 'vision');
  assert.ok(vision);
  assert.ok(vision.allowedTools.includes('fs.write'));
  assert.ok(!vision.allowedTools.includes('shell.exec'));

  const mlEngineer = BUILTIN_AGENT_DESCRIPTORS.find((d) => d.kind === 'ml-engineer');
  assert.ok(mlEngineer);
  assert.ok(mlEngineer.allowedTools.includes('fs.write'));
  assert.ok(mlEngineer.allowedTools.includes('shell.exec'));
});

test('createBuiltinAgents wraps every descriptor once, with unique kinds', () => {
  const agents = createBuiltinAgents();
  assert.equal(agents.length, BUILTIN_AGENT_DESCRIPTORS.length);
  const kinds = new Set(agents.map((a) => a.descriptor.kind));
  assert.equal(kinds.size, agents.length);
});
