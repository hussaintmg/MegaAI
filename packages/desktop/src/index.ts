/**
 * @megaai/desktop — desktop / UI automation (Phase 3).
 *
 * The capability the vision describes: a model that "sees the screen, finds
 * the buttons and knows what each one is for," then drives mouse and keyboard.
 *
 * It is browser-backed — the page rendered in real headless Chromium IS the
 * screen. `observe()` returns a screen map: every interactive element with its
 * geometry, its centre coordinates, and its *purpose* (from the trained
 * `@megaai/models` UI-purpose model when wired in, the heuristic otherwise).
 * `act()` runs a sequence of real mouse/keyboard steps, targeting elements by
 * purpose ("click the submit button"), by text, by selector, or by raw
 * coordinates. The `DesktopSession` seam means a native OS driver (mouse,
 * keyboard, OCR, windows) can slot in later behind the same shape.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import type { Tool } from '@megaai/contracts';
import {
  classifyPurposeHeuristic,
  launchChromium,
  type ElementFeatures,
  type PurposeClassifier,
  type PwPage,
  type UiElement,
} from '@megaai/vision';

/* ------------------------------------------------------------------ *
 * Types
 * ------------------------------------------------------------------ */

export interface DesktopInput {
  url?: string;
  html?: string;
  label?: string;
}

export interface Point {
  x: number;
  y: number;
}

/** A detected element plus its clickable centre coordinate. */
export interface DesktopElement extends UiElement {
  center?: Point;
}

export interface ScreenObservation {
  target: string;
  width: number;
  height: number;
  elements: DesktopElement[];
}

/** How to point at an element: by coordinates, selector, purpose, or text. */
export interface DesktopTarget {
  x?: number;
  y?: number;
  selector?: string;
  purpose?: string;
  text?: string;
}

export interface DesktopStep {
  action: 'click' | 'type' | 'press' | 'move' | 'scroll' | 'wait';
  target?: DesktopTarget;
  text?: string;
  key?: string;
  ms?: number;
  y?: number;
}

export interface StepResult {
  action: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

export interface ActReport {
  ok: boolean;
  steps: StepResult[];
  observation: ScreenObservation;
}

interface ResolvedTarget {
  x?: number;
  y?: number;
  selector?: string;
  matched?: DesktopElement;
}

/** The extra Playwright surface (mouse/keyboard) beyond the shared `PwPage`. */
interface DesktopPage extends PwPage {
  mouse: { click(x: number, y: number, options?: Record<string, unknown>): Promise<void>; move(x: number, y: number, options?: Record<string, unknown>): Promise<void> };
  keyboard: { type(text: string, options?: Record<string, unknown>): Promise<void>; press(key: string, options?: Record<string, unknown>): Promise<void> };
  waitForTimeout(ms: number): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-testable without a browser)
 * ------------------------------------------------------------------ */

export function centerOf(box?: { x: number; y: number; width: number; height: number }): Point | undefined {
  if (!box) return undefined;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

/** Resolve an intent (purpose/text/selector/coords) to something clickable. */
export function resolveTarget(elements: readonly DesktopElement[], target: DesktopTarget | undefined): ResolvedTarget | undefined {
  if (!target) return undefined;
  if (typeof target.x === 'number' && typeof target.y === 'number') return { x: target.x, y: target.y };
  if (target.selector) return { selector: target.selector };
  if (target.purpose) {
    const el = elements.find((e) => e.purpose === target.purpose && e.center);
    return el?.center ? { x: el.center.x, y: el.center.y, matched: el } : undefined;
  }
  if (target.text) {
    const needle = target.text.toLowerCase();
    const el =
      elements.find((e) => (e.text ?? '').toLowerCase().includes(needle) && e.center) ??
      elements.find((e) => (e.ariaLabel ?? '').toLowerCase().includes(needle) && e.center);
    return el?.center ? { x: el.center.x, y: el.center.y, matched: el } : undefined;
  }
  return undefined;
}

function describeStep(step: DesktopStep): string {
  const parts: string[] = [step.action];
  if (step.target) {
    if (step.target.purpose) parts.push(`purpose=${step.target.purpose}`);
    else if (step.target.text) parts.push(`text=${step.target.text}`);
    else if (step.target.selector) parts.push(step.target.selector);
    else if (typeof step.target.x === 'number') parts.push(`(${step.target.x},${step.target.y})`);
  }
  if (step.key) parts.push(`key=${step.key}`);
  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Page-context scripts (IIFEs — evaluated as string expressions)
 * ------------------------------------------------------------------ */

const PAGE_ELEMENTS = `(() => {
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

const PAGE_SIZE = `(() => ({ width: window.innerWidth, height: window.innerHeight }))()`;

/* ------------------------------------------------------------------ *
 * DesktopEngine
 * ------------------------------------------------------------------ */

export interface DesktopEngineOptions {
  classifier?: PurposeClassifier;
  /** When non-empty, `url` inputs must be on one of these hosts. */
  allowedHosts?: string[];
  logger?: (message: string, fields?: JsonObject) => void;
}

export class DesktopEngine {
  private readonly classify: PurposeClassifier;
  private readonly allowedHosts: string[];
  private readonly logger?: (message: string, fields?: JsonObject) => void;

  constructor(options: DesktopEngineOptions = {}) {
    this.classify = options.classifier ?? classifyPurposeHeuristic;
    this.allowedHosts = options.allowedHosts ?? [];
    this.logger = options.logger;
  }

  private checkHost(input: DesktopInput): void {
    if (!input.url || this.allowedHosts.length === 0) return;
    let host = '';
    try {
      host = new URL(input.url).hostname;
    } catch {
      throw new MegaError('INVALID_INPUT', `Not a valid URL: ${input.url}`);
    }
    const ok = this.allowedHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!ok) throw new MegaError('PERMISSION_DENIED', `Host not allowed for desktop automation: ${host}`, { allowedHosts: this.allowedHosts });
  }

  private async withPage<T>(input: DesktopInput, fn: (page: DesktopPage) => Promise<T>): Promise<T> {
    this.checkHost(input);
    const browser = await launchChromium();
    if (!browser) throw new MegaError('PROVIDER_UNAVAILABLE', 'No headless browser available for desktop automation');
    const page = (await browser.newPage()) as unknown as DesktopPage;
    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      if (input.url) await page.goto(input.url, { waitUntil: 'load', timeout: 20_000 });
      else await page.setContent(input.html ?? '', { waitUntil: 'load' });
      return await fn(page);
    } finally {
      await page.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private async scan(page: DesktopPage): Promise<DesktopElement[]> {
    const raw = await page.evaluate<Array<ElementFeatures & { box?: UiElement['box'] }>>(PAGE_ELEMENTS);
    return raw.map((e) => ({ ...e, purpose: this.classify(e), center: centerOf(e.box) }));
  }

  private label(input: DesktopInput): string {
    return input.label ?? input.url ?? 'inline html';
  }

  /** See the screen: every interactive element, its box, centre and purpose. */
  async observe(input: DesktopInput): Promise<ScreenObservation> {
    return this.withPage(input, async (page) => {
      const size = await page.evaluate<{ width: number; height: number }>(PAGE_SIZE);
      const elements = await this.scan(page);
      this.logger?.('desktop: observed screen', { target: this.label(input), elements: elements.length });
      return { target: this.label(input), width: size.width, height: size.height, elements };
    });
  }

  /** Drive real mouse/keyboard through a sequence of steps. */
  async act(input: DesktopInput, steps: readonly DesktopStep[]): Promise<ActReport> {
    return this.withPage(input, async (page) => {
      const results: StepResult[] = [];
      let elements = await this.scan(page);
      for (const step of steps.slice(0, 50)) {
        try {
          const detail = await this.runStep(page, step, elements);
          results.push({ action: describeStep(step), ok: true, detail });
          if (step.action === 'click' || step.action === 'type' || step.action === 'press' || step.action === 'scroll') {
            elements = await this.scan(page);
          }
        } catch (err) {
          results.push({ action: describeStep(step), ok: false, error: String(err).split('\n')[0] });
        }
      }
      const size = await page.evaluate<{ width: number; height: number }>(PAGE_SIZE);
      return { ok: results.every((r) => r.ok), steps: results, observation: { target: this.label(input), width: size.width, height: size.height, elements } };
    });
  }

  async screenshot(input: DesktopInput): Promise<{ format: 'png'; base64: string }> {
    return this.withPage(input, async (page) => {
      const buffer = await page.screenshot({ type: 'png', fullPage: true });
      return { format: 'png' as const, base64: buffer.toString('base64') };
    });
  }

  private async runStep(page: DesktopPage, step: DesktopStep, elements: readonly DesktopElement[]): Promise<string> {
    switch (step.action) {
      case 'wait':
        await page.waitForTimeout(Math.min(Math.max(step.ms ?? 100, 0), 5_000));
        return `waited ${step.ms ?? 100}ms`;
      case 'press':
        if (!step.key) throw new MegaError('INVALID_INPUT', 'press needs a "key"');
        await page.keyboard.press(step.key);
        return `pressed ${step.key}`;
      case 'scroll': {
        const dy = Number(step.y ?? 400) || 0;
        await page.evaluate(`window.scrollBy(0, ${dy})`);
        return `scrolled ${dy}px`;
      }
      case 'move': {
        const t = resolveTarget(elements, step.target);
        if (!t || t.x === undefined || t.y === undefined) throw new MegaError('NOT_FOUND', `Could not resolve move target: ${describeStep(step)}`);
        await page.mouse.move(t.x, t.y);
        return `moved to (${t.x},${t.y})`;
      }
      case 'click': {
        const t = resolveTarget(elements, step.target);
        if (!t) throw new MegaError('NOT_FOUND', `Could not resolve click target: ${describeStep(step)}`);
        if (t.selector) {
          await page.click(t.selector, { timeout: 5_000 });
          return `clicked ${t.selector}`;
        }
        await page.mouse.click(t.x!, t.y!);
        return `clicked (${t.x},${t.y})${t.matched ? ` [${t.matched.purpose}]` : ''}`;
      }
      case 'type': {
        const t = step.target ? resolveTarget(elements, step.target) : undefined;
        if (t?.selector) {
          await page.fill(t.selector, step.text ?? '', { timeout: 5_000 });
          return `typed into ${t.selector}`;
        }
        if (t && t.x !== undefined && t.y !== undefined) await page.mouse.click(t.x, t.y);
        await page.keyboard.type(step.text ?? '');
        return `typed ${(step.text ?? '').length} char(s)`;
      }
      default:
        throw new MegaError('INVALID_INPUT', `Unknown desktop action: ${String((step as DesktopStep).action)}`);
    }
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

function resolveInput(input: JsonObject, workspaceRoot: string): DesktopInput {
  if (typeof input.url === 'string') return { url: input.url, label: input.url };
  if (typeof input.file === 'string') return { html: readWorkspaceFile(workspaceRoot, input.file), label: input.file };
  if (typeof input.html === 'string') return { html: input.html, label: 'inline html' };
  throw new MegaError('INVALID_INPUT', 'desktop tools need one of: url, file, html');
}

function parseSteps(value: JsonValue | undefined): DesktopStep[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((raw) => {
    const s = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as JsonObject;
    const t = s.target && typeof s.target === 'object' && !Array.isArray(s.target) ? (s.target as JsonObject) : undefined;
    const target: DesktopTarget | undefined = t
      ? {
          x: typeof t.x === 'number' ? t.x : undefined,
          y: typeof t.y === 'number' ? t.y : undefined,
          selector: typeof t.selector === 'string' ? t.selector : undefined,
          purpose: typeof t.purpose === 'string' ? t.purpose : undefined,
          text: typeof t.text === 'string' ? t.text : undefined,
        }
      : undefined;
    const action = ['click', 'type', 'press', 'move', 'scroll', 'wait'].includes(String(s.action)) ? (s.action as DesktopStep['action']) : 'wait';
    return {
      action,
      target,
      text: typeof s.text === 'string' ? s.text : undefined,
      key: typeof s.key === 'string' ? s.key : undefined,
      ms: typeof s.ms === 'number' ? s.ms : undefined,
      y: typeof s.y === 'number' ? s.y : undefined,
    };
  });
}

const UNAVAILABLE = 'PROVIDER_UNAVAILABLE';

/** `desktop.observe` + `desktop.act` on the `desktop` permission. */
export function createDesktopTools(engine: DesktopEngine): Tool[] {
  const observe: Tool = {
    name: 'desktop.observe',
    description: 'See the screen: detect every interactive element with its box, centre coordinates and purpose (url | workspace file | html)',
    inputSchema: { url: 'string (optional)', file: 'string (workspace-relative, optional)', html: 'string (optional)' },
    permissions: ['desktop'],
    async execute(input, ctx) {
      try {
        return (await engine.observe(resolveInput(input, ctx.workspaceRoot))) as unknown as JsonValue;
      } catch (err) {
        if (err instanceof MegaError && err.code === UNAVAILABLE) {
          return { available: false, elements: [], note: 'no headless browser available for desktop automation' } as unknown as JsonValue;
        }
        throw err;
      }
    },
  };
  const act: Tool = {
    name: 'desktop.act',
    description: 'Drive mouse/keyboard: steps [{action:"click"|"type"|"press"|"move"|"scroll"|"wait", target:{purpose|text|selector|x,y}, text?, key?, ms?, y?}]',
    inputSchema: { url: 'string (optional)', file: 'string (optional)', html: 'string (optional)', steps: '[{action, target?, text?, key?, ms?, y?}]' },
    permissions: ['desktop'],
    async execute(input, ctx) {
      try {
        return (await engine.act(resolveInput(input, ctx.workspaceRoot), parseSteps(input.steps))) as unknown as JsonValue;
      } catch (err) {
        if (err instanceof MegaError && err.code === UNAVAILABLE) {
          return { ok: false, available: false, steps: [], note: 'no headless browser available for desktop automation' } as unknown as JsonValue;
        }
        throw err;
      }
    },
  };
  return [observe, act];
}
