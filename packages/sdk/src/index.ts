/**
 * @megaai/sdk — one call bootstraps the whole system.
 *
 *   const megaai = createMegaAI();
 *   await megaai.start();
 *   const result = await megaai.submitGoal('Build this client an ecommerce store');
 *
 * Everything is composed here: config → logging → events → storage →
 * security → resources → AI sessions → memory → policy → planning →
 * workflow → tools → context → meta brain → orchestrator.
 */

import { join } from 'node:path';
import type { JsonObject } from '@megaai/types';
import { type Clock, systemClock } from '@megaai/utils';
import { loadConfig, type LoadConfigOptions, type MegaConfig } from '@megaai/config';
import { ConsoleSink, createLogger, Logger, MemorySink, type LogSink } from '@megaai/logger';
import { createEventBus, EventBus } from '@megaai/events';
import { JsonFileDatabase, MemoryDatabase, type Database } from '@megaai/database';
import { AuditLog, PermissionManager, SecretVault } from '@megaai/security';
import { MetricsRegistry, Scheduler, ServiceContainer } from '@megaai/runtime';
import { ResourceMonitor } from '@megaai/resources';
import {
  AiSessionManager,
  AnthropicProvider,
  GeminiProvider,
  LimitTracker,
  MockProvider,
  ModelRegistry,
  OpenAICompatProvider,
  ProviderRegistry,
} from '@megaai/ai';
import { KnowledgeBase, MemoryEngine } from '@megaai/memory';
import { ApprovalManager, PolicyEngine } from '@megaai/policy';
import { PlanningService } from '@megaai/planning';
import { WorkflowEngine } from '@megaai/workflow';
import { createCommandRunner, createToolRegistry, ToolRegistry } from '@megaai/tools';
import { createGitTools, GitEngine } from '@megaai/code';
import { BrowserEngine, createBrowserTools } from '@megaai/browser';
import { createVisionTools, VisionTester } from '@megaai/vision';
import { createModelTools, loadRegistry, ModelRegistry as ModelPackRegistry } from '@megaai/models';
import { createDesktopTools, DesktopEngine } from '@megaai/desktop';
import { CrmEngine, createCrmTools } from '@megaai/crm';
import { createJobsTools, JobsEngine } from '@megaai/jobs';
import { createDeployTools, DeployEngine, type DeployTarget } from '@megaai/deploy';
import {
  CapturedChannel,
  CommEngine,
  createCommTool,
  createHttpEmailTransport,
  createSmtpTransport,
  EmailChannel,
  NotificationEngine,
  WebhookChannel,
} from '@megaai/comm';
import { ContextEngine } from '@megaai/context';
import { MetaBrain } from '@megaai/meta-brain';
import { Orchestrator, type GoalResult } from '@megaai/orchestrator';
import { createBuiltinAgents } from '@megaai/agents';
import type { AgentImplementation, Provider, Tool } from '@megaai/contracts';

export interface MegaAIOptions {
  /** Config file / env / overrides — see @megaai/config. */
  configOptions?: LoadConfigOptions;
  configOverrides?: JsonObject;
  /** false = in-memory state (tests, throwaway runs). Default: persistent. */
  persistent?: boolean;
  /** Suppress console logging (memory sink stays on for the dashboard). */
  quiet?: boolean;
  extraSinks?: LogSink[];
  extraProviders?: Provider[];
  extraAgents?: AgentImplementation[];
  extraTools?: Tool[];
  clock?: Clock;
}

export interface MegaAI {
  config: MegaConfig;
  logger: Logger;
  logBuffer: MemorySink;
  bus: EventBus;
  database: Database;
  container: ServiceContainer;
  scheduler: Scheduler;
  metrics: MetricsRegistry;
  vault: SecretVault;
  permissions: PermissionManager;
  audit: AuditLog;
  resources: ResourceMonitor;
  sessions: AiSessionManager;
  memory: MemoryEngine;
  knowledge: KnowledgeBase;
  policy: PolicyEngine;
  approvals: ApprovalManager;
  planning: PlanningService;
  workflow: WorkflowEngine;
  tools: ToolRegistry;
  contextEngine: ContextEngine;
  meta: MetaBrain;
  comm: CommEngine;
  notifications: NotificationEngine;
  vision: VisionTester;
  models: ModelPackRegistry;
  desktop: DesktopEngine;
  crm: CrmEngine;
  jobs: JobsEngine;
  orchestrator: Orchestrator;
  start(): Promise<void>;
  stop(): Promise<void>;
  submitGoal(goal: string): Promise<GoalResult>;
}

export function createMegaAI(options: MegaAIOptions = {}): MegaAI {
  const clock = options.clock ?? systemClock;
  const config = loadConfig({
    ...options.configOptions,
    overrides: { ...(options.configOptions?.overrides ?? {}), ...(options.configOverrides ?? {}) },
  });

  const logBuffer = new MemorySink(1_000);
  const sinks: LogSink[] = [logBuffer, ...(options.extraSinks ?? [])];
  if (!options.quiet) sinks.unshift(new ConsoleSink(config.logging.pretty));
  const logger = createLogger({ level: config.logging.level, sinks, clock });

  const bus = createEventBus({ clock });
  const database: Database =
    options.persistent === false ? new MemoryDatabase() : new JsonFileDatabase(join(config.system.dataDir, 'db'));

  const vault = new SecretVault();
  vault.loadFromEnv(process.env, ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']);
  const permissions = new PermissionManager();
  const audit = new AuditLog(database, bus, clock);
  const metrics = new MetricsRegistry();
  const scheduler = new Scheduler(logger.child('scheduler'));
  const container = new ServiceContainer(bus, logger.child('runtime'));

  const resources = new ResourceMonitor({
    bus,
    logger: logger.child('resources'),
    clock,
    sampleIntervalMs: config.resources.sampleIntervalMs,
    thresholds: {
      memElevatedPct: config.resources.memElevatedPct,
      memCriticalPct: config.resources.memCriticalPct,
      cpuElevatedLoad: config.resources.cpuElevatedLoad,
      cpuCriticalLoad: config.resources.cpuCriticalLoad,
    },
  });

  // AI layer: providers from config + any extras, behind one fallback chain.
  const providers = new ProviderRegistry();
  const providerConfigs = config.ai.providers;
  if (providerConfigs.mock?.enabled !== false) providers.register(new MockProvider());
  const anthropicConfig = providerConfigs.anthropic;
  if (anthropicConfig?.enabled) {
    providers.register(
      new AnthropicProvider({
        apiKey: anthropicConfig.apiKey,
        model: anthropicConfig.model,
        maxTokens: config.ai.maxTokens,
      }),
    );
  }
  const openaiConfig = providerConfigs.openai;
  if (openaiConfig?.enabled) {
    providers.register(new OpenAICompatProvider({ apiKey: openaiConfig.apiKey, model: openaiConfig.model }));
  }
  const geminiConfig = providerConfigs.gemini;
  if (geminiConfig?.enabled) {
    providers.register(new GeminiProvider({ apiKey: geminiConfig.apiKey, model: geminiConfig.model }));
  }
  // OpenRouter and Groq both speak the OpenAI chat-completions wire protocol,
  // so they reuse the OpenAI-compatible adapter with their own base URL + kind.
  const openrouterConfig = providerConfigs.openrouter;
  if (openrouterConfig?.enabled) {
    providers.register(
      new OpenAICompatProvider({
        kind: 'openrouter',
        name: 'OpenRouter',
        apiKey: openrouterConfig.apiKey,
        model: openrouterConfig.model ?? 'openai/gpt-4o-mini',
        baseURL: 'https://openrouter.ai/api',
      }),
    );
  }
  const groqConfig = providerConfigs.groq;
  if (groqConfig?.enabled) {
    providers.register(
      new OpenAICompatProvider({
        kind: 'groq',
        name: 'Groq',
        apiKey: groqConfig.apiKey,
        model: groqConfig.model ?? 'llama-3.3-70b-versatile',
        baseURL: 'https://api.groq.com/openai',
      }),
    );
  }
  for (const provider of options.extraProviders ?? []) providers.register(provider);

  const limits = new LimitTracker(clock);
  for (const [kind, providerConfig] of Object.entries(providerConfigs)) {
    limits.configure(kind, {
      requestsPerMinute: providerConfig.requestsPerMinute,
      tokensPerDay: providerConfig.tokensPerDay,
    });
  }

  const fallbackChain = config.ai.fallbackChain.filter((kind) => {
    const providerConfig = providerConfigs[kind];
    return providerConfig ? providerConfig.enabled !== false : true;
  });

  const sessions = new AiSessionManager({
    providers,
    models: new ModelRegistry(),
    limits,
    fallbackChain,
    maxTokens: config.ai.maxTokens,
    bus,
    logger: logger.child('ai'),
    clock,
  });

  const memory = new MemoryEngine(database, bus, clock);
  const knowledge = new KnowledgeBase(memory);
  const policy = PolicyEngine.fromConfig(config.policy, clock);
  const approvals = new ApprovalManager({ autoApprove: config.policy.autoApprove }, bus, clock);
  const planning = new PlanningService(database, bus, clock);
  const workflow = new WorkflowEngine(database, {
    bus,
    approvals,
    clock,
    maxStepAttempts: config.workflow.maxStepAttempts,
    retryBaseMs: config.workflow.stepRetryBaseMs,
  });
  const tools = createToolRegistry({
    allowShell: config.security.allowShell,
    shellAllowlist: config.security.shellAllowlist,
    httpAllowedHosts: config.security.httpAllowedHosts,
  });
  for (const tool of createGitTools(new GitEngine())) tools.register(tool);
  const browserEngine = new BrowserEngine({
    allowedHosts: config.security.browserAllowedHosts,
    preferReal: config.security.allowBrowser,
    logger: (message, fields) => logger.child('browser').info(message, fields),
  });
  for (const tool of createBrowserTools(browserEngine)) tools.register(tool);
  // Trained models pack: load persisted models if present (created by
  // `megaai train`). The UI-purpose model, when trained, replaces the vision
  // heuristic; lead-scoring and error-triage are reachable via `model.predict`.
  const models = loadRegistry(join(config.system.dataDir, 'models')) ?? new ModelPackRegistry();
  const uiModel = models.ui();
  // Vision/UI testing: static analysis always; real headless Chromium when
  // the browser is allowed (and playwright-core + Chromium are present).
  const vision = new VisionTester({
    preferBrowser: config.security.allowBrowser,
    classifier: uiModel ? uiModel.asClassifier() : undefined,
    logger: (message, fields) => logger.child('vision').info(message, fields),
  });
  for (const tool of createVisionTools(vision)) tools.register(tool);
  for (const tool of createModelTools(models)) tools.register(tool);
  // Desktop/UI automation: browser-backed screen perception (element detection
  // + purpose, sharing the trained UI-purpose model) plus real mouse/keyboard.
  const desktop = new DesktopEngine({
    classifier: uiModel ? uiModel.asClassifier() : undefined,
    allowedHosts: config.security.browserAllowedHosts,
    logger: (message, fields) => logger.child('desktop').info(message, fields),
  });
  for (const tool of createDesktopTools(desktop)) tools.register(tool);
  // Deploy: real execution only when a shell is allowed (and the binary is on
  // the allowlist); otherwise every target simulates. Publishing stays behind
  // the approval-gated `deploy` permission regardless.
  const deployEngine = new DeployEngine({
    defaultTarget: config.deploy.defaultTarget as DeployTarget,
    clock,
    tokens: { vercel: config.deploy.vercelToken || undefined, railway: config.deploy.railwayToken || undefined },
    runner: config.security.allowShell
      ? createCommandRunner({ enabled: true, allowlist: config.security.shellAllowlist })
      : undefined,
  });
  for (const tool of createDeployTools(deployEngine)) tools.register(tool);

  // Communication: a captured channel is always present (offline default);
  // a webhook channel is added when a URL is configured.
  const comm = new CommEngine(clock);
  comm.register(new CapturedChannel('captured', clock));
  if (config.comm.webhookUrl) {
    comm.register(new WebhookChannel('webhook', config.comm.webhookUrl, { allowedHosts: config.comm.allowedHosts, clock }));
  }
  // Native email: registered when a from-address is configured. Real delivery
  // uses an HTTP email API or SMTP (nodemailer) when set; otherwise the channel
  // composes and captures the RFC5322 message offline.
  if (config.comm.email.from) {
    const emailTransport = config.comm.email.apiUrl
      ? createHttpEmailTransport(config.comm.email.apiUrl, { allowedHosts: config.comm.email.allowedHosts, apiKey: config.comm.email.apiKey || undefined })
      : config.comm.email.smtpHost
        ? createSmtpTransport({ host: config.comm.email.smtpHost })
        : undefined;
    comm.register(
      new EmailChannel('email', {
        from: config.comm.email.from,
        defaultTo: config.comm.email.to || undefined,
        transport: emailTransport,
        clock,
      }),
    );
  }
  const commDefaultChannel = comm.has(config.comm.notifyChannel) ? config.comm.notifyChannel : 'captured';
  tools.register(createCommTool(comm, commDefaultChannel));
  const notifications = new NotificationEngine({
    bus,
    comm,
    channel: config.comm.notifyChannel,
    events: config.comm.notifyEvents,
    onError: (err) => logger.child('comm').warn('notification failed', { error: String(err) }),
  });

  // CRM: clients / leads / activities / invoices, behind the Database contract.
  // Leads are scored by the trained lead-scoring model when it is present.
  const crm = new CrmEngine({
    database,
    clock,
    bus,
    scoreLead: (signals) => {
      const model = models.get('lead-scoring');
      if (!model) return undefined;
      const prediction = model.predictInput(signals);
      return { band: prediction.label, score: prediction.confidence };
    },
  });
  for (const tool of createCrmTools(crm)) tools.register(tool);

  // Recurring jobs: durable, run on the runtime scheduler. Two built-in kinds
  // push operator/CRM summaries to the configured notify channel.
  const jobs = new JobsEngine({ database, scheduler, bus, clock, logger: (message, fields) => logger.child('jobs').info(message, fields) });
  jobs.registerHandler('operator-report', async (ctx) => {
    const projects = await planning.listProjects();
    const completed = projects.filter((p) => p.status === 'completed').length;
    const channel = typeof ctx.job.params?.channel === 'string' ? ctx.job.params.channel : commDefaultChannel;
    await comm.send(channel, { subject: 'MegaAI status report', text: `📊 Status: ${projects.length} projects, ${completed} completed.` });
  });
  jobs.registerHandler('crm-followup', async (ctx) => {
    const summary = await crm.summary();
    const channel = typeof ctx.job.params?.channel === 'string' ? ctx.job.params.channel : commDefaultChannel;
    await comm.send(channel, {
      subject: 'CRM follow-up',
      text: `👥 CRM: ${summary.clients} clients, ${summary.hotLeads} hot leads, ${summary.outstanding} outstanding.`,
    });
  });
  for (const tool of createJobsTools(jobs)) tools.register(tool);

  for (const tool of options.extraTools ?? []) tools.register(tool);
  const contextEngine = new ContextEngine({ memory, planning });
  const meta = new MetaBrain({
    database,
    bus,
    clock,
    resources,
    planner: config.meta.planner === 'model' ? 'model' : 'template',
    // Plans are high-value: run them at complex tier through the fallback chain.
    complete: (request) => sessions.completeWithFallback(request, { complexity: 'complex' }),
  });

  const orchestrator = new Orchestrator({
    config,
    logger,
    bus,
    database,
    planning,
    workflow,
    policy,
    approvals,
    permissions,
    audit,
    sessions,
    memory,
    contextEngine,
    tools,
    meta,
    resources,
    metrics,
    agentImplementations: [...createBuiltinAgents(), ...(options.extraAgents ?? [])],
    clock,
  });

  container.set('config', config);
  container.set('bus', bus);
  container.set('database', database);
  container.set('sessions', sessions);
  container.set('orchestrator', orchestrator);
  container.addService({
    name: 'resources',
    start: () => resources.start(),
    stop: () => resources.stop(),
  });
  container.addService({ name: 'ai-sessions' });
  container.addService({ name: 'planning' });
  container.addService({ name: 'workflow' });
  container.addService({ name: 'notifications', start: () => notifications.start(), stop: () => notifications.stop() });
  container.addService({ name: 'jobs', start: () => jobs.start(), stop: () => jobs.stop() });
  container.addService({ name: 'orchestrator' });

  let started = false;
  const megaai: MegaAI = {
    config,
    logger,
    logBuffer,
    bus,
    database,
    container,
    scheduler,
    metrics,
    vault,
    permissions,
    audit,
    resources,
    sessions,
    memory,
    knowledge,
    policy,
    approvals,
    planning,
    workflow,
    tools,
    contextEngine,
    meta,
    comm,
    notifications,
    vision,
    models,
    desktop,
    crm,
    jobs,
    orchestrator,
    async start() {
      if (started) return;
      started = true;
      await container.startAll();
      scheduler.every('gauges', 5_000, () => {
        metrics.gauge('agents.active', orchestrator.agents.list().filter((a) => a.state === 'running').length);
        metrics.gauge('ai.sessions.active', sessions.activeSessionCount());
        metrics.gauge('approvals.pending', approvals.pending().length);
      });
      logger.info('MegaAI started', {
        providers: sessions.providerStatus().map((p) => `${p.kind}${p.configured ? '' : ' (unconfigured)'}`).join(', '),
        dataDir: config.system.dataDir,
      });
    },
    async stop() {
      if (!started) return;
      started = false;
      scheduler.stopAll();
      await container.stopAll();
      await database.flush();
      logger.info('MegaAI stopped');
    },
    submitGoal(goal: string) {
      return orchestrator.submitGoal(goal);
    },
  };
  return megaai;
}

/* ------------------------------------------------------------------ *
 * Re-exports so apps and plugins need only @megaai/sdk
 * ------------------------------------------------------------------ */

export { loadConfig, defaultConfig } from '@megaai/config';
export type { MegaConfig } from '@megaai/config';
export { MegaError, Events } from '@megaai/types';
export type * from '@megaai/types';
export type { AgentImplementation, Provider, Tool, AgentContext } from '@megaai/contracts';
export { MockProvider, AnthropicProvider, OpenAICompatProvider, GeminiProvider, ModelRegistry } from '@megaai/ai';
export { ModelDrivenAgent, BUILTIN_AGENT_DESCRIPTORS } from '@megaai/agents';
export { generatePlan, analyzeGoal } from '@megaai/meta-brain';
export type { GoalResult } from '@megaai/orchestrator';
export { MemorySink } from '@megaai/logger';
export { GitEngine, createGitTools } from '@megaai/code';
export { BrowserEngine, SimulatedDriver, createBrowserTools } from '@megaai/browser';
export type { BrowserDriver, BrowserPage } from '@megaai/browser';
export { DeployEngine, createDeployTools, DEPLOY_TARGETS } from '@megaai/deploy';
export type { DeployTarget, DeployPlan, DeployResult } from '@megaai/deploy';
export {
  CommEngine,
  CapturedChannel,
  WebhookChannel,
  EmailChannel,
  createHttpEmailTransport,
  createSmtpTransport,
  NotificationEngine,
  createCommTool,
} from '@megaai/comm';
export type { Channel, OutboundMessage, SendReceipt, EmailEnvelope, EmailTransport } from '@megaai/comm';
export { VisionTester, StaticTestDriver, BrowserTestDriver, classifyPurposeHeuristic, createVisionTools } from '@megaai/vision';
export type { AuditReport, UiElement, PurposeClassifier } from '@megaai/vision';
export {
  ModelRegistry as ModelPackRegistry,
  UiPurposeModel,
  LeadScoringModel,
  TriageModel,
  LogisticRegression,
  MultinomialNB,
  Vectorizer,
  trainAllModels,
  saveRegistry,
  loadRegistry,
  createModelTools,
} from '@megaai/models';
export type { PredictiveModel, Prediction, ModelBundle } from '@megaai/models';
export { DesktopEngine, createDesktopTools, resolveTarget, centerOf } from '@megaai/desktop';
export type { ScreenObservation, DesktopElement, DesktopStep, DesktopTarget } from '@megaai/desktop';
export { CrmEngine, createCrmTools, CrmEvents } from '@megaai/crm';
export type { CrmClient, CrmLead, CrmInvoice, CrmActivity, LeadScorer } from '@megaai/crm';
export { JobsEngine, createJobsTools, JobEvents } from '@megaai/jobs';
export type { JobRecord, JobHandler } from '@megaai/jobs';
