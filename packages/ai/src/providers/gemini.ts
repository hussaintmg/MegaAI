/**
 * GeminiProvider — adapter for Google's Generative Language API
 * (`models/<id>:generateContent`).
 */

import type { CompletionRequest, CompletionResponse, ModelCard, ProviderKind } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { retryAfterFrom } from '../retry-after.js';
import { KeyRing, collectKeys } from '../keyring.js';
import type { Provider } from '@megaai/contracts';
import { BUILTIN_MODELS } from '../models.js';

export interface GeminiProviderOptions {
  apiKey?: string;
  /**
   * Several keys, used one after another.
   *
   * A key that hits its per-minute limit costs a key, not the provider: the
   * next one takes over inside the same request, and Gemini only reports a
   * rate limit upwards when every key it has is spent.
   */
  apiKeys?: string[];
  model?: string;
  baseURL?: string;
  maxTokens?: number;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

export class GeminiProvider implements Provider {
  readonly kind: ProviderKind = 'gemini';
  readonly name = 'Google Gemini';
  private readonly options: GeminiProviderOptions;
  readonly keys: KeyRing;

  constructor(options: GeminiProviderOptions = {}) {
    this.options = options;
    this.keys = new KeyRing(collectKeys(options));
  }

  models(): ModelCard[] {
    return BUILTIN_MODELS.filter((card) => card.provider === 'gemini');
  }

  isConfigured(): boolean {
    return this.keys.size > 0;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.keys.size === 0) {
      throw new MegaError('PROVIDER_UNAVAILABLE', 'Gemini provider has no API key configured');
    }
    // Every key gets a turn before the caller is told Gemini is out. One
    // spent key while two sit unused is the whole reason this loop exists.
    for (;;) {
      const active = this.keys.current();
      if (!active) {
        const readyAt = this.keys.readyAt();
        throw new MegaError('RATE_LIMITED', `Gemini: ${this.keys.explain()}`, {
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
          // A wrong key does not get better by waiting, and retrying a typo
          // every minute for a week helps nobody.
          this.keys.reject(active.index, error.message);
        } else {
          throw error;
        }
        if (!this.keys.hasAnother(active.index)) {
          const readyAt = this.keys.readyAt();
          throw new MegaError(error.code, `Gemini: ${this.keys.explain()}`, {
            ...(readyAt ? { retryAfterMs: Math.max(0, readyAt - Date.now()) } : {}),
          });
        }
      }
    }
  }

  private async attempt(request: CompletionRequest, apiKey: string): Promise<CompletionResponse> {
    const model = request.model ?? this.options.model ?? 'gemini-2.5-pro';
    const base = this.options.baseURL ?? 'https://generativelanguage.googleapis.com';
    const url = `${base}/v1beta/models/${model}:generateContent`;

    const contents = request.messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }],
      }));
    const systemText = [request.system, ...request.messages.filter((m) => m.role === 'system').map((m) => m.content)]
      .filter(Boolean)
      .join('\n\n');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents,
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          generationConfig: { maxOutputTokens: request.maxTokens ?? this.options.maxTokens ?? 16_000 },
        }),
      });
    } catch (err) {
      throw new MegaError('PROVIDER_UNAVAILABLE', `Gemini unreachable: ${String(err)}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 429) {
        // Google puts the wait in the body as RetryInfo.retryDelay ("27s").
        // Carrying it means the session manager waits that long and tries
        // again, instead of writing the provider off for a flat minute.
        const retryAfterMs = retryAfterFrom(response.headers, body);
        throw new MegaError(
          'RATE_LIMITED',
          `Gemini rate limited${retryAfterMs ? ` — retry in ${Math.ceil(retryAfterMs / 1000)}s` : ''}`,
          retryAfterMs ? { retryAfterMs } : {},
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new MegaError('PERMISSION_DENIED', `Gemini rejected this key (${response.status}): ${body.slice(0, 200)}`);
      }
      const code = response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'INTERNAL';
      throw new MegaError(code, `Gemini error ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as GenerateContentResponse;
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    return {
      text,
      provider: this.kind,
      model,
      stopReason: candidate?.finishReason ?? 'STOP',
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}
