/**
 * Chromium discovery + launch, used by the real-browser vision driver.
 *
 * Uses `playwright-core` (an optional dependency) against an already-present
 * Chromium via `executablePath`, so no version-tied browser download is
 * needed — matching the environment where a Chromium build is pre-installed.
 * Everything degrades to `undefined` (→ the static driver) when the browser
 * or the driver package isn't available.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal shape of the bits of a Playwright browser/page we use. */
export interface LaunchedBrowser {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
  executablePath: string;
}

export interface PwPage {
  goto(url: string, options?: Record<string, unknown>): Promise<unknown>;
  setContent(html: string, options?: Record<string, unknown>): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  title(): Promise<string>;
  evaluate<T>(fn: string | ((...args: unknown[]) => T), arg?: unknown): Promise<T>;
  screenshot(options?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string, options?: Record<string, unknown>): Promise<void>;
  fill(selector: string, value: string, options?: Record<string, unknown>): Promise<void>;
  on(event: string, handler: (arg: unknown) => void): void;
  close(): Promise<void>;
}

/** Locate a usable Chromium executable, or undefined. */
export function discoverChromium(): string | undefined {
  const override = process.env.MEGAAI_CHROMIUM_PATH;
  if (override && existsSync(override)) return override;

  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(base);
    } catch {
      entries = [];
    }
    // Prefer a full chromium build, then the lighter headless shell.
    const candidates = [
      ...entries
        .filter((e) => e.startsWith('chromium-'))
        .map((e) => join(base, e, 'chrome-linux', 'chrome')),
      ...entries
        .filter((e) => e.startsWith('chromium_headless_shell'))
        .map((e) => join(base, e, 'chrome-linux', 'headless_shell')),
    ];
    for (const path of candidates) if (existsSync(path)) return path;
  }

  for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

let cachedUnavailable = false;

/** Launch a headless Chromium, or undefined when unavailable. */
export async function launchChromium(): Promise<LaunchedBrowser | undefined> {
  if (cachedUnavailable) return undefined;
  const executablePath = discoverChromium();
  if (!executablePath) return undefined;
  try {
    const moduleName = 'playwright-core';
    const mod = (await import(moduleName)) as {
      chromium?: { launch(opts: Record<string, unknown>): Promise<LaunchedBrowser> };
    };
    if (!mod.chromium) {
      cachedUnavailable = true;
      return undefined;
    }
    const browser = await mod.chromium.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    // Attach the path for observability.
    (browser as LaunchedBrowser).executablePath = executablePath;
    return browser;
  } catch {
    cachedUnavailable = true;
    return undefined;
  }
}
