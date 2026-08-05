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
 * Libraries a goal names outright.
 *
 * "build a 3d car website using three.js with gsap scroll animations" produced
 * a plain page with none of them, because the contract listed the framework's
 * own dependencies and stopped — so the agent had no reason to think three.js
 * was part of the job. Whatever the goal asks for is now part of the contract,
 * with the package names and how it is meant to be used.
 */
const LIBRARIES: Array<{ match: string[]; packages: string; how: string }> = [
  {
    match: ['three', 'three js', 'threejs', '3d', 'webgl'],
    packages: 'three, @react-three/fiber, @react-three/drei (+ @types/three)',
    how:
      'Render the 3D scene in a client component (`\'use client\'`) with a `<Canvas>` from ' +
      '@react-three/fiber. Keep the scene, its lighting and its controls in their own files under ' +
      'components/. Load models with useGLTF, and always render a fallback while it loads.',
  },
  {
    match: ['gsap', 'scrolltrigger'],
    packages: 'gsap, @gsap/react',
    how:
      'Register ScrollTrigger once in a client component, drive scroll-linked animation with ' +
      'gsap.timeline({ scrollTrigger: … }), and clean up in the effect\'s teardown so navigating ' +
      'away does not leak triggers.',
  },
  {
    match: ['framer motion', 'framer-motion', 'framer'],
    packages: 'framer-motion',
    how:
      'Use `motion.*` elements with variants for entrance and hover, and `useInView` for reveal-on-scroll. ' +
      'Respect prefers-reduced-motion.',
  },
  { match: ['tailwind', 'tailwindcss'], packages: 'tailwindcss, postcss, autoprefixer', how: 'Configure tailwind.config.ts and the postcss config, and import the directives in the global stylesheet.' },
  { match: ['prisma'], packages: 'prisma, @prisma/client', how: 'Define schema.prisma and generate the client; keep every query behind lib/.' },
  { match: ['mongodb', 'mongo'], packages: 'mongodb', how: 'One shared client in lib/db.ts, reused across requests — never one per handler.' },
  { match: ['stripe'], packages: 'stripe', how: 'Server-side only, in an API route handler. Never put a secret key in a client component.' },
  { match: ['shadcn', 'radix'], packages: 'the radix primitives the components need', how: 'Keep generated components under components/ui/ and compose them.' },
];

/** The libraries this goal names, if any. */
export function detectLibraries(contains: (phrase: string) => boolean): Array<{ packages: string; how: string }> {
  const found: Array<{ packages: string; how: string }> = [];
  for (const lib of LIBRARIES) {
    if (lib.match.some(contains)) found.push({ packages: lib.packages, how: lib.how });
  }
  return found;
}

/**
 * What "finished" means, on top of the stack's file layout.
 *
 * The delivery that prompted this compiled and rendered — and looked like a
 * scaffold, because nothing ever asked for more than files in the right place.
 */
const QUALITY_BAR = `Quality bar — this is a client deliverable, not a scaffold:
- Real copy. Headings, body text and labels about *this* subject. No lorem ipsum,
  no "Feature 1", no "Your text here".
- A designed page, not a stack of default elements: a considered type scale,
  consistent spacing, a colour palette held in CSS variables, and visual
  hierarchy. Sections have breathing room.
- Responsive from 375px up. Nothing overflows horizontally on a phone; the
  navigation works there too.
- Accessible: semantic landmarks (header/nav/main/footer), one h1, alt text on
  every image, labels tied to inputs, visible focus states, and colour contrast
  that passes AA.
- Metadata: a real title and description, and Open Graph tags.
- No console errors, and no dead links or buttons that do nothing.`;

/**
 * Pick the stack for a goal. `contains` is the caller's word-boundary matcher
 * over the already-normalised goal, so this file stays free of the substring
 * bug that once made "api" match inside "rapid".
 */
export function chooseStack(
  domain: string,
  contains: (phrase: string) => boolean,
): StackSpec {
  let base = NEXTJS;
  const explicit = EXPLICIT.find(([, phrases]) => phrases.some(contains));
  if (explicit) base = STACKS[explicit[0]];
  else if (domain === 'api') base = NODE_API;
  else if (domain === 'generic' && !UI_HINTS.some(contains)) base = NODE_API;

  const libraries = detectLibraries(contains);
  const sections = [base.contract];
  if (libraries.length > 0) {
    sections.push(
      `Required libraries — the goal asks for these by name. Add them to package.json ` +
        `and genuinely use them; a delivery without them has not met the brief.\n` +
        libraries.map((lib) => `- **${lib.packages}**\n  ${lib.how}`).join('\n'),
    );
  }
  if (base.id !== 'node-api') sections.push(QUALITY_BAR);

  return { ...base, contract: sections.join('\n\n') };
}
