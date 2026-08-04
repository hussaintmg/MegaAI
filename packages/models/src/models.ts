/**
 * @megaai/models · models — the concrete, trainable models. Each one owns its
 * own synthetic dataset (we generate our data deterministically rather than
 * downloading a corpus), trains a real classifier from `core`, evaluates on a
 * held-out split, and serialises to a portable bundle.
 *
 *   - `UiPurposeModel`  — what is this UI element *for*? (softmax logistic over
 *     element features) — a drop-in `PurposeClassifier` for `@megaai/vision`.
 *   - `LeadScoringModel`— hot / warm / cold from lead signals (logistic).
 *   - `TriageModel`     — route an error/log line to a category (naive Bayes).
 *
 * A `ModelRegistry` holds trained models, predicts through a uniform shape and
 * saves/loads to disk so the CLI can `train` once and the SDK can load them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JsonObject } from '@megaai/types';
import { MegaError } from '@megaai/types';
import {
  classificationReport,
  LogisticRegression,
  type LogisticRegressionJSON,
  MultinomialNB,
  type MultinomialNBJSON,
  Rng,
  Standardizer,
  type StandardizerJSON,
  trainTestSplit,
  Vectorizer,
  type VectorizerJSON,
  type ClassificationReport,
} from './core.js';

/* ------------------------------------------------------------------ *
 * Shared model surface
 * ------------------------------------------------------------------ */

export type ModelKind = 'ui-purpose' | 'lead-scoring' | 'error-triage';

export interface Prediction {
  label: string;
  confidence: number;
  scores: Record<string, number>;
}

export interface ModelInfo {
  accuracy: number;
  samples: number;
}

/** A portable, JSON-serialisable snapshot of a trained model. */
export interface ModelBundle {
  name: string;
  kind: ModelKind;
  labels: string[];
  accuracy: number;
  samples: number;
  data: JsonObject;
}

/** Everything a trained model exposes to the registry and the predict tool. */
export interface PredictiveModel {
  readonly name: ModelKind;
  readonly labels: string[];
  readonly info: ModelInfo;
  /** Predict from a loosely-typed input object (model-specific fields). */
  predictInput(input: JsonObject): Prediction;
  toBundle(): ModelBundle;
}

function topLabel(scores: Record<string, number>): { label: string; confidence: number } {
  let label = '';
  let confidence = -Infinity;
  for (const [k, v] of Object.entries(scores)) {
    if (v > confidence) {
      confidence = v;
      label = k;
    }
  }
  return { label, confidence: confidence === -Infinity ? 0 : confidence };
}

function str(input: JsonObject, key: string): string | undefined {
  const v = input[key];
  return typeof v === 'string' ? v : undefined;
}

function num(input: JsonObject, key: string, fallback: number): number {
  const v = input[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return fallback;
}

/* ================================================================== *
 * 1. UI-purpose model
 * ================================================================== */

/** Structurally compatible with `@megaai/vision`'s `ElementFeatures`. */
export interface UiFeatureInput {
  tag: string;
  type?: string;
  role?: string;
  text?: string;
  id?: string;
  name?: string;
  classes?: string;
  href?: string;
  ariaLabel?: string;
}

/** Turn element features into a bag-of-words document with structural tokens. */
export function uiDoc(f: UiFeatureInput): string {
  const structural: string[] = [`tag${f.tag}`];
  if (f.type) structural.push(`type${f.type}`);
  if (f.role) structural.push(`role${f.role}`);
  if (f.href) structural.push(f.href.startsWith('#') ? 'hrefanchor' : 'hrefurl');
  const free = [f.text, f.ariaLabel, f.id, f.name, f.classes].filter(Boolean).join(' ');
  return `${structural.join(' ')} ${free}`.trim();
}

interface UiClassSpec {
  label: string;
  tags: Array<{ tag: string; type?: string }>;
  phrases: string[];
}

// Purpose labels mirror @megaai/vision's heuristic so this is a drop-in model.
const UI_CLASSES: UiClassSpec[] = [
  {
    label: 'submit',
    tags: [{ tag: 'button' }, { tag: 'button', type: 'submit' }, { tag: 'input', type: 'submit' }],
    phrases: ['submit', 'save', 'confirm', 'continue', 'checkout', 'pay now', 'place order', 'sign up', 'register', 'send', 'apply', 'proceed', 'complete order', 'save changes', 'update'],
  },
  { label: 'cancel', tags: [{ tag: 'button' }, { tag: 'a' }], phrases: ['cancel', 'close', 'dismiss', 'go back', 'not now', 'discard', 'back'] },
  { label: 'delete', tags: [{ tag: 'button' }, { tag: 'a' }], phrases: ['delete', 'remove', 'trash', 'clear all', 'erase', 'remove item', 'delete account'] },
  { label: 'login', tags: [{ tag: 'button' }, { tag: 'a' }, { tag: 'button', type: 'submit' }], phrases: ['login', 'log in', 'sign in', 'signin', 'access account', 'member login'] },
  { label: 'logout', tags: [{ tag: 'button' }, { tag: 'a' }], phrases: ['logout', 'log out', 'sign out', 'signout'] },
  {
    label: 'search',
    tags: [{ tag: 'button' }, { tag: 'input', type: 'search' }, { tag: 'input', type: 'text' }],
    phrases: ['search', 'find', 'look up', 'search products', 'search here', 'search the store'],
  },
  {
    label: 'navigation',
    tags: [{ tag: 'a' }, { tag: 'button' }],
    phrases: ['home', 'about', 'contact', 'products', 'catalog', 'menu', 'dashboard', 'profile', 'settings', 'pricing', 'blog', 'faq', 'shop', 'categories'],
  },
  {
    label: 'link',
    tags: [{ tag: 'a' }],
    phrases: ['read more', 'learn more', 'documentation', 'terms of service', 'privacy policy', 'view details', 'see all', 'details', 'help center'],
  },
  {
    label: 'action',
    tags: [{ tag: 'button' }, { tag: 'a' }],
    phrases: ['add to cart', 'buy', 'add', 'like', 'share', 'follow', 'subscribe', 'download', 'upload', 'edit', 'refresh', 'filter', 'sort', 'add to wishlist', 'compare'],
  },
  {
    label: 'input',
    tags: [{ tag: 'input', type: 'text' }, { tag: 'textarea' }],
    phrases: ['full name', 'address', 'city', 'company', 'comment', 'message', 'quantity', 'your name', 'phone number', 'notes', 'title', 'description'],
  },
  { label: 'email-input', tags: [{ tag: 'input', type: 'email' }, { tag: 'input', type: 'text' }], phrases: ['email', 'email address', 'your email', 'work email', 'enter email'] },
  { label: 'password-input', tags: [{ tag: 'input', type: 'password' }], phrases: ['password', 'confirm password', 'current password', 'new password', 'enter password'] },
  {
    label: 'toggle',
    tags: [{ tag: 'input', type: 'checkbox' }, { tag: 'input', type: 'radio' }],
    phrases: ['remember me', 'subscribe to newsletter', 'i agree', 'accept terms', 'enable notifications', 'yes', 'no'],
  },
];

function slug(phrase: string): string {
  return phrase.replace(/\s+/g, '-');
}

function placePhrase(rng: Rng, base: UiFeatureInput, phrase: string): UiFeatureInput {
  const slot = rng.int(0, 10);
  if (slot < 6) base.text = phrase;
  else if (slot < 7) base.ariaLabel = phrase;
  else if (slot < 8) base.id = slug(phrase);
  else if (slot < 9) base.name = slug(phrase);
  else base.classes = `${slug(phrase)} control`;
  return base;
}

/** Generate a labelled UI-element dataset (as bag-of-words documents). */
export function buildUiDataset(perLabel: number, rng: Rng): { docs: string[]; labels: string[] } {
  const docs: string[] = [];
  const labels: string[] = [];
  const distractors = ['btn', 'ui-control', 'el', 'item', 'field', 'primary', 'lg'];
  for (const spec of UI_CLASSES) {
    for (let i = 0; i < perLabel; i++) {
      const tagSpec = rng.pick(spec.tags);
      const feat: UiFeatureInput = { tag: tagSpec.tag, type: tagSpec.type };
      placePhrase(rng, feat, rng.pick(spec.phrases));
      if (rng.bool(0.3)) feat.classes = `${feat.classes ? `${feat.classes} ` : ''}${rng.pick(distractors)}`;
      docs.push(uiDoc(feat));
      labels.push(spec.label);
    }
  }
  return { docs, labels };
}

export interface UiTrainOptions {
  seed?: number;
  perLabel?: number;
  epochs?: number;
}

export class UiPurposeModel implements PredictiveModel {
  readonly name = 'ui-purpose' as const;

  constructor(
    private readonly vectorizer: Vectorizer,
    private readonly classifier: LogisticRegression,
    readonly info: ModelInfo,
  ) {}

  get labels(): string[] {
    return this.classifier.classes;
  }

  /** Classify an element document (already `uiDoc`-encoded). */
  classifyDoc(doc: string): string {
    if (this.vectorizer.known(doc) === 0) return 'action';
    return this.classifier.predict(this.vectorizer.transform(doc));
  }

  /** The `PurposeClassifier` seam for @megaai/vision. */
  classify(f: UiFeatureInput): string {
    return this.classifyDoc(uiDoc(f));
  }

  /** A bound classifier callback safe to pass into VisionTester. */
  asClassifier(): (f: UiFeatureInput) => string {
    return (f) => this.classify(f);
  }

  predictInput(input: JsonObject): Prediction {
    const feature: UiFeatureInput = {
      tag: str(input, 'tag') ?? 'button',
      type: str(input, 'type'),
      role: str(input, 'role'),
      text: str(input, 'text'),
      id: str(input, 'id'),
      name: str(input, 'name'),
      classes: str(input, 'classes') ?? str(input, 'class'),
      href: str(input, 'href'),
      ariaLabel: str(input, 'ariaLabel') ?? str(input, 'aria-label'),
    };
    const doc = uiDoc(feature);
    const scores = this.vectorizer.known(doc) === 0 ? { action: 1 } : this.classifier.predictProba(this.vectorizer.transform(doc));
    const { label, confidence } = topLabel(scores);
    return { label, confidence, scores };
  }

  toBundle(): ModelBundle {
    return {
      name: this.name,
      kind: this.name,
      labels: this.labels,
      accuracy: this.info.accuracy,
      samples: this.info.samples,
      data: { vectorizer: this.vectorizer.toJSON() as unknown as JsonObject, classifier: this.classifier.toJSON() as unknown as JsonObject },
    };
  }

  static fromBundle(bundle: ModelBundle): UiPurposeModel {
    const data = bundle.data as unknown as { vectorizer: VectorizerJSON; classifier: LogisticRegressionJSON };
    return new UiPurposeModel(Vectorizer.fromJSON(data.vectorizer), LogisticRegression.fromJSON(data.classifier), {
      accuracy: bundle.accuracy,
      samples: bundle.samples,
    });
  }

  static train(options: UiTrainOptions = {}): { model: UiPurposeModel; report: ClassificationReport } {
    const rng = new Rng(options.seed ?? 42);
    const { docs, labels } = buildUiDataset(options.perLabel ?? 110, rng);
    const indices = docs.map((_, i) => i);
    const { train, test } = trainTestSplit(indices, 0.2, rng);
    const vectorizer = new Vectorizer().fit(train.map((i) => docs[i]!), { minCount: 1, maxFeatures: 400 });
    const classifier = new LogisticRegression().fit(
      train.map((i) => vectorizer.transform(docs[i]!)),
      train.map((i) => labels[i]!),
      { epochs: options.epochs ?? 260, learningRate: 0.5, l2: 1e-4 },
    );
    const predicted = test.map((i) => classifier.predict(vectorizer.transform(docs[i]!)));
    const report = classificationReport(predicted, test.map((i) => labels[i]!));
    const model = new UiPurposeModel(vectorizer, classifier, { accuracy: report.accuracy, samples: docs.length });
    return { model, report };
  }
}

/* ================================================================== *
 * 2. Lead-scoring model
 * ================================================================== */

// Order of the numeric feature vector; also the accepted input keys.
const LEAD_FEATURES = ['budget', 'companySize', 'engagement', 'responsiveness', 'decisionMaker', 'industryFit'] as const;

export interface LeadTrainOptions {
  seed?: number;
  samples?: number;
  epochs?: number;
}

function leadVector(input: JsonObject): number[] {
  return [
    num(input, 'budget', 0.5),
    num(input, 'companySize', 0.5),
    num(input, 'engagement', 0.5),
    num(input, 'responsiveness', 0.5),
    num(input, 'decisionMaker', 0),
    num(input, 'industryFit', 0.5),
  ];
}

/** Generate synthetic leads with a latent quality score and tri-band labels. */
export function buildLeadDataset(samples: number, rng: Rng): { X: number[][]; labels: string[] } {
  const X: number[][] = [];
  const labels: string[] = [];
  for (let i = 0; i < samples; i++) {
    const budget = rng.next();
    const companySize = rng.next();
    const engagement = rng.next();
    const responsiveness = rng.next();
    const decisionMaker = rng.bool(0.5) ? 1 : 0;
    const industryFit = rng.next();
    const latent =
      2.2 * budget + 1.5 * engagement + 1.3 * responsiveness + 1.0 * industryFit + 0.8 * decisionMaker + 0.6 * companySize + rng.gaussian(0, 0.3);
    const label = latent > 4.6 ? 'hot' : latent > 3.2 ? 'warm' : 'cold';
    X.push([budget, companySize, engagement, responsiveness, decisionMaker, industryFit]);
    labels.push(label);
  }
  return { X, labels };
}

export class LeadScoringModel implements PredictiveModel {
  readonly name = 'lead-scoring' as const;

  constructor(
    private readonly scaler: Standardizer,
    private readonly classifier: LogisticRegression,
    readonly info: ModelInfo,
  ) {}

  get labels(): string[] {
    return this.classifier.classes;
  }

  /** Documents the numeric input fields this model expects (all ~0..1). */
  static get features(): readonly string[] {
    return LEAD_FEATURES;
  }

  predictInput(input: JsonObject): Prediction {
    const scores = this.classifier.predictProba(this.scaler.transform(leadVector(input)));
    const { label, confidence } = topLabel(scores);
    return { label, confidence, scores };
  }

  toBundle(): ModelBundle {
    return {
      name: this.name,
      kind: this.name,
      labels: this.labels,
      accuracy: this.info.accuracy,
      samples: this.info.samples,
      data: { scaler: this.scaler.toJSON() as unknown as JsonObject, classifier: this.classifier.toJSON() as unknown as JsonObject },
    };
  }

  static fromBundle(bundle: ModelBundle): LeadScoringModel {
    const data = bundle.data as unknown as { scaler: StandardizerJSON; classifier: LogisticRegressionJSON };
    return new LeadScoringModel(Standardizer.fromJSON(data.scaler), LogisticRegression.fromJSON(data.classifier), {
      accuracy: bundle.accuracy,
      samples: bundle.samples,
    });
  }

  static train(options: LeadTrainOptions = {}): { model: LeadScoringModel; report: ClassificationReport } {
    const rng = new Rng(options.seed ?? 7);
    const { X, labels } = buildLeadDataset(options.samples ?? 1200, rng);
    const rows = X.map((x, i) => ({ x, label: labels[i]! }));
    const { train, test } = trainTestSplit(rows, 0.2, rng);
    const scaler = new Standardizer().fit(train.map((r) => r.x));
    const classifier = new LogisticRegression().fit(
      train.map((r) => scaler.transform(r.x)),
      train.map((r) => r.label),
      { epochs: options.epochs ?? 400, learningRate: 0.5, l2: 1e-3 },
    );
    const predicted = test.map((r) => classifier.predict(scaler.transform(r.x)));
    const report = classificationReport(predicted, test.map((r) => r.label));
    const model = new LeadScoringModel(scaler, classifier, { accuracy: report.accuracy, samples: X.length });
    return { model, report };
  }
}

/* ================================================================== *
 * 3. Error-triage model
 * ================================================================== */

interface TriageClassSpec {
  label: string;
  phrases: string[];
}

const TRIAGE_CLASSES: TriageClassSpec[] = [
  { label: 'network', phrases: ['connection refused', 'econnrefused', 'network timeout', 'dns lookup failed', 'socket hang up', 'fetch failed', 'host unreachable', 'connection reset', 'could not resolve host'] },
  { label: 'auth', phrases: ['invalid credentials', 'unauthorized', '401 unauthorized', 'token expired', 'authentication failed', 'invalid api key', 'login failed', 'session expired', 'bad token'] },
  { label: 'database', phrases: ['deadlock detected', 'connection pool exhausted', 'duplicate key value', 'constraint violation', 'relation does not exist', 'query timeout', 'sql syntax error', 'unique constraint failed', 'database is locked'] },
  { label: 'validation', phrases: ['invalid input', 'required field missing', 'must be a string', 'schema validation failed', 'value out of range', 'malformed json', 'expected number', 'field is required', 'invalid email format'] },
  { label: 'timeout', phrases: ['operation timed out', 'deadline exceeded', 'request timeout', 'timed out after 30s', 'etimedout', 'gateway timeout', 'execution timeout'] },
  { label: 'permission', phrases: ['permission denied', 'access denied', 'forbidden', '403 forbidden', 'eacces', 'not allowed', 'insufficient privileges', 'operation not permitted'] },
  { label: 'ratelimit', phrases: ['rate limit exceeded', '429 too many requests', 'too many requests', 'quota exceeded', 'throttled', 'api rate limit reached'] },
  { label: 'build', phrases: ['compilation failed', 'type error', 'module not found', 'cannot find module', 'build failed', 'unexpected token', 'syntax error', 'missing semicolon', 'import error'] },
];

const TRIAGE_NOISE = ['at', 'in', 'file', 'line', 'service', 'handler', 'worker', 'process', 'request', 'job', 'task', 'step', 'module', 'server', 'retrying', 'failed'];

/** Generate synthetic error/log lines: a category phrase plus a little noise. */
export function buildTriageDataset(perLabel: number, rng: Rng): { docs: string[]; labels: string[] } {
  const docs: string[] = [];
  const labels: string[] = [];
  for (const spec of TRIAGE_CLASSES) {
    for (let i = 0; i < perLabel; i++) {
      const parts = [rng.pick(spec.phrases)];
      const extra = rng.int(0, 3);
      for (let k = 0; k < extra; k++) parts.splice(rng.int(0, parts.length + 1), 0, rng.pick(TRIAGE_NOISE));
      docs.push(parts.join(' '));
      labels.push(spec.label);
    }
  }
  return { docs, labels };
}

export interface TriageTrainOptions {
  seed?: number;
  perLabel?: number;
}

export class TriageModel implements PredictiveModel {
  readonly name = 'error-triage' as const;

  constructor(
    private readonly vectorizer: Vectorizer,
    private readonly classifier: MultinomialNB,
    readonly info: ModelInfo,
  ) {}

  get labels(): string[] {
    return this.classifier.classes;
  }

  classifyText(text: string): string {
    return this.classifier.predict(this.vectorizer.transform(text));
  }

  predictInput(input: JsonObject): Prediction {
    const text = str(input, 'message') ?? str(input, 'text') ?? str(input, 'error') ?? '';
    const scores = this.classifier.predictProba(this.vectorizer.transform(text));
    const { label, confidence } = topLabel(scores);
    return { label, confidence, scores };
  }

  toBundle(): ModelBundle {
    return {
      name: this.name,
      kind: this.name,
      labels: this.labels,
      accuracy: this.info.accuracy,
      samples: this.info.samples,
      data: { vectorizer: this.vectorizer.toJSON() as unknown as JsonObject, classifier: this.classifier.toJSON() as unknown as JsonObject },
    };
  }

  static fromBundle(bundle: ModelBundle): TriageModel {
    const data = bundle.data as unknown as { vectorizer: VectorizerJSON; classifier: MultinomialNBJSON };
    return new TriageModel(Vectorizer.fromJSON(data.vectorizer), MultinomialNB.fromJSON(data.classifier), {
      accuracy: bundle.accuracy,
      samples: bundle.samples,
    });
  }

  static train(options: TriageTrainOptions = {}): { model: TriageModel; report: ClassificationReport } {
    const rng = new Rng(options.seed ?? 99);
    const { docs, labels } = buildTriageDataset(options.perLabel ?? 90, rng);
    const indices = docs.map((_, i) => i);
    const { train, test } = trainTestSplit(indices, 0.2, rng);
    const vectorizer = new Vectorizer().fit(train.map((i) => docs[i]!), { minCount: 1 });
    const classifier = new MultinomialNB().fit(
      train.map((i) => vectorizer.transform(docs[i]!)),
      train.map((i) => labels[i]!),
    );
    const predicted = test.map((i) => classifier.predict(vectorizer.transform(docs[i]!)));
    const report = classificationReport(predicted, test.map((i) => labels[i]!));
    const model = new TriageModel(vectorizer, classifier, { accuracy: report.accuracy, samples: docs.length });
    return { model, report };
  }
}

/* ================================================================== *
 * Registry + persistence + train-all
 * ================================================================== */

export function rehydrateModel(bundle: ModelBundle): PredictiveModel | undefined {
  switch (bundle.kind) {
    case 'ui-purpose':
      return UiPurposeModel.fromBundle(bundle);
    case 'lead-scoring':
      return LeadScoringModel.fromBundle(bundle);
    case 'error-triage':
      return TriageModel.fromBundle(bundle);
    default:
      return undefined;
  }
}

export class ModelRegistry {
  private readonly models = new Map<string, PredictiveModel>();

  register(model: PredictiveModel): this {
    this.models.set(model.name, model);
    return this;
  }

  get(name: string): PredictiveModel | undefined {
    return this.models.get(name);
  }

  has(name: string): boolean {
    return this.models.has(name);
  }

  list(): string[] {
    return [...this.models.keys()];
  }

  ui(): UiPurposeModel | undefined {
    const model = this.models.get('ui-purpose');
    return model instanceof UiPurposeModel ? model : undefined;
  }

  predict(name: string, input: JsonObject): Prediction {
    const model = this.models.get(name);
    if (!model) throw new MegaError('NOT_FOUND', `No trained model named "${name}"`, { available: this.list() });
    return model.predictInput(input);
  }

  summary(): Array<{ name: string; labels: string[]; accuracy: number; samples: number }> {
    return [...this.models.values()].map((m) => ({ name: m.name, labels: m.labels, accuracy: m.info.accuracy, samples: m.info.samples }));
  }

  toBundles(): ModelBundle[] {
    return [...this.models.values()].map((m) => m.toBundle());
  }

  static fromBundles(bundles: readonly ModelBundle[]): ModelRegistry {
    const registry = new ModelRegistry();
    for (const bundle of bundles) {
      const model = rehydrateModel(bundle);
      if (model) registry.register(model);
    }
    return registry;
  }
}

interface Manifest {
  version: number;
  models: Array<{ name: string; kind: ModelKind; accuracy: number; samples: number; labels: string[] }>;
}

/** Persist a registry to `dir` — one JSON per model plus a manifest. */
export function saveRegistry(dir: string, registry: ModelRegistry): void {
  mkdirSync(dir, { recursive: true });
  const bundles = registry.toBundles();
  const manifest: Manifest = {
    version: 1,
    models: bundles.map((b) => ({ name: b.name, kind: b.kind, accuracy: b.accuracy, samples: b.samples, labels: b.labels })),
  };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const bundle of bundles) writeFileSync(join(dir, `${bundle.name}.json`), JSON.stringify(bundle));
}

/** Load a registry from `dir`; undefined when no manifest is present. */
export function loadRegistry(dir: string): ModelRegistry | undefined {
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) return undefined;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  } catch {
    return undefined;
  }
  const registry = new ModelRegistry();
  for (const entry of manifest.models ?? []) {
    const path = join(dir, `${entry.name}.json`);
    if (!existsSync(path)) continue;
    try {
      const bundle = JSON.parse(readFileSync(path, 'utf8')) as ModelBundle;
      const model = rehydrateModel(bundle);
      if (model) registry.register(model);
    } catch {
      // Skip a corrupt bundle rather than failing the whole load.
    }
  }
  return registry.list().length > 0 ? registry : undefined;
}

export interface TrainAllOptions {
  seed?: number;
  uiPerLabel?: number;
  leadSamples?: number;
  triagePerLabel?: number;
}

export interface TrainAllResult {
  registry: ModelRegistry;
  reports: Record<ModelKind, ClassificationReport>;
}

/** Build every dataset and train every model (deterministic from `seed`). */
export function trainAllModels(options: TrainAllOptions = {}): TrainAllResult {
  const base = options.seed ?? 1;
  const ui = UiPurposeModel.train({ seed: base + 41, perLabel: options.uiPerLabel });
  const lead = LeadScoringModel.train({ seed: base + 6, samples: options.leadSamples });
  const triage = TriageModel.train({ seed: base + 98, perLabel: options.triagePerLabel });
  const registry = new ModelRegistry().register(ui.model).register(lead.model).register(triage.model);
  return { registry, reports: { 'ui-purpose': ui.report, 'lead-scoring': lead.report, 'error-triage': triage.report } };
}
