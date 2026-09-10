/**
 * @megaai/config — layered configuration.
 *
 * Precedence (later wins): built-in defaults → config file (JSON) →
 * environment variables → explicit overrides. The result is validated before
 * anything else boots, so misconfiguration fails fast and loudly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MegaError, type JsonObject, type LogLevel } from '@megaai/types';
import { deepMerge, isPlainObject } from '@megaai/utils';

export interface ProviderConfig {
  enabled: boolean;
  apiKey?: string;
  /**
   * More keys for the same provider, all used.
   *
   * Free tiers are per key, so three Gemini keys is three times the
   * allowance — but only if a spent key costs a key rather than the whole
   * provider. The provider rotates through these before reporting a limit.
   */
  apiKeys?: string[];
  /** Preferred default model id for this provider. */
  model?: string;
  requestsPerMinute?: number;
  tokensPerDay?: number;
}

export interface MegaConfig {
  system: {
    name: string;
    /** Where MegaAI keeps its own state (json db, learning, checkpoints). */
    dataDir: string;
    /** Where agents are allowed to create project files. */
    workspaceRoot: string;
  };
  logging: {
    level: LogLevel;
    pretty: boolean;
  };
  ai: {
    /** Order in which providers are tried when one is exhausted or fails. */
    fallbackChain: string[];
    maxTokens: number;
    providers: Record<string, ProviderConfig>;
  };
  resources: {
    sampleIntervalMs: number;
    memElevatedPct: number;
    memCriticalPct: number;
    cpuElevatedLoad: number;
    cpuCriticalLoad: number;
  };
  policy: {
    /** When true, approval-gated steps resolve automatically (demo mode). */
    autoApprove: boolean;
    /** Tool permissions that always require human approval. */
    approvalRequiredPermissions: string[];
    /** Tool permissions that are denied outright. */
    deniedPermissions: string[];
  };
  workflow: {
    maxStepAttempts: number;
    stepRetryBaseMs: number;
  };
  agents: {
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    maxRestarts: number;
    maxConcurrent: number;
  };
  security: {
    allowShell: boolean;
    shellAllowlist: string[];
    httpAllowedHosts: string[];
    /** When true, browser.* tools try the real Playwright driver. */
    allowBrowser: boolean;
    browserAllowedHosts: string[];
    /** Hosts `git.push` may target. Empty means unrestricted (approval gate still applies). */
    gitRemoteAllowlist: string[];
  };
  server: {
    host: string;
    port: number;
  };
  deploy: {
    /** simulated | static | docker | vercel | railway */
    defaultTarget: string;
    /** Provider tokens for real deploys (redacted in logs/results). */
    vercelToken: string;
    railwayToken: string;
  };
  comm: {
    /** Channel for operator notifications: 'captured' | 'webhook' | 'email' | 'none'. */
    notifyChannel: string;
    /** If set, a 'webhook' channel POSTs notifications here. */
    webhookUrl: string;
    allowedHosts: string[];
    notifyEvents: string[];
    /** Native email: when `from` is set an 'email' channel is registered. */
    email: {
      from: string;
      to: string;
      /** HTTP email-API endpoint (SendGrid/Postmark-style) to POST to. */
      apiUrl: string;
      /** Bearer token / API key for the email API (sent as Authorization). */
      apiKey: string;
      /** SMTP host (uses the optional nodemailer transport when set). */
      smtpHost: string;
      allowedHosts: string[];
    };
  };
  meta: {
    /** 'template' (deterministic) or 'model' (ask the AI to plan). */
    planner: string;
  };
}

export function defaultConfig(): MegaConfig {
  return {
    system: {
      name: 'MegaAI',
      dataDir: '.megaai',
      workspaceRoot: 'workspace',
    },
    logging: { level: 'info', pretty: true },
    ai: {
      fallbackChain: ['anthropic', 'openai', 'gemini', 'openrouter', 'groq', 'mock'],
      maxTokens: 16_000,
      providers: {
        // Free-tier request rates, because that is what a first key is. The
        // engine now queues against these instead of bursting past them and
        // taking a 429 — set your real allowance in Settings if you pay for
        // more. Guessing high costs a rate limit; guessing low costs seconds.
        anthropic: { enabled: true, model: 'claude-opus-5', requestsPerMinute: 50 },
        openai: { enabled: true, requestsPerMinute: 50 },
        gemini: { enabled: true, model: 'gemini-2.5-flash', requestsPerMinute: 10 },
        openrouter: { enabled: true, model: 'openai/gpt-4o-mini', requestsPerMinute: 20 },
        groq: { enabled: true, model: 'llama-3.3-70b-versatile', requestsPerMinute: 30 },
        mock: { enabled: true },
      },
    },
    resources: {
      sampleIntervalMs: 5_000,
      memElevatedPct: 80,
      memCriticalPct: 92,
      cpuElevatedLoad: 0.85,
      cpuCriticalLoad: 1.2,
    },
    policy: {
      autoApprove: false,
      approvalRequiredPermissions: ['deploy', 'shell.exec', 'comm.send', 'git.push'],
      deniedPermissions: [],
    },
    workflow: { maxStepAttempts: 3, stepRetryBaseMs: 250 },
    agents: {
      heartbeatIntervalMs: 1_000,
      heartbeatTimeoutMs: 10_000,
      maxRestarts: 2,
      maxConcurrent: 4,
    },
    security: {
      allowShell: false,
      shellAllowlist: ['node', 'npm', 'git', 'ls', 'cat'],
      httpAllowedHosts: [],
      allowBrowser: false,
      browserAllowedHosts: [],
      gitRemoteAllowlist: [],
    },
    server: { host: '127.0.0.1', port: 4100 },
    deploy: { defaultTarget: 'simulated', vercelToken: '', railwayToken: '' },
    comm: {
      notifyChannel: 'captured',
      webhookUrl: '',
      allowedHosts: [],
      notifyEvents: [
        'orchestrator.goal.completed',
        'orchestrator.goal.failed',
        'workflow.approval.requested',
        'planning.project.completed',
      ],
      email: { from: '', to: '', apiUrl: '', apiKey: '', smtpHost: '', allowedHosts: [] },
    },
    meta: { planner: 'template' },
  };
}

export interface LoadConfigOptions {
  /** Path to a JSON config file; `megaai.config.json` is picked up if present. */
  file?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: JsonObject;
  cwd?: string;
}

/** Map recognised environment variables onto config paths. */
function envOverrides(env: NodeJS.ProcessEnv): JsonObject {
  const out: JsonObject = {};
  const setPath = (path: string[], value: string | number | boolean) => {
    let node: JsonObject = out;
    for (const key of path.slice(0, -1)) {
      const next = node[key];
      if (isPlainObject(next)) node = next as JsonObject;
      else {
        const created: JsonObject = {};
        node[key] = created;
        node = created;
      }
    }
    node[path[path.length - 1] as string] = value;
  };

  if (env.MEGAAI_LOG_LEVEL) setPath(['logging', 'level'], env.MEGAAI_LOG_LEVEL);
  if (env.MEGAAI_DATA_DIR) setPath(['system', 'dataDir'], env.MEGAAI_DATA_DIR);
  if (env.MEGAAI_WORKSPACE) setPath(['system', 'workspaceRoot'], env.MEGAAI_WORKSPACE);
  if (env.MEGAAI_SERVER_PORT) setPath(['server', 'port'], Number(env.MEGAAI_SERVER_PORT));
  if (env.MEGAAI_AUTO_APPROVE) setPath(['policy', 'autoApprove'], env.MEGAAI_AUTO_APPROVE === 'true');
  if (env.ANTHROPIC_API_KEY) setPath(['ai', 'providers', 'anthropic', 'apiKey'], env.ANTHROPIC_API_KEY);
  if (env.OPENAI_API_KEY) setPath(['ai', 'providers', 'openai', 'apiKey'], env.OPENAI_API_KEY);
  if (env.GEMINI_API_KEY) setPath(['ai', 'providers', 'gemini', 'apiKey'], env.GEMINI_API_KEY);
  if (env.OPENROUTER_API_KEY) setPath(['ai', 'providers', 'openrouter', 'apiKey'], env.OPENROUTER_API_KEY);
  if (env.GROQ_API_KEY) setPath(['ai', 'providers', 'groq', 'apiKey'], env.GROQ_API_KEY);
  if (env.VERCEL_TOKEN) setPath(['deploy', 'vercelToken'], env.VERCEL_TOKEN);
  if (env.RAILWAY_TOKEN) setPath(['deploy', 'railwayToken'], env.RAILWAY_TOKEN);
  return out;
}

const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

export function validateConfig(config: MegaConfig): void {
  const problems: string[] = [];
  if (!config.system.name) problems.push('system.name must not be empty');
  if (!LOG_LEVELS.includes(config.logging.level)) {
    problems.push(`logging.level must be one of ${LOG_LEVELS.join(', ')}`);
  }
  if (!Array.isArray(config.ai.fallbackChain) || config.ai.fallbackChain.length === 0) {
    problems.push('ai.fallbackChain must list at least one provider');
  }
  for (const name of config.ai.fallbackChain) {
    if (!config.ai.providers[name]) problems.push(`ai.fallbackChain references unknown provider "${name}"`);
  }
  if (config.ai.maxTokens < 256) problems.push('ai.maxTokens must be at least 256');
  if (config.workflow.maxStepAttempts < 1) problems.push('workflow.maxStepAttempts must be >= 1');
  if (config.agents.maxConcurrent < 1) problems.push('agents.maxConcurrent must be >= 1');
  if (!Number.isInteger(config.server.port) || config.server.port < 1 || config.server.port > 65_535) {
    problems.push('server.port must be a valid TCP port');
  }
  if (problems.length > 0) {
    throw new MegaError('INVALID_INPUT', `Invalid configuration: ${problems.join('; ')}`, {
      problems,
    });
  }
}

export function loadConfig(options: LoadConfigOptions = {}): MegaConfig {
  const cwd = options.cwd ?? process.cwd();
  let merged = defaultConfig() as unknown as Record<string, unknown>;

  const filePath = options.file ?? resolve(cwd, 'megaai.config.json');
  if (existsSync(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new MegaError('INVALID_INPUT', `Could not parse config file ${filePath}: ${String(err)}`);
    }
    if (!isPlainObject(parsed)) {
      throw new MegaError('INVALID_INPUT', `Config file ${filePath} must contain a JSON object`);
    }
    merged = deepMerge(merged, parsed);
  } else if (options.file) {
    throw new MegaError('NOT_FOUND', `Config file not found: ${filePath}`);
  }

  merged = deepMerge(merged, envOverrides(options.env ?? process.env));
  if (options.overrides) merged = deepMerge(merged, options.overrides);

  const config = merged as unknown as MegaConfig;
  // Resolve relative dirs against cwd so every module sees absolute paths.
  config.system.dataDir = resolve(cwd, config.system.dataDir);
  config.system.workspaceRoot = resolve(cwd, config.system.workspaceRoot);
  validateConfig(config);
  return config;
}
