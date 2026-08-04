/**
 * @megaai/models · core — the classical-ML primitives everything else trains
 * on. Real learning, no dependencies, fully deterministic:
 *
 *   - `mulberry32` / `Rng` — a seeded PRNG so every dataset and every training
 *     run reproduces bit-for-bit (offline, no `Math.random`).
 *   - `tokenize` / `Vectorizer` — text → bag-of-words count vectors.
 *   - `Standardizer` — zero-mean/unit-variance feature scaling.
 *   - `LogisticRegression` — softmax multiclass classifier trained by
 *     full-batch gradient descent (deterministic zero init).
 *   - `MultinomialNB` — multinomial naive Bayes text classifier.
 *   - split / accuracy / report helpers for honest evaluation.
 *
 * These are the same algorithms a scikit-learn user would reach for, written
 * small enough to run and train inside this environment with no GPU.
 */

import { MegaError } from '@megaai/types';

/* ------------------------------------------------------------------ *
 * Seeded randomness (deterministic datasets + training)
 * ------------------------------------------------------------------ */

/** Mulberry32: a tiny, fast, well-distributed seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ergonomic wrapper over a seeded stream: ints, picks, shuffles, gaussians. */
export class Rng {
  private readonly next01: () => number;

  constructor(seed = 0x9e3779b9) {
    this.next01 = mulberry32(seed);
  }

  next(): number {
    return this.next01();
  }

  /** Integer in [minInclusive, maxExclusive). */
  int(minInclusive: number, maxExclusive: number): number {
    return minInclusive + Math.floor(this.next01() * (maxExclusive - minInclusive));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new MegaError('INVALID_INPUT', 'Rng.pick needs a non-empty list');
    return items[this.int(0, items.length)]!;
  }

  bool(pTrue = 0.5): boolean {
    return this.next01() < pTrue;
  }

  /** Standard normal via Box–Muller, then scaled. */
  gaussian(mean = 0, std = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next01();
    while (v === 0) v = this.next01();
    return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Fisher–Yates on a copy (does not mutate the input). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i + 1);
      const tmp = out[i]!;
      out[i] = out[j]!;
      out[j] = tmp;
    }
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * Datasets + evaluation
 * ------------------------------------------------------------------ */

/** A numeric feature vector paired with its class label. */
export interface Sample {
  x: number[];
  label: string;
}

export interface SplitResult<T> {
  train: T[];
  test: T[];
}

/** Shuffle then carve off `testFraction` for held-out evaluation. */
export function trainTestSplit<T>(items: readonly T[], testFraction: number, rng: Rng): SplitResult<T> {
  const shuffled = rng.shuffle(items);
  const testSize = Math.min(shuffled.length, Math.max(0, Math.round(shuffled.length * testFraction)));
  return { test: shuffled.slice(0, testSize), train: shuffled.slice(testSize) };
}

export function accuracy(predicted: readonly string[], actual: readonly string[]): number {
  const n = Math.min(predicted.length, actual.length);
  if (n === 0) return 0;
  let correct = 0;
  for (let i = 0; i < n; i++) if (predicted[i] === actual[i]) correct += 1;
  return correct / n;
}

export interface ClassMetric {
  label: string;
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

export interface ClassificationReport {
  accuracy: number;
  macroF1: number;
  perClass: ClassMetric[];
}

/** Accuracy + per-class precision/recall/F1 + macro-F1. */
export function classificationReport(predicted: readonly string[], actual: readonly string[]): ClassificationReport {
  const labels = [...new Set([...predicted, ...actual])].sort();
  const tp = new Map<string, number>();
  const fp = new Map<string, number>();
  const fn = new Map<string, number>();
  const support = new Map<string, number>();
  for (const l of labels) {
    tp.set(l, 0);
    fp.set(l, 0);
    fn.set(l, 0);
    support.set(l, 0);
  }
  const n = Math.min(predicted.length, actual.length);
  for (let i = 0; i < n; i++) {
    const p = predicted[i]!;
    const a = actual[i]!;
    support.set(a, (support.get(a) ?? 0) + 1);
    if (p === a) tp.set(a, (tp.get(a) ?? 0) + 1);
    else {
      fp.set(p, (fp.get(p) ?? 0) + 1);
      fn.set(a, (fn.get(a) ?? 0) + 1);
    }
  }
  const perClass: ClassMetric[] = labels.map((label) => {
    const t = tp.get(label) ?? 0;
    const precision = t + (fp.get(label) ?? 0) === 0 ? 0 : t / (t + (fp.get(label) ?? 0));
    const recall = t + (fn.get(label) ?? 0) === 0 ? 0 : t / (t + (fn.get(label) ?? 0));
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { label, precision, recall, f1, support: support.get(label) ?? 0 };
  });
  const macroF1 = perClass.length === 0 ? 0 : perClass.reduce((s, m) => s + m.f1, 0) / perClass.length;
  return { accuracy: accuracy(predicted, actual), macroF1, perClass };
}

/* ------------------------------------------------------------------ *
 * Text vectorization
 * ------------------------------------------------------------------ */

/** Lowercase alphanumeric word tokens. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export interface VectorizerJSON {
  vocab: Record<string, number>;
}

/** Fits a vocabulary over a corpus and maps text → bag-of-words counts. */
export class Vectorizer {
  private vocab = new Map<string, number>();

  get size(): number {
    return this.vocab.size;
  }

  /** Build the vocabulary; ordering is deterministic (count desc, token asc). */
  fit(texts: readonly string[], options: { minCount?: number; maxFeatures?: number } = {}): this {
    const minCount = options.minCount ?? 1;
    const docFreq = new Map<string, number>();
    for (const text of texts) {
      for (const tok of new Set(tokenize(text))) docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
    }
    let entries = [...docFreq.entries()].filter(([, c]) => c >= minCount);
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    if (options.maxFeatures && entries.length > options.maxFeatures) entries = entries.slice(0, options.maxFeatures);
    this.vocab = new Map(entries.map(([tok], i) => [tok, i]));
    return this;
  }

  transform(text: string): number[] {
    const vec = new Array<number>(this.vocab.size).fill(0);
    for (const tok of tokenize(text)) {
      const idx = this.vocab.get(tok);
      if (idx !== undefined) vec[idx] = (vec[idx] ?? 0) + 1;
    }
    return vec;
  }

  transformAll(texts: readonly string[]): number[][] {
    return texts.map((t) => this.transform(t));
  }

  /** How many known tokens the text contains (0 = fully out-of-vocabulary). */
  known(text: string): number {
    let n = 0;
    for (const tok of tokenize(text)) if (this.vocab.has(tok)) n += 1;
    return n;
  }

  toJSON(): VectorizerJSON {
    return { vocab: Object.fromEntries(this.vocab) };
  }

  static fromJSON(json: VectorizerJSON): Vectorizer {
    const v = new Vectorizer();
    v.vocab = new Map(Object.entries(json.vocab));
    return v;
  }
}

/* ------------------------------------------------------------------ *
 * Feature standardization
 * ------------------------------------------------------------------ */

export interface StandardizerJSON {
  mean: number[];
  std: number[];
}

/** Zero-mean/unit-variance scaling so gradient descent converges cleanly. */
export class Standardizer {
  private mean: number[] = [];
  private std: number[] = [];

  fit(X: readonly number[][]): this {
    if (X.length === 0) throw new MegaError('INVALID_INPUT', 'Standardizer.fit needs at least one row');
    const d = X[0]!.length;
    this.mean = new Array<number>(d).fill(0);
    this.std = new Array<number>(d).fill(0);
    for (const row of X) for (let f = 0; f < d; f++) this.mean[f]! += row[f]! / X.length;
    for (const row of X) for (let f = 0; f < d; f++) this.std[f]! += (row[f]! - this.mean[f]!) ** 2 / X.length;
    for (let f = 0; f < d; f++) this.std[f] = Math.sqrt(this.std[f]!) || 1;
    return this;
  }

  transform(x: readonly number[]): number[] {
    return x.map((v, f) => (v - (this.mean[f] ?? 0)) / (this.std[f] ?? 1));
  }

  transformAll(X: readonly number[][]): number[][] {
    return X.map((row) => this.transform(row));
  }

  toJSON(): StandardizerJSON {
    return { mean: this.mean, std: this.std };
  }

  static fromJSON(json: StandardizerJSON): Standardizer {
    const s = new Standardizer();
    s.mean = json.mean;
    s.std = json.std;
    return s;
  }
}

/* ------------------------------------------------------------------ *
 * Softmax logistic regression (multiclass, full-batch gradient descent)
 * ------------------------------------------------------------------ */

export interface LogisticRegressionOptions {
  learningRate?: number;
  epochs?: number;
  /** L2 weight-decay strength. */
  l2?: number;
}

export interface LogisticRegressionJSON {
  labels: string[];
  weights: number[][];
  bias: number[];
  featureCount: number;
}

export class LogisticRegression {
  private labels: string[] = [];
  private weights: number[][] = [];
  private bias: number[] = [];
  private featureCount = 0;

  get classes(): string[] {
    return this.labels.slice();
  }

  fit(X: readonly number[][], y: readonly string[], options: LogisticRegressionOptions = {}): this {
    const lr = options.learningRate ?? 0.2;
    const epochs = options.epochs ?? 200;
    const l2 = options.l2 ?? 1e-4;
    const n = X.length;
    if (n === 0 || y.length !== n) {
      throw new MegaError('INVALID_INPUT', 'LogisticRegression.fit needs X and y of equal, non-zero length');
    }
    this.featureCount = X[0]!.length;
    this.labels = [...new Set(y)].sort();
    const C = this.labels.length;
    const labelIndex = new Map(this.labels.map((l, i) => [l, i]));
    const yIdx = y.map((l) => labelIndex.get(l)!);

    // Deterministic zero initialisation.
    this.weights = Array.from({ length: C }, () => new Array<number>(this.featureCount).fill(0));
    this.bias = new Array<number>(C).fill(0);

    for (let epoch = 0; epoch < epochs; epoch++) {
      const gradW = Array.from({ length: C }, () => new Array<number>(this.featureCount).fill(0));
      const gradB = new Array<number>(C).fill(0);
      for (let i = 0; i < n; i++) {
        const xi = X[i]!;
        const probs = this.softmax(xi);
        const target = yIdx[i]!;
        for (let c = 0; c < C; c++) {
          const err = probs[c]! - (c === target ? 1 : 0);
          gradB[c]! += err;
          const gw = gradW[c]!;
          for (let f = 0; f < this.featureCount; f++) gw[f]! += err * xi[f]!;
        }
      }
      for (let c = 0; c < C; c++) {
        this.bias[c]! -= lr * (gradB[c]! / n);
        const w = this.weights[c]!;
        const gw = gradW[c]!;
        for (let f = 0; f < this.featureCount; f++) w[f]! -= lr * (gw[f]! / n + l2 * w[f]!);
      }
    }
    return this;
  }

  private softmax(x: readonly number[]): number[] {
    const C = this.labels.length;
    const logits = new Array<number>(C).fill(0);
    for (let c = 0; c < C; c++) {
      let s = this.bias[c]!;
      const w = this.weights[c]!;
      for (let f = 0; f < this.featureCount; f++) s += w[f]! * (x[f] ?? 0);
      logits[c] = s;
    }
    let max = -Infinity;
    for (const v of logits) if (v > max) max = v;
    let sum = 0;
    for (let c = 0; c < C; c++) {
      const e = Math.exp(logits[c]! - max);
      logits[c] = e;
      sum += e;
    }
    const denom = sum || 1;
    for (let c = 0; c < C; c++) logits[c]! /= denom;
    return logits;
  }

  predictProba(x: readonly number[]): Record<string, number> {
    const probs = this.softmax(x);
    const out: Record<string, number> = {};
    for (let i = 0; i < this.labels.length; i++) out[this.labels[i]!] = probs[i]!;
    return out;
  }

  predict(x: readonly number[]): string {
    const probs = this.softmax(x);
    let best = 0;
    for (let c = 1; c < probs.length; c++) if (probs[c]! > probs[best]!) best = c;
    return this.labels[best] ?? '';
  }

  toJSON(): LogisticRegressionJSON {
    return { labels: this.labels, weights: this.weights, bias: this.bias, featureCount: this.featureCount };
  }

  static fromJSON(json: LogisticRegressionJSON): LogisticRegression {
    const m = new LogisticRegression();
    m.labels = json.labels;
    m.weights = json.weights;
    m.bias = json.bias;
    m.featureCount = json.featureCount;
    return m;
  }
}

/* ------------------------------------------------------------------ *
 * Multinomial naive Bayes (text classification)
 * ------------------------------------------------------------------ */

export interface MultinomialNBJSON {
  labels: string[];
  featureCount: number;
  logPrior: number[];
  logLikelihood: number[][];
}

export class MultinomialNB {
  private labels: string[] = [];
  private featureCount = 0;
  private logPrior: number[] = [];
  private logLikelihood: number[][] = [];

  get classes(): string[] {
    return this.labels.slice();
  }

  fit(X: readonly number[][], y: readonly string[], options: { alpha?: number } = {}): this {
    const alpha = options.alpha ?? 1;
    const n = X.length;
    if (n === 0 || y.length !== n) {
      throw new MegaError('INVALID_INPUT', 'MultinomialNB.fit needs X and y of equal, non-zero length');
    }
    this.featureCount = X[0]!.length;
    this.labels = [...new Set(y)].sort();
    const C = this.labels.length;
    const labelIndex = new Map(this.labels.map((l, i) => [l, i]));

    const classCount = new Array<number>(C).fill(0);
    const featureCount = Array.from({ length: C }, () => new Array<number>(this.featureCount).fill(0));
    const classTotal = new Array<number>(C).fill(0);
    for (let i = 0; i < n; i++) {
      const c = labelIndex.get(y[i]!)!;
      classCount[c]! += 1;
      const xi = X[i]!;
      const fc = featureCount[c]!;
      for (let f = 0; f < this.featureCount; f++) {
        fc[f]! += xi[f]!;
        classTotal[c]! += xi[f]!;
      }
    }
    this.logPrior = classCount.map((cc) => Math.log((cc || 1) / n));
    this.logLikelihood = featureCount.map((fc, c) => {
      const denom = classTotal[c]! + alpha * this.featureCount;
      return fc.map((count) => Math.log((count + alpha) / denom));
    });
    return this;
  }

  private scores(x: readonly number[]): number[] {
    const C = this.labels.length;
    const out = new Array<number>(C).fill(0);
    for (let c = 0; c < C; c++) {
      let s = this.logPrior[c]!;
      const ll = this.logLikelihood[c]!;
      for (let f = 0; f < this.featureCount; f++) s += (x[f] ?? 0) * ll[f]!;
      out[c] = s;
    }
    return out;
  }

  predictProba(x: readonly number[]): Record<string, number> {
    const s = this.scores(x);
    let max = -Infinity;
    for (const v of s) if (v > max) max = v;
    let sum = 0;
    const exps = s.map((v) => {
      const e = Math.exp(v - max);
      sum += e;
      return e;
    });
    const denom = sum || 1;
    const out: Record<string, number> = {};
    for (let i = 0; i < this.labels.length; i++) out[this.labels[i]!] = exps[i]! / denom;
    return out;
  }

  predict(x: readonly number[]): string {
    const s = this.scores(x);
    let best = 0;
    for (let c = 1; c < s.length; c++) if (s[c]! > s[best]!) best = c;
    return this.labels[best] ?? '';
  }

  toJSON(): MultinomialNBJSON {
    return {
      labels: this.labels,
      featureCount: this.featureCount,
      logPrior: this.logPrior,
      logLikelihood: this.logLikelihood,
    };
  }

  static fromJSON(json: MultinomialNBJSON): MultinomialNB {
    const m = new MultinomialNB();
    m.labels = json.labels;
    m.featureCount = json.featureCount;
    m.logPrior = json.logPrior;
    m.logLikelihood = json.logLikelihood;
    return m;
  }
}
