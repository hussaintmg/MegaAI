/**
 * @megaai/types — the shared domain model of MegaAI.
 *
 * Every other package depends on this one and only on data shapes declared
 * here, which keeps the layer boundaries honest: modules talk to each other
 * through records and enums, not through concrete classes.
 */

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

export type Id = string;
/** Unix epoch milliseconds. */
export type Timestamp = number;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PERMISSION_DENIED'
  | 'POLICY_BLOCKED'
  | 'APPROVAL_REQUIRED'
  | 'RATE_LIMITED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REFUSED'
  | 'RESOURCE_EXHAUSTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERNAL';

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'RESOURCE_EXHAUSTED',
  'TIMEOUT',
]);

/** The one error type used across the whole system. */
export class MegaError extends Error {
  readonly code: ErrorCode;
  readonly details: JsonObject;

  constructor(code: ErrorCode, message: string, details: JsonObject = {}) {
    super(message);
    this.name = 'MegaError';
    this.code = code;
    this.details = details;
  }

  /** Whether a caller may reasonably retry (possibly elsewhere). */
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }

  static from(err: unknown, fallback: ErrorCode = 'INTERNAL'): MegaError {
    if (err instanceof MegaError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new MegaError(fallback, message);
  }
}

/* ------------------------------------------------------------------ *
 * Services, health, metrics
 * ------------------------------------------------------------------ */

export type ServiceState = 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthReport {
  service: string;
  status: HealthStatus;
  detail?: string;
  checkedAt: Timestamp;
}

/* ------------------------------------------------------------------ *
 * Resources
 * ------------------------------------------------------------------ */

export interface ResourceSnapshot {
  timestamp: Timestamp;
  cpuCount: number;
  /** 1-minute load average normalised by core count (0..N). */
  cpuLoad: number;
  memTotalBytes: number;
  memFreeBytes: number;
  memUsedPct: number;
  diskTotalBytes?: number;
  diskFreeBytes?: number;
  diskUsedPct?: number;
}

export type ResourcePressure = 'ok' | 'elevated' | 'critical';

/* ------------------------------------------------------------------ *
 * AI layer
 * ------------------------------------------------------------------ */

export type ProviderKind = 'anthropic' | 'openai' | 'gemini' | 'mock' | (string & {});

export type ModelTier = 'frontier' | 'balanced' | 'fast';

export interface ModelCard {
  /** Provider-native model id, e.g. `claude-opus-5`. */
  id: string;
  provider: ProviderKind;
  displayName: string;
  tier: ModelTier;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per million tokens. */
  inputCostPerMTok: number;
  outputCostPerMTok: number;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatTextPart {
  type: 'text';
  text: string;
}

/** An inline image, base64-encoded (no `data:` URI prefix). */
export interface ChatImagePart {
  type: 'image';
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  data: string;
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export interface ChatMessage {
  role: ChatRole;
  /** Plain text, or a multimodal part list (text + images) for vision-capable models. */
  content: string | ChatContentPart[];
}

export interface CompletionRequest {
  /** Preferred model id; the provider may substitute within the same tier. */
  model?: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens?: number;
  metadata?: JsonObject;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CompletionResponse {
  text: string;
  provider: ProviderKind;
  model: string;
  stopReason: string;
  usage: TokenUsage;
}

export type TaskComplexity = 'trivial' | 'standard' | 'complex' | 'frontier';

/** A short-lived reservation of provider + model capacity. */
export interface SessionLease {
  id: Id;
  provider: ProviderKind;
  model: string;
  purpose: string;
  complexity: TaskComplexity;
  acquiredAt: Timestamp;
}

export interface ProviderLimits {
  requestsPerMinute?: number;
  tokensPerDay?: number;
}

export interface ProviderUsageSummary {
  provider: ProviderKind;
  requestsInWindow: number;
  tokensToday: number;
  exhaustedUntil?: Timestamp;
}

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

export type ProjectStatus = 'draft' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type TaskState =
  | 'pending'
  | 'ready'
  | 'in-progress'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface ProjectRecord {
  id: Id;
  name: string;
  goal: string;
  status: ProjectStatus;
  /** 0..1 */
  progress: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  meta: JsonObject;
}

export interface MilestoneRecord {
  id: Id;
  projectId: Id;
  name: string;
  order: number;
}

export interface TaskRecord {
  id: Id;
  projectId: Id;
  milestoneId?: Id;
  title: string;
  description: string;
  /** Which agent kind should execute this task, e.g. `coding`. */
  agentKind: string;
  state: TaskState;
  priority: Priority;
  complexity: TaskComplexity;
  dependsOn: Id[];
  attempts: number;
  maxAttempts: number;
  result?: JsonValue;
  error?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A plan produced by the meta brain before it is materialised into records. */
export interface PlanSpec {
  projectName: string;
  domain: string;
  summary: string;
  phases: PlanPhase[];
  risks: string[];
  questionsForHuman: string[];
}

export interface PlanPhase {
  name: string;
  tasks: PlanTask[];
}

export interface PlanTask {
  title: string;
  description: string;
  agentKind: string;
  complexity: TaskComplexity;
  /** Titles of tasks (in earlier or same phase) this one depends on. */
  dependsOnTitles?: string[];
}

/* ------------------------------------------------------------------ *
 * Workflow
 * ------------------------------------------------------------------ */

export type WorkflowRunState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepState =
  | 'pending'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'rolled-back';

export interface StepRecord {
  id: Id;
  name: string;
  state: StepState;
  attempts: number;
  startedAt?: Timestamp;
  finishedAt?: Timestamp;
  error?: string;
  output?: JsonValue;
}

export interface WorkflowRunRecord {
  id: Id;
  workflowName: string;
  state: WorkflowRunState;
  steps: StepRecord[];
  context: JsonObject;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

export type AgentState = 'spawned' | 'running' | 'paused' | 'completed' | 'failed' | 'killed';

export interface AgentDescriptor {
  /** Stable kind, e.g. `coding`, `testing`, `research`. */
  kind: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool names this agent may request. */
  allowedTools: string[];
  defaultComplexity: TaskComplexity;
}

export interface AgentInstanceInfo {
  id: Id;
  kind: string;
  state: AgentState;
  taskId?: Id;
  spawnedAt: Timestamp;
  lastHeartbeatAt: Timestamp;
  restarts: number;
}

export interface AgentRunResult {
  ok: boolean;
  summary: string;
  output?: JsonValue;
  actions: ActionResult[];
  usage: TokenUsage;
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Actions & tools
 * ------------------------------------------------------------------ */

export interface ActionRequest {
  tool: string;
  input: JsonObject;
  reason?: string;
}

export interface ActionResult {
  tool: string;
  ok: boolean;
  output?: JsonValue;
  error?: string;
  durationMs: number;
}

/* ------------------------------------------------------------------ *
 * Policy & security
 * ------------------------------------------------------------------ */

export type PolicyEffect = 'allow' | 'deny' | 'require-approval';

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  matchedRules: string[];
  reasons: string[];
}

export interface AuditEntry {
  id: Id;
  timestamp: Timestamp;
  actor: string;
  action: string;
  target?: string;
  outcome: 'ok' | 'denied' | 'error';
  details: JsonObject;
}

/* ------------------------------------------------------------------ *
 * Memory
 * ------------------------------------------------------------------ */

export type MemoryScope =
  | 'conversation'
  | 'project'
  | 'agent'
  | 'code'
  | 'knowledge'
  | 'longterm'
  | 'temporary';

export interface MemoryRecord {
  id: Id;
  scope: MemoryScope;
  /** Optional grouping key, e.g. a project or agent id. */
  refId?: Id;
  text: string;
  tags: string[];
  createdAt: Timestamp;
  meta: JsonObject;
}

export interface MemorySearchHit {
  record: MemoryRecord;
  score: number;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface EventEnvelope<T = unknown> {
  id: Id;
  type: string;
  payload: T;
  source?: string;
  timestamp: Timestamp;
}

/**
 * Well-known event types. The bus accepts arbitrary strings; these constants
 * document the vocabulary shared across modules.
 */
export const Events = {
  // runtime
  ServiceStarted: 'runtime.service.started',
  ServiceStopped: 'runtime.service.stopped',
  ServiceFailed: 'runtime.service.failed',
  // resources
  ResourceSample: 'resources.sample',
  ResourcePressure: 'resources.pressure',
  // ai
  ProviderExhausted: 'ai.provider.exhausted',
  ProviderRecovered: 'ai.provider.recovered',
  SessionAcquired: 'ai.session.acquired',
  SessionReleased: 'ai.session.released',
  CompletionFinished: 'ai.completion.finished',
  // planning
  ProjectCreated: 'planning.project.created',
  ProjectUpdated: 'planning.project.updated',
  ProjectCompleted: 'planning.project.completed',
  TaskUpdated: 'planning.task.updated',
  // workflow
  WorkflowStarted: 'workflow.run.started',
  WorkflowFinished: 'workflow.run.finished',
  WorkflowPaused: 'workflow.run.paused',
  WorkflowResumed: 'workflow.run.resumed',
  StepStarted: 'workflow.step.started',
  StepFinished: 'workflow.step.finished',
  ApprovalRequested: 'workflow.approval.requested',
  ApprovalResolved: 'workflow.approval.resolved',
  // agents
  AgentSpawned: 'agents.instance.spawned',
  AgentStateChanged: 'agents.instance.state-changed',
  AgentHeartbeat: 'agents.instance.heartbeat',
  AgentRecovered: 'agents.instance.recovered',
  // actions
  ActionExecuted: 'actions.executed',
  ActionBlocked: 'actions.blocked',
  // security
  AuditRecorded: 'security.audit.recorded',
  // orchestrator
  GoalReceived: 'orchestrator.goal.received',
  GoalCompleted: 'orchestrator.goal.completed',
  GoalFailed: 'orchestrator.goal.failed',
  // meta brain
  DecisionMade: 'meta.decision.made',
  LessonLearned: 'meta.lesson.learned',
} as const;

export type KnownEventType = (typeof Events)[keyof typeof Events];
