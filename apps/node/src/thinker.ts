/**
 * The one thing MegaAI's own model is allowed to do: think.
 *
 * It plans the work and writes the briefs. It does not open a file, it does not
 * edit a line, and nothing it produces is ever committed. Every line of code
 * comes from Claude Code, Codex or OpenCode, which is the whole point — those
 * are the agents that are actually good at it, and they are already paid for.
 *
 * Planning is one long call a few times a night, so any of the free tiers is
 * plenty. Whatever keys the machine has are tried in order, and a provider that
 * is rate-limited or has no key steps aside for the next one rather than
 * stopping the night.
 */

import { GeminiProvider, OpenAICompatProvider, AnthropicProvider } from '@megaai/ai';
import type { Provider } from '@megaai/contracts';

export interface ThinkerOptions {
  env?: NodeJS.ProcessEnv;
  /** Overrides the whole chain — used by the tests. */
  providers?: Provider[];
}

/** Every key for one provider: `GEMINI_API_KEY`, then `GEMINI_API_KEY_2`, … */
export function keysFor(env: NodeJS.ProcessEnv, base: string): string[] {
  const keys: string[] = [];
  const add = (value: string | undefined): void => {
    const trimmed = value?.trim();
    if (trimmed && !keys.includes(trimmed)) keys.push(trimmed);
  };
  add(env[base]);
  // Both spellings, because both are what people actually type.
  for (let index = 2; index <= 9; index += 1) {
    add(env[`${base}_${index}`]);
    add(env[`${base}${index}`]);
  }
  // And a comma-separated list in the one variable, which is what a settings
  // page tends to produce.
  for (const part of (env[base] ?? '').split(',')) add(part);
  return keys;
}

/**
 * The providers this machine can think with, best-value first.
 *
 * Gemini leads because its free tier is generous and a planning call is long
 * but rare. The paid ones are last: spending Claude's quota on planning is
 * spending it on the wrong thing, since Claude Code needs it to write the code.
 */
export function buildProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const providers: Provider[] = [];
  const gemini = keysFor(env, 'GEMINI_API_KEY');
  if (gemini.length > 0) providers.push(new GeminiProvider({ apiKeys: gemini, model: env['MEGAAI_PLANNER_MODEL'] || undefined }));

  const openrouter = keysFor(env, 'OPENROUTER_API_KEY');
  if (openrouter.length > 0) {
    providers.push(
      new OpenAICompatProvider({
        kind: 'openrouter',
        name: 'OpenRouter',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKeys: openrouter,
      }),
    );
  }

  const groq = keysFor(env, 'GROQ_API_KEY');
  if (groq.length > 0) {
    providers.push(
      new OpenAICompatProvider({ kind: 'groq', name: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKeys: groq }),
    );
  }

  const openai = keysFor(env, 'OPENAI_API_KEY');
  if (openai.length > 0) {
    providers.push(
      new OpenAICompatProvider({ kind: 'openai', name: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKeys: openai }),
    );
  }

  // Last, and only the first key: this is the quota Claude Code needs to write
  // the code with, and spending it on planning is spending it on the wrong job.
  const anthropic = keysFor(env, 'ANTHROPIC_API_KEY');
  if (anthropic[0]) providers.push(new AnthropicProvider({ apiKey: anthropic[0] }));

  return providers.filter((provider) => provider.isConfigured());
}

export const PLANNER_SYSTEM =
  'You are a senior engineer planning work for a team of coding agents. ' +
  'You never write code — you decide what gets built and how it is judged. ' +
  'When asked for JSON, answer with JSON and nothing else.';

export interface Thinker {
  think: (prompt: string) => Promise<string>;
  /** Named providers, for `status` to show. */
  describe: () => string;
}

/**
 * A thinker over whatever is configured.
 *
 * Failing with the reason from every provider matters here: "planning is
 * unavailable" tells you nothing, while "Gemini: all 2 keys are rate limited
 * until 19:40; OpenRouter: 401" tells you exactly which key to go and fix.
 */
export function createThinker(options: ThinkerOptions = {}): Thinker {
  const providers = options.providers ?? buildProviders(options.env);

  return {
    describe: () =>
      providers.length === 0
        ? 'none — set GEMINI_API_KEY (or OPENROUTER_API_KEY / GROQ_API_KEY) so goals can be planned'
        : providers.map((provider) => provider.name).join(', '),

    think: async (prompt: string): Promise<string> => {
      if (providers.length === 0) {
        throw new Error(
          'no planning model is configured on this machine — run `megaai-node set GEMINI_API_KEY <key>` ' +
            '(OpenRouter and Groq work too, and their free tiers are enough for planning)',
        );
      }
      const failures: string[] = [];
      for (const provider of providers) {
        try {
          const response = await provider.complete({
            system: PLANNER_SYSTEM,
            messages: [{ role: 'user', content: prompt }],
            maxTokens: 8_000,
          });
          if (response.text.trim()) return response.text;
          failures.push(`${provider.name}: answered with nothing`);
        } catch (error) {
          failures.push(`${provider.name}: ${(error as Error).message}`);
        }
      }
      throw new Error(failures.join('; '));
    },
  };
}
