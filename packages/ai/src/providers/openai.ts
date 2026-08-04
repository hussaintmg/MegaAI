/**
 * OpenAICompatProvider — adapter for OpenAI-style `/v1/chat/completions`
 * endpoints. Because it is base-URL configurable it also covers
 * Codex/OpenCode-style backends that speak the same wire protocol.
 */

import type { ChatMessage, CompletionRequest, CompletionResponse, ModelCard, ProviderKind } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Provider } from '@megaai/contracts';
import { BUILTIN_MODELS } from '../models.js';

type OpenAiContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

/** MegaAI's provider-agnostic content parts → OpenAI chat content parts. */
function toOpenAiContent(content: ChatMessage['content']): string | OpenAiContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((part): OpenAiContentPart =>
    part.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }
      : { type: 'text', text: part.text },
  );
}

export interface OpenAICompatOptions {
  apiKey?: string;
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

  constructor(options: OpenAICompatOptions = {}) {
    this.options = options;
    this.kind = options.kind ?? 'openai';
    this.name = options.name ?? 'OpenAI-compatible endpoint';
  }

  models(): ModelCard[] {
    return BUILTIN_MODELS.filter((card) => card.provider === this.kind);
  }

  isConfigured(): boolean {
    return Boolean(this.options.apiKey);
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (!this.options.apiKey) {
      throw new MegaError('PROVIDER_UNAVAILABLE', `${this.name} has no API key configured`);
    }
    const model = request.model ?? this.options.model ?? 'gpt-5';
    const url = `${this.options.baseURL ?? 'https://api.openai.com'}/v1/chat/completions`;
    const messages = [
      ...(request.system ? [{ role: 'system', content: request.system }] : []),
      ...request.messages.map((message) => ({ role: message.role, content: toOpenAiContent(message.content) })),
    ];

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
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

    if (response.status === 429) throw new MegaError('RATE_LIMITED', `${this.name} rate limited`);
    if (response.status === 401 || response.status === 403) {
      throw new MegaError('PROVIDER_UNAVAILABLE', `${this.name} auth failed (${response.status})`);
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
