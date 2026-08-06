/**
 * AnthropicProvider — Claude adapter built on the official
 * `@anthropic-ai/sdk`. Defaults to `claude-opus-5`.
 *
 * Refusals surface as PROVIDER_REFUSED and rate limits as RATE_LIMITED so
 * the session manager can walk MegaAI's own provider fallback chain
 * (Anthropic → OpenAI-compatible → Gemini → mock), which is the recovery
 * behaviour this system is designed around.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { CompletionRequest, CompletionResponse, ModelCard, ProviderKind } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Provider } from '@megaai/contracts';
import { BUILTIN_MODELS } from '../models.js';
import { KeyRing, collectKeys } from '../keyring.js';

export interface AnthropicProviderOptions {
  apiKey?: string;
  /** Default model when a request does not name one. */
  model?: string;
  maxTokens?: number;
  baseURL?: string;
}

const DEFAULT_MODEL = 'claude-opus-5';

export class AnthropicProvider implements Provider {
  readonly kind: ProviderKind = 'anthropic';
  readonly name = 'Anthropic (Claude)';
  private readonly options: AnthropicProviderOptions;
  /** One client per key — the SDK binds the key at construction. */
  private readonly clients = new Map<number, Anthropic>();
  readonly keys: KeyRing;

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
    this.keys = new KeyRing(collectKeys(options));
  }

  models(): ModelCard[] {
    return BUILTIN_MODELS.filter((card) => card.provider === 'anthropic');
  }

  isConfigured(): boolean {
    return this.keys.size > 0;
  }

  private clientFor(index: number, apiKey: string): Anthropic {
    let client = this.clients.get(index);
    if (!client) {
      client = new Anthropic({ apiKey, baseURL: this.options.baseURL });
      this.clients.set(index, client);
    }
    return client;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.keys.size === 0) {
      throw new MegaError('PROVIDER_UNAVAILABLE', 'Anthropic provider has no API key configured');
    }
    for (;;) {
      const active = this.keys.current();
      if (!active) {
        const readyAt = this.keys.readyAt();
        throw new MegaError('RATE_LIMITED', `Anthropic: ${this.keys.explain()}`, {
          ...(readyAt ? { retryAfterMs: Math.max(0, readyAt - Date.now()) } : {}),
        });
      }
      try {
        return await this.attempt(request, this.clientFor(active.index, active.key));
      } catch (error) {
        if (!(error instanceof MegaError)) throw error;
        const retryAfterMs = typeof error.details['retryAfterMs'] === 'number' ? error.details['retryAfterMs'] : undefined;
        if (error.code === 'RATE_LIMITED') {
          this.keys.park(active.index, error.message, retryAfterMs ? Date.now() + retryAfterMs : undefined);
        } else if (error.code === 'PERMISSION_DENIED') {
          this.keys.reject(active.index, error.message);
        } else {
          throw error;
        }
        if (!this.keys.hasAnother(active.index)) {
          const readyAt = this.keys.readyAt();
          throw new MegaError(error.code, `Anthropic: ${this.keys.explain()}`, {
            ...(readyAt ? { retryAfterMs: Math.max(0, readyAt - Date.now()) } : {}),
          });
        }
      }
    }
  }

  private async attempt(request: CompletionRequest, client: Anthropic): Promise<CompletionResponse> {
    const model = request.model ?? this.options.model ?? DEFAULT_MODEL;

    // Fold any system-role chat messages into the top-level system prompt;
    // the Messages API takes only user/assistant turns in `messages`.
    const systemParts: string[] = [];
    if (request.system) systemParts.push(request.system);
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const message of request.messages) {
      if (message.role === 'system') systemParts.push(message.content);
      else turns.push({ role: message.role, content: message.content });
    }
    if (turns.length === 0) turns.push({ role: 'user', content: '(empty)' });

    try {
      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens ?? this.options.maxTokens ?? 16_000,
        system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
        messages: turns,
      });

      if (response.stop_reason === 'refusal') {
        // Let the session manager fail over to the next provider in the chain.
        throw new MegaError('PROVIDER_REFUSED', 'Anthropic declined this request (stop_reason=refusal)', {
          model,
        });
      }

      const text = response.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('');

      return {
        text,
        provider: this.kind,
        model: response.model,
        stopReason: response.stop_reason ?? 'end_turn',
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof MegaError) throw err;
      if (err instanceof Anthropic.RateLimitError) {
        throw new MegaError('RATE_LIMITED', `Anthropic rate limited: ${err.message}`);
      }
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        // A key problem, not a provider problem — one bad key must not take
        // Anthropic down when others are configured.
        throw new MegaError('PERMISSION_DENIED', `Anthropic rejected this key: ${err.message}`);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new MegaError('PROVIDER_UNAVAILABLE', `Anthropic unreachable: ${err.message}`);
      }
      if (err instanceof Anthropic.APIError && typeof err.status === 'number' && err.status >= 500) {
        throw new MegaError('PROVIDER_UNAVAILABLE', `Anthropic server error ${err.status}: ${err.message}`);
      }
      throw new MegaError('INTERNAL', `Anthropic request failed: ${String(err)}`);
    }
  }
}
