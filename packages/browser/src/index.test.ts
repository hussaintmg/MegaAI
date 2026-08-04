import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserEngine, createBrowserTools, SimulatedDriver } from './index.js';

test('simulated driver opens deterministic pages and reads them', async () => {
  const driver = new SimulatedDriver();
  const page = await driver.open('https://example.com/docs');
  assert.match(page.title, /example\.com/);
  const text = await driver.readText(page.id);
  assert.match(text, /simulated content for https:\/\/example\.com\/docs/);
  await driver.click(page.id, 'button.buy');
  const shot = await driver.screenshot(page.id);
  assert.equal(shot.format, 'png');
  assert.ok(shot.base64.length > 0);
  await driver.close(page.id);
  await assert.rejects(driver.readText(page.id), /No open page/);
});

test('engine enforces the host allowlist for real navigation', async () => {
  const engine = new BrowserEngine({ allowedHosts: ['example.com'], preferReal: true, driver: new SimulatedDriver() });
  // Allowlisted host is fine.
  const page = await engine.open('https://docs.example.com/x');
  assert.ok(page.id);
  // Off-allowlist host is refused.
  await assert.rejects(engine.open('https://evil.test/steal'), /not on the browser allowlist/);
});

test('simulator (preferReal=false) tolerates non-http targets', async () => {
  const engine = new BrowserEngine({ allowedHosts: [], preferReal: false });
  const page = await engine.open('about:task');
  assert.equal(page.url, 'about:task');
  assert.equal(engine.driverName(), 'simulated');
});

test('browser.fetch tool opens, reads and closes in one action', async () => {
  const engine = new BrowserEngine({ allowedHosts: ['example.com'], driver: new SimulatedDriver() });
  const [fetch] = createBrowserTools(engine);
  const result = (await fetch!.execute({ url: 'https://example.com' }, { workspaceRoot: '/tmp' })) as {
    url: string;
    title: string;
    text: string;
  };
  assert.equal(result.url, 'https://example.com');
  assert.match(result.text, /simulated content/);
});

test('browser tools carry the net.browser permission', () => {
  const tools = createBrowserTools(new BrowserEngine());
  for (const tool of tools) assert.deepEqual(tool.permissions, ['net.browser']);
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['browser.click', 'browser.fetch', 'browser.open', 'browser.read', 'browser.screenshot'],
  );
});
