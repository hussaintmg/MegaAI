/**
 * Delivery stacks — what "build me a website" actually means in files.
 *
 * Without this, a goal reached the coding agent as bare prose and came back as
 * one `public/index.html`: a heading, a paragraph and a button. A real product
 * has a framework, routes, components, an API and typed data access, so the
 * stack is decided during planning and its contract travels with every task
 * the coding agents receive.
 */

export type StackId = 'nextjs' | 'react-vite' | 'node-api';

export interface StackSpec {
  id: StackId;
  label: string;
  /** The file layout and rules every coding agent on this project must follow. */
  contract: string;
  /** Commands that install, build and serve it — used by build and preview tasks. */
  install: string[];
  build: string[];
  start: string[];
  port: number;
  /** Routes worth loading and photographing once it is running. */
  routes: string[];
}

const NEXTJS: StackSpec = {
  id: 'nextjs',
  label: 'Next.js (App Router) + TypeScript + React',
  install: ['npm', 'install', '--no-audit', '--no-fund'],
  build: ['npm', 'run', 'build'],
  start: ['npm', 'run', 'start'],
  port: 3000,
  routes: ['/'],
  contract: `Stack: **Next.js 15 App Router + TypeScript + React 19**. A single
static \`index.html\` is NOT an acceptable delivery for this project.

File layout — create these, and put each concern in its own file:
- \`package.json\` — dependencies next/react/react-dom (+ their @types and typescript
  as devDependencies); scripts: \`dev\`, \`build\` (\`next build\`), \`start\` (\`next start\`)
- \`next.config.mjs\`, \`tsconfig.json\`
- \`app/layout.tsx\` — root layout: \`<html lang="en">\`, \`metadata\`, imports \`./globals.css\`
- \`app/page.tsx\` — the home page, composed from components
- \`app/globals.css\` — design tokens as CSS variables, layout, responsive rules
- \`app/<section>/page.tsx\` — one file per additional route
- \`app/api/<name>/route.ts\` — the backend: \`export async function GET/POST(req: Request)\`
  returning \`Response.json(...)\`
- \`components/*.tsx\` — reusable components; add \`'use client'\` only to the ones
  that actually use state, effects or event handlers
- \`lib/types.ts\`, \`lib/*.ts\` — typed domain models and the single source of data

Rules:
- A page composes components. Do not inline several hundred lines of JSX in \`page.tsx\`.
- Data lives in \`lib/\` and is read by a Server Component or an \`app/api\` route
  handler. Never paste the same array into two files.
- Every exported function and every data shape is typed. No \`any\`.
- Style with \`globals.css\` and CSS variables (or CSS Modules). No giant inline-style objects.
- It must compile: \`npm run build\` has to pass with no missing imports and no type errors.`,
};

const REACT_VITE: StackSpec = {
  id: 'react-vite',
  label: 'React + Vite + TypeScript',
  install: ['npm', 'install', '--no-audit', '--no-fund'],
  build: ['npm', 'run', 'build'],
  start: ['npm', 'run', 'preview'],
  port: 4173,
  routes: ['/'],
  contract: `Stack: **React 19 + Vite + TypeScript**. A single static \`index.html\`
is NOT an acceptable delivery for this project.

File layout:
- \`package.json\` — react/react-dom + vite, @vitejs/plugin-react, typescript;
  scripts: \`dev\`, \`build\` (\`vite build\`), \`preview\` (\`vite preview --port 4173\`)
- \`vite.config.ts\`, \`tsconfig.json\`, \`index.html\` (the Vite entry only — the UI is React)
- \`src/main.tsx\`, \`src/App.tsx\`, \`src/index.css\`
- \`src/components/*.tsx\` — one component per file
- \`src/pages/*.tsx\` — one per screen, wired with react-router-dom
- \`src/lib/types.ts\`, \`src/lib/*.ts\` — typed domain models and data access
- \`server/index.ts\` — a small Node HTTP API when the project needs a backend

Rules:
- Components are small and typed; no several-hundred-line \`App.tsx\`.
- Data comes from \`src/lib/\`, never duplicated across components.
- No \`any\`. It must compile: \`npm run build\` has to pass.`,
};

const NODE_API: StackSpec = {
  id: 'node-api',
  label: 'Node.js + TypeScript HTTP service',
  install: ['npm', 'install', '--no-audit', '--no-fund'],
  build: ['npm', 'run', 'build'],
  start: ['npm', 'run', 'start'],
  port: 3000,
  routes: ['/health'],
  contract: `Stack: **Node.js 22 + TypeScript HTTP service** (ESM, \`node:http\` or
Express if you declare it as a dependency).

File layout:
- \`package.json\` — \`"type": "module"\`, typescript + @types/node; scripts:
  \`build\` (\`tsc -p tsconfig.json\`), \`start\` (\`node dist/server.js\`), \`test\`
- \`tsconfig.json\` — strict, outDir \`dist\`
- \`src/server.ts\` — creates and starts the server; a \`GET /health\` route always exists
- \`src/routes/*.ts\` — one module per resource, each exporting typed handlers
- \`src/lib/*.ts\` — domain logic and data access, no HTTP types in here
- \`tests/*.test.ts\` — \`node:test\` covering success and error paths

Rules:
- Handlers validate their input and return correct status codes; never throw raw.
- Domain logic is testable without a server.
- No \`any\`. It must compile: \`npm run build\` has to pass.`,
};

export const STACKS: Record<StackId, StackSpec> = {
  nextjs: NEXTJS,
  'react-vite': REACT_VITE,
  'node-api': NODE_API,
};

/**
 * Phrases that name a stack outright. Checked before any default, because an
 * explicit "build it in React" outranks whatever the domain would have picked.
 */
const EXPLICIT: Array<[StackId, string[]]> = [
  ['nextjs', ['next', 'next js', 'nextjs', 'next 15', 'app router']],
  ['react-vite', ['react', 'vite', 'react js', 'reactjs', 'spa']],
  ['node-api', ['express', 'node api', 'rest service', 'fastify']],
];

/** UI words that turn an otherwise headless goal into something with a face. */
const UI_HINTS = [
  'website', 'web site', 'page', 'pages', 'ui', 'frontend', 'front end', 'dashboard',
  'landing page', 'portfolio', 'blog', 'storefront', 'app', 'web app', 'interface',
];

/**
 * Pick the stack for a goal. `contains` is the caller's word-boundary matcher
 * over the already-normalised goal, so this file stays free of the substring
 * bug that once made "api" match inside "rapid".
 */
export function chooseStack(
  domain: string,
  contains: (phrase: string) => boolean,
): StackSpec {
  for (const [id, phrases] of EXPLICIT) {
    if (phrases.some(contains)) return STACKS[id];
  }
  if (domain === 'api') return NODE_API;
  if (domain === 'generic' && !UI_HINTS.some(contains)) return NODE_API;
  return NEXTJS;
}
