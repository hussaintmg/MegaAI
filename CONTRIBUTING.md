# Contributing to MegaAI

## Setup

```bash
npm install
npm run build     # tsc -b over all workspaces (project references)
npm test          # build + node:test suite (all offline, < 1s)
npm run demo      # end-to-end smoke test on the mock provider
```

Node.js ≥ 20 required. No other system dependencies.

## Repository layout

```
packages/   23 packages, one responsibility each (see ARCHITECTURE.md)
apps/       cli (megaai command) · server (REST + dashboard)
docs/       VISION.md and supporting documents
scripts/    repo maintenance (clean)
```

Rules that keep the codebase healthy:

- **Layering is one-way.** A package may only depend on packages below it
  (`tsconfig.json` references mirror `package.json` dependencies — update
  both together). `types` and `contracts` are the only things everyone may
  import.
- **Modules communicate through `@megaai/types` shapes and
  `@megaai/contracts` interfaces** — never through another module's
  concrete classes.
- **Everything must work offline.** New features need to be exercisable
  with the mock provider and in-memory database; network and real
  credentials are configuration.
- **Determinism in tests.** Inject `Clock`/waits (`ManualClock`, `wait`
  options) instead of sleeping. The suite must stay fast and flake-free.
- **Every action an agent takes goes through the ActionEngine.** Never give
  agent code direct fs/network access.

## Adding things

**A provider** — implement `Provider` (`@megaai/contracts`), map vendor
errors to `MegaError` codes (`RATE_LIMITED`, `PROVIDER_UNAVAILABLE`,
`PROVIDER_REFUSED` drive the fallback chain), register via
`createMegaAI({ extraProviders })` and add its models to the registry.

**A tool** — implement `Tool` with an honest `permissions` list; anything
dangerous should be deny-by-default or approval-gated in config. Add tests
proving the sandbox holds.

**An agent kind** — usually just a new `AgentDescriptor` handed to
`ModelDrivenAgent`; write a custom `AgentImplementation` only when the
standard loop (context → prompt → complete → act → remember) isn't enough.
Teach the `MockProvider` how to answer for the new kind so demos and tests
cover it.

**A plan domain** — extend `corePhasesFor()` in `@megaai/meta-brain` and
add detection keywords to `analyzeGoal()`.

## Style

- TypeScript strict; ESM with `.js` import specifiers.
- Comments explain *why* and module intent, not what the next line does.
- Files stay focused; if a module needs a second responsibility, it
  probably needs a second file (or package).

## Tests

`*.test.ts` lives next to the source it tests and compiles into `dist/`;
the runner picks up `packages/**/*.test.js`. End-to-end coverage belongs in
`packages/sdk/src/index.test.ts` — it boots the entire system in-memory.
