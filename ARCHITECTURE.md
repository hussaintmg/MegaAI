# MegaAI Architecture

MegaAI is a layered monorepo: 23 packages + 2 apps, each with a single
responsibility, talking to each other only through the data shapes in
`@megaai/types` and the interfaces in `@megaai/contracts`. Lower layers never
import higher ones; the dependency graph is a strict DAG enforced by
TypeScript project references.

## Layers

```
┌────────────────────────────────────────────────────────────┐
│  Surface        apps/cli · apps/server (dashboard) · sdk   │
├────────────────────────────────────────────────────────────┤
│  Intelligence   orchestrator · meta-brain · agents         │
├────────────────────────────────────────────────────────────┤
│  Execution      workflow · planning · policy · actions     │
│                 tools · prompt · context · memory          │
├────────────────────────────────────────────────────────────┤
│  AI & machine   ai (providers/sessions/limits) · resources │
├────────────────────────────────────────────────────────────┤
│  Core runtime   runtime (DI · lifecycle · metrics · jobs)  │
├────────────────────────────────────────────────────────────┤
│  Foundation     types · contracts · utils · config         │
│                 logger · events · database · security      │
└────────────────────────────────────────────────────────────┘
```

## Life of a goal

`submitGoal("Build this client an ecommerce store")` flows through the
system like this:

1. **Think + Plan** — `MetaBrain.plan()` analyses the goal (domain,
   features) and produces a `PlanSpec`: named phases containing typed tasks
   (`agentKind`, `complexity`, dependencies). Planning is template-driven
   today — deterministic and offline-testable — and `plan()` is the single
   seam where model-backed planning slots in later.
2. **Divide** — `PlanningService.materializePlan()` turns the spec into
   durable records: a project, one milestone per phase, and tasks whose
   `dependsOn` edges make phases sequential and intra-phase work parallel.
3. **Gate** — the orchestrator wraps execution in a `WorkflowEngine` run
   whose first step is an **approval gate**: the plan waits for a human
   (dashboard/API) unless `policy.autoApprove` is on. Every step checkpoints
   to the database; runs can pause, resume — even from a fresh process —
   and roll back completed steps on failure.
4. **Assign + Execute** — the orchestrator claims ready tasks in waves
   (concurrency adapted to resource pressure) and hands each to the
   `AgentRuntime`, which spawns a supervised instance of the implementation
   registered for the task's `agentKind`, with heartbeats and
   restart-on-failure.
5. **Agent loop** — each agent runs the same shape
   (`ModelDrivenAgent`): `ContextEngine.assemble()` gathers project state,
   sibling results and relevant memories under a token budget →
   `buildSystemPrompt()`/`buildTaskMessages()` compile the prompt →
   `AiSession.complete()` runs the model → `parseProposal()` extracts the
   action protocol → `ActionEngine.execute()` authorises and runs each
   action → the outcome is written to memory.
6. **Act** — the `ActionEngine` is the only path from "model said" to
   "system did": unknown tools are rejected, the agent's tool allowlist and
   per-permission grants (`security.PermissionManager`) are checked, the
   `PolicyEngine` evaluates deny/approval rules, approval-gated permissions
   block on the `ApprovalManager`, and the tool finally executes inside the
   workspace sandbox. Every action is evented and audited.
7. **Recover** — three independent safety nets:
   - *Provider level:* `AiSessionManager.completeWithFallback()` walks the
     provider chain; 429s cool a provider down (`LimitTracker`), refusals
     and outages fall through to the next provider mid-task.
   - *Task level:* failed tasks return to `pending` until `maxAttempts`,
     with complexity escalated to a stronger model tier on retry; exhausted
     tasks mark dependents `blocked`.
   - *Agent level:* the runtime restarts a failed agent with a fresh
     context up to `maxRestarts`.
8. **Report + Learn** — progress updates project records (events feed the
   dashboard live), a `MEGAAI_REPORT.md` is written into the workspace, and
   `MetaBrain.recordOutcome()` accumulates per-agent / per-provider success
   rates, flagging repeated failures as lessons.

## Module responsibilities

| Package | Responsibility | Key exports |
| --- | --- | --- |
| `types` | Shared domain model: records, enums, `MegaError`, event names | `TaskRecord`, `PlanSpec`, `Events`, `MegaError` |
| `contracts` | Interfaces between modules (the plugin seams) | `Provider`, `Tool`, `AgentImplementation`, `Database` |
| `utils` | Ids, clocks, retry/backoff, semaphore, JSON extraction | `retry`, `Semaphore`, `ManualClock`, `extractJsonObject` |
| `config` | Layered config: defaults → file → env → overrides, validated | `loadConfig`, `MegaConfig` |
| `logger` | Structured leveled logging, child scopes, pluggable sinks | `createLogger`, `MemorySink` |
| `events` | Typed bus: prefix wildcards, history buffer, `waitFor` | `EventBus` |
| `database` | Storage engines behind one interface | `JsonFileDatabase` (atomic writes), `MemoryDatabase` |
| `security` | Permission grants, secret vault + redaction, audit log, rate limiter | `PermissionManager`, `SecretVault`, `AuditLog` |
| `runtime` | DI container, ordered lifecycle with unwind, health, metrics, scheduler | `ServiceContainer`, `MetricsRegistry`, `Scheduler` |
| `resources` | CPU/RAM/disk sampling, pressure classification, concurrency advice | `ResourceMonitor` |
| `ai` | Provider adapters (Anthropic/OpenAI-compat/Gemini/mock), model registry with tiers + pricing, per-provider limits, fallback session manager | `AiSessionManager`, `MockProvider`, `AnthropicProvider` |
| `memory` | Scoped memories + knowledge base + local vector search (hashed bag-of-words, cosine) | `MemoryEngine`, `KnowledgeBase`, `embed` |
| `policy` | Declarative rules (deny / require-approval, actor + time-window scoped), approvals with auto-approve mode | `PolicyEngine`, `ApprovalManager` |
| `planning` | Projects, milestones, dependency-graphed tasks, ready-queue, progress | `PlanningService` |
| `workflow` | Durable step execution: retries, rollback, checkpoints, pause/resume, approval gates | `WorkflowEngine` |
| `tools` | Tool registry + built-ins: sandboxed fs, allowlisted http, gated shell, time | `ToolRegistry`, `createBuiltinTools`, `resolveInWorkspace` |
| `actions` | Parse model proposals, authorise (allowlist → grants → policy → approvals), execute, report | `ActionEngine`, `parseProposal` |
| `prompt` | Prompt compilation + the action protocol contract | `buildSystemPrompt`, `ACTION_PROTOCOL` |
| `context` | Budgeted context assembly from planning + memory | `ContextEngine` |
| `code` | Code engine: git for delivery workspaces (auto-versioned deliveries, `git.*` agent tools) | `GitEngine`, `createGitTools` |
| `browser` | Browser automation: pluggable driver (offline simulator + optional Playwright), `browser.*` tools gated on `net.browser` | `BrowserEngine`, `SimulatedDriver`, `createBrowserTools` |
| `deploy` | Deployment engine: pure `deploy.plan` + approval-gated `deploy.execute`; simulated by default, Docker/Vercel/Railway adapters | `DeployEngine`, `createDeployTools` |
| `comm` | Communication engine: channels (captured/webhook), `comm.send` tool (gated), event-driven `NotificationEngine` for operator updates | `CommEngine`, `NotificationEngine`, `createCommTool` |
| `agents` | Supervised agent lifecycle + 9 built-in agent kinds | `AgentRuntime`, `ModelDrivenAgent` |
| `meta-brain` | Goal analysis, plan generation (templates or model-backed via `makePlan`), decisions (complexity/concurrency/retry), learning store | `MetaBrain`, `generatePlan`, `parsePlanSpec` |
| `orchestrator` | Wires everything: goal → plan → workflow → agents → report | `Orchestrator` |
| `sdk` | `createMegaAI()` composition root + re-exports | `createMegaAI` |

## Design decisions

- **Offline-first.** The `MockProvider` speaks the same action protocol as
  real models, deterministically. Every test and the demo run with zero
  network access; real providers are configuration, not code changes.
- **The action protocol is the trust boundary.** Models return JSON
  (`{ thoughts, summary, actions[] }`); nothing executes except through the
  `ActionEngine`'s authorisation pipeline. Prompt-injection cannot invent
  capabilities an agent was never granted.
- **Determinism where it matters.** Clocks are injectable (`ManualClock`),
  waits are injectable, ids are time-ordered — the whole test suite runs in
  under a second with no sleeps or flakiness.
- **State is durable and inspectable.** Everything MegaAI knows lives in
  JSON files under `.megaai/db/` (atomic writes) — projects, tasks,
  workflow checkpoints, memories, audit, outcomes. Swap in a real database
  by implementing the four-method `Database` contract.
- **Events over coupling.** Modules publish to the bus; the dashboard, CLI
  progress, audit trails and tests are all just subscribers. The bus keeps
  bounded history so a late-attaching observer still sees the recent story.
- **Contracts anticipate the marketplace.** Providers, tools, agents and
  databases are all interfaces a plugin can implement without forking core
  — the Phase 4 plugin runtime will load exactly these shapes.

## Known Phase-2 limitations (by design, tracked in ROADMAP.md)

- Plan generation is template-based by default; model-backed planning is
  available via `config.meta.planner: 'model'` (`makePlan()`), with a critic/
  refine loop still to come.
- Goal workflows use closure steps, so a crashed *goal* run resumes at task
  granularity (tasks are individually durable) rather than mid-step.
  Registered named workflows already resume across processes.
- The vector index is a hashed bag-of-words placeholder — honest, local and
  swappable for real embeddings behind `embed()`.
- Browser/desktop automation, vision and communication tools are Phase 3
  surface area; the tool/permission model they'll plug into is in place.
