#!/usr/bin/env node
/**
 * MegaAI's own vision dataset — generated, not downloaded.
 *
 * Renders synthetic pages in real headless Chromium and reads every element's
 * class and bounding box straight from the DOM, so each screenshot arrives
 * with perfect labels and zero manual annotation. One pass produces training
 * data for all three vision models:
 *
 *   - ui-detector       YOLO boxes (button/input/link/checkbox/…)   labels/*.txt
 *   - screen-classifier the page kind (login/checkout/dashboard/…)  screens.csv
 *   - defect-detector   the injected defect (overflow/overlap/…)    defects.csv
 *
 * Usage:
 *   node scripts/dataset/generate-ui-dataset.mjs --count 400 --out dataset
 *   node scripts/dataset/generate-ui-dataset.mjs --count 2000 --defect-ratio 0.4
 *
 * Then zip `dataset/` and train on Colab with the notebooks in notebooks/.
 */

import { mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { launchChromium } from '../../packages/vision/dist/launch.js';
import { buildPage, DEFECT_KINDS, KINDS_WITH_IMAGES, SCREEN_KINDS } from './templates.mjs';

/** YOLO class ids — order matters, it is baked into the label files. */
export const CLASSES = ['button', 'input', 'link', 'checkbox', 'radio', 'select', 'textarea', 'image', 'heading', 'nav'];

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded shuffle, so the balanced schedule is still deterministic. */
class Rng {
  constructor(seed) {
    this.next = mulberry32(seed);
  }
  shuffle(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }
}

function parseArgs(argv) {
  const args = { count: 300, out: 'dataset', seed: 1234, defectRatio: 0.35, valSplit: 0.2, prefix: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--count') args.count = Number(value);
    else if (key === '--out') args.out = String(value);
    else if (key === '--seed') args.seed = Number(value);
    else if (key === '--defect-ratio') args.defectRatio = Number(value);
    else if (key === '--val-split') args.valSplit = Number(value);
    // Distinguishes shards when several generators write into one dataset.
    else if (key === '--prefix') args.prefix = String(value);
  }
  return args;
}

// Runs inside the page: map every visible element to a YOLO class + box.
// Only elements actually on screen and big enough to matter are labelled.
const PAGE_LABELS = `(() => {
  const out = [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const add = (el, cls) => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return;
    // Clip to the viewport so partially-visible elements stay accurate.
    const x1 = Math.max(0, r.left), y1 = Math.max(0, r.top);
    const x2 = Math.min(vw, r.right), y2 = Math.min(vh, r.bottom);
    if (x2 - x1 < 6 || y2 - y1 < 6) return;
    out.push({ cls, x1, y1, x2, y2 });
  };
  document.querySelectorAll('button').forEach((e) => add(e, 'button'));
  document.querySelectorAll('input').forEach((e) => {
    const t = (e.getAttribute('type') || 'text').toLowerCase();
    add(e, t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : 'input');
  });
  document.querySelectorAll('a').forEach((e) => add(e, 'link'));
  document.querySelectorAll('select').forEach((e) => add(e, 'select'));
  document.querySelectorAll('textarea').forEach((e) => add(e, 'textarea'));
  document.querySelectorAll('img').forEach((e) => add(e, 'image'));
  document.querySelectorAll('h1,h2').forEach((e) => add(e, 'heading'));
  document.querySelectorAll('nav').forEach((e) => add(e, 'nav'));
  return { vw, vh, boxes: out };
})()`;

function toYolo(boxes, vw, vh) {
  const lines = [];
  for (const box of boxes) {
    const id = CLASSES.indexOf(box.cls);
    if (id === -1) continue;
    const cx = (box.x1 + box.x2) / 2 / vw;
    const cy = (box.y1 + box.y2) / 2 / vh;
    const w = (box.x2 - box.x1) / vw;
    const h = (box.y2 - box.y1) / vh;
    if (w <= 0 || h <= 0 || cx < 0 || cx > 1 || cy < 0 || cy > 1) continue;
    lines.push(`${id} ${cx.toFixed(6)} ${cy.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rng = mulberry32(args.seed);

  const browser = await launchChromium();
  if (!browser) {
    console.error(
      'No headless Chromium available. Install playwright-core + a Chromium build, ' +
        'or set MEGAAI_CHROMIUM_PATH to an existing browser.',
    );
    process.exit(2);
  }

  const root = args.out;
  rmSync(root, { recursive: true, force: true });
  for (const split of ['train', 'val']) {
    mkdirSync(join(root, 'images', split), { recursive: true });
    mkdirSync(join(root, 'labels', split), { recursive: true });
  }
  writeFileSync(join(root, 'screens.csv'), 'file,split,kind\n');
  writeFileSync(join(root, 'defects.csv'), 'file,split,defect\n');

  const page = await browser.newPage();
  const counts = { train: 0, val: 0 };
  let boxTotal = 0;

  // Build a balanced schedule up front rather than sampling per image: with
  // six defect kinds, uniform sampling leaves each one a small minority of a
  // mostly-clean set, and a classifier trained on that learns to answer
  // "clean". Here every defect kind gets an equal share of `defectRatio`.
  const defectPool = DEFECT_KINDS.filter((d) => d !== 'clean');
  const schedule = [];
  for (let i = 0; i < args.count; i++) {
    const useDefect = i < Math.round(args.count * args.defectRatio);
    const defect = useDefect ? defectPool[i % defectPool.length] : 'clean';
    // `broken-image` is only visible on a page that actually has images —
    // anywhere else the "defect" renders identically to clean, so the label
    // would be unlearnable.
    const kinds = defect === 'broken-image' ? KINDS_WITH_IMAGES : SCREEN_KINDS;
    schedule.push({ kind: kinds[Math.floor(rng() * kinds.length)], defect });
  }
  const plan = new Rng(args.seed ^ 0x5f3759df).shuffle(schedule);

  for (let i = 0; i < plan.length; i++) {
    const split = rng() < args.valSplit ? 'val' : 'train';
    const { kind, defect } = plan[i];

    const { html } = buildPage(rng, { kind, defect, forceImages: defect === 'broken-image' });
    const viewport = VIEWPORTS[Math.floor(rng() * VIEWPORTS.length)];

    await page.setViewportSize(viewport);
    await page.setContent(html, { waitUntil: 'load' });

    const { vw, vh, boxes } = await page.evaluate(PAGE_LABELS);
    // A page with nothing to find teaches the detector nothing — skip it.
    if (boxes.length === 0) continue;

    const name = `${args.prefix}${String(i).padStart(6, '0')}_${kind}_${defect}`;
    const buffer = await page.screenshot({ type: 'png' });
    writeFileSync(join(root, 'images', split, `${name}.png`), buffer);
    writeFileSync(join(root, 'labels', split, `${name}.txt`), `${toYolo(boxes, vw, vh)}\n`);
    appendFileSync(join(root, 'screens.csv'), `${name}.png,${split},${kind}\n`);
    appendFileSync(join(root, 'defects.csv'), `${name}.png,${split},${defect}\n`);

    counts[split] += 1;
    boxTotal += boxes.length;
    if ((i + 1) % 25 === 0) process.stdout.write(`  generated ${i + 1}/${args.count}\r`);
  }

  await page.close().catch(() => undefined);
  await browser.close().catch(() => undefined);

  // Ultralytics resolves a relative `path` against its own datasets_dir, not
  // against this file — so write an absolute one. Notebooks rewrite it to
  // their own root after unzipping, which keeps the dataset portable.
  const yaml = `# MegaAI UI-detector dataset (generated by scripts/dataset/generate-ui-dataset.mjs)
path: ${resolve(root)}
train: images/train
val: images/val
names:
${CLASSES.map((c, i) => `  ${i}: ${c}`).join('\n')}
`;
  writeFileSync(join(root, 'data.yaml'), yaml);

  console.log(`\nDataset written to ${root}/`);
  console.log(`  images     ${counts.train} train · ${counts.val} val`);
  console.log(`  boxes      ${boxTotal} (avg ${(boxTotal / Math.max(1, counts.train + counts.val)).toFixed(1)} per image)`);
  console.log(`  classes    ${CLASSES.length} → ${CLASSES.join(', ')}`);
  console.log(`  screens    ${SCREEN_KINDS.length} kinds → screens.csv`);
  console.log(`  defects    ${DEFECT_KINDS.length} kinds → defects.csv`);
  console.log(`\nZip it and train on Colab: see notebooks/README.md`);
}

main().catch((err) => {
  console.error('dataset generation failed:', err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
