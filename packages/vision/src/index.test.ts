import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserTestDriver,
  classifyPurposeHeuristic,
  createVisionTools,
  StaticTestDriver,
  VisionTester,
} from './index.js';
import { launchChromium } from './launch.js';

const GOOD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Shop</title></head>
<body><main><h1>Shop</h1><button type="submit">Checkout</button><a href="/cart">Cart</a></main></body></html>`;

const BAD_HTML = `<html><body><h1>No viewport, no lang, no title</h1>
<img src="x.png"><button></button><input type="text"></body></html>`;

test('heuristic classifier labels common controls', () => {
  assert.equal(classifyPurposeHeuristic({ tag: 'button', text: 'Checkout now' }), 'submit');
  assert.equal(classifyPurposeHeuristic({ tag: 'button', text: 'Cancel' }), 'cancel');
  assert.equal(classifyPurposeHeuristic({ tag: 'button', text: 'Delete item' }), 'delete');
  assert.equal(classifyPurposeHeuristic({ tag: 'a', text: 'Home', href: '/' }), 'navigation');
  assert.equal(classifyPurposeHeuristic({ tag: 'a', text: 'Docs', href: 'https://x/y' }), 'link');
  assert.equal(classifyPurposeHeuristic({ tag: 'input', type: 'search', text: '' }), 'search');
  assert.equal(classifyPurposeHeuristic({ tag: 'input', type: 'password', text: '' }), 'password-input');
});

test('static driver passes a clean page and flags a bad one', () => {
  const driver = new StaticTestDriver();

  const good = driver.audit({ html: GOOD_HTML, label: 'good' });
  assert.equal(good.driver, 'static');
  assert.equal(good.passed, true);
  assert.ok(good.score >= 90);
  assert.equal(good.elements.length, 2); // one button + one link
  assert.ok(good.elements.some((e) => e.purpose === 'submit'));

  const bad = driver.audit({ html: BAD_HTML, label: 'bad' });
  assert.equal(bad.passed, false);
  const rules = bad.accessibility.map((i) => i.rule);
  assert.ok(rules.includes('viewport'));
  assert.ok(rules.includes('lang'));
  assert.ok(rules.includes('title'));
  assert.ok(rules.includes('img-alt'));
  assert.ok(rules.includes('label'));
});

test('vision.audit tool reads a workspace file and audits it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-vision-'));
  try {
    writeFileSync(join(dir, 'index.html'), GOOD_HTML);
    const [audit] = createVisionTools(new VisionTester({ preferBrowser: false }));
    assert.deepEqual(audit!.permissions, ['vision']);
    const report = (await audit!.execute({ file: 'index.html' }, { workspaceRoot: dir })) as {
      passed: boolean;
      elements: unknown[];
    };
    assert.equal(report.passed, true);
    assert.ok(report.elements.length >= 2);
    await assert.rejects(audit!.execute({ file: '../escape.html' }, { workspaceRoot: dir }), /escapes the workspace/);
    await assert.rejects(audit!.execute({}, { workspaceRoot: dir }), /need one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tester without a browser returns a static report', async () => {
  const tester = new VisionTester({ preferBrowser: false });
  const report = await tester.audit({ html: GOOD_HTML });
  assert.equal(report.driver, 'static');
  assert.equal(report.passed, true);
});

// Real headless Chromium — runs where a browser is available, skips otherwise.
test('real browser driver catches console errors and horizontal overflow', async (t) => {
  const probe = await launchChromium();
  if (!probe) {
    t.skip('no headless browser available in this environment');
    return;
  }
  await probe.close();

  const driver = new BrowserTestDriver();
  const report = await driver.audit({
    html: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width">
      <title>T</title></head><body><div style="width:2000px">wide</div>
      <button>Go</button><script>console.error("runtime boom")</script></body></html>`,
    label: 'runtime',
  });
  assert.equal(report.driver, 'browser');
  assert.ok(report.console.errors.some((e) => e.includes('runtime boom')), 'should capture the console error');
  assert.ok(report.responsive.some((r) => r.viewport === 'mobile' && r.overflow), 'should detect mobile overflow');
  assert.ok(report.elements.some((e) => e.tag === 'button'));
  assert.equal(report.passed, false);
});
