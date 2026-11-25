import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../projects/types.js';

// Contrôle de bout en bout : le « conteneur » est la machine du test (Chromium de /opt/ms-playwright et
// playwright-mcp dans le PATH, comme dans l'image skipper-runner). Ignoré quand ils n'y sont pas.
vi.mock('../runners/index.js', async () => {
  const { LAZY_BROWSER_MCP, START_CHROMIUM, parseDevToolsActivePort } = await import('../runners/browserLauncher.js');
  const run = (script: string) => {
    try {
      return { stdout: execFileSync('sh', ['-c', script], { encoding: 'utf8' }), code: 0 };
    } catch (err) {
      return { stdout: String((err as { stdout?: string }).stdout ?? ''), code: 1 };
    }
  };
  return {
    runner: {
      ensureReady: async () => ({ image: 'local', ready: true }),
      status: async () => ({ image: 'local', ready: true }),
      exec: async (_p: unknown, command: string[]) => run(command[2]),
      shellCommand: async (_p: unknown, _cwd: string, _shell: string, script: string) => ({ command: 'sh', args: ['-c', script] }),
      // Même commande que celle du runner Docker (relais qui lance Chromium au premier outil), sans conteneur.
      browserMcpCommand: async (_p: unknown, cwd: string, opts: { sessionId: string }) => {
        const dir = `/tmp/skipper-check-test-${opts.sessionId}`;
        const portFile = `${dir}/profile/DevToolsActivePort`;
        return {
          command: 'node',
          args: ['-e', LAZY_BROWSER_MCP, dir, START_CHROMIUM, '--output-dir', `${cwd}/.playwright-mcp`],
          cdp: async () => (existsSync(portFile) ? parseDevToolsActivePort(readFileSync(portFile, 'utf8')) : null),
          dispose: async () => {
            const pid = existsSync(`${dir}/chromium.pid`) ? Number(readFileSync(`${dir}/chromium.pid`, 'utf8')) : 0;
            if (pid) {
              try {
                process.kill(pid);
              } catch {
                /* déjà arrêté */
              }
              for (let i = 0; i < 50; i++) {
                try {
                  process.kill(pid, 0);
                  await new Promise((r) => setTimeout(r, 100));
                } catch {
                  break;
                }
              }
            }
            rmSync(dir, { recursive: true, force: true });
          },
        };
      },
    },
  };
});

const { BROWSER_FIELD_READERS, browserPrompt, checkBrowser, parseProbe, probeProblems } = await import('./check.js');

const MB = 1024 * 1024;
const probeOutput = (over: Record<string, string> = {}) =>
  Object.entries({
    arch: 'aarch64',
    chromium: '/opt/ms-playwright/chromium_headless_shell-1247/chrome-headless-shell-linux-arm64/chrome-headless-shell',
    chromiumVersion: 'Google Chrome for Testing 156.0.7000.0',
    browsers: 'chromium-1247 chromium_headless_shell-1247 ffmpeg-1013 ',
    mcp: '/usr/local/bin/playwright-mcp',
    mcpVersion: 'Version 0.0.84',
    memMax: String(1536 * MB),
    memCurrent: String(536 * MB),
    memAvailableKb: String(8 * 1024 * 1024),
    ...over,
  })
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');

describe('parseProbe', () => {
  it('lit le relevé du conteneur', () => {
    const p = parseProbe(probeOutput());
    expect(p).toMatchObject({ arch: 'aarch64', chromiumVersion: 'Google Chrome for Testing 156.0.7000.0', mcpVersion: 'Version 0.0.84', memoryLimitMb: 1536, memoryUsedMb: 536, memoryAvailableMb: 1000 });
    expect(p.browsers).toEqual(['chromium-1247', 'chromium_headless_shell-1247', 'ffmpeg-1013']);
  });

  it('conteneur sans limite mémoire : la mémoire libre de l’hôte', () => {
    const p = parseProbe(probeOutput({ memMax: 'max', memAvailableKb: String(700 * 1024) }));
    expect(p.memoryLimitMb).toBeNull();
    expect(p.memoryAvailableMb).toBe(700);
  });

  it('valeurs vides : null', () => {
    const p = parseProbe(probeOutput({ chromium: '', mcp: '', chromiumVersion: '', browsers: '' }));
    expect(p.chromiumPath).toBeNull();
    expect(p.mcpPath).toBeNull();
    expect(p.browsers).toEqual([]);
  });
});

describe('probeProblems', () => {
  it('aucun problème quand tout est là', () => {
    expect(probeProblems(parseProbe(probeOutput()), 'skipper-runner:latest')).toEqual([]);
  });

  it('image à reconstruire : Chromium ou playwright-mcp absents', () => {
    const problems = probeProblems(parseProbe(probeOutput({ chromium: '', mcp: '', browsers: 'chromium-1247' })), 'skipper-runner:latest');
    expect(problems.map((p) => [p.level, p.code])).toEqual([
      ['error', 'mcp_missing'],
      ['error', 'chromium_missing'],
    ]);
    expect(problems[1].message).toContain('chromium-1247');
    expect(problems[1].message).toContain('reconstruire l\'image skipper-runner:latest');
  });

  it('mémoire insuffisante : avertissement', () => {
    const problems = probeProblems(parseProbe(probeOutput({ memCurrent: String(1300 * MB) })), null);
    expect(problems).toEqual([expect.objectContaining({ level: 'warning', code: 'low_memory' })]);
    expect(problems[0].message).toContain('236 Mo disponibles sur une limite de 1536 Mo');
  });
});

describe('browserPrompt', () => {
  it('nomme le serveur MCP et interdit d’installer Chromium', () => {
    const text = browserPrompt({ prefix: 'mcp__playwright__', fill: 'browser_fill' });
    expect(text).toContain('serveur MCP `playwright`');
    expect(text).toContain('`mcp__playwright__browser_navigate`');
    expect(text).toContain('npx playwright install');
  });

  it('navigateur indisponible : la raison, et ne pas chercher à le réparer', () => {
    const text = browserPrompt({ prefix: 'playwright_', fill: 'vault_browser_fill', unavailable: 'Chromium introuvable.' });
    expect(text).toContain("n'a pas pu démarrer pour cette session : Chromium introuvable.");
    expect(text).toContain("n'essaie jamais de les installer");
  });

  it('retire aussi browser_run_code_unsafe quand le coffre saisit des secrets', () => {
    expect(BROWSER_FIELD_READERS).toContain('browser_run_code_unsafe');
  });
});

const hasBrowser = (() => {
  try {
    return readdirSync('/opt/ms-playwright').some((d) => d.startsWith('chromium_headless_shell-')) && execFileSync('sh', ['-c', 'command -v playwright-mcp'], { encoding: 'utf8' }).trim() !== '';
  } catch {
    return false;
  }
})();

describe.skipIf(!hasBrowser)('checkBrowser (Chromium et playwright-mcp locaux)', () => {
  it('ouvre une page locale et en renvoie la capture', async () => {
    const result = await checkBrowser({ id: 'p', runnerConfig: { browser: true } } as unknown as Project);
    expect(result.steps.filter((s) => !s.ok)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.enabled).toBe(true);
    expect(result.probe?.chromiumVersion).toMatch(/Chrom/);
    expect(result.screenshot).toMatch(/^data:image\/png;base64,/);
  }, 90_000);
});
