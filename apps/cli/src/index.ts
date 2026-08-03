#!/usr/bin/env node
/**
 * megaai — the MegaAI command line.
 *
 *   megaai demo                     run the offline end-to-end demo
 *   megaai run "<goal>"             plan + execute a goal
 *   megaai plan "<goal>"            show the plan without executing
 *   megaai status                   projects, providers and learning stats
 *   megaai serve                    hint for the dashboard server
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import process from 'node:process';
import {
  createMegaAI,
  Events,
  generatePlan,
  type MegaAI,
} from '@megaai/sdk';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, text: string): string => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text: string) => paint('1', text);
const dim = (text: string) => paint('2', text);
const green = (text: string) => paint('32', text);
const red = (text: string) => paint('31', text);
const yellow = (text: string) => paint('33', text);
const cyan = (text: string) => paint('36', text);

function walkFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function watchProgress(megaai: MegaAI): void {
  megaai.bus.on<{ task: { title: string; state: string; agentKind: string } }>(
    Events.TaskUpdated,
    (event) => {
      const task = event.payload.task;
      if (task.state === 'in-progress') {
        process.stdout.write(`  ${cyan('▶')} ${task.title} ${dim(`(${task.agentKind} agent)`)}\n`);
      } else if (task.state === 'completed') {
        process.stdout.write(`  ${green('✔')} ${task.title}\n`);
      } else if (task.state === 'failed' || task.state === 'blocked') {
        process.stdout.write(`  ${red('✖')} ${task.title} ${dim(`(${task.state})`)}\n`);
      }
    },
  );
  megaai.bus.on<{ approval: { description: string } }>(Events.ApprovalRequested, (event) => {
    process.stdout.write(`  ${yellow('⏸')} approval: ${event.payload.approval.description}\n`);
  });
  megaai.bus.on<{ approval: { status: string; resolvedBy?: string } }>(Events.ApprovalResolved, (event) => {
    const approval = event.payload.approval;
    process.stdout.write(`  ${yellow('⏵')} approval ${approval.status} ${dim(`by ${approval.resolvedBy ?? '?'}`)}\n`);
  });
}

async function executeGoal(goal: string, options: { persistent: boolean; quiet: boolean }): Promise<number> {
  const megaai = createMegaAI({
    persistent: options.persistent,
    quiet: true, // CLI renders its own progress; full logs stay in the buffer
    configOverrides: {
      policy: { autoApprove: true },
      // Let the testing agent really execute suites (node --test) and let
      // coding agents commit; both stay allowlisted and sandboxed.
      security: { allowShell: true },
    },
  });
  await megaai.start();
  if (!options.quiet) watchProgress(megaai);

  process.stdout.write(`\n${bold('Goal:')} ${goal}\n\n`);
  const startedAt = Date.now();
  try {
    const result = await megaai.submitGoal(goal);
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const ok = result.project.status === 'completed';

    process.stdout.write(`\n${bold('Result:')} ${ok ? green(result.project.status) : red(result.project.status)} ${dim(`in ${seconds}s`)}\n`);
    process.stdout.write(`${bold('Project:')} ${result.project.name}\n`);
    process.stdout.write(`${bold('Tasks:')} ${result.tasks.filter((task) => task.state === 'completed').length}/${result.tasks.length} completed\n`);

    const usage = megaai.sessions.usage();
    process.stdout.write(
      `${bold('AI usage:')} ${usage.requests} requests, ${usage.inputTokens + usage.outputTokens} tokens, ~$${usage.estimatedCostUsd.toFixed(4)}\n`,
    );

    const files = walkFiles(result.workspaceDir);
    process.stdout.write(`\n${bold('Workspace:')} ${result.workspaceDir}\n`);
    for (const file of files) process.stdout.write(`  ${dim('•')} ${file}\n`);
    process.stdout.write(`\n${dim('Full report: ')}${join(result.workspaceDir, 'MEGAAI_REPORT.md')}\n`);
    return ok ? 0 : 1;
  } finally {
    await megaai.stop();
  }
}

function printPlan(goal: string): number {
  const plan = generatePlan(goal);
  process.stdout.write(`\n${bold('Plan for:')} ${goal}\n`);
  process.stdout.write(`${dim(plan.summary)}\n\n`);
  for (const [index, phase] of plan.phases.entries()) {
    process.stdout.write(`${bold(`Phase ${index + 1}: ${phase.name}`)}\n`);
    for (const task of phase.tasks) {
      process.stdout.write(`  - ${task.title} ${dim(`[${task.agentKind}, ${task.complexity}]`)}\n`);
    }
  }
  if (plan.risks.length > 0) {
    process.stdout.write(`\n${bold('Risks:')}\n${plan.risks.map((risk) => `  ! ${risk}`).join('\n')}\n`);
  }
  return 0;
}

async function printStatus(): Promise<number> {
  const megaai = createMegaAI({ quiet: true });
  const projects = await megaai.planning.listProjects();
  process.stdout.write(`\n${bold('Projects')} (${projects.length})\n`);
  for (const project of projects.slice(0, 15)) {
    const progress = await megaai.planning.progressOf(project.id);
    const pct = `${Math.round(project.progress * 100)}%`.padStart(4);
    process.stdout.write(
      `  ${project.status === 'completed' ? green('●') : project.status === 'failed' ? red('●') : yellow('●')} ${pct} ${project.name} ${dim(`(${progress.completed}/${progress.total} tasks)`)}\n`,
    );
  }
  const stats = await megaai.meta.stats();
  process.stdout.write(`\n${bold('Learning')} (${stats.totalRuns} outcomes)\n`);
  for (const [kind, agent] of Object.entries(stats.byAgent)) {
    process.stdout.write(
      `  ${kind.padEnd(14)} ${Math.round(agent.successRate * 100)}% success over ${agent.runs} runs ${dim(`avg ${agent.avgDurationMs}ms`)}\n`,
    );
  }
  process.stdout.write(`\n${bold('Providers')}\n`);
  for (const provider of megaai.sessions.providerStatus()) {
    const mark = provider.configured ? green('configured') : dim('not configured');
    process.stdout.write(`  ${provider.kind.padEnd(10)} ${mark}${provider.exhausted ? red(' [exhausted]') : ''}\n`);
  }
  return 0;
}

function help(): number {
  process.stdout.write(`\n${bold('MegaAI')} — autonomous AI delivery team\n\n`);
  process.stdout.write(`Usage:\n`);
  process.stdout.write(`  megaai demo [--quiet]        offline end-to-end demo (mock provider)\n`);
  process.stdout.write(`  megaai run "<goal>"          plan + execute a goal\n`);
  process.stdout.write(`  megaai plan "<goal>"         show the generated plan only\n`);
  process.stdout.write(`  megaai status                projects, learning and provider status\n`);
  process.stdout.write(`  megaai serve                 how to start the dashboard server\n\n`);
  process.stdout.write(`Environment:\n`);
  process.stdout.write(`  ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY enable real providers;\n`);
  process.stdout.write(`  without keys MegaAI runs fully offline on the mock provider.\n\n`);
  return 0;
}

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;
  const quiet = rest.includes('--quiet');
  const positional = rest.filter((arg) => !arg.startsWith('--'));

  switch (command) {
    case 'demo':
      return executeGoal(
        'Build a complete ecommerce store for a client: product catalog, cart, checkout and authentication',
        { persistent: false, quiet },
      );
    case 'run': {
      const goal = positional.join(' ').trim();
      if (!goal) {
        process.stderr.write(`${red('error:')} megaai run needs a goal, e.g. megaai run "Build a blog"\n`);
        return 2;
      }
      return executeGoal(goal, { persistent: true, quiet });
    }
    case 'plan': {
      const goal = positional.join(' ').trim();
      if (!goal) {
        process.stderr.write(`${red('error:')} megaai plan needs a goal\n`);
        return 2;
      }
      return printPlan(goal);
    }
    case 'status':
      return printStatus();
    case 'serve':
      process.stdout.write(`Run the dashboard server with:\n  node apps/server/dist/index.js\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
      return help();
    default:
      process.stderr.write(`${red('error:')} unknown command "${command}"\n`);
      return help() || 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${red('fatal:')} ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });
