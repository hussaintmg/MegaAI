# The laptop agent

This is the part of MegaAI that runs on your own machine. It joins the queue,
watches how busy the machine is, and drives the coding agents you already pay
for — Claude Code, Codex, OpenCode — handing work from one to the next as each
hits its limit.

It is built around one promise: **the laptop stays yours**. While you are using
it, work that would take over the mouse, the keyboard or the screen waits —
everything else carries on, because a background process does not disturb
anyone. When it gets hot, everything stops. When you walk away, the whole
backlog runs, including the work that needs the screen.

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
| `--interactive` | it needs the mouse, keyboard or screen — so it waits until you step away |
| `--urgent` | run it now even though it will interrupt you (only matters for `--interactive`) |
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
| **full** | you have been away 3 minutes | everything, up to 3 at once — including work that takes over the screen |
| **background** | you are at the keyboard | everything that stays out of your way, 2 at once. Only work needing the mouse/keyboard/screen waits |
| **stop** | over 82°C, under 20% battery unplugged, or memory over 94% | nothing |

The line between the two top gears is **not** how urgent a task is — it is
whether it needs the human interface. A coding agent running in a background
process costs you nothing while you type, so it keeps going. A task that grabs
the mouse, focuses a window or photographs the screen makes the machine
unusable while it runs, so that is the one that waits.

Heat has hysteresis: once it stops for temperature it will not start again
until the CPU is back under 72°C, so it cannot sit at the threshold all night
cycling on and off. Speeding up is held for 20 seconds; stopping is immediate.

**If the machine cannot report idle time**, load stands in for the keyboard:
after the same period below 12% CPU, it counts as you being away. Without this
the agent would never reach `full` on any machine whose idle-time reading does
not work, so work needing the screen would be deferred for ever, silently.

### Settings that survive closing the window

`$env:MEGAAI_MONGODB_URI = "…"` in PowerShell lasts exactly as long as that
PowerShell does, and the Scheduled Task starts with no shell at all — so the
obvious place to put a setting is the one place the agent cannot read it from.
Save it instead:

```powershell
node apps\node\dist\index.js set MEGAAI_MONGODB_URI "mongodb+srv://…"
node apps\node\dist\index.js set                     # list what is saved
node apps\node\dist\index.js set MEGAAI_MONGODB_URI ""   # remove it
```

It goes in `%LOCALAPPDATA%\MegaAI\.env`, readable only by you, and every run
from then on picks it up — from a terminal, from the Task Scheduler, after a
reboot. A real environment variable still wins, so you can point one run
somewhere else without editing anything.

**If the shared queue cannot be reached**, the agent does not stop. It says
what went wrong, what fixes it, and carries on from this machine's own queue —
the coding agents are here, the projects are here, and the night can happen
without a database in another country. The one thing it will not do is pretend
the website can see it.

The failure you are most likely to meet is `querySrv ECONNREFUSED`. That is
DNS: many home routers and most office and campus networks will not answer the
SRV lookup that a `mongodb+srv://` string needs. In Atlas, go to
**Connect → Drivers** and set the driver version to *Node.js 2.2.12 or later* —
you get a plain `mongodb://` string listing the servers directly, which needs
no SRV lookup at all. Changing the machine's DNS to `8.8.8.8` also works.

Everything is turned down with environment variables — or `set`, which is the
same names written down:

| Variable | Default | |
| --- | --- | --- |
| `MEGAAI_HOT_C` | 82 | stop above this (the restart point moves with it) |
| `MEGAAI_IDLE_SECONDS` | 180 | how long before you count as away |
| `MEGAAI_MAX_TASKS` | 3 | how many at once when you are away |
| `MEGAAI_BACKGROUND_TASKS` | 2 | how many at once while you are using the machine |
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

---

## Watching it from anywhere

Set `MEGAAI_MONGODB_URI` to the same connection string the website uses, and
the **Machines** page shows this laptop live: its gear and why, its CPU,
memory, temperature and battery, what it is running, and every task in the
queue with the reason anything is waiting. It is pushed over Server-Sent
Events, so a phone that locks its screen picks the stream back up by itself.

The same page queues work — coding, a command, something that needs the mouse
and screen, a WhatsApp, an email — which is how you hand the laptop a job from
your phone. Anything needing the screen is marked as such when you queue it and
waits until you step away, unless you tick *do it now*.
