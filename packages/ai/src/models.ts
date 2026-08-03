/**
 * Model registry — knows every model MegaAI can route work to, what it
 * costs and which tier of work it fits.
 */

import type { ModelCard, ModelTier, ProviderKind, TaskComplexity } from '@megaai/types';
import { MegaError } from '@megaai/types';

/** Built-in model cards (pricing = USD per million tokens). */
export const BUILTIN_MODELS: ModelCard[] = [
  // Anthropic — pricing/context per platform.claude.com (2026).
  {
    id: 'claude-fable-5',
    provider: 'anthropic',
    displayName: 'Claude Fable 5',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPerMTok: 10,
    outputCostPerMTok: 50,
  },
  {
    id: 'claude-opus-5',
    provider: 'anthropic',
    displayName: 'Claude Opus 5',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPerMTok: 5,
    outputCostPerMTok: 25,
  },
  {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    displayName: 'Claude Sonnet 5',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    inputCostPerMTok: 3,
    outputCostPerMTok: 15,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    tier: 'fast',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPerMTok: 1,
    outputCostPerMTok: 5,
  },
  // OpenAI-compatible endpoints (Codex/OpenCode-style backends).
  {
    id: 'gpt-5',
    provider: 'openai',
    displayName: 'GPT-5',
    tier: 'frontier',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    inputCostPerMTok: 10,
    outputCostPerMTok: 30,
  },
  {
    id: 'gpt-5-mini',
    provider: 'openai',
    displayName: 'GPT-5 mini',
    tier: 'fast',
    contextWindow: 400_000,
    maxOutputTokens: 64_000,
    inputCostPerMTok: 1,
    outputCostPerMTok: 4,
  },
  // Google
  {
    id: 'gemini-2.5-pro',
    provider: 'gemini',
    displayName: 'Gemini 2.5 Pro',
    tier: 'balanced',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputCostPerMTok: 2.5,
    outputCostPerMTok: 10,
  },
  // Offline simulator
  {
    id: 'mock-frontier',
    provider: 'mock',
    displayName: 'Mock Frontier',
    tier: 'frontier',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    inputCostPerMTok: 0,
    outputCostPerMTok: 0,
  },
  {
    id: 'mock-fast',
    provider: 'mock',
    displayName: 'Mock Fast',
    tier: 'fast',
    contextWindow: 200_000,
    maxOutputTokens: 16_000,
    inputCostPerMTok: 0,
    outputCostPerMTok: 0,
  },
];

const COMPLEXITY_TIER: Record<TaskComplexity, ModelTier> = {
  trivial: 'fast',
  standard: 'balanced',
  complex: 'frontier',
  frontier: 'frontier',
};

export class ModelRegistry {
  private readonly cards = new Map<string, ModelCard>();

  constructor(cards: ModelCard[] = BUILTIN_MODELS) {
    for (const card of cards) this.add(card);
  }

  add(card: ModelCard): void {
    this.cards.set(card.id, card);
  }

  get(id: string): ModelCard | undefined {
    return this.cards.get(id);
  }

  all(): ModelCard[] {
    return [...this.cards.values()];
  }

  forProvider(provider: ProviderKind): ModelCard[] {
    return this.all().filter((card) => card.provider === provider);
  }

  /**
   * Pick the model a provider should use for a task of the given complexity:
   * exact tier match first, then the closest heavier tier, then anything.
   */
  pick(provider: ProviderKind, complexity: TaskComplexity): ModelCard {
    const models = this.forProvider(provider);
    if (models.length === 0) {
      throw new MegaError('NOT_FOUND', `No models registered for provider "${provider}"`);
    }
    const wanted = COMPLEXITY_TIER[complexity];
    const order: ModelTier[] =
      wanted === 'fast'
        ? ['fast', 'balanced', 'frontier']
        : wanted === 'balanced'
          ? ['balanced', 'frontier', 'fast']
          : ['frontier', 'balanced', 'fast'];
    for (const tier of order) {
      const found = models.find((card) => card.tier === tier);
      if (found) return found;
    }
    return models[0] as ModelCard;
  }

  /** Estimated cost in USD for a usage amount on a model (0 when unknown). */
  costOf(modelId: string, inputTokens: number, outputTokens: number): number {
    const card = this.cards.get(modelId);
    if (!card) return 0;
    return (inputTokens * card.inputCostPerMTok + outputTokens * card.outputCostPerMTok) / 1_000_000;
  }
}
