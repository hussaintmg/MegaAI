# Starting a new project with one prompt

Copy the block below, fill in the two `<< >>` slots, and paste it into a fresh
**Claude Code chat started on the laptop** — in PowerShell, inside
`C:\Automation\MegaAIByClaude`, run `claude` and paste.

It has to be the laptop. A chat on the web cannot reach your machine: it cannot
create the folder, cannot queue anything, and cannot start the agent. If you
paste this into a browser chat, the best it can do is hand the commands back to
you.

---

```
You are working on a Windows 11 laptop. MegaAI is checked out at
C:\Automation\MegaAIByClaude and already builds. Its agent keeps its queue in
C:\Users\lenovo\AppData\Local\MegaAI. Claude Code and OpenCode are installed;
Codex is not.

PROJECT FOLDER: <<C:\Automation\projects\my-new-project>>

WHAT I WANT BUILT:
<<Describe it properly. Not "a website" — say what it is for, what pages or
screens it has, what it has to do, and anything it must connect to. If you have
a preference about the stack, say it; if you don't, say so and let it choose.>>

Do this:

1. Make sure MegaAI is current: in C:\Automation\MegaAIByClaude run
   `git pull`, then `npm install` and `npm run build` if anything changed.
   Never point a task at C:\Automation\MegaAIByClaude itself — that is MegaAI's
   own source and a coding agent would start rewriting it.

2. Create the project folder if it does not exist, and `git init` it. MegaAI
   passes `git status` into every handoff brief, so a repo means each agent can
   see what the one before it changed.

3. Break the work into tasks that each end in something checkable — "the app
   builds and the home page renders", not "start the frontend". Order them so
   each one can be finished without the next existing yet. Queue them:

   node C:/Automation/MegaAIByClaude/apps/node/dist/index.js add "<task>" ^
        --project <<PROJECT FOLDER, with forward slashes>> ^
        --goal "<one sentence: what the whole project is>"

   Use forward slashes. Node understands them on Windows, and a backslash path
   passed through a shell layer loses its backslashes — `C:\Automation\projects\x`
   arrives as `Automationprojectsx`. The CLI now refuses that rather than
   creating a folder nobody meant, but forward slashes avoid the argument.

   Use the same --goal on every task. Add --urgent only to something I am
   waiting on right now; everything else should wait until I am away from the
   machine.

4. Show me the queue with `... index.js tasks` and stop. Tell me what you
   queued and in what order. Do not start `run` yourself — I will.

Rules:
- Check, do not assume. After each command, look at what it actually printed.
  If something failed, say so plainly and stop; do not carry on and report
  success at the end.
- If any of this is ambiguous — the stack, the scope, whether something is one
  task or four — ask me before queueing. A badly split task wastes a whole
  night of agent quota.
```

---

## Then, to actually run it

```powershell
node apps\node\dist\index.js run
```

Leave that window open. It takes urgent work straight away and everything else
once you have been away from the keyboard for three minutes. Ctrl-C puts
anything in flight back on the queue.

To have it start on its own at logon instead, run **once** from a PowerShell
started with *Run as administrator*:

```powershell
node apps\node\dist\index.js install
```

Without administrator, `schtasks` answers "Access is denied" and the installer
will tell you it did not work.

## Checking on it later

```powershell
node apps\node\dist\index.js status    # gear, machine, which coders are free
node apps\node\dist\index.js tasks     # every task, and why anything is waiting
node apps\node\dist\index.js cancel <id or part of the title>
```

`tasks` is the one to read the morning after. A task still `pending` always
carries the reason — waiting for a coding agent's quota to reset, waiting for
you to leave the machine, or waiting on another task in the same folder.
