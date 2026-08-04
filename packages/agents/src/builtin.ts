/**
 * Built-in agents. Each is a descriptor (persona, tools, complexity) driven
 * by the shared model loop in `ModelDrivenAgent`: build context → build
 * prompt → complete → parse proposal → act → remember → report.
 *
 * New agent kinds — including future plugin-provided ones — are just more
 * descriptors registered with the runtime.
 */

import type { AgentDescriptor, AgentRunResult, TaskRecord } from '@megaai/types';
import type { AgentContext, AgentImplementation } from '@megaai/contracts';
import { parseProposal } from '@megaai/actions';
import { buildSystemPrompt } from '@megaai/prompt';

export class ModelDrivenAgent implements AgentImplementation {
  constructor(readonly descriptor: AgentDescriptor) {}

  async run(task: TaskRecord, ctx: AgentContext): Promise<AgentRunResult> {
    const contextText = await ctx.buildContext(task);
    const system = buildSystemPrompt({
      agentName: this.descriptor.name,
      role: this.descriptor.systemPrompt,
      toolCatalog: ctx.toolCatalog,
    });
    const messages = ctx.buildMessages(task, contextText);

    const response = await ctx.session.complete({
      system,
      messages,
      metadata: {
        agentKind: this.descriptor.kind,
        taskTitle: task.title,
        taskDescription: task.description,
        taskId: task.id,
        projectId: task.projectId,
        shellEnabled: ctx.capabilities?.shell === true,
      },
    });

    const proposal = parseProposal(response.text);
    const actionResults = await ctx.act(proposal.actions);
    const failures = actionResults.filter((result) => !result.ok);
    const ok = failures.length === 0;

    await ctx.remember(
      `[${this.descriptor.kind}] ${task.title}: ${proposal.summary}` +
        (ok ? '' : ` (${failures.length} action(s) failed)`),
      [this.descriptor.kind, ok ? 'success' : 'failure'],
    );

    return {
      ok,
      summary: proposal.summary,
      output: { summary: proposal.summary, provider: response.provider, model: response.model },
      actions: actionResults,
      usage: response.usage,
      error: ok ? undefined : failures.map((failure) => `${failure.tool}: ${failure.error}`).join('; '),
    };
  }
}

const FS_TOOLS = ['fs.write', 'fs.read', 'fs.list'];

export const BUILTIN_AGENT_DESCRIPTORS: AgentDescriptor[] = [
  {
    kind: 'coding',
    name: 'Coding Agent',
    description: 'Implements features, writes and edits source code',
    systemPrompt:
      'You are a senior software engineer. Implement the task by writing clean, working code with the fs tools. Keep files small and cohesive, follow the conventions already present in the workspace, and never leave placeholders. Commit finished work with git.commit; use git.branch.create/git.checkout/git.merge to work on a branch and integrate it. Pushing to a remote is a separate, human-approved step, not yours to take.',
    allowedTools: [
      ...FS_TOOLS,
      'fs.delete',
      'shell.exec',
      'git.commit',
      'git.status',
      'git.diff',
      'git.branch.list',
      'git.branch.create',
      'git.checkout',
      'git.merge',
    ],
    defaultComplexity: 'complex',
  },
  {
    kind: 'testing',
    name: 'Testing Agent',
    description: 'Writes and runs tests, verifies behaviour',
    systemPrompt:
      'You are a meticulous QA engineer. Write focused automated tests for the task at hand, run them when a shell is available (use expectSuccess so failures are loud), and report exactly what passed and failed.',
    allowedTools: [...FS_TOOLS, 'shell.exec', 'git.status'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'review',
    name: 'Review Agent',
    description: 'Reviews code and plans for defects and risks',
    systemPrompt:
      'You are a code reviewer. Read the relevant files and report every defect or risk you find, including low-confidence ones, each with severity. Do not modify files.',
    allowedTools: ['fs.read', 'fs.list', 'git.log', 'git.diff', 'git.status'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'research',
    name: 'Research Agent',
    description: 'Gathers requirements, compares approaches, summarises findings',
    systemPrompt:
      'You are a product/tech researcher. Analyse the task, enumerate requirements, risks and options, and produce a crisp recommendation. You normally need no tools.',
    allowedTools: ['fs.read', 'http.fetch'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'documentation',
    name: 'Documentation Agent',
    description: 'Writes user and developer documentation',
    systemPrompt:
      'You are a technical writer. Produce clear, accurate documentation for the task using the fs tools. Prefer short sections and concrete examples.',
    allowedTools: FS_TOOLS,
    defaultComplexity: 'trivial',
  },
  {
    kind: 'marketing',
    name: 'Marketing Agent',
    description: 'Produces launch copy, landing text and campaign content',
    systemPrompt:
      'You are a product marketer. Create compelling, truthful marketing content for the deliverable. Write files under marketing/.',
    allowedTools: FS_TOOLS,
    defaultComplexity: 'trivial',
  },
  {
    kind: 'crm',
    name: 'CRM Agent',
    description: 'Keeps client records, notes and follow-ups current',
    systemPrompt:
      'You maintain the CRM. Record project status, decisions and follow-ups for the client under crm/. Be factual and brief.',
    allowedTools: FS_TOOLS,
    defaultComplexity: 'trivial',
  },
  {
    kind: 'devops',
    name: 'DevOps Agent',
    description: 'Prepares builds, deployment plans and release checklists',
    systemPrompt:
      'You are a DevOps engineer. Prepare deployment configuration and a rollout plan for the task. Deployment execution is simulated in this phase — write the plan and configs; the deploy permission is approval-gated. You may configure a remote with git.remote.add and push with git.push, but both require human approval before they run.',
    allowedTools: [
      ...FS_TOOLS,
      'shell.exec',
      'git.commit',
      'git.log',
      'git.status',
      'git.remote.add',
      'git.push',
    ],
    defaultComplexity: 'standard',
  },
  {
    kind: 'architecture',
    name: 'Architecture Agent',
    description: 'Designs system structure and records decisions',
    systemPrompt:
      'You are a software architect. Produce a concise design for the task: components, data flow, trade-offs, and record it as an ADR-style document when appropriate.',
    allowedTools: FS_TOOLS,
    defaultComplexity: 'complex',
  },
];

export function createBuiltinAgents(): AgentImplementation[] {
  return BUILTIN_AGENT_DESCRIPTORS.map((descriptor) => new ModelDrivenAgent(descriptor));
}
