# MegaAI Roadmap

Four phases, bottom-up — each phase makes the next one possible. Phases 1–2
are implemented in this repository; Phases 3–4 are specified and have their
contracts in place.

## Phase 1 — Foundation ✅

The system services, runtime and control plane.

- [x] Config (layered: defaults → file → env → overrides, validated)
- [x] Logger (structured, leveled, child scopes, memory sink for dashboard)
- [x] Events (typed bus, wildcards, history, waitFor)
- [x] Runtime (DI container, ordered lifecycle with unwind, health, metrics, scheduler)
- [x] Contracts (Provider / Tool / Agent / Database interfaces — the plugin seams)
- [x] Database (atomic JSON file store + in-memory engine behind one interface)
- [x] Security (permission grants, secret vault + redaction, audit log, rate limiter)
- [x] Types & Utils (shared domain model, `MegaError`, ids, clocks, retry)
- [x] SDK (`createMegaAI()` one-call bootstrap)
- [x] Resource monitor (CPU/RAM/disk, pressure levels, concurrency advice)
- [x] Policy engine (deny / require-approval rules, actor + time-window scoping, maintenance mode)
- [x] Workflow engine (steps, retries, rollback, checkpoints, pause/resume, approval gates)
- [x] Planning (projects, milestones, dependency-graphed tasks, ready queue, progress)
- [x] Orchestrator (goal → plan → workflow → agents → report)
- [x] CI (build + tests + demo smoke test)

## Phase 2 — Execution layer ✅

Where MegaAI first does real work.

- [x] AI session manager (leases, provider fallback chain, cooldowns)
- [x] Provider adapters: Anthropic (official SDK), OpenAI-compatible, Gemini, deterministic mock
- [x] Model registry (tiers, context windows, pricing → cost tracking)
- [x] Limits (requests/minute, tokens/day, exhaustion cooldowns per provider)
- [x] Memory engine (scoped memories, local vector search) + knowledge base
- [x] Context engine (budgeted assembly: project state, sibling results, memories)
- [x] Prompt engine (compiled system/task prompts, action protocol)
- [x] Action engine (parse → allowlist → grants → policy → approvals → execute → audit)
- [x] Tool system (sandboxed fs, allowlisted http, gated shell, time; registry + specs)
- [x] Agent runtime (spawn, heartbeat, pause/resume/kill, restart-on-failure, concurrency)
- [x] Built-in agents: coding, testing, review, research, documentation, marketing, crm, devops, architecture
- [x] Meta brain v1 (goal analysis, plan templates, complexity escalation, learning stats)
- [x] Dashboard + REST API + SSE event stream
- [x] CLI (demo / run / plan / status)

## Phase 3 — Automation layer 🚧 (in progress)

Reaching out of the workspace into the real world. The tool/permission
model these plug into already exists.

- [x] Code engine v1 (`@megaai/code`): git tool suite (`git.commit/status/log/diff`),
      every delivery workspace versioned automatically as a real repository
- [x] Real test execution: the testing agent runs `node --test` through the
      gated shell tool (`expectSuccess` makes red suites fail the task)
- [ ] Git collaboration (branches, merge, remote push behind approval)
- [ ] Real build pipelines (npm install/build on top of the gated shell tool)
- [ ] Browser automation (profiles, tabs, logins, downloads — sandboxed, allowlisted)
- [ ] Desktop automation (mouse, keyboard, clipboard, OCR, windows)
- [ ] Vision (screenshots, UI understanding, image analysis)
- [ ] Deployment integrations (Docker, VPS, Railway, Vercel, Cloudflare) behind the approval-gated `deploy` permission
- [ ] Communication channels (email, WhatsApp, Slack, Discord, Telegram) behind `comm.send`
- [ ] CRM integrations (clients, invoices, leads, meetings, payments)
- [ ] Scheduler-driven recurring jobs (reports, monitors, follow-ups)
- [ ] Notification engine (progress pings to the human's channels)

## Phase 4 — Intelligence layer 🔮

Self-improving, distributed, extensible.

- [ ] Model-backed planning (the `MetaBrain.plan()` seam swaps templates for a frontier model + critic loop)
- [ ] Real embeddings + semantic retrieval (swap `embed()`; add re-ranking)
- [ ] Learning-driven routing (choose provider/model/agent from outcome stats automatically)
- [ ] Multi-step agent loops (iterative act → observe → refine within one task)
- [ ] Agent-to-agent delegation and review chains
- [ ] Plugin runtime (load third-party providers/tools/agents from packages)
- [ ] Plugin + agent marketplace
- [ ] Multi-user / multi-tenant (auth, RBAC, per-tenant workspaces and budgets)
- [ ] Distributed execution (remote workers, cluster scheduling, cross-machine fallback — "another account, another browser, another PC")
- [ ] Cost manager + billing
- [ ] Desktop / mobile / web clients on the existing API

## Where to plug in today

| You want to add… | Implement | Register via |
| --- | --- | --- |
| A model provider | `Provider` (`@megaai/contracts`) | `createMegaAI({ extraProviders })` |
| A tool | `Tool` | `createMegaAI({ extraTools })` |
| An agent kind | `AgentDescriptor` (+ optional custom `AgentImplementation`) | `createMegaAI({ extraAgents })` |
| A storage backend | `Database` | construct and pass through the SDK wiring |
| A plan template | extend `generatePlan()` domains | `@megaai/meta-brain` |
