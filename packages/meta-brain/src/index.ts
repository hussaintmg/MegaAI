/**
 * @megaai/meta-brain — the CEO layer.
 *
 * Understands goals (Think), turns them into phased plans (Plan/Divide),
 * decides which agent and model tier handles what (Assign), adapts
 * concurrency to resource pressure, and learns from every outcome.
 *
 * Planning is template-driven today so the whole system is deterministic
 * and offline-testable; `plan()` is the single seam where model-backed
 * planning slots in (Phase 4) without touching any caller.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  JsonObject,
  PlanPhase,
  PlanSpec,
  PlanTask,
  TaskComplexity,
  TaskRecord,
} from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, extractJsonObject, isPlainObject, newId, systemClock, truncate } from '@megaai/utils';
import type { Database, Collection } from '@megaai/database';
import type { EventBus } from '@megaai/events';
import type { ResourceMonitor } from '@megaai/resources';

/** Runs one completion — injected so the meta brain stays decoupled from @megaai/ai. */
export type PlanCompleter = (request: CompletionRequest) => Promise<CompletionResponse>;

/** Agent kinds the built-in fleet can execute (unknowns coerce to coding). */
export const KNOWN_AGENT_KINDS = [
  'coding',
  'testing',
  'review',
  'research',
  'documentation',
  'marketing',
  'crm',
  'devops',
  'architecture',
  'build',
  'browser',
  'support',
] as const;

const COMPLEXITIES: TaskComplexity[] = ['trivial', 'standard', 'complex', 'frontier'];

/* ------------------------------------------------------------------ *
 * Goal analysis
 * ------------------------------------------------------------------ */

export type Domain = 'ecommerce' | 'erp' | 'api' | 'website' | 'generic';

export interface GoalAnalysis {
  domain: Domain;
  /** Feature keywords detected in the goal. */
  features: string[];
  projectName: string;
}

/**
 * Domain signals, scored rather than first-match-wins.
 *
 * Two rules learned the hard way. Keywords match on WORD boundaries, never as
 * substrings: "api" inside "rapid"/"therapist"/"capital" and "shop" inside
 * "workshop"/"coffee shop" used to decide the whole plan. And each keyword
 * carries a weight, because "landing page" says far more about intent than
 * "shop" appearing incidentally — the highest total wins, so a goal mentioning
 * several domains lands on the one it actually talks about most.
 */
const DOMAIN_KEYWORDS: Record<Exclude<Domain, 'generic'>, Array<[string, number]>> = {
  ecommerce: [
    ['ecommerce', 5],
    ['e commerce', 5],
    ['online store', 5],
    ['storefront', 4],
    ['product catalog', 4],
    ['shopping cart', 4],
    ['checkout', 3],
    ['cart', 2],
    ['store', 2],
    ['shop', 1],
  ],
  erp: [
    ['erp', 5],
    ['resource planning', 5],
    ['payroll', 4],
    ['accounting', 3],
    ['inventory', 3],
    ['hr system', 4],
  ],
  api: [
    ['api', 4],
    ['rest api', 5],
    ['graphql', 5],
    ['microservice', 4],
    ['microservices', 4],
    ['backend', 3],
    ['endpoint', 2],
    ['endpoints', 2],
  ],
  website: [
    ['website', 4],
    ['web site', 4],
    ['landing page', 5],
    ['portfolio', 4],
    ['blog', 3],
    ['marketing site', 5],
    ['homepage', 3],
  ],
};

/** Order used only to break exact score ties, so results stay deterministic. */
const DOMAIN_PRIORITY: Array<Exclude<Domain, 'generic'>> = ['ecommerce', 'erp', 'api', 'website'];

/** Lowercase, strip punctuation, collapse whitespace — "e-commerce" → "e commerce". */
function normalizeGoal(goal: string): string {
  return ` ${goal.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

/** True when `phrase` appears as whole words in an already-normalised goal. */
function containsPhrase(normalized: string, phrase: string): boolean {
  return normalized.includes(` ${phrase} `);
}

/**
 * Feature name → the phrases that indicate it. Spelled out rather than
 * stemmed, because word-boundary matching means "auth" alone would no longer
 * catch "authentication" (and substring matching is what caused the domain
 * misdetection this file used to have).
 */
const FEATURE_KEYWORDS: Record<string, string[]> = {
  auth: ['auth', 'authentication', 'sign in', 'signin', 'sign up', 'signup', 'login', 'log in', 'accounts'],
  payments: ['payment', 'payments', 'billing', 'stripe', 'subscription', 'subscriptions', 'invoice', 'invoices'],
  search: ['search', 'filtering', 'filters'],
  admin: ['admin', 'admin panel', 'back office', 'cms'],
  dashboard: ['dashboard', 'dashboards'],
  notifications: ['notification', 'notifications', 'alerts', 'emails'],
  reports: ['report', 'reports', 'reporting'],
  'multi-tenant': ['multi tenant', 'multitenant', 'multi tenancy', 'tenants'],
  analytics: ['analytics', 'metrics', 'tracking'],
};

export function analyzeGoal(goal: string): GoalAnalysis {
  const normalized = normalizeGoal(goal);

  let domain: Domain = 'generic';
  let best = 0;
  for (const candidate of DOMAIN_PRIORITY) {
    let score = 0;
    for (const [keyword, weight] of DOMAIN_KEYWORDS[candidate]) {
      if (containsPhrase(normalized, keyword)) score += weight;
    }
    if (score > best) {
      best = score;
      domain = candidate;
    }
  }

  const features = Object.entries(FEATURE_KEYWORDS)
    .filter(([, phrases]) => phrases.some((phrase) => containsPhrase(normalized, phrase)))
    .map(([feature]) => feature);
  const projectName = truncate(goal.replace(/\s+/g, ' ').trim(), 60) || 'Untitled project';
  return { domain, features, projectName };
}

/* ------------------------------------------------------------------ *
 * Plan templates
 * ------------------------------------------------------------------ */

function task(
  title: string,
  agentKind: string,
  complexity: TaskComplexity,
  description: string,
  dependsOnTitles?: string[],
): PlanTask {
  return { title, description, agentKind, complexity, dependsOnTitles };
}

function corePhasesFor(domain: Domain, goal: string): PlanSpec['phases'] {
  switch (domain) {
    case 'ecommerce':
      return [
        {
          name: 'Discovery',
          tasks: [
            task('Requirements research', 'research', 'standard', `Clarify requirements, users and constraints for: ${goal}`),
            task('System architecture', 'architecture', 'complex', 'Design components, data flow and integration points for the store'),
          ],
        },
        {
          name: 'Foundation',
          tasks: [
            task('Project scaffold setup', 'coding', 'standard', 'Initialise the project: package manifest, entrypoint, folder layout'),
            task('Database schema and models', 'coding', 'complex', 'Design product, order and customer schema with a data-access layer'),
          ],
        },
        {
          name: 'Core features',
          tasks: [
            task('Authentication module', 'coding', 'complex', 'User signup, login and session verification'),
            task('Product catalog API', 'coding', 'complex', 'REST endpoints for listing and managing products'),
            task('Storefront UI pages', 'coding', 'standard', 'Customer-facing catalog and product pages'),
            task('Cart and checkout flow', 'coding', 'complex', 'Cart management and checkout order placement'),
          ],
        },
        {
          name: 'Quality',
          tasks: [
            task('Build verification', 'build', 'standard', 'Verify every source file builds and parses cleanly'),
            task('Automated test suite', 'testing', 'standard', 'Tests covering auth, catalog and checkout behaviour'),
            task('Visual and responsive testing', 'vision-testing', 'standard', 'Check the storefront renders responsively without console errors'),
            task('Code review pass', 'review', 'standard', 'Review all modules for defects and risks'),
          ],
        },
        {
          name: 'Launch',
          tasks: [
            task('Project documentation', 'documentation', 'trivial', 'User and developer docs for the store'),
            task('Launch marketing content', 'marketing', 'trivial', 'Landing copy and launch announcement'),
            task('Deployment preparation', 'devops', 'standard', 'Deployment plan, environment config and rollback strategy'),
            task('Client CRM update', 'crm', 'trivial', 'Record delivery status and follow-ups for the client'),
          ],
        },
      ];
    case 'erp':
      return [
        {
          name: 'Discovery',
          tasks: [
            task('Requirements research', 'research', 'standard', `Identify industry, modules, budget and risks for: ${goal}`),
            task('System architecture', 'architecture', 'complex', 'Module boundaries and shared data model for the ERP'),
          ],
        },
        {
          name: 'Foundation',
          tasks: [
            task('Project scaffold setup', 'coding', 'standard', 'Initialise the ERP project skeleton'),
            task('Authentication module', 'coding', 'complex', 'Role-based access for ERP users'),
          ],
        },
        {
          name: 'Modules',
          tasks: [
            task('Inventory module', 'coding', 'complex', 'Stock tracking, locations and movements'),
            task('Accounting module', 'coding', 'complex', 'Ledger, invoices and payment records'),
            task('Reporting module', 'coding', 'standard', 'Cross-module summary reports'),
          ],
        },
        {
          name: 'Quality',
          tasks: [
            task('Build verification', 'build', 'standard', 'Verify every module builds and parses cleanly'),
            task('Automated test suite', 'testing', 'standard', 'Module and integration tests'),
            task('Code review pass', 'review', 'standard', 'Review all modules'),
          ],
        },
        {
          name: 'Launch',
          tasks: [
            task('Project documentation', 'documentation', 'trivial', 'Admin and user documentation'),
            task('Deployment preparation', 'devops', 'standard', 'Deployment plan and configs'),
            task('Client CRM update', 'crm', 'trivial', 'Record delivery status for the client'),
          ],
        },
      ];
    case 'api':
      return [
        {
          name: 'Design',
          tasks: [
            task('Requirements research', 'research', 'standard', `Define resources, consumers and SLAs for: ${goal}`),
            task('API architecture', 'architecture', 'standard', 'Endpoint design and data contracts'),
          ],
        },
        {
          name: 'Build',
          tasks: [
            task('Project scaffold setup', 'coding', 'standard', 'Initialise service skeleton'),
            task('Core API endpoints', 'coding', 'complex', 'Implement the primary endpoints and validation'),
          ],
        },
        {
          name: 'Quality & launch',
          tasks: [
            task('Build verification', 'build', 'standard', 'Verify the service builds and parses cleanly'),
            task('Automated test suite', 'testing', 'standard', 'Endpoint tests including error paths'),
            task('Project documentation', 'documentation', 'trivial', 'API reference and quickstart'),
            task('Deployment preparation', 'devops', 'standard', 'Deployment plan and configs'),
          ],
        },
      ];
    case 'website':
      return [
        {
          name: 'Design',
          tasks: [task('Content and structure research', 'research', 'standard', `Pages, audience and tone for: ${goal}`)],
        },
        {
          name: 'Build',
          tasks: [
            task('Project scaffold setup', 'coding', 'standard', 'Initialise the site skeleton'),
            task('Site pages UI', 'coding', 'standard', 'Build the pages and navigation'),
          ],
        },
        {
          name: 'Quality & launch',
          tasks: [
            task('Automated test suite', 'testing', 'trivial', 'Smoke tests for the site'),
            task('Visual and responsive testing', 'vision-testing', 'standard', 'Check the site renders responsively without console errors'),
            task('Launch marketing content', 'marketing', 'trivial', 'Announcement and SEO copy'),
            task('Deployment preparation', 'devops', 'standard', 'Hosting plan and configs'),
          ],
        },
      ];
    default:
      return [
        {
          name: 'Understand',
          tasks: [task('Requirements research', 'research', 'standard', `Understand and de-risk: ${goal}`)],
        },
        {
          name: 'Build',
          tasks: [
            task('Project scaffold setup', 'coding', 'standard', 'Initialise the project skeleton'),
            task('Implement core functionality', 'coding', 'complex', goal),
          ],
        },
        {
          name: 'Verify & deliver',
          tasks: [
            task('Automated test suite', 'testing', 'standard', 'Verify the core functionality'),
            task('Project documentation', 'documentation', 'trivial', 'Document what was built and how to run it'),
          ],
        },
      ];
  }
}

export function generatePlan(goal: string): PlanSpec {
  const analysis = analyzeGoal(goal);
  const phases = corePhasesFor(analysis.domain, goal);
  return {
    projectName: analysis.projectName,
    domain: analysis.domain,
    summary: `Detected domain "${analysis.domain}"${analysis.features.length > 0 ? ` with features: ${analysis.features.join(', ')}` : ''}. ${phases.length} phases, ${phases.reduce((n, p) => n + p.tasks.length, 0)} tasks.`,
    phases,
    risks:
      analysis.domain === 'generic'
        ? ['Goal is broad — early research phase will refine scope']
        : ['Scope may grow as requirements are clarified'],
    questionsForHuman: [],
  };
}

/* ------------------------------------------------------------------ *
 * Model-backed planning
 * ------------------------------------------------------------------ */

export const PLAN_SYSTEM_PROMPT = `You are the planning brain of MegaAI, an autonomous software delivery system.
Given a goal, produce a concrete, phased delivery plan and respond with ONLY a JSON object of this shape:
{
  "projectName": "short name",
  "domain": "e.g. ecommerce | erp | api | website | generic",
  "summary": "one sentence",
  "phases": [
    { "name": "Phase name", "tasks": [
      { "title": "Task title", "description": "what to do",
        "agentKind": "one of: ${KNOWN_AGENT_KINDS.join(', ')}",
        "complexity": "trivial | standard | complex | frontier",
        "dependsOnTitles": ["earlier task titles this depends on (optional)"] }
    ] }
  ],
  "risks": ["..."],
  "questionsForHuman": ["..."]
}
Phases run in order. Always include research, implementation (coding), a build check, tests, documentation and a deployment task. No prose outside the JSON.`;

function coerceAgentKind(value: unknown): string {
  return typeof value === 'string' && (KNOWN_AGENT_KINDS as readonly string[]).includes(value) ? value : 'coding';
}

function coerceComplexity(value: unknown): TaskComplexity {
  return typeof value === 'string' && COMPLEXITIES.includes(value as TaskComplexity)
    ? (value as TaskComplexity)
    : 'standard';
}

/** Parse and sanitise a model-produced plan into a valid PlanSpec, or undefined. */
export function parsePlanSpec(text: string, goal: string): PlanSpec | undefined {
  const parsed = extractJsonObject(text);
  if (!isPlainObject(parsed)) return undefined;
  const raw = parsed as JsonObject;
  if (!Array.isArray(raw.phases)) return undefined;

  const phases: PlanPhase[] = [];
  for (const rawPhase of raw.phases) {
    if (!isPlainObject(rawPhase) || !Array.isArray(rawPhase.tasks)) continue;
    const tasks: PlanTask[] = [];
    for (const rawTask of rawPhase.tasks) {
      if (!isPlainObject(rawTask) || typeof rawTask.title !== 'string' || rawTask.title.trim().length === 0) continue;
      const dependsOnTitles = Array.isArray(rawTask.dependsOnTitles)
        ? rawTask.dependsOnTitles.filter((title): title is string => typeof title === 'string')
        : undefined;
      tasks.push({
        title: rawTask.title.trim(),
        description: typeof rawTask.description === 'string' ? rawTask.description : '',
        agentKind: coerceAgentKind(rawTask.agentKind),
        complexity: coerceComplexity(rawTask.complexity),
        ...(dependsOnTitles && dependsOnTitles.length > 0 ? { dependsOnTitles } : {}),
      });
    }
    if (tasks.length > 0) {
      phases.push({ name: typeof rawPhase.name === 'string' ? rawPhase.name : `Phase ${phases.length + 1}`, tasks });
    }
  }
  if (phases.length === 0) return undefined;

  return {
    projectName: typeof raw.projectName === 'string' && raw.projectName.trim() ? raw.projectName.trim() : truncate(goal, 60),
    domain: typeof raw.domain === 'string' ? raw.domain : 'model',
    summary:
      typeof raw.summary === 'string'
        ? raw.summary
        : `Model-generated plan: ${phases.length} phases, ${phases.reduce((n, p) => n + p.tasks.length, 0)} tasks.`,
    phases,
    risks: Array.isArray(raw.risks) ? raw.risks.filter((r): r is string => typeof r === 'string') : [],
    questionsForHuman: Array.isArray(raw.questionsForHuman)
      ? raw.questionsForHuman.filter((q): q is string => typeof q === 'string')
      : [],
  };
}

/* ------------------------------------------------------------------ *
 * Learning
 * ------------------------------------------------------------------ */

export interface OutcomeRecord {
  id: string;
  at: number;
  projectId: string;
  taskId: string;
  agentKind: string;
  provider: string;
  model: string;
  ok: boolean;
  durationMs: number;
  error?: string;
}

export interface LearningStats {
  byAgent: Record<string, { runs: number; successes: number; successRate: number; avgDurationMs: number }>;
  byProvider: Record<string, { runs: number; successes: number; successRate: number }>;
  totalRuns: number;
}

/* ------------------------------------------------------------------ *
 * Meta brain
 * ------------------------------------------------------------------ */

export interface MetaBrainOptions {
  database: Database;
  bus?: EventBus;
  clock?: Clock;
  resources?: ResourceMonitor;
  /** 'template' (deterministic, default) or 'model' (ask the AI to plan). */
  planner?: 'template' | 'model';
  /** Completion runner used when planner === 'model'. */
  complete?: PlanCompleter;
}

export class MetaBrain {
  readonly name = 'meta-brain';
  private readonly outcomes: Collection<OutcomeRecord>;
  private readonly bus?: EventBus;
  private readonly clock: Clock;
  private readonly resources?: ResourceMonitor;
  private readonly planner: 'template' | 'model';
  private readonly complete?: PlanCompleter;

  constructor(options: MetaBrainOptions) {
    this.outcomes = options.database.collection<OutcomeRecord>('outcomes');
    this.bus = options.bus;
    this.clock = options.clock ?? systemClock;
    this.resources = options.resources;
    this.planner = options.planner ?? 'template';
    this.complete = options.complete;
  }

  private requireGoal(goal: string): string {
    if (!goal || goal.trim().length < 3) {
      throw new MegaError('INVALID_INPUT', 'Goal must be a non-empty description of what to build');
    }
    return goal.trim();
  }

  /** Think + Plan (template): deterministic, synchronous, offline. */
  plan(goal: string): PlanSpec {
    const spec = generatePlan(this.requireGoal(goal));
    this.bus?.emit(
      Events.DecisionMade,
      { kind: 'plan', source: 'template', domain: spec.domain, phases: spec.phases.length, summary: spec.summary },
      'meta-brain',
    );
    return spec;
  }

  /**
   * Produce a plan using the configured planner: ask the model when
   * `planner: 'model'` (with a completer), otherwise use templates. Any
   * model failure — unavailable, unparseable, empty — falls back to the
   * template plan so a goal is never left unplanned.
   */
  async makePlan(goal: string): Promise<PlanSpec> {
    const clean = this.requireGoal(goal);
    if (this.planner === 'model' && this.complete) {
      try {
        const response = await this.complete({
          system: PLAN_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `Goal: ${clean}\n\nProduce the delivery plan as JSON.` }],
          metadata: { planning: true, goal: clean },
        });
        const spec = parsePlanSpec(response.text, clean);
        if (spec) {
          this.bus?.emit(
            Events.DecisionMade,
            { kind: 'plan', source: 'model', domain: spec.domain, phases: spec.phases.length, summary: spec.summary },
            'meta-brain',
          );
          return spec;
        }
        this.bus?.emit(Events.DecisionMade, { kind: 'plan', source: 'model-fallback', reason: 'unparseable' }, 'meta-brain');
      } catch (err) {
        this.bus?.emit(
          Events.DecisionMade,
          { kind: 'plan', source: 'model-fallback', reason: MegaError.from(err).message },
          'meta-brain',
        );
      }
    }
    return this.plan(clean);
  }

  /** Which model tier a task deserves (informed by past failures). */
  async complexityFor(task: TaskRecord): Promise<TaskComplexity> {
    if (task.attempts > 1) {
      // Escalate after a failure: retry harder work on a stronger tier.
      return task.complexity === 'trivial' ? 'standard' : task.complexity === 'standard' ? 'complex' : 'frontier';
    }
    return task.complexity;
  }

  /** How many agents should run in parallel right now. */
  concurrency(configuredMax: number): number {
    return this.resources?.recommendedConcurrency(configuredMax) ?? configuredMax;
  }

  shouldRetry(task: TaskRecord, error: MegaError): boolean {
    if (task.attempts >= task.maxAttempts) return false;
    return error.retryable || error.code === 'INTERNAL' || error.code === 'PROVIDER_REFUSED';
  }

  /** Learn: record an outcome and surface repeated-failure lessons. */
  async recordOutcome(input: Omit<OutcomeRecord, 'id' | 'at'>): Promise<void> {
    const record: OutcomeRecord = { ...input, id: newId('out'), at: this.clock.now() };
    await this.outcomes.put(record);
    if (!record.ok) {
      const failures = await this.outcomes.find(
        (outcome) => outcome.agentKind === record.agentKind && !outcome.ok,
      );
      if (failures.length > 0 && failures.length % 3 === 0) {
        const lesson = `Agent "${record.agentKind}" has failed ${failures.length} times; latest: ${record.error ?? 'unknown'}. Consider stronger models or better task descriptions for this kind.`;
        this.bus?.emit(Events.LessonLearned, { lesson, agentKind: record.agentKind }, 'meta-brain');
      }
    }
  }

  async stats(): Promise<LearningStats> {
    const all = await this.outcomes.all();
    const byAgent: LearningStats['byAgent'] = {};
    const byProvider: LearningStats['byProvider'] = {};
    for (const outcome of all) {
      const agent = (byAgent[outcome.agentKind] ??= { runs: 0, successes: 0, successRate: 0, avgDurationMs: 0 });
      agent.runs += 1;
      agent.avgDurationMs += outcome.durationMs;
      if (outcome.ok) agent.successes += 1;
      const provider = (byProvider[outcome.provider] ??= { runs: 0, successes: 0, successRate: 0 });
      provider.runs += 1;
      if (outcome.ok) provider.successes += 1;
    }
    for (const agent of Object.values(byAgent)) {
      agent.successRate = agent.runs > 0 ? agent.successes / agent.runs : 0;
      agent.avgDurationMs = agent.runs > 0 ? Math.round(agent.avgDurationMs / agent.runs) : 0;
    }
    for (const provider of Object.values(byProvider)) {
      provider.successRate = provider.runs > 0 ? provider.successes / provider.runs : 0;
    }
    return { byAgent, byProvider, totalRuns: all.length };
  }

  async recentOutcomes(limit = 50): Promise<OutcomeRecord[]> {
    return (await this.outcomes.all()).sort((a, b) => b.at - a.at).slice(0, limit);
  }
}

export type { JsonObject };
