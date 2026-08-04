import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '@megaai/vision';
import { centerOf, createDesktopTools, DesktopEngine, resolveTarget, type DesktopElement } from './index.js';

function el(partial: Partial<DesktopElement> & { purpose: string }): DesktopElement {
  return { tag: 'button', text: '', ...partial };
}

/* -------------------- pure helpers (no browser) -------------------- */

test('centerOf computes the box centre', () => {
  assert.deepEqual(centerOf({ x: 10, y: 20, width: 100, height: 40 }), { x: 60, y: 40 });
  assert.equal(centerOf(undefined), undefined);
});

test('resolveTarget points at elements by coords, selector, purpose and text', () => {
  const elements: DesktopElement[] = [
    el({ purpose: 'submit', text: 'Place order', center: { x: 50, y: 60 } }),
    el({ tag: 'a', purpose: 'navigation', text: 'Home', center: { x: 10, y: 5 } }),
    el({ tag: 'input', purpose: 'input', ariaLabel: 'full name', center: { x: 200, y: 30 } }),
  ];
  assert.deepEqual(resolveTarget(elements, { x: 5, y: 7 }), { x: 5, y: 7 });
  assert.deepEqual(resolveTarget(elements, { selector: '#go' }), { selector: '#go' });
  assert.equal(resolveTarget(elements, { purpose: 'submit' })?.x, 50);
  assert.equal(resolveTarget(elements, { text: 'home' })?.y, 5);
  assert.equal(resolveTarget(elements, { text: 'full name' })?.x, 200); // matches ariaLabel
  assert.equal(resolveTarget(elements, { purpose: 'delete' }), undefined);
  assert.equal(resolveTarget(elements, undefined), undefined);
});

test('desktop tools validate input before touching a browser', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-desktop-'));
  try {
    const [observe] = createDesktopTools(new DesktopEngine());
    assert.deepEqual(observe!.permissions, ['desktop']);
    await assert.rejects(observe!.execute({ file: '../escape.html' }, { workspaceRoot: dir }), /escapes the workspace/);
    await assert.rejects(observe!.execute({}, { workspaceRoot: dir }), /need one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------- real headless Chromium (skips otherwise) -------------------- */

const PAGE = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>t</title></head>
<body style="margin:0">
<input id="name" type="text" name="name" placeholder="full name" style="display:block;width:220px;height:32px">
<button type="submit" id="go" onclick="document.title='clicked'" style="width:160px;height:40px">Place order</button>
</body></html>`;

test('desktop engine observes elements and drives mouse/keyboard', async (t) => {
  const probe = await launchChromium();
  if (!probe) {
    t.skip('no headless browser available in this environment');
    return;
  }
  await probe.close();

  const engine = new DesktopEngine();

  const screen = await engine.observe({ html: PAGE, label: 'form' });
  assert.ok(screen.width > 0 && screen.height > 0);
  const submit = screen.elements.find((e) => e.purpose === 'submit');
  const input = screen.elements.find((e) => e.tag === 'input');
  assert.ok(submit && submit.center, 'submit button should be detected with a centre');
  assert.ok(input && input.center, 'input should be detected with a centre');

  const report = await engine.act({ html: PAGE, label: 'form' }, [
    { action: 'type', target: { selector: '#name' }, text: 'Jane' },
    { action: 'click', target: { purpose: 'submit' } },
    { action: 'wait', ms: 30 },
  ]);
  assert.equal(report.ok, true, JSON.stringify(report.steps));
  // The click resolved via the submit purpose to real coordinates.
  assert.ok(report.steps[1]!.detail?.includes('submit'));
  // The typed value is reflected on re-observation.
  assert.ok(report.observation.elements.some((e) => (e.text ?? '').includes('Jane')));
});

test('desktop tools observe a workspace file with a real browser', async (t) => {
  const probe = await launchChromium();
  if (!probe) {
    t.skip('no headless browser available in this environment');
    return;
  }
  await probe.close();

  const dir = mkdtempSync(join(tmpdir(), 'megaai-desktop-'));
  try {
    writeFileSync(join(dir, 'ui.html'), PAGE);
    const [observe, act] = createDesktopTools(new DesktopEngine());
    const screen = (await observe!.execute({ file: 'ui.html' }, { workspaceRoot: dir })) as { elements: Array<{ purpose: string }> };
    assert.ok(screen.elements.some((e) => e.purpose === 'submit'));
    const result = (await act!.execute(
      { file: 'ui.html', steps: [{ action: 'click', target: { text: 'Place order' } }] },
      { workspaceRoot: dir },
    )) as { ok: boolean };
    assert.equal(result.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
