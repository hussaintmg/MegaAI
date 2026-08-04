import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accuracy,
  classificationReport,
  createModelTools,
  LeadScoringModel,
  loadRegistry,
  LogisticRegression,
  ModelRegistry,
  MultinomialNB,
  mulberry32,
  Rng,
  saveRegistry,
  Standardizer,
  TriageModel,
  trainAllModels,
  trainTestSplit,
  UiPurposeModel,
  Vectorizer,
} from './index.js';

/* -------------------- core primitives -------------------- */

test('mulberry32 is deterministic for a seed and varies across seeds', () => {
  const a = mulberry32(123);
  const b = mulberry32(123);
  const c = mulberry32(124);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notDeepEqual(seqA, [c(), c(), c()]);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
});

test('Rng helpers stay within range and shuffle deterministically', () => {
  const r1 = new Rng(5);
  const r2 = new Rng(5);
  assert.deepEqual(r1.shuffle([1, 2, 3, 4, 5]), r2.shuffle([1, 2, 3, 4, 5]));
  for (let i = 0; i < 100; i++) {
    const n = new Rng(i).int(3, 7);
    assert.ok(n >= 3 && n < 7);
  }
});

test('Vectorizer fits a vocabulary and counts tokens', () => {
  const vec = new Vectorizer().fit(['buy now', 'buy buy cart', 'checkout cart'], { minCount: 1 });
  assert.ok(vec.size >= 3);
  const v = vec.transform('buy buy unknownword');
  assert.equal(v.reduce((a, b) => a + b, 0), 2); // two "buy", the OOV word ignored
  assert.equal(vec.known('totally different'), 0);
});

test('LogisticRegression learns a linearly separable problem', () => {
  // class "a": high first feature; class "b": high second feature.
  const X: number[][] = [];
  const y: string[] = [];
  const rng = new Rng(1);
  for (let i = 0; i < 60; i++) {
    X.push([1 + rng.gaussian(0, 0.1), 0 + rng.gaussian(0, 0.1)]);
    y.push('a');
    X.push([0 + rng.gaussian(0, 0.1), 1 + rng.gaussian(0, 0.1)]);
    y.push('b');
  }
  const model = new LogisticRegression().fit(X, y, { epochs: 300, learningRate: 0.5 });
  assert.equal(model.predict([1, 0]), 'a');
  assert.equal(model.predict([0, 1]), 'b');
  const proba = model.predictProba([1, 0]);
  assert.ok(proba.a! > proba.b!);
  assert.ok(Math.abs(proba.a! + proba.b! - 1) < 1e-6);
});

test('MultinomialNB classifies bag-of-words documents', () => {
  const vec = new Vectorizer().fit(['spam win money', 'win money now', 'meeting schedule tomorrow', 'project schedule meeting'], { minCount: 1 });
  const X = ['spam win money', 'win money now', 'meeting schedule tomorrow', 'project schedule meeting'].map((t) => vec.transform(t));
  const nb = new MultinomialNB().fit(X, ['spam', 'spam', 'ham', 'ham']);
  assert.equal(nb.predict(vec.transform('win money')), 'spam');
  assert.equal(nb.predict(vec.transform('schedule meeting')), 'ham');
});

test('Standardizer centers and scales; split + accuracy behave', () => {
  const scaler = new Standardizer().fit([[0, 10], [2, 20], [4, 30]]);
  const z = scaler.transform([2, 20]);
  assert.ok(Math.abs(z[0]!) < 1e-9 && Math.abs(z[1]!) < 1e-9); // the mean row maps to ~0
  const { train, test } = trainTestSplit([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.3, new Rng(2));
  assert.equal(train.length + test.length, 10);
  assert.equal(test.length, 3);
  assert.equal(accuracy(['a', 'b', 'c'], ['a', 'x', 'c']), 2 / 3);
  assert.equal(classificationReport(['a', 'a'], ['a', 'b']).perClass.length, 2);
});

/* -------------------- concrete models (trained once) -------------------- */

// Train small-but-real models a single time and reuse across assertions.
const trained = trainAllModels({ uiPerLabel: 45, leadSamples: 700, triagePerLabel: 60 });

test('UI-purpose model learns element purposes with high accuracy', () => {
  const report = trained.reports['ui-purpose'];
  assert.ok(report.accuracy >= 0.85, `ui accuracy ${report.accuracy.toFixed(3)} should be >= 0.85`);
  const ui = trained.registry.ui()!;
  assert.equal(ui.classify({ tag: 'button', text: 'Checkout' }), 'submit');
  assert.equal(ui.classify({ tag: 'a', text: 'Home', href: '/' }), 'navigation');
  assert.equal(ui.classify({ tag: 'input', type: 'password' }), 'password-input');
  assert.equal(ui.classify({ tag: 'input', type: 'email', ariaLabel: 'email address' }), 'email-input');
  // A fully out-of-vocabulary element (unknown tag + gibberish) degrades to a
  // sensible default rather than throwing.
  assert.equal(ui.classify({ tag: 'xyz', text: 'zzzzz qqqqq' }), 'action');
});

test('UI-purpose model exposes a bound classifier for @megaai/vision', () => {
  const classify = trained.registry.ui()!.asClassifier();
  assert.equal(classify({ tag: 'button', text: 'Delete item' }), 'delete');
  assert.equal(classify({ tag: 'input', type: 'search', ariaLabel: 'search products' }), 'search');
});

test('lead-scoring model separates strong from weak leads', () => {
  const report = trained.reports['lead-scoring'];
  assert.ok(report.accuracy >= 0.7, `lead accuracy ${report.accuracy.toFixed(3)} should be >= 0.70`);
  const model = trained.registry.get('lead-scoring')!;
  const hot = model.predictInput({ budget: 1, companySize: 1, engagement: 1, responsiveness: 1, decisionMaker: 1, industryFit: 1 });
  const cold = model.predictInput({ budget: 0, companySize: 0, engagement: 0, responsiveness: 0, decisionMaker: 0, industryFit: 0 });
  assert.equal(hot.label, 'hot');
  assert.equal(cold.label, 'cold');
  assert.ok(hot.confidence > 0.5);
  assert.ok(LeadScoringModel.features.includes('budget'));
});

test('error-triage model routes messages to categories', () => {
  const report = trained.reports['error-triage'];
  assert.ok(report.accuracy >= 0.85, `triage accuracy ${report.accuracy.toFixed(3)} should be >= 0.85`);
  const model = trained.registry.get('error-triage') as TriageModel;
  assert.equal(model.classifyText('connection refused at server'), 'network');
  assert.equal(model.classifyText('invalid api key'), 'auth');
  assert.equal(model.classifyText('permission denied'), 'permission');
  assert.equal(model.classifyText('cannot find module ./src/index.js'), 'build');
  assert.equal(model.predictInput({ message: 'rate limit exceeded' }).label, 'ratelimit');
});

/* -------------------- registry: persistence + tools -------------------- */

test('registry round-trips through disk and reproduces predictions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-models-'));
  try {
    saveRegistry(dir, trained.registry);
    const loaded = loadRegistry(dir);
    assert.ok(loaded, 'registry should load back from disk');
    assert.deepEqual(loaded!.list().sort(), ['error-triage', 'lead-scoring', 'ui-purpose']);
    // A reloaded model predicts identically to the in-memory one.
    const before = trained.registry.predict('ui-purpose', { tag: 'button', text: 'Sign in' });
    const after = loaded!.predict('ui-purpose', { tag: 'button', text: 'Sign in' });
    assert.equal(before.label, after.label);
    assert.equal(loaded!.get('error-triage')!.predictInput({ message: 'deadlock detected' }).label, 'database');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('model tools predict and list over the registry', async () => {
  const [predict, list] = createModelTools(trained.registry);
  assert.deepEqual(predict!.permissions, ['model']);
  const out = (await predict!.execute({ model: 'ui-purpose', input: { tag: 'a', text: 'Contact' } }, { workspaceRoot: '/tmp' })) as {
    model: string;
    label: string;
  };
  assert.equal(out.model, 'ui-purpose');
  assert.equal(out.label, 'navigation');
  const listed = (await list!.execute({}, { workspaceRoot: '/tmp' })) as { models: Array<{ name: string }> };
  assert.equal(listed.models.length, 3);
  await assert.rejects(predict!.execute({ model: 'nope', input: {} }, { workspaceRoot: '/tmp' }), /No trained model/);
  await assert.rejects(predict!.execute({ input: {} }, { workspaceRoot: '/tmp' }), /needs a "model" name/);
});

test('empty registry predict reports available models', () => {
  const empty = new ModelRegistry();
  assert.throws(() => empty.predict('ui-purpose', {}), /No trained model/);
  assert.equal(empty.list().length, 0);
});
