# MegaAI as a mesh — laptop, phone, cloud

The system you asked for is not the one that exists. What exists is a cloud
runner that executes one goal per GitHub Actions job and reports back. What you
want is **one brain across three bodies**: your laptop, your Samsung A07, and
Vercel — where the laptop leads when it is awake, the phone can hand out work
from anywhere, and nothing is ever lost because a machine was asleep.

This document is the plan. Read the decisions first; they are the parts worth
arguing with.

---

## 1. The shape

```
                     ┌──────────────── MongoDB Atlas ────────────────┐
                     │  nodes · tasks · leases · events · memory     │
                     └───▲───────────────▲───────────────────▲───────┘
      change streams     │               │                   │
      (live, no polling) │               │                   │
              ┌──────────┴───┐   ┌───────┴──────┐   ┌────────┴───────┐
              │  LAPTOP node │   │  PHONE node  │   │  VERCEL node   │
              │  priority 100│   │  priority 40 │   │  priority 10   │
              │              │   │              │   │                │
              │ heavy work:  │   │ phone-only:  │   │ always-on:     │
              │ coding,      │   │ SMS, calls,  │   │ dashboard,     │
              │ builds,      │   │ WhatsApp,    │   │ scheduling,    │
              │ Chrome,      │   │ camera,      │   │ light API work,│
              │ Unreal/Unity │   │ location     │   │ webhooks       │
              └──────────────┘   └──────────────┘   └────────────────┘
```

**Every node runs the same engine.** A node is not a different program — it is
the same MegaAI with a different *capability set* and a different *priority*.
That is the only way "laptop first, phone if the laptop is asleep, cloud if
neither" stays one system instead of three that drift apart.

---

## 2. Decisions

### 2.1 Live transport: change streams, not WebSockets

You asked for sockets, not APIs. You are right about the goal — no polling —
but a raw WebSocket server cannot live on Vercel: serverless functions are
killed between requests and cannot hold a connection open.

So:

- **Node ↔ Node ↔ Cloud: MongoDB change streams.** Every node opens one
  long-lived `watch()` on the tasks and events collections. Mongo pushes the
  change the instant it is written. This *is* a socket — a persistent TCP
  connection to Atlas — and it needs no server of our own, no extra hosting,
  and no second account. It survives network drops by resuming from a stored
  token, which is precisely the "continue where it left off" behaviour you
  asked for.
- **Cloud → Browser: Server-Sent Events.** Vercel supports streaming responses.
  SSE reconnects by itself, which a raw WebSocket does not. Live logs, live
  task state, live node health — all pushed, none polled.

If you later want a true WebSocket relay (for phone→laptop direct commands with
no Atlas round trip), it slots in as a second transport without changing
anything above it. That is why the transport sits behind one interface.

### 2.2 The queue is the heart, and it must never lie

Every failure you have hit came from the system claiming something that was not
true. The queue is built so it cannot:

- A task is **claimed with a lease**, not assigned. A lease is a timed
  ownership record. If a node dies mid-task — laptop lid closed, Termux killed,
  Vercel timeout — the lease expires and the task returns to the queue with its
  progress intact. Nothing needs to notice the crash.
- A task **never fails because a machine is absent**. If the only node that can
  run it is offline, it waits. `pending` is a normal state, not an error.
- Progress is **checkpointed per step**, so resuming does not redo finished
  work.
- Every state change is an event with a cause. "Waiting for the laptop"
  is a status you can see, not silence.

### 2.3 Routing: capability first, then priority, then load

A task declares what it needs (`shell`, `browser`, `gpu`, `sms`, `whatsapp`,
`camera`, `always-on`). The queue offers it to the highest-priority *online*
node that has those capabilities.

- "Send this WhatsApp" needs `whatsapp` → laptop (Chrome) or phone.
- "Build this Unreal project" needs `gpu` + `shell` → laptop only; waits if the
  laptop is asleep.
- "Run the nightly report" needs `always-on` → Vercel.
- Anything unrestricted → laptop if awake, else Vercel.

### 2.4 The laptop must not become unusable

This is a hard requirement, not a nice-to-have. The laptop agent:

- Samples CPU load, RAM, and package temperature every few seconds.
- Has three gears: **full** (you are away — everything runs, including work
  that takes over the screen), **background** (you are here — everything that
  stays out of your way still runs; only work needing the mouse, keyboard or
  screen waits), and **stop** (too hot, nearly flat, nearly out of memory).
- The dividing line is **not urgency**. The first build of this deferred all
  non-urgent work while you were at the keyboard, which meant a laptop sitting
  idle all day for no reason: a coding agent in a background process costs you
  nothing while you type. What costs you the machine is a task grabbing the
  mouse or photographing the screen, and that is the only thing that waits.
- Reads its own thresholds from config, so if it still gets warm you turn it
  down without touching code.

Built, and one thing had to change once it ran. "Are you at the keyboard" comes
from `GetLastInputInfo`, which some machines cannot answer at all. The first
version treated *unknown* as *you are here* — safe, and completely useless:
on any such machine the whole backlog deferred forever, silently, which is the
exact failure this system exists to end. So where there is no idle-time
reading, CPU load stands in: sustained quiet below 12% for the same period
counts as away, and the reason on screen says which signal it acted on.

### 2.5 The agent fleet

Today: one coding agent, one testing agent, one reviewer. That is why the
output is mediocre — one prompt is asked to be an architect, a designer and an
engineer at once.

Planned fleet, each with its own prompt, tools and verification step:

| Group | Agents |
| --- | --- |
| Plan | product, architecture, tech-selection, task-breakdown |
| Design | UI design, UX flow, design-system, animation |
| Build | frontend, backend, database, API, integration, devops |
| Verify | unit-test, e2e-test, visual-regression, accessibility, performance, security, code-review |
| Content | copywriting, SEO, marketing, documentation |
| Ops | deployment, monitoring, CRM, support, communication |

Every build agent is followed by a verify agent that can **send the work back**.
That loop — not a better prompt — is what raises quality.

### 2.6 Driving the coding agents you already pay for

You have Claude Code, Codex and OpenCode. They are better at writing code than
anything MegaAI would prompt from scratch — so MegaAI stops competing with them
and becomes their shift manager instead.

- **Their CLIs, not their editor windows.** `claude -p`, `codex exec` and
  `opencode run` each take a prompt, a working directory and a session to
  resume. GUI automation has none of that and breaks on every update. Apps with
  no CLI fall back to the existing screen-and-click path.
- **Quota is tracked per agent.** Their output is watched for "usage limit
  reached" and the reset time it usually carries. The patterns are deliberately
  narrow — parking a working agent over a type error would waste the night.
- **A limit costs a handoff, not the task.** The next agent receives a brief
  that says *do not start over*: the goal, what each previous agent already
  did, the files that changed on disk, and the last thing the stopped agent
  reported. A handoff that just repeats the original prompt makes the new agent
  redo the work — and often undo it.
- **When all of them are spent, the work waits.** The earliest reset becomes
  the task's `notBefore`, so the night resumes by itself rather than needing
  you to notice.
- **Projects run in parallel**, one agent per folder — with the session
  remembered per project, so a second turn on the same codebase resumes the
  conversation instead of re-explaining it.

### 2.7 Multi-turn agents

The single biggest quality lever, and the one thing still missing after all the
fixes so far: an agent gets **one** shot per task. It writes, and never sees
whether the build passed.

The loop: propose → run tools → read the real result (compiler errors, test
output, the screenshot) → correct → repeat, up to a step budget. This is how a
type error gets fixed instead of shipped.

### 2.8 Inputs: voice, files, images

- **Voice**: recorded on the phone or laptop, transcribed by whichever provider
  is configured (Gemini takes audio directly).
- **Files**: pdf, docx, csv, code — read and summarised into the task context.
- **Images**: the trained vision models already read screenshots; OCR is added
  for text inside images, so a screenshot of an error message becomes a task.

---

## 3. Phases

Each phase ends with something you can run and see. No phase depends on a later
one being finished.

| # | Phase | You can | Size |
| --- | --- | --- | --- |
| **1** ✅ | **Mesh core** — node registry, heartbeats, durable task queue with leases, capability routing, MongoDB store with change streams (polling fallback), local file store | See every node's status live; queue a task with the laptop off and watch it run when the laptop wakes | done |
| **2** ✅ | **Laptop agent** — autostart, resource guard, three gears, crash-resume, per-project locking | Close the lid mid-task and have it continue after reboot; watch it back off while you work — see [LAPTOP-AGENT.md](./LAPTOP-AGENT.md) | done |
| **3** ✅ | **Coder relay** — drive Claude Code / Codex / OpenCode, track quota, hand off with context, resume at reset | Leave it overnight and find work done by three agents in turn, not one that stopped at midnight | done |
| **3a** | **The rest of phase 1–3** — SSE to the browser, the dashboard's live node/queue view, local Chrome control for WhatsApp | Watch it work from the phone | ~1 week |
| **3b** | **Multi-turn agents + fleet** — the propose→verify→correct loop, and the specialist agents above | Get code that compiles because the agent saw the error | ~2 weeks |
| **4** | **Phone node** — PWA for control and live logs; Termux agent for phone-only work (SMS, WhatsApp, camera) | Say "email this to the client" from your phone and have it happen | ~1 week |
| **5** | **Full delivery** — repo creation, push, Vercel deploy, then open the live URL and verify it really works | One sentence in, a live verified URL out | ~1 week |
| **6** | **Voice, files, image OCR** | Talk to it | ~1 week |
| **7** | **Heavy tooling** — Unreal, Unity, image generation, Photoshop/Canva automation | The long tail | ongoing |

---

## 4. What each node needs from you, once

| Node | Setup |
| --- | --- |
| Laptop | `node apps/node/dist/index.js install` — registers the autostart task. Full instructions: [LAPTOP-AGENT.md](./LAPTOP-AGENT.md) |
| Phone (control) | Open the dashboard in Chrome → "Add to home screen" |
| Phone (worker) | Termux from **F-Droid** (the Play Store build is abandoned), then `npx megaai node install` |
| Vercel | Already done |

No Play Store app: publishing one needs a developer account, a review cycle and
a release pipeline, and it would still be the same Node agent underneath.
Termux gives you the same capability today.

---

## 5. What this replaces

The GitHub Actions runner stays, as one more node — useful when everything else
is offline and for clean-room builds. But it stops being the only way work
happens, which is what makes the current system feel like a website with a
build button rather than a company that works while you sleep.
