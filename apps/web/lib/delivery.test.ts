import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_FILE_TEXT,
  MAX_IMAGE_CHARS,
  MAX_IMAGE_TOTAL_CHARS,
  MAX_TOTAL_TEXT,
  sanitizeDeployment,
  sanitizeGoalFiles,
  sanitizeProviderTallies,
} from './delivery.ts';
import { buildPreview, resolveRelative } from './preview.ts';
import { createZip } from './zip.ts';

test('delivered files survive the round trip with their contents', () => {
  const files = sanitizeGoalFiles([
    { path: 'public/index.html', bytes: 11, text: '<h1>hi</h1>' },
    { path: 'assets/logo.png', bytes: 4096, binary: true },
  ]);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0], { path: 'public/index.html', bytes: 11, text: '<h1>hi</h1>' });
  assert.deepEqual(files[1], { path: 'assets/logo.png', bytes: 4096, binary: true });
});

test('sanitizeGoalFiles rejects junk and neutralises climbing paths', () => {
  assert.deepEqual(sanitizeGoalFiles(undefined), []);
  assert.deepEqual(sanitizeGoalFiles('nope'), []);
  assert.deepEqual(sanitizeGoalFiles([null, 42, { bytes: 1 }, { path: '' }]), []);
  const [file] = sanitizeGoalFiles([{ path: '..\\..\\etc\\passwd', bytes: 'x', text: 'root' }]);
  assert.equal(file?.path, '__/__/etc/passwd');
  assert.equal(file?.bytes, 0, 'a non-numeric size becomes 0 rather than NaN');
});

test('a single huge file is truncated, and the total budget is respected', () => {
  const [big] = sanitizeGoalFiles([{ path: 'a.txt', bytes: 999_999, text: 'x'.repeat(MAX_FILE_TEXT + 500) }]);
  assert.equal(big?.text?.length, MAX_FILE_TEXT);
  assert.equal(big?.truncated, true);

  // Twenty 128 KB files exceed the 1.2 MB budget; later ones lose their text
  // but must still be listed, so the file browser shows the whole delivery.
  const many = sanitizeGoalFiles(
    Array.from({ length: 20 }, (_, i) => ({ path: `f${i}.txt`, bytes: MAX_FILE_TEXT, text: 'y'.repeat(MAX_FILE_TEXT) })),
  );
  assert.equal(many.length, 20);
  const stored = many.reduce((sum, f) => sum + (f.text?.length ?? 0), 0);
  assert.ok(stored <= MAX_TOTAL_TEXT, `stored ${stored} must stay within ${MAX_TOTAL_TEXT}`);
  assert.equal(many.at(-1)?.text, undefined);
  assert.equal(many.at(-1)?.truncated, true, 'a file dropped for budget is marked, not silently empty');
});

test('provider tallies are cleaned but keep who answered', () => {
  assert.deepEqual(sanitizeProviderTallies([{ kind: 'gemini', requests: 7 }, { kind: '', requests: 1 }, 'x']), [
    { kind: 'gemini', requests: 7 },
  ]);
  assert.deepEqual(sanitizeProviderTallies([{ kind: 'mock', requests: '3' }]), [{ kind: 'mock', requests: 3 }]);
});

test('preview inlines the delivery\'s own stylesheet and script', () => {
  const files = [
    {
      path: 'public/index.html',
      bytes: 0,
      text: '<link rel="stylesheet" href="styles.css"><script src="../src/app.js"></script>',
    },
    { path: 'public/styles.css', bytes: 0, text: 'body { color: red }' },
    { path: 'src/app.js', bytes: 0, text: 'console.log(1)' },
  ];
  const html = buildPreview(files[0]!, files);
  assert.match(html, /<style>\s*body \{ color: red \}\s*<\/style>/);
  assert.match(html, /<script>\s*console\.log\(1\)\s*<\/script>/);
  assert.doesNotMatch(html, /href="styles\.css"/);
});

test('preview leaves alone what it cannot resolve, and does not corrupt content', () => {
  const files = [
    {
      path: 'index.html',
      bytes: 0,
      text:
        '<link rel="stylesheet" href="https://cdn.test/x.css">' +
        '<link rel="icon" href="fav.css">' +
        '<link rel="stylesheet" href="theme.css">' +
        '<script src="missing.js"></script>',
    },
    // `$&` is a replacement pattern; a string replacer would paste the match.
    { path: 'theme.css', bytes: 0, text: 'a::after { content: "$& $1 $\'" }' },
    { path: 'fav.css', bytes: 0, text: 'NOT-A-STYLESHEET' },
  ];
  const html = buildPreview(files[0]!, files);
  assert.match(html, /href="https:\/\/cdn\.test\/x\.css"/, 'external CDN links stay as-is');
  assert.match(html, /rel="icon" href="fav\.css"/, 'only rel=stylesheet is inlined');
  assert.match(html, /content: "\$& \$1 \$'"/, 'the CSS is inlined verbatim');
  assert.match(html, /<script src="missing\.js"><\/script>/, 'an unresolvable script is untouched');
});

test('a script that contains its own closing tag cannot break out of the block', () => {
  const files = [
    { path: 'i.html', bytes: 0, text: '<script src="a.js"></script>' },
    { path: 'a.js', bytes: 0, text: 'const s = "</script><img onerror=alert(1)>";' },
  ];
  const html = buildPreview(files[0]!, files);
  assert.doesNotMatch(html, /<\/script><img/);
  assert.match(html, /<\\\/script>/);
});

test('resolveRelative walks the delivery, not the machine', () => {
  assert.equal(resolveRelative('public/index.html', 'styles.css'), 'public/styles.css');
  assert.equal(resolveRelative('public/index.html', './a/b.css'), 'public/a/b.css');
  assert.equal(resolveRelative('a/b/c.html', '../../x.css'), 'x.css');
  assert.equal(resolveRelative('public/index.html', '/root.css'), 'root.css');
  assert.equal(resolveRelative('i.html', 'https://x.test/a.css'), '');
  assert.equal(resolveRelative('i.html', '//x.test/a.css'), '');
  assert.equal(resolveRelative('i.html', 'data:text/css,a'), '');
  assert.equal(resolveRelative('public/i.html', 'a.css?v=2#x'), 'public/a.css');
});

test('the download zip is a real archive that unzip accepts', () => {
  const zip = createZip(
    [
      { path: 'public/index.html', content: '<h1>car</h1>'.repeat(80) },
      { path: 'src/app.js', content: 'console.log("drive")' },
      { path: 'tiny.txt', content: 'a' },
    ],
    new Date('2026-08-05T09:41:00Z'),
  );
  const dir = mkdtempSync(join(tmpdir(), 'megaai-zip-'));
  const file = join(dir, 'd.zip');
  writeFileSync(file, zip);
  // `unzip -t` verifies every CRC and the central directory, which is the
  // whole point: a hand-rolled writer that "looks" right still corrupts files.
  execFileSync('unzip', ['-tqq', file]);
  execFileSync('unzip', ['-qq', file, '-d', join(dir, 'out')]);
  assert.equal(readFileSync(join(dir, 'out/src/app.js'), 'utf8'), 'console.log("drive")');
  assert.equal(readFileSync(join(dir, 'out/public/index.html'), 'utf8'), '<h1>car</h1>'.repeat(80));
  assert.equal(readFileSync(join(dir, 'out/tiny.txt'), 'utf8'), 'a', 'incompressible input is stored, not mangled');
});

test('a screenshot of the running app survives, and only as a PNG data URL', () => {
  const png = `data:image/png;base64,${'A'.repeat(200)}`;
  const files = sanitizeGoalFiles([
    { path: '.megaai/preview/home.png', bytes: 150, image: png },
    // Anything else claiming to be an image is not rendered into the page.
    { path: 'evil.svg', bytes: 10, image: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
    { path: 'remote.png', bytes: 10, image: 'https://attacker.test/x.png' },
    { path: 'js.png', bytes: 10, image: 'javascript:alert(1)' },
  ]);
  assert.equal(files[0]?.image, png);
  for (const rejected of files.slice(1)) {
    assert.equal(rejected.image, undefined, `${rejected.path} must not be rendered`);
    assert.equal(rejected.binary, true, `${rejected.path} falls back to "binary"`);
  }
});

test('screenshots have their own budget and cannot swallow the document', () => {
  const big = `data:image/png;base64,${'A'.repeat(MAX_IMAGE_CHARS + 10)}`;
  const [oversized] = sanitizeGoalFiles([{ path: 'huge.png', bytes: 1, image: big }]);
  assert.equal(oversized?.image, undefined, 'a single oversized image is dropped');

  const one = `data:image/png;base64,${'A'.repeat(600 * 1024)}`;
  const many = sanitizeGoalFiles(
    Array.from({ length: 10 }, (_, i) => ({ path: `s${i}.png`, bytes: 1, image: one })),
  );
  const stored = many.reduce((sum, f) => sum + (f.image?.length ?? 0), 0);
  assert.ok(stored <= MAX_IMAGE_TOTAL_CHARS, `stored ${stored} exceeds ${MAX_IMAGE_TOTAL_CHARS}`);
  assert.ok(many.some((f) => f.image), 'the first few still make it through');
  assert.equal(many.length, 10, 'and every screenshot is still listed');
});

test('a deployment link is only ever an https URL', () => {
  // This becomes an anchor in the dashboard, and the value arrives from the
  // runner — so a javascript: or data: URL must never survive.
  assert.equal(sanitizeDeployment({ url: 'javascript:alert(1)', simulated: false }), undefined);
  assert.equal(sanitizeDeployment({ url: 'http://insecure.test', simulated: false }), undefined);
  assert.equal(sanitizeDeployment({ url: 'data:text/html,<h1>x', simulated: false }), undefined);
  assert.equal(sanitizeDeployment({ url: 'https://ok.test/a b', simulated: false }), undefined);
  assert.equal(sanitizeDeployment(undefined), undefined);
  assert.equal(sanitizeDeployment({ simulated: false }), undefined);

  const ok = sanitizeDeployment({
    url: 'https://car-site-abc.vercel.app',
    target: 'vercel',
    simulated: false,
    inspectorUrl: 'https://vercel.com/x/dpl_1',
  });
  assert.deepEqual(ok, {
    url: 'https://car-site-abc.vercel.app',
    target: 'vercel',
    simulated: false,
    inspectorUrl: 'https://vercel.com/x/dpl_1',
  });
});

test('a simulated deployment is marked as such, so its URL is not offered as a link', () => {
  const simulated = sanitizeDeployment({ url: 'https://shop.example.com', target: 'simulated' });
  assert.equal(simulated?.simulated, true, 'absent means simulated — never assume a deploy was real');
  // A bad inspector URL is dropped without taking the deployment with it.
  const partial = sanitizeDeployment({ url: 'https://a.test', simulated: false, inspectorUrl: 'javascript:x' });
  assert.equal(partial?.url, 'https://a.test');
  assert.equal(partial?.inspectorUrl, undefined);
});
