/**
 * MockProvider — MegaAI's offline model simulator.
 *
 * Deterministic, dependency-free and instant: it reads the structured task
 * metadata agents attach to a completion request and answers in the action
 * protocol (`{ thoughts, summary, actions[] }`). This is what makes the whole
 * system runnable and testable with zero API keys; swap in real providers and
 * nothing else changes.
 */

import type {
  ActionRequest,
  CompletionRequest,
  CompletionResponse,
  ErrorCode,
  JsonObject,
  ModelCard,
  ProviderKind,
} from '@megaai/types';
import { MegaError } from '@megaai/types';
import { estimateTokens, slugify } from '@megaai/utils';
import type { Provider } from '@megaai/contracts';
import { BUILTIN_MODELS } from '../models.js';

export interface MockProviderOptions {
  kind?: ProviderKind;
  name?: string;
  models?: ModelCard[];
  /** Throw RATE_LIMITED once more than this many requests have been served. */
  rateLimitAfter?: number;
  /** Always fail with this code (for fallback-chain tests). */
  alwaysFail?: ErrorCode;
}

interface FilePlan {
  path: string;
  content: string;
}

/** What the scaffolded app renders — used by the audit/observe simulations. */
const MOCK_RENDERED_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>MegaAI app</title></head>
<body>
<header class="site-header"><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/contact">Contact</a></nav></header>
<main class="container">
  <section class="hero"><h1>MegaAI app</h1><p>Served by this app's own API routes.</p></section>
  <section class="grid">
    <article class="card"><h2>Fast</h2><p>Server-rendered pages.</p></article>
    <article class="card"><h2>Typed</h2><p>Every data shape is declared.</p></article>
  </section>
  <form><label for="email">Email</label><input id="email" name="email" type="email" /><button type="submit">Subscribe</button></form>
</main>
<footer class="site-footer">Built by MegaAI.</footer>
</body>
</html>`;

/**
 * A Next.js App Router skeleton the mock emits for UI work.
 *
 * The simulator has to produce what the real stack contract asks for, or the
 * offline path stops representing the online one — which is exactly how a
 * "website" delivery came out as one `public/index.html` for so long.
 */
function nextjsFilesFor(title: string, goal: string): FilePlan[] {
  const t = title.toLowerCase();
  const name = slugify(goal) || 'megaai-app';

  if (t.includes('scaffold')) {
    return [
      {
        path: 'package.json',
        content: `${JSON.stringify(
          {
            name,
            version: '0.1.0',
            private: true,
            scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
            dependencies: { next: '^15.1.0', react: '^19.0.0', 'react-dom': '^19.0.0' },
            devDependencies: { '@types/node': '^22.10.0', '@types/react': '^19.0.0', typescript: '^5.7.0' },
          },
          null,
          2,
        )}\n`,
      },
      { path: 'next.config.mjs', content: `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\nexport default nextConfig;\n` },
      { path: '.gitignore', content: `node_modules/\n.next/\nout/\n.env*.local\nnext-env.d.ts\n` },
      {
        path: 'tsconfig.json',
        content: `${JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              lib: ['dom', 'dom.iterable', 'esnext'],
              strict: true,
              noEmit: true,
              esModuleInterop: true,
              module: 'esnext',
              moduleResolution: 'bundler',
              resolveJsonModule: true,
              isolatedModules: true,
              jsx: 'preserve',
              incremental: true,
              plugins: [{ name: 'next' }],
              paths: { '@/*': ['./*'] },
            },
            include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
            exclude: ['node_modules'],
          },
          null,
          2,
        )}\n`,
      },
      {
        path: 'app/layout.tsx',
        content: `import type { Metadata } from 'next';\nimport './globals.css';\nimport { SiteHeader } from '@/components/SiteHeader';\nimport { SiteFooter } from '@/components/SiteFooter';\n\nexport const metadata: Metadata = {\n  title: '${goal.replace(/'/g, "\\'")}',\n  description: 'Built by MegaAI.',\n};\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return (\n    <html lang="en">\n      <body>\n        <SiteHeader />\n        <main className="container">{children}</main>\n        <SiteFooter />\n      </body>\n    </html>\n  );\n}\n`,
      },
      {
        path: 'app/page.tsx',
        content: `import { Hero } from '@/components/Hero';\nimport { FeatureGrid } from '@/components/FeatureGrid';\nimport { getFeatures } from '@/lib/data';\n\nexport default async function HomePage() {\n  const features = await getFeatures();\n  return (\n    <>\n      <Hero title="${goal.replace(/"/g, '&quot;')}" />\n      <FeatureGrid features={features} />\n    </>\n  );\n}\n`,
      },
      { path: 'lib/types.ts', content: `export interface Feature {\n  id: string;\n  title: string;\n  body: string;\n}\n` },
      // Without this Next serves no favicon and every page load logs a 404 —
      // a real defect the audit reports, so the scaffold ships one.
      {
        path: 'app/icon.svg',
        content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#5b8cff"/><text x="16" y="22" font-family="system-ui" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">M</text></svg>\n`,
      },
    ];
  }

  if (t.includes('design system') || t.includes('layout') || t.includes('app shell')) {
    return [
      {
        path: 'app/globals.css',
        content: `:root {\n  --bg: #0b0e14;\n  --panel: #131722;\n  --text: #e6e9f0;\n  --muted: #8b94a7;\n  --accent: #5b8cff;\n  --space: 1rem;\n}\n* { box-sizing: border-box; }\nhtml, body { margin: 0; padding: 0; }\nbody {\n  background: var(--bg);\n  color: var(--text);\n  font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;\n}\n.container { max-width: 68rem; margin: 0 auto; padding: calc(var(--space) * 2) var(--space); }\n.site-header, .site-footer { padding: var(--space); border-bottom: 1px solid #232838; }\n.site-footer { border-bottom: 0; border-top: 1px solid #232838; color: var(--muted); }\n.hero h1 { font-size: clamp(1.8rem, 5vw, 3rem); margin: 0 0 var(--space); }\n.grid { display: grid; gap: var(--space); grid-template-columns: 1fr; }\n@media (min-width: 720px) { .grid { grid-template-columns: repeat(3, 1fr); } }\n.card { background: var(--panel); border-radius: 12px; padding: var(--space); }\n`,
      },
      {
        path: 'components/SiteHeader.tsx',
        content: `import Link from 'next/link';\n\nexport function SiteHeader() {\n  return (\n    <header className="site-header">\n      <nav>\n        <Link href="/">Home</Link> · <Link href="/about">About</Link> · <Link href="/contact">Contact</Link>\n      </nav>\n    </header>\n  );\n}\n`,
      },
      {
        path: 'components/SiteFooter.tsx',
        content: `export function SiteFooter() {\n  return <footer className="site-footer">Built by MegaAI.</footer>;\n}\n`,
      },
    ];
  }

  if (t.includes('home page') || t.includes('storefront') || t.includes('pages')) {
    return [
      {
        path: 'components/Hero.tsx',
        content: `export function Hero({ title }: { title: string }) {\n  return (\n    <section className="hero">\n      <h1>{title}</h1>\n      <p>Everything below is served by this app&apos;s own API routes.</p>\n    </section>\n  );\n}\n`,
      },
      {
        path: 'components/FeatureGrid.tsx',
        content: `import type { Feature } from '@/lib/types';\n\nexport function FeatureGrid({ features }: { features: Feature[] }) {\n  return (\n    <section className="grid">\n      {features.map((feature) => (\n        <article key={feature.id} className="card">\n          <h2>{feature.title}</h2>\n          <p>{feature.body}</p>\n        </article>\n      ))}\n    </section>\n  );\n}\n`,
      },
      {
        path: 'app/about/page.tsx',
        content: `export default function AboutPage() {\n  return (\n    <section>\n      <h1>About</h1>\n      <p>What this project is and who it is for.</p>\n    </section>\n  );\n}\n`,
      },
      {
        path: 'app/contact/page.tsx',
        content: `export default function ContactPage() {\n  return (\n    <section>\n      <h1>Contact</h1>\n      <p>Reach the team at hello@example.com.</p>\n    </section>\n  );\n}\n`,
      },
    ];
  }

  // API + data layer, and the fallback for any other coding task.
  return [
    {
      path: 'lib/data.ts',
      content: `import type { Feature } from './types';\n\nconst FEATURES: Feature[] = [\n  { id: 'a', title: 'Fast', body: 'Server-rendered pages with no client waterfall.' },\n  { id: 'b', title: 'Typed', body: 'Every data shape is declared in lib/types.ts.' },\n  { id: 'c', title: 'Tested', body: 'The data layer and the API routes both have tests.' },\n];\n\nexport async function getFeatures(): Promise<Feature[]> {\n  return FEATURES;\n}\n\nexport async function getFeature(id: string): Promise<Feature | undefined> {\n  return FEATURES.find((feature) => feature.id === id);\n}\n`,
    },
    {
      path: 'app/api/features/route.ts',
      content: `import { getFeatures } from '@/lib/data';\n\nexport async function GET() {\n  return Response.json({ features: await getFeatures() });\n}\n`,
    },
  ];
}

function codeFilesFor(title: string, description: string): FilePlan[] {
  // The stack contract travels in the task description, so the simulator can
  // honour the same layout the real agents are given.
  if (description.includes('Next.js 15 App Router')) {
    const goalLine = /Create the project skeleton for: (.+)/.exec(description)?.[1];
    return nextjsFilesFor(title, (goalLine ?? title).trim());
  }
  const text = `${title} ${description}`.toLowerCase();
  const slug = slugify(title);
  const has = (...words: string[]) => words.some((word) => text.includes(word));

  if (has('setup', 'scaffold', 'init', 'skeleton', 'boilerplate')) {
    return [
      {
        path: 'package.json',
        content: `${JSON.stringify({ name: slug, version: '0.1.0', private: true, type: 'module', scripts: { start: 'node src/index.js', test: 'node --test "tests/**/*.test.js"' } }, null, 2)}\n`,
      },
      { path: 'src/index.js', content: `// Application entrypoint\nimport { createServer } from './server.js';\n\ncreateServer().listen(process.env.PORT ?? 3000);\nconsole.log('app started');\n` },
      { path: '.gitignore', content: 'node_modules/\n.env\n' },
    ];
  }
  if (has('database', 'schema', 'model', 'inventory')) {
    return [
      {
        path: 'src/db/schema.sql',
        content: `-- ${title}\nCREATE TABLE IF NOT EXISTS items (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  price_cents INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL\n);\n`,
      },
      {
        path: 'src/db/index.js',
        content: `// Minimal data-access layer for: ${title}\nconst rows = new Map();\n\nexport const db = {\n  put: (row) => rows.set(row.id, row),\n  get: (id) => rows.get(id),\n  all: () => [...rows.values()],\n};\n`,
      },
    ];
  }
  if (has('auth', 'login', 'signup', 'user account')) {
    return [
      {
        path: 'src/auth/auth.js',
        content: `// Authentication module for: ${title}\nconst sessions = new Map();\n\nexport function login(user, password) {\n  if (!user || !password) throw new Error('missing credentials');\n  const token = Math.random().toString(36).slice(2);\n  sessions.set(token, { user, at: Date.now() });\n  return token;\n}\n\nexport function verify(token) {\n  return sessions.has(token);\n}\n`,
      },
    ];
  }
  if (has('api', 'backend', 'server', 'endpoint', 'rest')) {
    return [
      {
        path: 'src/server.js',
        content: `// HTTP API for: ${title}\nimport http from 'node:http';\n\nexport function createServer() {\n  return http.createServer((req, res) => {\n    res.setHeader('content-type', 'application/json');\n    res.end(JSON.stringify({ ok: true, path: req.url }));\n  });\n}\n`,
      },
    ];
  }
  if (has('ui', 'frontend', 'page', 'storefront', 'catalog', 'design')) {
    return [
      {
        path: 'public/index.html',
        content: `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n<meta name="viewport" content="width=device-width, initial-scale=1" />\n<title>${title}</title>\n<style>\n  body { font-family: system-ui, sans-serif; margin: 0; }\n  main { max-width: 100%; padding: 1rem; }\n  @media (min-width: 768px) { main { max-width: 60rem; margin: 0 auto; } }\n</style>\n</head>\n<body>\n<main>\n  <h1>${title}</h1>\n  <p>Generated by MegaAI.</p>\n  <button type="submit">Continue</button>\n</main>\n</body>\n</html>\n`,
      },
    ];
  }
  if (has('cart', 'checkout', 'payment', 'order')) {
    return [
      {
        path: `src/features/${slug}.js`,
        content: `// Feature: ${title}\nexport function ${slug.replace(/-/g, '_')}(input) {\n  return { ok: true, input };\n}\n`,
      },
    ];
  }
  return [
    {
      path: `src/modules/${slug}.js`,
      content: `// ${title}\n// ${description}\nexport function run() {\n  return '${slug} implemented';\n}\n`,
    },
  ];
}

/** Build the deterministic action-protocol reply for a task. */
function replyForTask(meta: JsonObject, request: CompletionRequest): JsonObject {
  const agentKind = String(meta.agentKind ?? 'generic');
  const title = String(meta.taskTitle ?? 'task');
  const description = String(meta.taskDescription ?? '');
  const slug = slugify(title);
  const actions: ActionRequest[] = [];
  let summary: string;

  switch (agentKind) {
    case 'coding': {
      const files = codeFilesFor(title, description);
      for (const file of files) {
        actions.push({ tool: 'fs.write', input: { path: file.path, content: file.content }, reason: title });
      }
      summary = `Implemented "${title}": wrote ${files.length} file(s) — ${files.map((f) => f.path).join(', ')}.`;
      break;
    }
    case 'testing': {
      const path = `tests/${slug}.test.js`;
      actions.push({
        tool: 'fs.write',
        input: {
          path,
          content: `import test from 'node:test';\nimport assert from 'node:assert';\n\ntest('${slug}', () => {\n  assert.ok(true, 'behaviour verified for: ${title}');\n});\n`,
        },
        reason: title,
      });
      if (meta.shellEnabled === true) {
        // Really execute the suite — expectSuccess makes a red run fail the
        // task. A glob (expanded by Node's own test runner) is used because
        // bare directory args are treated as entry files on Node 22.
        actions.push({
          tool: 'shell.exec',
          input: { command: 'node', args: ['--test', 'tests/**/*.test.js'], expectSuccess: true },
          reason: 'run the test suite for real',
        });
        summary = `Wrote tests for "${title}" and executed them with node --test — suite green.`;
      } else {
        summary = `Wrote tests for "${title}" (shell disabled here, so execution was skipped).`;
      }
      break;
    }
    case 'build': {
      if (meta.shellEnabled === true) {
        // Write a real, side-effect-free syntax checker and run it as a
        // pipeline step. It spawns `node --check` per file (parse only, no
        // execution), so a genuine syntax error fails the build task.
        actions.push({
          tool: 'fs.write',
          input: {
            path: 'build-check.mjs',
            content: `import { readdirSync, statSync } from 'node:fs';\nimport { join } from 'node:path';\nimport { spawnSync } from 'node:child_process';\n\nfunction walk(dir) {\n  const out = [];\n  for (const entry of readdirSync(dir)) {\n    if (entry === 'node_modules' || entry === '.git') continue;\n    const full = join(dir, entry);\n    if (statSync(full).isDirectory()) out.push(...walk(full));\n    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full);\n  }\n  return out;\n}\n\nlet failed = 0;\nfor (const file of walk('.')) {\n  const result = spawnSync(process.execPath, ['--check', file]);\n  if (result.status !== 0) {\n    failed += 1;\n    process.stderr.write('syntax error: ' + file + '\\n' + (result.stderr?.toString() ?? ''));\n  }\n}\nconsole.log('build-check: ' + (failed === 0 ? 'all files parse' : failed + ' file(s) failed'));\nprocess.exit(failed === 0 ? 0 : 1);\n`,
          },
          reason: 'build verification script',
        });
        actions.push({
          tool: 'pipeline.run',
          input: {
            steps: [{ name: 'syntax-check', command: 'node', args: ['build-check.mjs'] }],
          },
          reason: 'verify the project builds',
        });
        summary = `Verified the build for "${title}": every source file parses cleanly.`;
      } else {
        summary = `Build verification for "${title}" skipped (shell disabled in this environment).`;
      }
      break;
    }
    case 'documentation': {
      actions.push({
        tool: 'fs.write',
        input: { path: `docs/${slug}.md`, content: `# ${title}\n\n${description || 'Documentation'}\n\n_Authored by the MegaAI documentation agent._\n` },
        reason: title,
      });
      summary = `Documented "${title}" in docs/${slug}.md.`;
      break;
    }
    case 'marketing': {
      actions.push({
        tool: 'fs.write',
        input: {
          path: `marketing/${slug}.md`,
          content: `# ${title}\n\nHeadline: Ship faster with an AI-run delivery team.\n\n- Benefit 1: one sentence in, working software out\n- Benefit 2: every step audited and recoverable\n- Call to action: try the demo today\n`,
        },
        reason: title,
      });
      summary = `Drafted marketing content for "${title}".`;
      break;
    }
    case 'devops': {
      actions.push({
        tool: 'fs.write',
        input: {
          path: 'DEPLOYMENT.md',
          content: `# Deployment plan\n\nTarget: ${title}\n\n1. Build artifacts\n2. Provision environment\n3. Deploy + smoke test\n4. Rollback plan: previous release kept warm\n`,
        },
        reason: title,
      });
      actions.push({ tool: 'deploy.plan', input: {}, reason: 'describe the deployment' });
      // Approval-gated in policy; auto-resolves under autoApprove, otherwise
      // pauses for a human — exactly the intended deploy safety behaviour.
      actions.push({ tool: 'deploy.execute', input: {}, reason: 'deploy the delivery' });
      summary = `Prepared and deployed "${title}" (simulated target); URL recorded in .megaai-deploy.json.`;
      break;
    }
    case 'crm': {
      actions.push({
        tool: 'crm.client.upsert',
        input: { name: 'Client', email: 'client@example.com', status: 'active' },
        reason: 'record the client',
      });
      actions.push({
        tool: 'crm.activity.log',
        input: { client: 'client@example.com', kind: 'status', summary: title },
        reason: 'log project status',
      });
      actions.push({
        tool: 'fs.write',
        input: { path: `crm/${slug}.md`, content: `# CRM update — ${title}\n\nStatus: progressed\nNext follow-up: scheduled\n` },
        reason: title,
      });
      summary = `Updated CRM records for "${title}".`;
      break;
    }
    case 'support': {
      actions.push({
        tool: 'fs.write',
        input: { path: `support/${slug}.md`, content: `# Support note — ${title}\n\n${description || 'Client update'}\n` },
        reason: title,
      });
      actions.push({
        tool: 'comm.send',
        input: { to: 'client', subject: title, text: `Update on "${title}": completed and ready for your review.` },
        reason: 'notify the client',
      });
      summary = `Sent a client update for "${title}".`;
      break;
    }
    case 'browser': {
      // Pull a URL out of the task if present, else visit a synthetic page.
      const match = `${title} ${description}`.match(/https?:\/\/[^\s)]+/);
      const url = match?.[0] ?? 'https://example.com';
      actions.push({ tool: 'browser.fetch', input: { url }, reason: title });
      summary = `Browsed ${url} for "${title}" and captured its content.`;
      break;
    }
    case 'vision-testing': {
      // The simulator has no model to write an app with and no minutes to
      // spend installing one, so it audits a representative snapshot rather
      // than claiming to have run `app.preview` against a real server. A real
      // provider follows the task description and starts the actual app.
      actions.push({ tool: 'vision.audit', input: { html: MOCK_RENDERED_PAGE, label: 'simulated render' }, reason: title });
      summary =
        `Audited a simulated render for "${title}" — responsiveness, console errors, accessibility. ` +
        `The offline mock cannot install and start the real app; run this with a real provider for app.preview.`;
      break;
    }
    case 'desktop': {
      actions.push({ tool: 'desktop.observe', input: { html: MOCK_RENDERED_PAGE }, reason: title });
      summary = `Observed the UI and identified its interactive elements for "${title}".`;
      break;
    }
    case 'research':
    case 'review':
    case 'architecture':
    default: {
      summary =
        agentKind === 'research'
          ? `Research on "${title}": summarised requirements, comparable products and constraints; no blockers found.`
          : agentKind === 'review'
            ? `Reviewed "${title}": code follows conventions; 0 blocking issues, 2 suggestions noted.`
            : `Completed "${title}".`;
      break;
    }
  }

  return {
    thoughts: `Deterministic mock reasoning for ${agentKind} task "${title}".`,
    summary,
    actions: actions as unknown as JsonObject['actions'],
    confidence: 0.9,
    echo: { promptChars: JSON.stringify(request.messages).length },
  } as unknown as JsonObject;
}

/**
 * Deterministic stand-in for a model-generated plan. Shapes a valid PlanSpec
 * JSON so the meta brain's model-planning path is exercisable offline.
 */
function planReplyFor(goal: string): JsonObject {
  const spec = {
    projectName: goal.replace(/\s+/g, ' ').trim().slice(0, 60) || 'Model project',
    domain: 'model-generated',
    summary: `Model-generated plan for: ${goal.slice(0, 120)}`,
    phases: [
      {
        name: 'Discovery',
        tasks: [
          { title: 'Requirements research', description: `Clarify requirements for: ${goal}`, agentKind: 'research', complexity: 'standard' },
        ],
      },
      {
        name: 'Build',
        tasks: [
          { title: 'Project scaffold setup', description: 'Initialise the project skeleton', agentKind: 'coding', complexity: 'standard' },
          { title: 'Implement core functionality', description: goal, agentKind: 'coding', complexity: 'complex' },
        ],
      },
      {
        name: 'Quality',
        tasks: [
          { title: 'Build verification', description: 'Verify the project builds and parses', agentKind: 'build', complexity: 'standard' },
          { title: 'Automated test suite', description: 'Test the core functionality', agentKind: 'testing', complexity: 'standard' },
        ],
      },
      {
        name: 'Delivery',
        tasks: [
          { title: 'Project documentation', description: 'Document the deliverable', agentKind: 'documentation', complexity: 'trivial' },
          { title: 'Deployment preparation', description: 'Plan and run the deployment', agentKind: 'devops', complexity: 'standard' },
        ],
      },
    ],
    risks: ['Scope may grow as requirements are clarified'],
    questionsForHuman: [],
  };
  return spec as unknown as JsonObject;
}

export class MockProvider implements Provider {
  readonly kind: ProviderKind;
  readonly name: string;
  private readonly cards: ModelCard[];
  private readonly options: MockProviderOptions;
  private requestCount = 0;

  constructor(options: MockProviderOptions = {}) {
    this.kind = options.kind ?? 'mock';
    this.name = options.name ?? `${this.kind} provider (offline simulator)`;
    this.cards = options.models ?? BUILTIN_MODELS.filter((card) => card.provider === 'mock');
    this.options = options;
  }

  models(): ModelCard[] {
    return this.cards;
  }

  isConfigured(): boolean {
    return true;
  }

  requestsServed(): number {
    return this.requestCount;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.options.alwaysFail) {
      throw new MegaError(this.options.alwaysFail, `${this.kind} provider forced failure (${this.options.alwaysFail})`);
    }
    this.requestCount += 1;
    if (this.options.rateLimitAfter !== undefined && this.requestCount > this.options.rateLimitAfter) {
      throw new MegaError('RATE_LIMITED', `${this.kind} provider hit its simulated rate limit`);
    }

    const meta = request.metadata ?? {};
    const text =
      meta.planning === true
        ? JSON.stringify(planReplyFor(String(meta.goal ?? request.messages.at(-1)?.content ?? 'a project')), null, 2)
        : meta.agentKind !== undefined
          ? JSON.stringify(replyForTask(meta, request), null, 2)
          : JSON.stringify(
              {
                thoughts: 'No task metadata supplied; replying generically.',
                summary: `Acknowledged: ${request.messages.at(-1)?.content.slice(0, 120) ?? ''}`,
                actions: [],
              },
              null,
              2,
            );

    const inputTokens = estimateTokens(`${request.system ?? ''}${request.messages.map((m) => m.content).join('')}`);
    return {
      text,
      provider: this.kind,
      model: request.model ?? this.cards[0]?.id ?? 'mock-frontier',
      stopReason: 'end_turn',
      usage: { inputTokens, outputTokens: estimateTokens(text) },
    };
  }
}
