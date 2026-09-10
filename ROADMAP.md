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
- [x] Real build pipelines: `pipeline.run` (ordered, fail-fast, allowlisted)
      + a build agent that syntax-checks every source file; a broken build
      fails the task and triggers recovery
- [x] Git collaboration (`@megaai/code`): `git.branch.create/list`, `git.checkout`,
      `git.merge` (no-fast-forward, conflicts reported not thrown) — all
      `git.write`; `git.remote.add`; `git.push` on its own `git.push`
      permission, approval-gated by default and checked against an optional
      remote host allowlist
- [ ] `npm install`/`npm build` pipelines for dependency-bearing projects
- [x] Browser automation v1 (`@megaai/browser`): pluggable driver — offline
      deterministic simulator by default, optional real Chromium via
      Playwright (dynamic import, config-gated); `browser.fetch/open/read/
      click/screenshot` tools on the `net.browser` permission, host-allowlisted;
      browser agent kind
- [ ] Browser sessions: profiles, tabs, cookies, logins, downloads
- [x] Desktop / UI automation v1 (`@megaai/desktop`): browser-backed screen
      perception — `desktop.observe` returns every interactive element with its
      geometry, centre coordinates and *purpose* (sharing the trained
      UI-purpose model) — plus real mouse/keyboard through `desktop.act` (click
      by purpose/text/selector/coordinates, type, press, scroll, wait), on the
      `desktop` permission; a desktop-automation agent kind. The
      `DesktopSession` seam lets a native OS driver slot in later.
- [ ] Native desktop driver: OS-level mouse/keyboard, clipboard, OCR, windows
- [x] Vision / UI testing engine (`@megaai/vision`): static HTML analysis
      (always on) + real headless Chromium (via `playwright-core` against the
      pre-installed browser) — responsive overflow across viewports, captured
      console/JS errors, accessibility, navigation-timing performance, UI
      element detection with purpose classification, full-page screenshots and
      mouse/keyboard interaction. `vision.audit/screenshot/interact` tools,
      vision-testing agent, wired into ecommerce/website plans. Run with
      `megaai run "…" --browser`.
- [x] Trainable models pack (`@megaai/models`): real in-process classical ML
      (softmax logistic regression + multinomial naive Bayes) trained on
      seeded, self-generated datasets — no GPU, no downloaded corpus. Three
      models, each reporting held-out accuracy: UI-purpose (backs the vision
      engine's element classification), lead-scoring (hot/warm/cold) and
      error-triage (routes an error/log line to a category). `megaai train`
      persists them to `.megaai/models/`, the SDK loads them on boot, and the
      `model.predict` tool serves them. Heavy deep-vision models register
      later through the same `PredictiveModel` seam.
- [ ] Deeper vision: image/object analysis, visual diffing, OCR
- [x] Deployment engine v1 (`@megaai/deploy`): pure `deploy.plan` + approval-gated
      `deploy.execute`; simulated target by default (records `.megaai-deploy.json`
      with a URL), Docker/Vercel/Railway/static adapters as command lists run by
      an allowlisted runner only when a shell is enabled
- [ ] More targets (Cloudflare, Kubernetes, VPS) + live URL/health readback
- [x] Communication engine v1 (`@megaai/comm`): one `send()` channel shape
      (captured default + webhook for Slack/Discord/Telegram); `comm.send`
      tool on the approval-gated `comm.send` permission; support agent + CRM
      client messaging
- [x] Notification engine: watches lifecycle events (goal/project/approval)
      and pushes operator updates to the configured channel — surfaced at
      `GET /api/notifications`
- [x] Native email (`@megaai/comm` `EmailChannel`): composes a proper RFC5322
      message and delivers through a pluggable transport — an HTTP email API
      (SendGrid/Postmark-style, host-allowlisted) or SMTP via the optional
      `nodemailer` seam; captures the composed message offline. Registered as an
      `email` channel when `comm.email.from` is configured.
- [x] CRM engine (`@megaai/crm`): clients, leads (scored hot/warm/cold by the
      trained lead-scoring model), activities and invoices behind the Database
      contract; `crm.client.upsert` / `crm.lead.add` / `crm.activity.log` /
      `crm.invoice.create` / `crm.summary` tools; the CRM agent uses them.
- [x] Recurring scheduled jobs (`@megaai/jobs`): durable job records run on the
      runtime Scheduler with pluggable job kinds; `jobs.schedule/list/run/cancel`
      tools; built-in `operator-report` and `crm-followup` kinds push summaries
      to the notify channel. Survive restarts; run bookkeeping per job.

## Phase 4 — Intelligence layer 🔮

Self-improving, distributed, extensible.

- [x] Model-backed planning v1: `MetaBrain.makePlan()` asks the AI (through the
      fallback chain) to generate a validated `PlanSpec`, sanitising and
      falling back to templates on any failure; `config.meta.planner: 'model'`
      or `megaai run … --model-planner`. Deterministic offline via the mock.
- [x] Bring-your-own-keys: OpenRouter + Groq providers (OpenAI-compatible, base-
      URL adapter); a dashboard **Settings** page (`/settings`) to enter provider
      API keys, the fallback order, email delivery and a Vercel/Railway deploy
      token — persisted to `.megaai/settings.json` (local, gitignored) and
      hot-applied by rebuilding the engine in place. A Colab notebook
      (`notebooks/`) trains the models pack on larger data and exports drop-in
      bundles the runtime loads unchanged.
- [ ] Planning critic loop (generate → critique → refine)
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
| A trained model | `PredictiveModel` (`@megaai/models`) | `ModelRegistry.register()` (served by `model.predict`) |
