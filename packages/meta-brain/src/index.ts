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

import type { JsonObject, PlanSpec, PlanTask, TaskComplexity, TaskRecord } from '@megaai/types';
import { Events, MegaError } from '@megaai/types';
import { type Clock, newId, systemClock, truncate } from '@megaai/utils';
import type { Database, Collection } from '@megaai/database';
import type { EventBus } from '@megaai/events';
import type { ResourceMonitor } from '@megaai/resources';

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

const DOMAIN_KEYWORDS: Record<Exclude<Domain, 'generic'>, string[]> = {
  ecommerce: ['ecommerce', 'e-commerce', 'shop', 'store', 'storefront', 'cart', 'checkout', 'product catalog'],
  erp: ['erp', 'inventory', 'accounting', 'payroll', 'hr system', 'resource planning'],
  api: ['api', 'backend', 'rest', 'graphql', 'microservice', 'endpoint'],
  website: ['website', 'landing page', 'portfolio', 'blog', 'web site'],
};

const FEATURE_KEYWORDS = [
  'auth',
  'login',
  'payment',
  'search',
  'admin',
  'dashboard',
  'notifications',
  'reports',
  'multi-tenant',
  'analytics',
];

export function analyzeGoal(goal: string): GoalAnalysis {
  const text = goal.toLowerCase();
  let domain: Domain = 'generic';
  for (const [candidate, keywords] of Object.entries(DOMAIN_KEYWORDS) as Array<[Domain, string[]]>) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      domain = candidate;
      break;
    }
  }
  const features = FEATURE_KEYWORDS.filter((feature) => text.includes(feature));
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
            task('Automated test suite', 'testing', 'standard', 'Tests covering auth, catalog and checkout behaviour'),
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
}

export class MetaBrain {
  readonly name = 'meta-brain';
  private readonly outcomes: Collection<OutcomeRecord>;
  private readonly bus?: EventBus;
  private readonly clock: Clock;
  private readonly resources?: ResourceMonitor;

  constructor(options: MetaBrainOptions) {
    this.outcomes = options.database.collection<OutcomeRecord>('outcomes');
    this.bus = options.bus;
    this.clock = options.clock ?? systemClock;
    this.resources = options.resources;
  }

  /** Think + Plan: understand the goal and produce a phased plan. */
  plan(goal: string): PlanSpec {
    if (!goal || goal.trim().length < 3) {
      throw new MegaError('INVALID_INPUT', 'Goal must be a non-empty description of what to build');
    }
    const spec = generatePlan(goal.trim());
    this.bus?.emit(
      Events.DecisionMade,
      { kind: 'plan', domain: spec.domain, phases: spec.phases.length, summary: spec.summary },
      'meta-brain',
    );
    return spec;
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
