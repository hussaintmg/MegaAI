/**
 * OpenAICompatProvider — adapter for OpenAI-style `/v1/chat/completions`
 * endpoints. Because it is base-URL configurable it also covers
 * Codex/OpenCode-style backends that speak the same wire protocol.
 */

import type { CompletionRequest, CompletionResponse, ModelCard, ProviderKind } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { retryAfterFrom } from '../retry-after.js';
import { KeyRing, collectKeys } from '../keyring.js';
import type { Provider } from '@megaai/contracts';
import { BUILTIN_MODELS } from '../models.js';

export interface OpenAICompatOptions {
  apiKey?: string;
  /** Several keys, tried one after another before the provider gives up. */
  apiKeys?: string[];
  model?: string;
  baseURL?: string;
  maxTokens?: number;
  kind?: ProviderKind;
  name?: string;
}

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatProvider implements Provider {
  readonly kind: ProviderKind;
  readonly name: string;
  private readonly options: OpenAICompatOptions;

  readonly keys: KeyRing;

  constructor(options: OpenAICompatOptions = {}) {
    this.options = options;
    this.kind = options.kind ?? 'openai';
    this.name = options.name ?? 'OpenAI-compatible endpoint';
    this.keys = new KeyRing(collectKeys(options));
  }

  models(): ModelCard[] {
    return BUILTIN_MODELS.filter((card) => card.provider === this.kind);
  }

  isConfigured(): boolean {
    return this.keys.size > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.keys.size === 0) {
      throw new MegaError('PROVIDER_UNAVAILABLE', `${this.name} has no API key configured`);
    }
    for (;;) {
      const active = this.keys.current();
      if (!active) {
        const readyAt = this.keys.readyAt();
        throw new MegaError('RATE_LIMITED', `${this.name}: ${this.keys.explain()}`, {
          ...(readyAt ? { retryAfterMs: Math.max(0, readyAt - Date.now()) } : {}),
        });
      }
      try {
        return await this.attempt(request, active.key);
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
          throw new MegaError(error.code, `${this.name}: ${this.keys.explain()}`, {
            ...(readyAt ? { retryAfterMs: Math.max(0, readyAt - Date.now()) } : {}),
          });
        }
      }
    }
  }

  private async attempt(request: CompletionRequest, apiKey: string): Promise<CompletionResponse> {
    const model = request.model ?? this.options.model ?? 'gpt-5';
    const url = `${this.options.baseURL ?? 'https://api.openai.com'}/v1/chat/completions`;
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages,
    ];

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_completion_tokens: request.maxTokens ?? this.options.maxTokens ?? 16_000,
        }),
      });
    } catch (err) {
      throw new MegaError('PROVIDER_UNAVAILABLE', `${this.name} unreachable: ${String(err)}`);
    }

    if (response.status === 429) {
      const body = await response.text().catch(() => '');
      const retryAfterMs = retryAfterFrom(response.headers, body);
      throw new MegaError(
        'RATE_LIMITED',
        `${this.name} rate limited${retryAfterMs ? ` — retry in ${Math.ceil(retryAfterMs / 1000)}s` : ''}`,
        retryAfterMs ? { retryAfterMs } : {},
      );
    }
    if (response.status === 401 || response.status === 403) {
      // Named as a key problem, not a provider problem: with several keys
      // configured, one bad paste must not take the whole provider down.
      throw new MegaError('PERMISSION_DENIED', `${this.name} rejected this key (${response.status})`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const code = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'INTERNAL';
      throw new MegaError(code, `${this.name} error ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? '',
      provider: this.kind,
      model: data.model ?? model,
      stopReason: choice?.finish_reason ?? 'stop',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    };
  }
}
