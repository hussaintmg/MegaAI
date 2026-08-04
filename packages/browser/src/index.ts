/**
 * @megaai/browser — browser automation (Phase 3, milestone 2).
 *
 * A pluggable `BrowserDriver` behind the same offline-first pattern as the
 * AI providers: a deterministic `SimulatedDriver` runs everywhere with no
 * dependencies (tests, demos, CI), and an optional Playwright driver drives
 * a real Chromium when it is installed and enabled — chosen lazily on first
 * use so bootstrapping stays synchronous and dependency-light.
 *
 * Host access is allowlisted; `browser.*` tools sit behind the `net.browser`
 * permission, which is off by default in the security config.
 */

import type { JsonObject, JsonValue } from '@megaai/types';
import { MegaError } from '@megaai/types';
import { newId } from '@megaai/utils';
import type { Tool } from '@megaai/contracts';

export interface BrowserPage {
  id: string;
  url: string;
  title: string;
}

export interface Screenshot {
  format: 'png';
  /** base64-encoded image bytes. */
  base64: string;
  width: number;
  height: number;
}

/** What any browser backend must provide. */
export interface BrowserDriver {
  readonly name: string;
  open(url: string): Promise<BrowserPage>;
  readText(pageId: string): Promise<string>;
  click(pageId: string, selector: string): Promise<void>;
  screenshot(pageId: string): Promise<Screenshot>;
  close(pageId?: string): Promise<void>;
}

// 1x1 transparent PNG — a stable placeholder the simulator returns.
const BLANK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * Deterministic, offline browser. It never touches the network; pages are
 * synthetic and derived purely from their URL, so tests and demos are
 * reproducible.
 */
export class SimulatedDriver implements BrowserDriver {
  readonly name = 'simulated';
  private readonly pages = new Map<string, BrowserPage & { clicks: string[] }>();

  async open(url: string): Promise<BrowserPage> {
    let host = url;
    try {
      host = new URL(url).hostname || url;
    } catch {
      /* non-URL targets (e.g. about:task) keep their raw value */
    }
    const page: BrowserPage & { clicks: string[] } = {
      id: newId('page'),
      url,
      title: `Simulated page — ${host}`,
      clicks: [],
    };
    this.pages.set(page.id, page);
    return { id: page.id, url: page.url, title: page.title };
  }

  private require(pageId: string): BrowserPage & { clicks: string[] } {
    const page = this.pages.get(pageId);
    if (!page) throw new MegaError('NOT_FOUND', `No open page "${pageId}"`);
    return page;
  }

  async readText(pageId: string): Promise<string> {
    const page = this.require(pageId);
    return `[simulated content for ${page.url}]\nTitle: ${page.title}\nThis deterministic page stands in for real browser content; install Playwright and enable the browser to fetch live pages.`;
  }

  async click(pageId: string, selector: string): Promise<void> {
    this.require(pageId).clicks.push(selector);
  }

  async screenshot(pageId: string): Promise<Screenshot> {
    this.require(pageId);
    return { format: 'png', base64: BLANK_PNG, width: 1, height: 1 };
  }

  async close(pageId?: string): Promise<void> {
    if (pageId) this.pages.delete(pageId);
    else this.pages.clear();
  }
}

/**
 * Real Chromium via Playwright, loaded only when asked for. `create()`
 * returns undefined (rather than throwing) when Playwright is not installed,
 * so callers can fall back to the simulator cleanly.
 */
export class PlaywrightDriver implements BrowserDriver {
  readonly name = 'playwright';
  private readonly pages = new Map<string, { page: unknown }>();

  private constructor(
    private readonly browser: { newPage(): Promise<unknown>; close(): Promise<void> },
  ) {}

  static async create(): Promise<PlaywrightDriver | undefined> {
    try {
      // Dynamic + variable specifier so bundlers/tsc don't hard-require it.
      const moduleName = 'playwright';
      const mod = (await import(moduleName)) as {
        chromium?: { launch(opts?: JsonObject): Promise<{ newPage(): Promise<unknown>; close(): Promise<void> }> };
      };
      if (!mod.chromium) return undefined;
      const launchOptions: JsonObject = { headless: true };
      const exe = process.env.PLAYWRIGHT_BROWSERS_PATH;
      if (exe) launchOptions.executablePath = `${exe}/chromium`;
      const browser = await mod.chromium.launch(launchOptions).catch(() => undefined);
      return browser ? new PlaywrightDriver(browser) : undefined;
    } catch {
      return undefined;
    }
  }

  async open(url: string): Promise<BrowserPage> {
    const page = (await this.browser.newPage()) as {
      goto(url: string): Promise<unknown>;
      title(): Promise<string>;
    };
    await page.goto(url);
    const id = newId('page');
    this.pages.set(id, { page });
    return { id, url, title: await page.title() };
  }

  private require(pageId: string): { page: unknown } {
    const entry = this.pages.get(pageId);
    if (!entry) throw new MegaError('NOT_FOUND', `No open page "${pageId}"`);
    return entry;
  }

  async readText(pageId: string): Promise<string> {
    const page = this.require(pageId).page as { innerText(selector: string): Promise<string> };
    return page.innerText('body');
  }

  async click(pageId: string, selector: string): Promise<void> {
    const page = this.require(pageId).page as { click(selector: string): Promise<void> };
    await page.click(selector);
  }

  async screenshot(pageId: string): Promise<Screenshot> {
    const page = this.require(pageId).page as { screenshot(opts?: JsonObject): Promise<Buffer> };
    const buffer = await page.screenshot({ type: 'png' });
    return { format: 'png', base64: buffer.toString('base64'), width: 0, height: 0 };
  }

  async close(pageId?: string): Promise<void> {
    if (pageId) {
      const entry = this.pages.get(pageId);
      if (entry) {
        await (entry.page as { close(): Promise<void> }).close().catch(() => undefined);
        this.pages.delete(pageId);
      }
      return;
    }
    await this.browser.close().catch(() => undefined);
    this.pages.clear();
  }
}

export interface BrowserEngineOptions {
  /** Hostnames the browser may visit (empty = only non-http targets). */
  allowedHosts?: string[];
  /** Try the real Playwright driver first (falls back to the simulator). */
  preferReal?: boolean;
  /** Inject a driver directly (tests). */
  driver?: BrowserDriver;
  logger?: (message: string, fields?: JsonObject) => void;
}

/**
 * Owns a single browser driver, resolved lazily on first use, and enforces
 * the host allowlist before any navigation.
 */
export class BrowserEngine {
  private driver?: BrowserDriver;
  private resolving?: Promise<BrowserDriver>;
  private readonly allowedHosts: string[];
  private readonly preferReal: boolean;
  private readonly injected?: BrowserDriver;
  private readonly logger?: (message: string, fields?: JsonObject) => void;

  constructor(options: BrowserEngineOptions = {}) {
    this.allowedHosts = options.allowedHosts ?? [];
    this.preferReal = options.preferReal ?? false;
    this.injected = options.driver;
    this.logger = options.logger;
  }

  private async resolveDriver(): Promise<BrowserDriver> {
    if (this.driver) return this.driver;
    if (this.injected) {
      this.driver = this.injected;
      return this.driver;
    }
    if (!this.resolving) {
      this.resolving = (async () => {
        if (this.preferReal) {
          const real = await PlaywrightDriver.create();
          if (real) {
            this.logger?.('browser: using Playwright (Chromium)');
            return real;
          }
          this.logger?.('browser: Playwright unavailable, using the offline simulator');
        }
        return new SimulatedDriver();
      })();
    }
    this.driver = await this.resolving;
    return this.driver;
  }

  /** The active driver's name, once resolved (else the intended one). */
  driverName(): string {
    return this.driver?.name ?? (this.preferReal ? 'playwright?' : 'simulated');
  }

  private checkHost(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Non-URL targets (about:*, data:*) are allowed only on the simulator.
      if (this.preferReal) throw new MegaError('INVALID_INPUT', `Not a valid URL: ${url}`);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      if (this.preferReal) throw new MegaError('PERMISSION_DENIED', `Unsupported protocol: ${parsed.protocol}`);
      return;
    }
    const allowed = this.allowedHosts.some(
      (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
    );
    if (!allowed) {
      throw new MegaError('PERMISSION_DENIED', `Host "${parsed.hostname}" is not on the browser allowlist`);
    }
  }

  async open(url: string): Promise<BrowserPage> {
    this.checkHost(url);
    const driver = await this.resolveDriver();
    return driver.open(url);
  }

  async readText(pageId: string): Promise<string> {
    return (await this.resolveDriver()).readText(pageId);
  }

  async click(pageId: string, selector: string): Promise<void> {
    return (await this.resolveDriver()).click(pageId, selector);
  }

  async screenshot(pageId: string): Promise<Screenshot> {
    return (await this.resolveDriver()).screenshot(pageId);
  }

  async close(pageId?: string): Promise<void> {
    if (!this.driver) return;
    return this.driver.close(pageId);
  }
}

/* ------------------------------------------------------------------ *
 * Agent-facing tools
 * ------------------------------------------------------------------ */

function str(input: JsonObject, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new MegaError('INVALID_INPUT', `Tool input "${key}" must be a string`);
  return value;
}

export function createBrowserTools(engine: BrowserEngine): Tool[] {
  // High-level convenience: open → read → close in one action, so agents
  // don't have to thread a page id between separate tool calls.
  const fetch: Tool = {
    name: 'browser.fetch',
    description: 'Open a URL, read its visible text, and close the page — returns the title and text',
    inputSchema: { url: 'string (http(s) URL on an allowlisted host)' },
    permissions: ['net.browser'],
    async execute(input) {
      const page = await engine.open(str(input, 'url'));
      try {
        const text = await engine.readText(page.id);
        return { url: page.url, title: page.title, text: text.slice(0, 100_000) };
      } finally {
        await engine.close(page.id);
      }
    },
  };
  const open: Tool = {
    name: 'browser.open',
    description: 'Open a URL in the browser and return the page id and title',
    inputSchema: { url: 'string (http(s) URL on an allowlisted host)' },
    permissions: ['net.browser'],
    async execute(input) {
      const page = await engine.open(str(input, 'url'));
      return page as unknown as JsonValue;
    },
  };
  const read: Tool = {
    name: 'browser.read',
    description: 'Read the visible text of an open page',
    inputSchema: { pageId: 'string (from browser.open)' },
    permissions: ['net.browser'],
    async execute(input) {
      return { text: (await engine.readText(str(input, 'pageId'))).slice(0, 100_000) };
    },
  };
  const click: Tool = {
    name: 'browser.click',
    description: 'Click an element (CSS selector) on an open page',
    inputSchema: { pageId: 'string', selector: 'string (CSS selector)' },
    permissions: ['net.browser'],
    async execute(input) {
      await engine.click(str(input, 'pageId'), str(input, 'selector'));
      return { clicked: str(input, 'selector') };
    },
  };
  const screenshot: Tool = {
    name: 'browser.screenshot',
    description: 'Capture a PNG screenshot of an open page (base64)',
    inputSchema: { pageId: 'string' },
    permissions: ['net.browser'],
    async execute(input) {
      const shot = await engine.screenshot(str(input, 'pageId'));
      return shot as unknown as JsonValue;
    },
  };
  return [fetch, open, read, click, screenshot];
}
