import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { LAZY_BROWSER_MCP, parseDevToolsActivePort, START_CHROMIUM } from './browserLauncher.js';

describe('parseDevToolsActivePort', () => {
  it('lit le port et le chemin du navigateur', () => {
    expect(parseDevToolsActivePort('41237\n/devtools/browser/abc-123')).toEqual({ port: 41237, browserPath: '/devtools/browser/abc-123' });
  });
  it('fichier incomplet ou vide : null', () => {
    expect(parseDevToolsActivePort('41237')).toBeNull();
    expect(parseDevToolsActivePort('')).toBeNull();
    expect(parseDevToolsActivePort('x\n/devtools/browser/a')).toBeNull();
  });
});

const hasBrowser = (() => {
  try {
    return readdirSync('/opt/ms-playwright').some((d) => d.startsWith('chromium_headless_shell-')) && execFileSync('sh', ['-c', 'command -v playwright-mcp'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
})();

// Le relais tel que le lance le CLI d'une session, Chromium et playwright-mcp de la machine du test (comme dans l'image skipper-runner).
describe.skipIf(!hasBrowser)('relais du navigateur (Chromium lancé au premier usage)', () => {
  const dir = `/tmp/skipper-lazy-browser-test-${process.pid}`;
  const pidFile = `${dir}/chromium.pid`;
  const portFile = `${dir}/profile/DevToolsActivePort`;
  let client: Client | null = null;

  afterEach(async () => {
    await client?.close().catch(() => undefined);
    client = null;
    const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
    if (pid) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* déjà arrêté */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('répond à tools/list sans lancer Chromium, puis le lance au premier outil', async () => {
    rmSync(dir, { recursive: true, force: true });
    const transport = new StdioClientTransport({ command: 'node', args: ['-e', LAZY_BROWSER_MCP, dir, START_CHROMIUM, '--output-dir', `${dir}/out`], stderr: 'pipe' });
    client = new Client({ name: 'skipper-lazy-browser-test', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('browser_navigate');
    // Aucun Chromium tant que l'agent n'a pas appelé d'outil du navigateur.
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(pidFile)).toBe(false);

    const result = await client.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<h1>Skipper</h1>' } });
    expect(result.isError).toBeFalsy();
    expect(existsSync(pidFile)).toBe(true);
    expect(parseDevToolsActivePort(readFileSync(portFile, 'utf8'))).not.toBeNull();

    // Chromium arrêté (plantage) : relancé au prochain outil.
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
    for (let i = 0; i < 50 && existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(portFile)).toBe(false);
    const again = await client.callTool({ name: 'browser_navigate', arguments: { url: 'data:text/html,<h1>Encore</h1>' } });
    expect(again.isError).toBeFalsy();
    expect(existsSync(portFile)).toBe(true);
  }, 90_000);
});
