/**
 * @megaai/ai — the AI layer: model registry, provider adapters, usage
 * limits and the fallback-driven session manager.
 */

export { BUILTIN_MODELS, ModelRegistry } from './models.js';
export { LimitTracker, type LimitCheck } from './limits.js';
export {
  AiSessionManager,
  ProviderRegistry,
  type AcquireOptions,
  type SessionManagerOptions,
  type ProviderStatus,
} from './sessions.js';
export { MockProvider, type MockProviderOptions } from './providers/mock.js';
export { AnthropicProvider, type AnthropicProviderOptions } from './providers/anthropic.js';
export { OpenAICompatProvider, type OpenAICompatOptions } from './providers/openai.js';
export { GeminiProvider, type GeminiProviderOptions } from './providers/gemini.js';
