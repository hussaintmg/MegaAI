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
import type { ChatMessage, CompletionRequest, CompletionResponse, ModelCard, ProviderKind } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Provider } from '@megaai/contracts';
import { BUILTIN_MODELS } from '../models.js';

/** Anthropic's Messages API content-block shape for one chat turn. */
function toAnthropicContent(content: ChatMessage['content']): string | Array<Record<string, unknown>> {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: part.data } },
  );
}

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
  private client?: Anthropic;

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
  }

  models(): ModelCard[] {
    return BUILTIN_MODELS.filter((card) => card.provider === 'anthropic');
  }

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  private getClient(): Anthropic {
    if (!this.client) {
      if (!this.options.apiKey) {
        throw new MegaError('PROVIDER_UNAVAILABLE', 'Anthropic provider has no API key configured');
      }
      this.client = new Anthropic({ apiKey: this.options.apiKey, baseURL: this.options.baseURL });
    }
    return this.client;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const client = this.getClient();
    const model = request.model ?? this.options.model ?? DEFAULT_MODEL;

    // Fold any system-role chat messages into the top-level system prompt;
    // the Messages API takes only user/assistant turns in `messages`.
    const systemParts: string[] = [];
    if (request.system) systemParts.push(request.system);
    const turns: Array<{ role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }> = [];
    for (const message of request.messages) {
      if (message.role === 'system') {
        systemParts.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      } else {
        turns.push({ role: message.role, content: toAnthropicContent(message.content) });
      }
    }
    if (turns.length === 0) turns.push({ role: 'user', content: '(empty)' });

    try {
      const response = await client.messages.create({
        model,
        max_tokens: request.maxTokens ?? this.options.maxTokens ?? 16_000,
        system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
        messages: turns as unknown as Anthropic.MessageParam[],
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
        throw new MegaError('PROVIDER_UNAVAILABLE', `Anthropic auth failed: ${err.message}`);
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
