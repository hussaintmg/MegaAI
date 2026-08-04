import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { letterbox, loadDeepModels, nms, OnnxClassifier, OnnxDetector, type DetectedBox, type RgbImage } from './index.js';

function solid(width: number, height: number, rgb: [number, number, number]): RgbImage {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = rgb[0];
    data[i * 3 + 1] = rgb[1];
    data[i * 3 + 2] = rgb[2];
  }
  return { width, height, data };
}

function box(partial: Partial<DetectedBox> & { label: string; confidence: number }): DetectedBox {
  const x = partial.x ?? 0;
  const y = partial.y ?? 0;
  const width = partial.width ?? 10;
  const height = partial.height ?? 10;
  return {
    label: partial.label,
    confidence: partial.confidence,
    x,
    y,
    width,
    height,
    center: { x: x + width / 2, y: y + height / 2 },
  };
}

test('letterbox keeps aspect ratio, centres the image and pads the rest', () => {
  // A wide image into a square: scaled to fill the width, padded top/bottom.
  const image = solid(200, 100, [255, 0, 0]);
  const { tensor, scale, padX, padY } = letterbox(image, 100);
  assert.equal(scale, 0.5);
  assert.equal(padX, 0);
  assert.equal(padY, 25); // (100 - 50) / 2
  assert.equal(tensor.length, 3 * 100 * 100);

  const plane = 100 * 100;
  const at = (x: number, y: number, c: number) => tensor[c * plane + y * 100 + x]!;
  // Centre falls inside the image: pure red.
  assert.ok(Math.abs(at(50, 50, 0) - 1) < 1e-6, 'red channel should be 1 inside the image');
  assert.ok(at(50, 50, 1) < 1e-6, 'green channel should be 0 inside the image');
  // Top row is padding: the 114/255 grey YOLO letterboxes with.
  assert.ok(Math.abs(at(50, 2, 0) - 114 / 255) < 1e-6, 'padding should be grey');
});

test('letterbox handles a tall image and never exceeds the target size', () => {
  const { tensor, scale, padX, padY } = letterbox(solid(50, 200, [0, 0, 255]), 100);
  assert.equal(scale, 0.5);
  assert.equal(padY, 0);
  assert.equal(padX, 37); // (100 - 25) / 2
  assert.equal(tensor.length, 3 * 100 * 100);
  assert.ok(tensor.every((v) => v >= 0 && v <= 1));
});

test('nms drops overlapping boxes of the same label, keeping the most confident', () => {
  const kept = nms(
    [
      box({ label: 'button', confidence: 0.9, x: 0, y: 0, width: 100, height: 40 }),
      box({ label: 'button', confidence: 0.6, x: 4, y: 2, width: 100, height: 40 }), // ~90% overlap
      box({ label: 'button', confidence: 0.8, x: 400, y: 0, width: 100, height: 40 }), // far away
    ],
    0.45,
  );
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((b) => b.confidence), [0.9, 0.8]);
});

test('nms never suppresses across different labels', () => {
  const overlapping = [
    box({ label: 'button', confidence: 0.9, x: 0, y: 0, width: 50, height: 20 }),
    box({ label: 'link', confidence: 0.7, x: 0, y: 0, width: 50, height: 20 }),
  ];
  assert.equal(nms(overlapping, 0.45).length, 2);
});

test('loaders degrade gracefully when weights or labels are missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'megaai-onnx-'));
  try {
    // Nothing on disk at all.
    assert.deepEqual(await loadDeepModels(dir), {});
    // A labels file with no matching .onnx must not throw either.
    writeFileSync(join(dir, 'ui-detector.labels.json'), JSON.stringify({ labels: ['button'], imgSize: 640 }));
    assert.equal((await loadDeepModels(dir)).detector, undefined);
    // Direct loads of absent files are undefined, not exceptions.
    assert.equal(await OnnxDetector.load(join(dir, 'missing.onnx'), { labels: ['button'] }), undefined);
    assert.equal(await OnnxClassifier.load(join(dir, 'missing.onnx'), { labels: ['login'] }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
