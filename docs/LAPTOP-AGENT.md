# The laptop agent

This is the part of MegaAI that runs on your own machine. It joins the queue,
watches how busy the machine is, and drives the coding agents you already pay
for — Claude Code, Codex, OpenCode — handing work from one to the next as each
hits its limit.

It is built around one promise: **the laptop stays yours**. While you are using
it, only urgent work runs. When it gets hot, everything stops. When you walk
away, the backlog drains.

---

## Setting it up on Windows 11

```powershell
git clone https://github.com/hussaintmg/MegaAI
cd MegaAI
npm install
npm run build

node apps\node\dist\index.js status      # what it can see
node apps\node\dist\index.js install     # start by itself at logon
```

`install` registers a Scheduled Task called **MegaAI Node Agent**. Three of its
settings are not the Windows defaults, on purpose:

| Setting | Default | Here | Why |
| --- | --- | --- | --- |
| `DisallowStartIfOnBatteries` | true | **false** | The default means the agent silently refuses to run the moment you unplug. Battery is handled properly by the resource guard, which stops at 20%. |
| `ExecutionTimeLimit` | 3 days | **none** | It is meant to keep running. |
| `MultipleInstancesPolicy` | parallel | **IgnoreNew** | Logging in again must not start a second agent competing with the first. |

Add `--dry-run` to see exactly what it would write and run without changing
anything. `uninstall` removes it.

macOS gets a LaunchAgent, Linux a systemd **user** service with lingering
enabled so it survives logout.

---

## Giving it work

```powershell
node apps\node\dist\index.js add "build the landing page" ^
    --project C:\projects\velocity ^
    --goal "build the 3d car website" ^
    --open
```

| Flag | |
| --- | --- |
| `--project` | the folder to work in — required, and the folder two tasks never share |
| `--goal` | the bigger picture, carried into every handoff brief |
| `--urgent` | run it even while you are at the keyboard |
| `--open` | open the folder in VS Code when it is done |

Then leave `run` going — or let the Scheduled Task do it.

For a whole new project rather than one task, there is a prompt to paste into
Claude Code on the laptop that sets the folder up and queues the work in the
right order: [NEW-PROJECT-PROMPT.md](./NEW-PROJECT-PROMPT.md).

`tasks` lists everything in the queue with its id and, for anything still
waiting, the reason it is waiting. `cancel <id or part of the title>` takes one
off — including one a machine is part-way through.

### If `install` fails

It will say so and exit non-zero; it asks Windows whether the task exists
rather than assuming that reaching the end means it worked.

- **"Access is denied"** — run it from a PowerShell started with *Run as
  administrator*.
- Anything else — the task file it generated is still at
  `%LOCALAPPDATA%\MegaAI\megaai-node-agent.xml`, and Task Scheduler →
  *Action* → *Import Task* will take it directly.

---

## What it does with the machine

| Gear | When | What runs |
| --- | --- | --- |
| **full** | you have been away 3 minutes | up to 3 tasks at once |
| **gentle** | you are at the keyboard | urgent work only, one at a time |
| **stop** | over 82°C, under 20% battery unplugged, or memory over 94% | nothing |

Heat has hysteresis: once it stops for temperature it will not start again
until the CPU is back under 72°C, so it cannot sit at the threshold all night
cycling on and off. Speeding up is held for 20 seconds; stopping is immediate.

**If the machine cannot report idle time**, load stands in for the keyboard:
after the same period below 12% CPU, it counts as you being away. Without this
the agent would sit in `gentle` forever on any machine whose idle-time reading
does not work, deferring the entire backlog silently.

Everything is turned down with environment variables rather than code:

| Variable | Default | |
| --- | --- | --- |
| `MEGAAI_HOT_C` | 82 | stop above this (the restart point moves with it) |
| `MEGAAI_IDLE_SECONDS` | 180 | how long before you count as away |
| `MEGAAI_MAX_TASKS` | 3 | how many at once when you are away |
| `MEGAAI_LOW_BATTERY_PCT` | 20 | stop below this on battery |
| `MEGAAI_TICK_MS` | 5000 | how often it looks |
| `MEGAAI_NODE_NAME` | the hostname | what it is called in the queue |
| `MEGAAI_MONGODB_URI` | — | share the queue with the phone and the cloud |

A value that is not a number, or is far outside anything sensible, is reported
and ignored rather than obeyed.

---

## The coding agents

It finds whichever of `claude`, `codex` and `opencode` are on your PATH. On
Windows these are `.cmd` shims installed by npm, which `spawn` cannot find by
name — the launcher walks PATH with PATHEXT the way the shell does, which is
why it works here and fails in most scripts people write.

When one runs out of quota:

1. The reset time is read out of what it said.
2. The task is handed to the next agent with a brief that starts **"You are
   continuing work another agent started. Do not start over."** — the goal,
   what each previous agent did, the files that changed, what is already in the
   folder, and the last thing the stopped agent reported.
3. When all of them are spent, the task is **parked until the earliest reset**.
   That is not a failure and does not use up one of the task's attempts. The
   queue says so in words:

   > every coding agent is out of quota (Claude Code until 06:00, Codex until
   > 02:00, OpenCode until 08:00) — work resumes on its own when the first one
   > comes back

Each turn is written into the task's checkpoint *before* the next agent starts,
so a reboot in the middle of the night resumes with everything the earlier
agents did rather than starting over.

Several projects run at the same time; two tasks in the same folder never do.

---

## When it is interrupted

| What happens | What the queue does |
| --- | --- |
| You close the lid | The lease lapses; the task returns to `pending` with its progress |
| The machine restarts | The agent comes back as the *same* node and releases what it was holding immediately, rather than waiting out the lease |
| It gets too hot mid-task | The task is paused and parked with the temperature in the reason |
| Ctrl-C | Anything in flight goes back on the queue before it exits |
| Every coding agent is spent | Parked until the earliest reset |

None of these count as the task failing, and none of them consume an attempt.

---

## Where things are kept

| | Windows | Linux / macOS |
| --- | --- | --- |
| State and queue | `%LOCALAPPDATA%\MegaAI` | `~/.megaai` |
| Node identity | `node.json` — same id across restarts | same |
| Local queue | `queue.json` — used until `MEGAAI_MONGODB_URI` is set | same |

With no connection string the queue is a file on this machine, which is enough
to leave it working overnight on one laptop. Point it at MongoDB and the same
queue is shared with the phone and the cloud, pushed over a change stream
rather than polled — and if the database cannot do change streams, it falls
back to polling **and says so** rather than going quiet.
