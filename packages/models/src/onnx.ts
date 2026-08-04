/**
 * @megaai/models · onnx — running the trained deep-vision models in Node.
 *
 * The classical models in this package are pure JS. The deep ones (YOLO
 * ui-detector, screen-classifier, ui-defect-detector) are trained on a GPU and
 * exported to ONNX, then run here through `onnxruntime-node` — same weights,
 * no Python at inference.
 *
 * Both dependencies are optional and loaded dynamically: with the runtime or
 * the weights absent, callers get `undefined` and the engine keeps using its
 * existing DOM-based path. Nothing breaks when the models are not installed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MegaError } from '@megaai/types';

/* ------------------------------------------------------------------ *
 * Image decoding (PNG -> RGB) + letterbox resize
 * ------------------------------------------------------------------ */

export interface RgbImage {
  width: number;
  height: number;
  /** Row-major RGB triples, 0..255. */
  data: Uint8Array;
}

/** Decode a PNG buffer via the optional `pngjs` dependency. */
export async function decodePng(buffer: Buffer): Promise<RgbImage | undefined> {
  try {
    const moduleName = 'pngjs';
    const { PNG } = (await import(moduleName)) as { PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } };
    const png = PNG.sync.read(buffer);
    const rgb = new Uint8Array(png.width * png.height * 3);
    for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
      rgb[j] = png.data[i]!;
      rgb[j + 1] = png.data[i + 1]!;
      rgb[j + 2] = png.data[i + 2]!;
    }
    return { width: png.width, height: png.height, data: rgb };
  } catch {
    return undefined;
  }
}

export interface LetterboxResult {
  /** NCHW float tensor, values 0..1. */
  tensor: Float32Array;
  scale: number;
  padX: number;
  padY: number;
}

/**
 * Resize into a square `size`×`size` keeping aspect ratio, padding the rest
 * grey — the same letterboxing YOLO trains with, so boxes map back exactly.
 */
export function letterbox(image: RgbImage, size: number): LetterboxResult {
  const scale = Math.min(size / image.width, size / image.height);
  const newW = Math.round(image.width * scale);
  const newH = Math.round(image.height * scale);
  const padX = Math.floor((size - newW) / 2);
  const padY = Math.floor((size - newH) / 2);

  const tensor = new Float32Array(3 * size * size).fill(114 / 255);
  const plane = size * size;
  for (let y = 0; y < newH; y++) {
    // Nearest-neighbour: cheap, and detection is tolerant of it.
    const srcY = Math.min(image.height - 1, Math.floor(y / scale));
    for (let x = 0; x < newW; x++) {
      const srcX = Math.min(image.width - 1, Math.floor(x / scale));
      const src = (srcY * image.width + srcX) * 3;
      const dst = (y + padY) * size + (x + padX);
      tensor[dst] = image.data[src]! / 255;
      tensor[plane + dst] = image.data[src + 1]! / 255;
      tensor[2 * plane + dst] = image.data[src + 2]! / 255;
    }
  }
  return { tensor, scale, padX, padY };
}

/* ------------------------------------------------------------------ *
 * onnxruntime session (optional dependency)
 * ------------------------------------------------------------------ */

interface OrtTensorCtor {
  new (type: string, data: Float32Array, dims: number[]): unknown;
}
interface OrtSession {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
}
interface OrtModule {
  InferenceSession: { create(path: string): Promise<OrtSession> };
  Tensor: OrtTensorCtor;
}

let ortCache: OrtModule | undefined | null = null;

async function loadOrt(): Promise<OrtModule | undefined> {
  if (ortCache !== null) return ortCache ?? undefined;
  try {
    const moduleName = 'onnxruntime-node';
    ortCache = (await import(moduleName)) as unknown as OrtModule;
  } catch {
    ortCache = undefined;
  }
  return ortCache ?? undefined;
}

/* ------------------------------------------------------------------ *
 * Detector (YOLO)
 * ------------------------------------------------------------------ */

export interface DetectedBox {
  label: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  center: { x: number; y: number };
}

function iou(a: DetectedBox, b: DetectedBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union <= 0 ? 0 : inter / union;
}

/** Greedy non-maximum suppression, highest confidence first. */
export function nms(boxes: DetectedBox[], threshold = 0.45): DetectedBox[] {
  const sorted = boxes.slice().sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedBox[] = [];
  for (const box of sorted) {
    if (kept.some((k) => k.label === box.label && iou(k, box) > threshold)) continue;
    kept.push(box);
  }
  return kept;
}

export interface DetectorOptions {
  labels: string[];
  imgSize?: number;
  confidence?: number;
  iouThreshold?: number;
}

/** Runs a YOLO ONNX export over screenshots. */
export class OnnxDetector {
  private constructor(
    private readonly session: OrtSession,
    private readonly ort: OrtModule,
    private readonly options: Required<DetectorOptions>,
  ) {}

  get labels(): string[] {
    return this.options.labels.slice();
  }

  static async load(modelPath: string, options: DetectorOptions): Promise<OnnxDetector | undefined> {
    const ort = await loadOrt();
    if (!ort || !existsSync(modelPath)) return undefined;
    try {
      const session = await ort.InferenceSession.create(modelPath);
      return new OnnxDetector(session, ort, {
        labels: options.labels,
        imgSize: options.imgSize ?? 640,
        confidence: options.confidence ?? 0.3,
        iouThreshold: options.iouThreshold ?? 0.45,
      });
    } catch {
      return undefined;
    }
  }

  /** Detect elements in a PNG screenshot; coordinates are in image pixels. */
  async detect(png: Buffer): Promise<DetectedBox[]> {
    const image = await decodePng(png);
    if (!image) throw new MegaError('PROVIDER_UNAVAILABLE', 'pngjs is required to decode screenshots');
    const size = this.options.imgSize;
    const { tensor, scale, padX, padY } = letterbox(image, size);

    const input = new this.ort.Tensor('float32', tensor, [1, 3, size, size]);
    const feeds: Record<string, unknown> = { [this.session.inputNames[0] ?? 'images']: input };
    const output = await this.session.run(feeds);
    const first = output[this.session.outputNames[0] ?? 'output0'];
    if (!first) return [];

    // YOLOv8/11 export: [1, 4 + numClasses, numBoxes] (cx, cy, w, h, scores…).
    const dims = first.dims;
    const channels = dims[1] ?? 0;
    const count = dims[2] ?? 0;
    const numClasses = channels - 4;
    if (numClasses <= 0 || count <= 0) return [];
    const data = first.data;

    const boxes: DetectedBox[] = [];
    for (let i = 0; i < count; i++) {
      let bestScore = 0;
      let bestClass = -1;
      for (let c = 0; c < numClasses; c++) {
        const score = data[(4 + c) * count + i]!;
        if (score > bestScore) {
          bestScore = score;
          bestClass = c;
        }
      }
      if (bestClass < 0 || bestScore < this.options.confidence) continue;

      const cx = data[0 * count + i]!;
      const cy = data[1 * count + i]!;
      const w = data[2 * count + i]!;
      const h = data[3 * count + i]!;
      // Undo the letterbox to get back to original image pixels.
      const x = (cx - w / 2 - padX) / scale;
      const y = (cy - h / 2 - padY) / scale;
      const width = w / scale;
      const height = h / scale;
      boxes.push({
        label: this.options.labels[bestClass] ?? String(bestClass),
        confidence: bestScore,
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
        center: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) },
      });
    }
    return nms(boxes, this.options.iouThreshold);
  }
}

/* ------------------------------------------------------------------ *
 * Classifier (screen kind / defect kind)
 * ------------------------------------------------------------------ */

export interface ClassificationResult {
  label: string;
  confidence: number;
  scores: Record<string, number>;
}

/** Runs a classification ONNX export over screenshots. */
export class OnnxClassifier {
  private constructor(
    private readonly session: OrtSession,
    private readonly ort: OrtModule,
    readonly labels: string[],
    private readonly imgSize: number,
  ) {}

  static async load(modelPath: string, options: { labels: string[]; imgSize?: number }): Promise<OnnxClassifier | undefined> {
    const ort = await loadOrt();
    if (!ort || !existsSync(modelPath)) return undefined;
    try {
      const session = await ort.InferenceSession.create(modelPath);
      return new OnnxClassifier(session, ort, options.labels, options.imgSize ?? 224);
    } catch {
      return undefined;
    }
  }

  async classify(png: Buffer): Promise<ClassificationResult> {
    const image = await decodePng(png);
    if (!image) throw new MegaError('PROVIDER_UNAVAILABLE', 'pngjs is required to decode screenshots');
    const { tensor } = letterbox(image, this.imgSize);
    const input = new this.ort.Tensor('float32', tensor, [1, 3, this.imgSize, this.imgSize]);
    const output = await this.session.run({ [this.session.inputNames[0] ?? 'images']: input });
    const first = output[this.session.outputNames[0] ?? 'output0'];
    if (!first) return { label: '', confidence: 0, scores: {} };

    // Ultralytics classification heads already emit probabilities; softmax is
    // applied defensively so raw-logit exports behave the same.
    const raw = Array.from(first.data);
    const sum = raw.reduce((a, b) => a + b, 0);
    const probs =
      Math.abs(sum - 1) < 0.05 && raw.every((v) => v >= 0)
        ? raw
        : (() => {
            const max = Math.max(...raw);
            const exps = raw.map((v) => Math.exp(v - max));
            const total = exps.reduce((a, b) => a + b, 0) || 1;
            return exps.map((v) => v / total);
          })();

    const scores: Record<string, number> = {};
    let best = 0;
    for (let i = 0; i < probs.length && i < this.labels.length; i++) {
      scores[this.labels[i]!] = probs[i]!;
      if (probs[i]! > probs[best]!) best = i;
    }
    return { label: this.labels[best] ?? '', confidence: probs[best] ?? 0, scores };
  }
}

/* ------------------------------------------------------------------ *
 * Loading a trained pack from disk
 * ------------------------------------------------------------------ */

export interface DeepModels {
  detector?: OnnxDetector;
  screenClassifier?: OnnxClassifier;
  defectDetector?: OnnxClassifier;
}

interface LabelsFile {
  labels: string[];
  imgSize?: number;
}

function readLabels(dir: string, name: string): LabelsFile | undefined {
  const path = join(dir, `${name}.labels.json`);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as LabelsFile;
    return Array.isArray(parsed.labels) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Load whichever deep models are present in `dir` (typically
 * `.megaai/models/`). Everything is optional — a missing model, a missing
 * labels file or a missing onnxruntime simply yields `undefined` for it.
 */
export async function loadDeepModels(dir: string): Promise<DeepModels> {
  const out: DeepModels = {};

  const detectorLabels = readLabels(dir, 'ui-detector');
  if (detectorLabels) {
    out.detector = await OnnxDetector.load(join(dir, 'ui-detector.onnx'), {
      labels: detectorLabels.labels,
      imgSize: detectorLabels.imgSize ?? 640,
    });
  }
  const screenLabels = readLabels(dir, 'screen-classifier');
  if (screenLabels) {
    out.screenClassifier = await OnnxClassifier.load(join(dir, 'screen-classifier.onnx'), {
      labels: screenLabels.labels,
      imgSize: screenLabels.imgSize ?? 224,
    });
  }
  const defectLabels = readLabels(dir, 'ui-defect-detector');
  if (defectLabels) {
    out.defectDetector = await OnnxClassifier.load(join(dir, 'ui-defect-detector.onnx'), {
      labels: defectLabels.labels,
      imgSize: defectLabels.imgSize ?? 224,
    });
  }
  return out;
}
