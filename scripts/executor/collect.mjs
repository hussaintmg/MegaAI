/**
 * Turning a finished workspace into a delivery the dashboard can show.
 *
 * Kept separate from run-goal.mjs so it can be tested without a platform, a
 * runner or a goal — this is the code that decides what the person who asked
 * for the thing actually gets to see.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Deliveries now really install and build, so the workspace holds a
// node_modules and a framework build directory. Those are not the delivery —
// and left in, they would fill the entry budget before the first source file.
// Skipped by name at any depth.
export const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.cache',
  '.vercel',
  'dist',
  'build',
  'out',
  'coverage',
]);

export const MAX_FILES = 300;
export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_TOTAL_BYTES = 1_200 * 1024;
export const MAX_IMAGE_BYTES = 500 * 1024;
export const MAX_IMAGE_TOTAL = 2_000 * 1024;

export function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir).sort()) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, base, out);
    else out.push(relative(base, full));
    if (out.length >= MAX_FILES) return out;
  }
  return base === dir ? out.sort() : out;
}

function isProbablyText(buffer) {
  // A NUL in the first few KB means binary in every text format we emit.
  return !buffer.subarray(0, 4096).includes(0);
}

/** A screenshot app.preview took of the running app, small enough to inline. */
export function isPreviewShot(path, bytes) {
  return path.startsWith('.megaai/preview/') && path.endsWith('.png') && bytes <= MAX_IMAGE_BYTES;
}

/** Read the delivered files back, within the caps, ready to post. */
export function collectContents(root, paths) {
  const sized = [];
  for (const path of paths) {
    try {
      sized.push({ path, bytes: statSync(join(root, path)).size });
    } catch {
      // Vanished between the walk and now — nothing to send.
    }
  }
  // Smallest first, so a cap spends its budget on the most files rather than
  // on one big one. Source files are small; a stray asset should not crowd out
  // the page the user is actually looking for.
  sized.sort((a, b) => a.bytes - b.bytes);

  const contents = [];
  const sent = new Set();

  // Screenshots get their own budget, taken before the text pass. They are the
  // proof the app runs, so a workspace full of source must not crowd them out.
  let imageTotal = 0;
  for (const { path, bytes } of sized) {
    if (!isPreviewShot(path, bytes) || imageTotal >= MAX_IMAGE_TOTAL) continue;
    try {
      const buffer = readFileSync(join(root, path));
      contents.push({ path, bytes, image: `data:image/png;base64,${buffer.toString('base64')}` });
      imageTotal += Math.ceil((bytes * 4) / 3);
      sent.add(path);
    } catch {
      // Vanished — nothing to send.
    }
  }

  let total = 0;
  for (const { path, bytes } of sized) {
    if (total >= MAX_TOTAL_BYTES) break;
    if (sent.has(path)) continue;
    let buffer;
    try {
      buffer = readFileSync(join(root, path));
    } catch {
      continue;
    }
    if (!isProbablyText(buffer)) {
      contents.push({ path, bytes, binary: true });
      continue;
    }
    const room = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
    const truncated = buffer.length > room;
    const text = buffer.subarray(0, room).toString('utf8');
    total += Buffer.byteLength(text, 'utf8');
    contents.push({ path, bytes, text, ...(truncated ? { truncated: true } : {}) });
  }

  contents.sort((a, b) => a.path.localeCompare(b.path));
  return contents;
}
