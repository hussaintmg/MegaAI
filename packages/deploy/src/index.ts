/**
 * @megaai/deploy — the deployment engine (Phase 3, milestone 3).
 *
 * Two operations, deliberately split by risk:
 *   - `plan`    is pure and side-effect-free: it describes what a deploy to a
 *               given target would do (commands + expected URL). Safe to run
 *               freely (`deploy.plan` permission).
 *   - `execute` performs the deploy (`deploy` permission — approval-gated by
 *               default). Without a command runner, or with the `simulated`
 *               target, it returns a deterministic result and records it,
 *               so the whole flow is exercisable offline.
 *
 * Real targets (Docker/Vercel/Railway) are expressed as command lists an
 * injected runner executes; publishing therefore stays behind both the
 * approval gate and the shell allowlist.
 */

import { writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { JsonObject, JsonValue, Timestamp } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { collectDeployFiles, deployToVercel } from './vercel.js';
import { type Clock, slugify, systemClock } from '@megaai/utils';
import type { Tool } from '@megaai/contracts';

export type DeployTarget = 'simulated' | 'static' | 'docker' | 'vercel' | 'railway';

export const DEPLOY_TARGETS: DeployTarget[] = ['simulated', 'static', 'docker', 'vercel', 'railway'];

export interface DeployCommand {
  command: string;
  args: string[];
}

export interface DeployPlan {
  target: DeployTarget;
  appName: string;
  description: string;
  commands: DeployCommand[];
  estimatedUrl: string;
  /** True when execution needs no external commands (safe to auto-run). */
  simulated: boolean;
}

export interface DeployResult {
  /** Vercel's build log for this deployment, when there is one. */
  inspectorUrl?: string;
  /** Why the deployment is not live, when it is not. */
  error?: string;
  target: DeployTarget;
  appName: string;
  url: string;
  simulated: boolean;
  deployedAt: Timestamp;
  steps: Array<{ command: string; ok: boolean; exitCode: number }>;
}

/** Injected command runner (wired to the shell tool when enabled). */
export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export interface DeployTokens {
  vercel?: string;
  railway?: string;
}

function buildPlan(target: DeployTarget, appName: string, tokens: DeployTokens = {}): Omit<DeployPlan, 'appName'> {
  switch (target) {
    case 'docker':
      return {
        target,
        description: 'Build a Docker image and run the container',
        commands: [
          { command: 'docker', args: ['build', '-t', appName, '.'] },
          { command: 'docker', args: ['run', '-d', '-p', '3000:3000', '--name', appName, appName] },
        ],
        estimatedUrl: 'http://localhost:3000',
        simulated: false,
      };
    case 'vercel':
      return {
        target,
        description: tokens.vercel
          ? 'Deploy to Vercel (production) over the REST API — no CLI needed'
          : 'Deploy to Vercel (production) — no token saved, so this will simulate',
        // No commands: the deployment goes over the REST API. The CLI is not
        // installed on the runner and is not on the shell allowlist, so a
        // command list here could only ever describe something that never ran.
        commands: [],
        estimatedUrl: `https://${appName}.vercel.app`,
        simulated: false,
      };
    case 'railway':
      return {
        target,
        description: 'Deploy to Railway',
        commands: [{ command: 'railway', args: ['up', '--detach', ...(tokens.railway ? ['--token', tokens.railway] : [])] }],
        estimatedUrl: `https://${appName}.up.railway.app`,
        simulated: false,
      };
    case 'static':
      return {
        target,
        description: 'Publish static files to MegaAI hosting',
        commands: [],
        estimatedUrl: `https://${appName}.megaai.app`,
        simulated: true,
      };
    case 'simulated':
    default:
      return {
        target: 'simulated',
        description: 'Simulated deploy (no external calls) — returns a placeholder URL',
        commands: [],
        estimatedUrl: `https://${appName}.megaai.app`,
        simulated: true,
      };
  }
}

export interface DeployEngineOptions {
  defaultTarget?: DeployTarget;
  /** When absent, every target simulates (no external commands run). */
  runner?: CommandRunner;
  /** Provider tokens injected into deploy commands (redacted in results/logs). */
  tokens?: DeployTokens;
  clock?: Clock;
  /** Injected for tests, so no real deployment is made. */
  deployToVercel?: typeof deployToVercel;
}

/** Mask any secret token values inside a display string. */
function redactCommand(display: string, secrets: Array<string | undefined>): string {
  let out = display;
  for (const secret of secrets) if (secret && secret.length > 0) out = out.split(secret).join('***');
  return out;
}

export class DeployEngine {
  private readonly defaultTarget: DeployTarget;
  private readonly runner?: CommandRunner;
  private readonly tokens: DeployTokens;
  private readonly clock: Clock;
  private readonly vercel: typeof deployToVercel;

  constructor(options: DeployEngineOptions = {}) {
    this.defaultTarget = options.defaultTarget ?? 'simulated';
    this.runner = options.runner;
    this.tokens = options.tokens ?? {};
    this.clock = options.clock ?? systemClock;
    this.vercel = options.deployToVercel ?? deployToVercel;
  }

  appNameFor(workspaceDir: string, override?: string): string {
    return slugify(override ?? basename(workspaceDir));
  }

  plan(workspaceDir: string, options: { target?: DeployTarget; appName?: string } = {}): DeployPlan {
    const target = options.target ?? this.defaultTarget;
    if (!DEPLOY_TARGETS.includes(target)) {
      throw new MegaError('INVALID_INPUT', `Unknown deploy target "${target}"`);
    }
    const appName = this.appNameFor(workspaceDir, options.appName);
    return { ...buildPlan(target, appName, this.tokens), appName };
  }

  /** Planned commands with any secrets redacted — safe to show/log. */
  redactedCommands(plan: DeployPlan): string[] {
    const secrets = [this.tokens.vercel, this.tokens.railway];
    return plan.commands.map((c) => redactCommand(`${c.command} ${c.args.join(' ')}`.trim(), secrets));
  }

  async execute(
    workspaceDir: string,
    options: { target?: DeployTarget; appName?: string; framework?: string | null } = {},
  ): Promise<DeployResult> {
    const plan = this.plan(workspaceDir, options);
    const steps: DeployResult['steps'] = [];

    // Vercel goes over the REST API, not the CLI: the runner has no `vercel`
    // binary and never will, so the CLI path could only ever simulate — and a
    // simulated deploy hands back a URL that resolves to nothing.
    if (plan.target === 'vercel' && this.tokens.vercel) {
      const files = collectDeployFiles(workspaceDir);
      const deployment = await this.vercel({
        token: this.tokens.vercel,
        projectName: plan.appName,
        files,
        framework: options.framework ?? 'nextjs',
      });
      steps.push({
        command: `vercel-api deploy (${deployment.files} files)`,
        ok: deployment.ok,
        exitCode: deployment.ok ? 0 : 1,
      });
      const deployed: DeployResult = {
        target: 'vercel',
        appName: plan.appName,
        url: deployment.url,
        simulated: false,
        deployedAt: this.clock.now(),
        steps,
        ...(deployment.inspectorUrl ? { inspectorUrl: deployment.inspectorUrl } : {}),
        ...(deployment.error ? { error: deployment.error } : {}),
      };
      this.record(workspaceDir, deployed);
      if (!deployment.ok) {
        throw new MegaError('INTERNAL', `Vercel deployment did not go live: ${deployment.error ?? deployment.readyState}`, {
          url: deployment.url,
          ...(deployment.inspectorUrl ? { inspectorUrl: deployment.inspectorUrl } : {}),
        });
      }
      return deployed;
    }

    // Simulated targets — or the absence of a runner — never shell out.
    const canRunReal = this.runner && !plan.simulated && plan.commands.length > 0;
    const secrets = [this.tokens.vercel, this.tokens.railway];
    if (canRunReal) {
      for (const step of plan.commands) {
        const outcome = await (this.runner as CommandRunner)(step.command, step.args, workspaceDir);
        const display = redactCommand(`${step.command} ${step.args.join(' ')}`.trim(), secrets);
        steps.push({ command: display, ok: outcome.exitCode === 0, exitCode: outcome.exitCode });
        if (outcome.exitCode !== 0) {
          throw new MegaError('INTERNAL', `deploy step "${step.command}" failed (exit ${outcome.exitCode}): ${outcome.stderr.slice(0, 1_000)}`, {
            steps: steps as unknown as JsonValue,
          });
        }
      }
    }

    const result: DeployResult = {
      target: plan.target,
      appName: plan.appName,
      url: plan.estimatedUrl,
      simulated: !canRunReal,
      deployedAt: this.clock.now(),
      steps,
    };
    this.record(workspaceDir, result);
    return result;
  }

  /** Record the deploy alongside the delivery (best-effort). */
  private record(workspaceDir: string, result: DeployResult): void {
    try {
      writeFileSync(join(workspaceDir, '.megaai-deploy.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch {
      /* recording is best-effort */
    }
  }
}

/* ------------------------------------------------------------------ *
 * Agent-facing tools
 * ------------------------------------------------------------------ */

function optTarget(input: JsonObject): DeployTarget | undefined {
  const value = input.target;
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DEPLOY_TARGETS.includes(value as DeployTarget)) {
    throw new MegaError('INVALID_INPUT', `target must be one of ${DEPLOY_TARGETS.join(', ')}`);
  }
  return value as DeployTarget;
}

export function createDeployTools(engine: DeployEngine): Tool[] {
  const plan: Tool = {
    name: 'deploy.plan',
    description: 'Describe how the project would be deployed to a target (no side effects)',
    inputSchema: { target: `string (optional: ${DEPLOY_TARGETS.join(' | ')})`, appName: 'string (optional)' },
    permissions: ['deploy.plan'],
    async execute(input, ctx) {
      const appName = typeof input.appName === 'string' ? input.appName : undefined;
      return engine.plan(ctx.workspaceRoot, { target: optTarget(input), appName }) as unknown as JsonValue;
    },
  };
  const execute: Tool = {
    name: 'deploy.execute',
    description: 'Deploy the project to a target (approval-gated); returns the deployment URL',
    inputSchema: { target: `string (optional: ${DEPLOY_TARGETS.join(' | ')})`, appName: 'string (optional)' },
    permissions: ['deploy'],
    async execute(input, ctx) {
      const appName = typeof input.appName === 'string' ? input.appName : undefined;
      return (await engine.execute(ctx.workspaceRoot, { target: optTarget(input), appName })) as unknown as JsonValue;
    },
  };
  return [plan, execute];
}

export {
  collectDeployFiles,
  deployToVercel,
  type VercelDeployment,
  type VercelDeployOptions,
  type VercelFile,
} from './vercel.js';
