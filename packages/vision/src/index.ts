/**
 * @megaai/vision — the vision / UI testing engine (Phase 3).
 *
 * Answers the questions a human tester would: is the page responsive, are
 * there JS/console errors, is it accessible, how does it perform, and what
 * are the interactive elements and what is each one *for*.
 *
 * Two drivers behind one report shape:
 *   - `StaticTestDriver`  — offline HTML analysis (no browser); deterministic,
 *     always available; used by tests and whenever no browser is present.
 *   - `BrowserTestDriver` — real headless Chromium (via `playwright-core` +
 *     the pre-installed browser); adds runtime checks: true responsive
 *     overflow across viewports, captured console errors, navigation-timing
 *     performance, real element geometry, screenshots and mouse/keyboard.
 *
 * Element *purpose* classification is pluggable — a heuristic by default, and
 * the trained UI-purpose model from `@megaai/models` when wired in.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool } from '@megaai/contracts';
import { launchChromium, type PwPage } from './launch.js';

/* ------------------------------------------------------------------ *
 * Report + element types
 * ------------------------------------------------------------------ */

export interface ElementFeatures {
  tag: string;
  type?: string;
  role?: string;
  text: string;
  id?: string;
  name?: string;
  classes?: string;
  href?: string;
  ariaLabel?: string;
}

export interface UiElement extends ElementFeatures {
  purpose: string;
  selector?: string;
  box?: { x: number; y: number; width: number; height: number };
}

export type PurposeClassifier = (features: ElementFeatures) => string;

export interface AuditIssue {
  rule: string;
  severity: 'info' | 'warn' | 'error';
  detail: string;
}

export interface ResponsiveResult {
  viewport: string;
  width: number;
  overflow: boolean;
  note?: string;
}

export interface AuditReport {
  target: string;
  driver: 'static' | 'browser';
  score: number;
  passed: boolean;
  responsive: ResponsiveResult[];
  console: { errors: string[]; warnings: string[] };
  accessibility: AuditIssue[];
  performance: { loadMs?: number; domContentLoadedMs?: number; resources?: number; note?: string };
  elements: UiElement[];
}

export interface AuditInput {
  url?: string;
  html?: string;
  label?: string;
}

/* ------------------------------------------------------------------ *
 * Heuristic purpose classifier (replaceable by a trained model)
 * ------------------------------------------------------------------ */

export const classifyPurposeHeuristic: PurposeClassifier = (f) => {
  const text = `${f.text} ${f.ariaLabel ?? ''} ${f.id ?? ''} ${f.name ?? ''} ${f.classes ?? ''}`.toLowerCase();
  const has = (...words: string[]) => words.some((w) => text.includes(w));
  if (f.tag === 'input') {
    if (f.type === 'submit' || f.type === 'button') return has('search') ? 'search' : 'submit';
    if (f.type === 'search' || has('search')) return 'search';
    if (f.type === 'password' || has('password')) return 'password-input';
    if (f.type === 'email' || has('email')) return 'email-input';
    if (f.type === 'checkbox' || f.type === 'radio') return 'toggle';
    return 'input';
  }
  if (f.tag === 'select' || f.tag === 'textarea') return 'input';
  if (has('submit', 'save', 'confirm', 'continue', 'checkout', 'pay', 'place order', 'sign up', 'register')) return 'submit';
  if (has('cancel', 'close', 'dismiss', 'back')) return 'cancel';
  if (has('delete', 'remove', 'trash')) return 'delete';
  if (has('login', 'log in', 'sign in')) return 'login';
  if (has('logout', 'sign out')) return 'logout';
  if (has('search', 'find')) return 'search';
  if (has('menu', 'nav', 'home', 'about', 'contact', 'products', 'catalog')) return 'navigation';
  if (has('add to cart', 'buy', 'add')) return 'action';
  if (f.tag === 'a') return f.href && f.href.startsWith('#') ? 'navigation' : 'link';
  return 'action';
};

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

function scoreReport(report: Omit<AuditReport, 'score' | 'passed'>): { score: number; passed: boolean } {
  let score = 100;
  score -= report.console.errors.length * 8;
  score -= report.console.warnings.length * 2;
  for (const issue of report.accessibility) score -= issue.severity === 'error' ? 6 : issue.severity === 'warn' ? 3 : 1;
  score -= report.responsive.filter((r) => r.overflow).length * 10;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const hasBlockingIssue =
    report.console.errors.length > 0 ||
    report.accessibility.some((i) => i.severity === 'error') ||
    report.responsive.some((r) => r.overflow);
  return { score, passed: score >= 70 && !hasBlockingIssue };
}

/* ------------------------------------------------------------------ *
 * Static (offline) driver — HTML analysis without a browser
 * ------------------------------------------------------------------ */

function attr(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

function textInside(html: string, openTagEnd: number, tagName: string): string {
  const close = html.toLowerCase().indexOf(`</${tagName}`, openTagEnd);
  const inner = close === -1 ? '' : html.slice(openTagEnd, close);
  return inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export class StaticTestDriver {
  readonly name = 'static';
  constructor(private readonly classify: PurposeClassifier = classifyPurposeHeuristic) {}

  audit(input: AuditInput): AuditReport {
    const html = input.html ?? '';
    const target = input.label ?? input.url ?? 'inline html';
    const lower = html.toLowerCase();
    const accessibility: AuditIssue[] = [];

    if (!/<title[\s>]/i.test(html)) accessibility.push({ rule: 'title', severity: 'warn', detail: 'missing <title>' });
    if (!/<html[^>]*\slang=/i.test(html)) accessibility.push({ rule: 'lang', severity: 'warn', detail: '<html> missing lang attribute' });

    // Responsive (static signals).
    const hasViewport = /<meta[^>]+name=["']?viewport/i.test(html);
    const hasMedia = lower.includes('@media');
    const fixedWide = /style=["'][^"']*width:\s*\d{3,}px/i.test(html);
    if (!hasViewport) accessibility.push({ rule: 'viewport', severity: 'error', detail: 'no responsive viewport meta tag' });
    const responsive: ResponsiveResult[] = [
      {
        viewport: 'static',
        width: 0,
        overflow: fixedWide,
        note: `viewport-meta=${hasViewport} media-queries=${hasMedia}${fixedWide ? ' fixed-wide-element' : ''}`,
      },
    ];

    // Images without alt.
    const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
    let missingAlt = 0;
    for (const img of imgs) if (attr(img, 'alt') === undefined) missingAlt += 1;
    if (missingAlt > 0) accessibility.push({ rule: 'img-alt', severity: 'warn', detail: `${missingAlt} image(s) without alt text` });

    // Elements + empty-label checks.
    const elements: UiElement[] = [];
    let emptyButtons = 0;
    const scan = (tagName: string) => {
      const re = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) !== null) {
        const rawAttrs = m[0];
        const text = tagName === 'input' ? attr(rawAttrs, 'value') ?? '' : textInside(html, re.lastIndex, tagName);
        const features: ElementFeatures = {
          tag: tagName,
          type: attr(rawAttrs, 'type'),
          text,
          id: attr(rawAttrs, 'id'),
          name: attr(rawAttrs, 'name'),
          classes: attr(rawAttrs, 'class'),
          href: attr(rawAttrs, 'href'),
          ariaLabel: attr(rawAttrs, 'aria-label'),
        };
        if ((tagName === 'button' || tagName === 'a') && !text && !features.ariaLabel) emptyButtons += 1;
        elements.push({ ...features, purpose: this.classify(features) });
        if (elements.length > 500) break;
      }
    };
    scan('button');
    scan('a');
    scan('input');
    scan('select');
    scan('textarea');
    if (emptyButtons > 0) {
      accessibility.push({ rule: 'label', severity: 'warn', detail: `${emptyButtons} button/link(s) without accessible text` });
    }

    const performance = {
      resources: (html.match(/<script\b/gi) ?? []).length + imgs.length + (html.match(/<link\b/gi) ?? []).length,
      note: 'static estimate (runtime timing needs the browser driver)',
    };

    const base = { target, driver: 'static' as const, responsive, console: { errors: [], warnings: [] }, accessibility, performance, elements };
    return { ...base, ...scoreReport(base) };
  }
}

/* ------------------------------------------------------------------ *
 * Browser (real Chromium) driver
 * ------------------------------------------------------------------ */

const VIEWPORTS: Array<{ name: string; width: number; height: number }> = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
];

// These run INSIDE the page. Passed to page.evaluate() as string expressions,
// so each is an IIFE that returns its value (a bare "() => {}" string would
// evaluate to an uncalled function).
const PAGE_SCAN = `(() => {
  const out = [];
  const push = (el, tag) => {
    const r = el.getBoundingClientRect();
    out.push({
      tag,
      type: el.getAttribute('type') || undefined,
      role: el.getAttribute('role') || undefined,
      text: (el.innerText || el.value || '').trim().slice(0, 120),
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      classes: el.className && typeof el.className === 'string' ? el.className : undefined,
      href: el.getAttribute('href') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
    });
  };
  document.querySelectorAll('button').forEach((e) => push(e, 'button'));
  document.querySelectorAll('a').forEach((e) => push(e, 'a'));
  document.querySelectorAll('input,select,textarea').forEach((e) => push(e, e.tagName.toLowerCase()));
  return out.slice(0, 500);
})()`;

const PAGE_A11Y = `(() => {
  const issues = [];
  const imgs = [...document.images].filter((i) => !i.getAttribute('alt'));
  if (imgs.length) issues.push({ rule: 'img-alt', severity: 'warn', detail: imgs.length + ' image(s) without alt text' });
  const empties = [...document.querySelectorAll('button,a')].filter((e) => !(e.innerText || '').trim() && !e.getAttribute('aria-label'));
  if (empties.length) issues.push({ rule: 'label', severity: 'warn', detail: empties.length + ' button/link(s) without accessible text' });
  if (!document.documentElement.getAttribute('lang')) issues.push({ rule: 'lang', severity: 'warn', detail: '<html> missing lang attribute' });
  if (!document.title) issues.push({ rule: 'title', severity: 'warn', detail: 'missing <title>' });
  return issues;
})()`;

const PAGE_PERF = `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    loadMs: nav ? Math.round(nav.loadEventEnd - nav.startTime) : undefined,
    domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : undefined,
    resources: performance.getEntriesByType('resource').length,
  };
})()`;

export class BrowserTestDriver {
  readonly name = 'browser';
  constructor(private readonly classify: PurposeClassifier = classifyPurposeHeuristic) {}

  private async withPage<T>(input: AuditInput, fn: (page: PwPage) => Promise<T>): Promise<T> {
    const browser = await launchChromium();
    if (!browser) throw new MegaError('PROVIDER_UNAVAILABLE', 'No headless browser available');
    const page = await browser.newPage();
    try {
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private async load(page: PwPage, input: AuditInput, errors: string[], warnings: string[]): Promise<void> {
    page.on('console', (msg) => {
      const m = msg as { type(): string; text(): string };
      if (m.type() === 'error') errors.push(m.text().slice(0, 500));
      else if (m.type() === 'warning') warnings.push(m.text().slice(0, 500));
    });
    page.on('pageerror', (err) => errors.push(String(err).slice(0, 500)));
    if (input.url) await page.goto(input.url, { waitUntil: 'load', timeout: 20_000 });
    else await page.setContent(input.html ?? '', { waitUntil: 'load' });
  }

  async audit(input: AuditInput): Promise<AuditReport> {
    return this.withPage(input, async (page) => {
      const errors: string[] = [];
      const warnings: string[] = [];
      await this.load(page, input, errors, warnings);

      const responsive: ResponsiveResult[] = [];
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        const scrollWidth = await page.evaluate<number>('document.documentElement.scrollWidth');
        responsive.push({ viewport: vp.name, width: vp.width, overflow: scrollWidth > vp.width + 2 });
      }
      await page.setViewportSize({ width: 1280, height: 900 });

      const performance = await page.evaluate<AuditReport['performance']>(PAGE_PERF);
      const accessibility = await page.evaluate<AuditIssue[]>(PAGE_A11Y);
      const rawElements = await page.evaluate<Array<ElementFeatures & { box?: UiElement['box'] }>>(PAGE_SCAN);
      const elements: UiElement[] = rawElements.map((e) => ({ ...e, purpose: this.classify(e) }));

      const base = {
        target: input.label ?? input.url ?? 'inline html',
        driver: 'browser' as const,
        responsive,
        console: { errors, warnings },
        accessibility,
        performance,
        elements,
      };
      return { ...base, ...scoreReport(base) };
    });
  }

  async screenshot(input: AuditInput): Promise<{ format: 'png'; base64: string }> {
    return this.withPage(input, async (page) => {
      const errors: string[] = [];
      await this.load(page, input, errors, []);
      const buffer = await page.screenshot({ type: 'png', fullPage: true });
      return { format: 'png' as const, base64: buffer.toString('base64') };
    });
  }

  /** Run mouse/keyboard steps against the page (real DOM interaction testing). */
  async interact(
    input: AuditInput,
    steps: Array<{ action: 'click' | 'type'; selector: string; text?: string }>,
  ): Promise<{ ok: boolean; steps: Array<{ action: string; selector: string; ok: boolean; error?: string }>; errors: string[] }> {
    return this.withPage(input, async (page) => {
      const errors: string[] = [];
      await this.load(page, input, errors, []);
      const results: Array<{ action: string; selector: string; ok: boolean; error?: string }> = [];
      for (const step of steps.slice(0, 50)) {
        try {
          if (step.action === 'click') await page.click(step.selector, { timeout: 5_000 });
          else await page.fill(step.selector, step.text ?? '', { timeout: 5_000 });
          results.push({ action: step.action, selector: step.selector, ok: true });
        } catch (err) {
          results.push({ action: step.action, selector: step.selector, ok: false, error: String(err).split('\n')[0] });
        }
      }
      return { ok: results.every((r) => r.ok), steps: results, errors };
    });
  }
}

/* ------------------------------------------------------------------ *
 * VisionTester — picks a driver, resolves inputs, merges static+browser
 * ------------------------------------------------------------------ */

export interface VisionTesterOptions {
  /** Try the real browser first (falls back to static). */
  preferBrowser?: boolean;
  classifier?: PurposeClassifier;
  logger?: (message: string, fields?: JsonObject) => void;
}

export class VisionTester {
  private readonly staticDriver: StaticTestDriver;
  private readonly browserDriver: BrowserTestDriver;
  private readonly preferBrowser: boolean;
  private readonly logger?: (message: string, fields?: JsonObject) => void;

  constructor(options: VisionTesterOptions = {}) {
    const classifier = options.classifier ?? classifyPurposeHeuristic;
    this.staticDriver = new StaticTestDriver(classifier);
    this.browserDriver = new BrowserTestDriver(classifier);
    this.preferBrowser = options.preferBrowser ?? true;
    this.logger = options.logger;
  }

  async audit(input: AuditInput): Promise<AuditReport> {
    if (this.preferBrowser) {
      try {
        return await this.browserDriver.audit(input);
      } catch (err) {
        this.logger?.('vision: browser unavailable, using static analysis', { error: String(err) });
      }
    }
    if (input.html === undefined && input.url !== undefined) {
      // Static can't fetch a URL — return a minimal report explaining why.
      const base = {
        target: input.url,
        driver: 'static' as const,
        responsive: [{ viewport: 'static', width: 0, overflow: false, note: 'URL analysis needs the browser driver' }],
        console: { errors: [], warnings: [] },
        accessibility: [{ rule: 'driver', severity: 'info' as const, detail: 'install playwright-core + Chromium for live URL testing' }],
        performance: { note: 'unavailable without a browser' },
        elements: [],
      };
      return { ...base, ...scoreReport(base) };
    }
    return this.staticDriver.audit(input);
  }

  async screenshot(input: AuditInput): Promise<{ format: 'png'; base64: string } | undefined> {
    try {
      return await this.browserDriver.screenshot(input);
    } catch {
      return undefined;
    }
  }

  interact(input: AuditInput, steps: Array<{ action: 'click' | 'type'; selector: string; text?: string }>) {
    return this.browserDriver.interact(input, steps);
  }
}

/* ------------------------------------------------------------------ *
 * Agent-facing tools
 * ------------------------------------------------------------------ */

function readWorkspaceFile(workspaceRoot: string, relPath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new MegaError('PERMISSION_DENIED', `Path escapes the workspace: ${relPath}`);
  }
  if (!existsSync(target) || statSync(target).isDirectory()) {
    throw new MegaError('NOT_FOUND', `File not found: ${relPath}`);
  }
  return readFileSync(target, 'utf8');
}

function resolveInput(input: JsonObject, workspaceRoot: string): AuditInput {
  if (typeof input.url === 'string') return { url: input.url, label: input.url };
  if (typeof input.file === 'string') return { html: readWorkspaceFile(workspaceRoot, input.file), label: input.file };
  if (typeof input.html === 'string') return { html: input.html, label: 'inline html' };
  throw new MegaError('INVALID_INPUT', 'vision tools need one of: url, file, html');
}

export function createVisionTools(tester: VisionTester): Tool[] {
  const audit: Tool = {
    name: 'vision.audit',
    description: 'Audit a page (url | workspace file | html) for responsiveness, console errors, accessibility, performance and UI elements',
    inputSchema: { url: 'string (optional)', file: 'string (workspace-relative, optional)', html: 'string (optional)' },
    permissions: ['vision'],
    async execute(input, ctx) {
      return (await tester.audit(resolveInput(input, ctx.workspaceRoot))) as unknown as JsonValue;
    },
  };
  const screenshot: Tool = {
    name: 'vision.screenshot',
    description: 'Capture a full-page PNG screenshot of a page (needs the browser driver)',
    inputSchema: { url: 'string (optional)', file: 'string (optional)', html: 'string (optional)' },
    permissions: ['vision'],
    async execute(input, ctx) {
      const shot = await tester.screenshot(resolveInput(input, ctx.workspaceRoot));
      return (shot ?? { format: 'png', base64: '', note: 'browser unavailable' }) as unknown as JsonValue;
    },
  };
  const interact: Tool = {
    name: 'vision.interact',
    description: 'Run mouse/keyboard steps ([{action:"click"|"type", selector, text?}]) against a page and report results',
    inputSchema: { url: 'string (optional)', file: 'string (optional)', html: 'string (optional)', steps: '[{action, selector, text?}]' },
    permissions: ['vision'],
    async execute(input, ctx) {
      const steps = Array.isArray(input.steps)
        ? (input.steps as JsonObject[]).map((s) => ({
            action: s.action === 'type' ? ('type' as const) : ('click' as const),
            selector: String(s.selector ?? ''),
            text: typeof s.text === 'string' ? s.text : undefined,
          }))
        : [];
      return (await tester.interact(resolveInput(input, ctx.workspaceRoot), steps)) as unknown as JsonValue;
    },
  };
  return [audit, screenshot, interact];
}
