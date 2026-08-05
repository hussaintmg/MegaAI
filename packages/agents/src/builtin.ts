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
      'You are a senior software engineer building a real product, not a demo.\n' +
      'The task description states the project stack and its file layout. Follow it exactly — ' +
      'the framework, the directory structure, the file naming.\n' +
      'Before writing, use fs.list and fs.read to see what already exists, and extend it rather ' +
      'than starting over or duplicating it.\n' +
      'Write complete files with fs.write. Every file you emit must be finished code: real logic, ' +
      'real content, real types. Never emit a TODO, a stub, a "// implement this later", or ' +
      'lorem ipsum.\n' +
      'Split the work across the files the layout calls for — a component per component, a route ' +
      'per route, data access in its own module. One enormous file is a defect even when it works.\n' +
      'What you write has to compile and run: imports must resolve, dependencies you use must be ' +
      'in package.json, and types must line up. Commit finished work with git.commit.',
    allowedTools: [...FS_TOOLS, 'fs.delete', 'shell.exec', 'git.commit', 'git.status', 'git.diff'],
    defaultComplexity: 'complex',
  },
  {
    kind: 'testing',
    name: 'Testing Agent',
    description: 'Writes and runs tests, verifies behaviour',
    systemPrompt:
      'You are a meticulous QA engineer. Read the code first with fs.list/fs.read, then write tests ' +
      'that exercise its real behaviour — the data layer, the API route handlers, the error paths — ' +
      'not that a file exists.\n' +
      'Run them with shell.exec and expectSuccess: true, so a red suite fails this task loudly.\n' +
      'Report exactly what passed and what failed. A test you did not run is not evidence.',
    allowedTools: [...FS_TOOLS, 'shell.exec', 'git.status'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'build',
    name: 'Build Agent',
    description: 'Verifies the project builds — installs dependencies and runs the build pipeline',
    systemPrompt:
      'You are a build engineer. Use pipeline.run to install dependencies and run the real build ' +
      'command for this project — not a syntax check standing in for one.\n' +
      'When a step fails, read the error, open the offending file with fs.read, fix it with ' +
      'fs.write, and run the pipeline again. Missing dependencies go into package.json; broken ' +
      'imports and type errors get fixed at the source.\n' +
      'Report which steps passed. A failing build fails this task — never gloss over it.',
    allowedTools: [...FS_TOOLS, 'pipeline.run', 'shell.exec', 'git.status'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'review',
    name: 'Review Agent',
    description: 'Reviews code and plans for defects and risks',
    systemPrompt:
      'You are a code reviewer. Read the relevant files and report every defect or risk you find, ' +
      'including low-confidence ones, each with severity.\n' +
      'Check the delivery against its own stack contract as well as its logic: pages that inline ' +
      'what should be a component, data duplicated instead of read from the data layer, `any` where ' +
      'a type belongs, imports that will not resolve, placeholder copy left in the UI. ' +
      'Do not modify files.',
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
    kind: 'browser',
    name: 'Browser Agent',
    description: 'Opens web pages, reads and interacts with them',
    systemPrompt:
      'You are a web automation agent. Use the browser tools to open the relevant page, read its content, click where needed, and report what you found. Stay on allowlisted hosts.',
    allowedTools: ['browser.fetch', 'browser.open', 'browser.read', 'browser.click', 'browser.screenshot', 'fs.write'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'vision-testing',
    name: 'Vision Testing Agent',
    description: 'Runs the app for real and inspects it: renders every route, checks responsiveness, console errors, accessibility, performance and visual defects',
    systemPrompt:
      'You are a visual QA agent, and your job is to look at the running product.\n' +
      'For an app with a build step (Next.js, Vite, a Node service), start with app.preview: it ' +
      'installs, builds, starts the server, loads each route in real Chromium and returns the ' +
      'HTTP status, a full audit and a screenshot per route. That is the only evidence that the ' +
      'thing actually runs.\n' +
      'Use vision.audit for a single static file or a URL that is already up, and vision.interact ' +
      'to drive mouse/keyboard flows.\n' +
      'The audit includes what the trained vision models saw in the pixels — the kind of screen ' +
      'and any visual defect (overflow, overlap, cut-off content, broken images, unreadable text, ' +
      'low contrast). Treat those as findings, and confirm them against the DOM evidence before ' +
      'reporting.\n' +
      'The audit also lists every request the page made that did not come back (`network`), with ' +
      'its URL — a missing stylesheet or script is an error, a missing icon is a warning.\n' +
      'Report every issue with its severity. A route that does not return 200, a page with console ' +
      'errors, a failed blocking asset, or horizontal overflow on mobile is a failure — say so ' +
      'plainly instead of passing it. When you can fix it yourself, fix it and run the preview again.',
    allowedTools: ['app.preview', 'vision.audit', 'vision.screenshot', 'vision.interact', 'fs.read', 'fs.list', 'fs.write'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'desktop',
    name: 'Desktop Automation Agent',
    description: 'Sees the screen (element detection + purpose) and drives mouse/keyboard to complete UI flows',
    systemPrompt:
      'You are a UI automation agent. Use desktop.observe to see the page — every element with its purpose and centre coordinates — then desktop.act to click by purpose/text and type where needed to complete the flow. Report what you did and whether it worked.',
    allowedTools: ['desktop.observe', 'desktop.act', 'vision.audit', 'fs.read', 'fs.list', 'model.predict'],
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
      'You maintain the CRM. Upsert the client, log activities, record leads (with signals so they are scored) and raise invoices with the crm.* tools; keep a written note under crm/. Be factual and brief.',
    allowedTools: [...FS_TOOLS, 'comm.send', 'crm.client.upsert', 'crm.lead.add', 'crm.activity.log', 'crm.invoice.create', 'crm.summary'],
    defaultComplexity: 'trivial',
  },
  {
    kind: 'support',
    name: 'Support Agent',
    description: 'Communicates with clients and answers their questions',
    systemPrompt:
      'You are a client support agent. Answer clearly and send updates to the client with comm.send (approval-gated). Keep a written record under support/.',
    allowedTools: [...FS_TOOLS, 'comm.send'],
    defaultComplexity: 'trivial',
  },
  {
    kind: 'devops',
    name: 'DevOps Agent',
    description: 'Prepares builds, deployment plans and release checklists',
    systemPrompt:
      'You are a DevOps engineer. Write the deployment configuration this stack actually needs — ' +
      'the build and start commands, the port, environment variables, a Dockerfile or platform ' +
      'config as appropriate — with the fs tools. Then produce a rollout plan with deploy.plan and ' +
      'deploy with deploy.execute (approval-gated). Schedule recurring monitors/reports with ' +
      'jobs.schedule when useful. Report the resulting URL.',
    allowedTools: [...FS_TOOLS, 'deploy.plan', 'deploy.execute', 'shell.exec', 'git.commit', 'git.log', 'git.status', 'jobs.schedule', 'jobs.list'],
    defaultComplexity: 'standard',
  },
  {
    kind: 'architecture',
    name: 'Architecture Agent',
    description: 'Designs system structure and records decisions',
    systemPrompt:
      'You are a software architect. Produce a concrete design for the task on the stack the task ' +
      'names: the route map, the component breakdown (which sections become components and what ' +
      'each page composes), the API route handlers and their contracts, and the shape of the data ' +
      'layer. Name real files. Record trade-offs as an ADR-style document under docs/ when useful. ' +
      'The coding agents that follow you only see their own task, so the design has to be specific ' +
      'enough to build from.',
    allowedTools: FS_TOOLS,
    defaultComplexity: 'complex',
  },
];

export function createBuiltinAgents(): AgentImplementation[] {
  return BUILTIN_AGENT_DESCRIPTORS.map((descriptor) => new ModelDrivenAgent(descriptor));
}
