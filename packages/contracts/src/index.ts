/**
 * @megaai/contracts — the interfaces modules implement for each other.
 *
 * Implementations live in their own packages (`@megaai/ai`, `@megaai/tools`,
 * `@megaai/agents`, …); everything upstream programs against these contracts,
 * which is what will later allow plugins to ship their own providers, tools
 * and agents without touching core code.
 */

import type {
  AgentDescriptor,
  AgentRunResult,
  ActionRequest,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  HealthStatus,
  JsonObject,
  JsonValue,
  LogLevel,
  ModelCard,
  ProviderKind,
  SessionLease,
  TaskRecord,
} from '@megaai/types';

/* ------------------------------------------------------------------ *
 * Services
 * ------------------------------------------------------------------ */

/** Anything with a lifecycle that the runtime container manages. */
export interface Service {
  readonly name: string;
  start?(): Promise<void> | void;
  stop?(): Promise<void> | void;
  health?(): Promise<HealthStatus> | HealthStatus;
}

/* ------------------------------------------------------------------ *
 * Logging (interface here so low-level packages can accept any logger)
 * ------------------------------------------------------------------ */

export interface LogFn {
  (message: string, fields?: JsonObject): void;
}

export interface LoggerLike {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(scope: string): LoggerLike;
  level?: LogLevel;
}

/* ------------------------------------------------------------------ *
 * AI providers
 * ------------------------------------------------------------------ */

/** A backend able to run chat completions (Anthropic, OpenAI, Gemini, mock…). */
export interface Provider {
  readonly kind: ProviderKind;
  readonly name: string;
  /** Models this provider can serve, best first. */
  models(): ModelCard[];
  /** Cheap synchronous availability check (configured, has credentials…). */
  isConfigured(): boolean;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

/** Handle returned by the session manager for running completions. */
export interface AiSession {
  readonly lease: SessionLease;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
  release(): void;
}

/* ------------------------------------------------------------------ *
 * Tools
 * ------------------------------------------------------------------ */

export interface ToolContext {
  /** Absolute directory all filesystem work must stay inside. */
  workspaceRoot: string;
  agentId?: string;
  taskId?: string;
  /** When true, tools must describe instead of act. */
  dryRun?: boolean;
  log?: LogFn;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON-schema-ish shape of the input, used in prompts and validation. */
  inputSchema: JsonObject;
  /** Permission tags checked against security + policy, e.g. `fs.write`. */
  permissions: string[];
}

export interface Tool extends ToolSpec {
  execute(input: JsonObject, ctx: ToolContext): Promise<JsonValue>;
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

/** Everything an agent implementation may use while running a task. */
export interface AgentContext {
  workspaceRoot: string;
  /** Rendered catalog of the tools this agent may call (for prompts). */
  toolCatalog: string;
  /** What the environment actually permits right now (shell on/off, …). */
  capabilities?: { shell?: boolean };
  session: AiSession;
  /** Executes model-proposed actions through policy + tools. */
  act(actions: ActionRequest[]): Promise<AgentRunResult['actions']>;
  remember(text: string, tags?: string[]): Promise<void>;
  recall(query: string, limit?: number): Promise<string[]>;
  buildContext(task: TaskRecord): Promise<string>;
  buildMessages(task: TaskRecord, contextText: string): ChatMessage[];
  log: LogFn;
  signal?: AbortSignal;
}

export interface AgentImplementation {
  readonly descriptor: AgentDescriptor;
  run(task: TaskRecord, ctx: AgentContext): Promise<AgentRunResult>;
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

export interface KeyValueStore {
  get<T extends JsonValue>(key: string): Promise<T | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
}

/** Document collection with ids. */
export interface Collection<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  put(doc: T): Promise<void>;
  delete(id: string): Promise<boolean>;
  all(): Promise<T[]>;
  find(predicate: (doc: T) => boolean): Promise<T[]>;
}

export interface Database {
  kv(namespace: string): KeyValueStore;
  collection<T extends { id: string }>(name: string): Collection<T>;
  flush(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Event bus (interface for packages that only publish)
 * ------------------------------------------------------------------ */

export interface EventPublisher {
  emit<T>(type: string, payload: T, source?: string): void;
}
