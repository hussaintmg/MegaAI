/**
 * @megaai/models — the trainable models pack.
 *
 * Real, self-contained classical ML that trains and runs inside this
 * environment (no GPU, no downloaded corpus): softmax logistic regression and
 * multinomial naive Bayes in `core`, three concrete models in `models`, each
 * learning from a dataset it generates itself.
 *
 * The UI-purpose model is a drop-in `PurposeClassifier` for `@megaai/vision`;
 * the lead-scoring and error-triage models are reachable through the
 * `model.predict` / `model.list` tools on the `model` permission. Heavy
 * deep-vision models can later register through the same `PredictiveModel`
 * seam without changing anything upstream.
 */

import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool } from '@megaai/contracts';
import { ModelRegistry } from './models.js';

export * from './core.js';
export * from './models.js';

/* ------------------------------------------------------------------ *
 * Agent-facing tools
 * ------------------------------------------------------------------ */

/** `model.predict` + `model.list` over a (possibly empty) registry. */
export function createModelTools(registry: ModelRegistry): Tool[] {
  const predict: Tool = {
    name: 'model.predict',
    description: 'Run a trained model. input: { model: "ui-purpose"|"lead-scoring"|"error-triage", input: {…model-specific fields} }',
    inputSchema: { model: 'string (model name)', input: 'object (model-specific features)' },
    permissions: ['model'],
    async execute(input) {
      const name = typeof input.model === 'string' ? input.model : '';
      if (!name) throw new MegaError('INVALID_INPUT', 'model.predict needs a "model" name', { available: registry.list() });
      const features = input.input && typeof input.input === 'object' && !Array.isArray(input.input) ? (input.input as JsonObject) : {};
      return { model: name, ...registry.predict(name, features) } as unknown as JsonValue;
    },
  };
  const list: Tool = {
    name: 'model.list',
    description: 'List the trained models available for prediction, with their labels and held-out accuracy',
    inputSchema: {},
    permissions: ['model'],
    async execute() {
      return { models: registry.summary() as unknown as JsonValue };
    },
  };
  return [predict, list];
}
