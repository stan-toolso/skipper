import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Le niveau initial vient de LOG_LEVEL lu à l'import de config.ts : on fixe l'environnement puis on réimporte.
async function loadLog(level?: string) {
  vi.resetModules();
  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  const mod = await import('./log.js');
  const out: string[] = [];
  const err: string[] = [];
  mod.logOutput.stdout = (line) => void out.push(line);
  mod.logOutput.stderr = (line) => void err.push(line);
  return { ...mod, out, err };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

describe('journal', () => {
  afterEach(() => {
    delete process.env.LOG_LEVEL;
  });

  it('écrit une ligne horodatée avec le niveau, info sur stdout et warn/error sur stderr', async () => {
    const { log, out, err } = await loadLog();
    log.info('[sessions] 3 session(s) relancée(s)');
    log.warn('[git] attention');
    log.error('[http] cassé');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(ISO);
    expect(out[0]).toMatch(/Z INFO  \[sessions\] 3 session\(s\) relancée\(s\)$/);
    expect(err).toEqual([expect.stringMatching(/Z WARN  \[git\] attention$/), expect.stringMatching(/Z ERROR \[http\] cassé$/)]);
  });

  it('tait les niveaux sous LOG_LEVEL et refuse une valeur inconnue', async () => {
    const warnOnly = await loadLog('warn');
    expect(warnOnly.getLogLevel()).toBe('warn');
    warnOnly.log.debug('non');
    warnOnly.log.info('non');
    warnOnly.log.warn('oui');
    expect(warnOnly.out).toEqual([]);
    expect(warnOnly.err).toHaveLength(1);

    const debug = await loadLog('DEBUG');
    debug.log.debug('détail');
    expect(debug.out).toEqual([expect.stringContaining('DEBUG détail')]);
    debug.setLogLevel('error');
    debug.log.warn('tu');
    expect(debug.err).toEqual([]);

    await expect(loadLog('verbose')).rejects.toThrow(/LOG_LEVEL invalide : verbose/);
  });

  it('formate une erreur sur une ligne, avec sa trace seulement au niveau error', async () => {
    const { log, err, formatLine } = await loadLog();
    const boom = new Error('disque plein');
    log.warn('[files]', boom);
    expect(err).toHaveLength(1);
    expect(err[0]).not.toContain('\n');
    expect(err[0]).toMatch(/WARN  \[files\] Error : disque plein$/);

    log.error('[files]', boom);
    const lines = err[1].split('\n');
    expect(lines[0]).toMatch(/ERROR \[files\] Error : disque plein$/);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[1]).toMatch(/^\s+at /);

    // Un objet quelconque tient sur une ligne, même imbriqué.
    const line = formatLine('info', ['[x]', { a: 1, b: { c: [1, 2, 3] } }], new Date('2026-10-10T08:00:00.000Z'));
    expect(line).toBe('2026-10-10T08:00:00.000Z INFO  [x] { a: 1, b: { c: [ 1, 2, 3 ] } }');
  });

  it("préfixe les messages d'un journal de module", async () => {
    const { createLogger, out } = await loadLog();
    createLogger('git').info('fetch terminé', 3);
    expect(out[0]).toMatch(/INFO  \[git\] fetch terminé 3$/);
  });
});

describe('avertissements Node', () => {
  const listeners = process.listeners('warning');
  beforeEach(() => {
    process.removeAllListeners('warning');
  });
  afterEach(() => {
    process.removeAllListeners('warning');
    for (const l of listeners) process.on('warning', l);
  });

  const flush = () => new Promise((r) => setTimeout(r, 10));

  it("journalise une fois l'avertissement attendu du SDK Claude, en info, et les autres en warn sur une ligne", async () => {
    const { captureProcessWarnings, out, err } = await loadLog();
    captureProcessWarnings();
    process.emitWarning('canUseTool will not be invoked for: mcp__context', { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
    process.emitWarning("canUseTool will not be invoked: permissionMode 'bypassPermissions'", { code: 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED' });
    process.emitWarning('Buffer() is deprecated', 'DeprecationWarning', 'DEP0005');
    await flush();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/INFO  \[node\] avertissement attendu du SDK Claude \(CLAUDE_SDK_CAN_USE_TOOL_SHADOWED, affiché une seule fois\) : canUseTool will not be invoked for: mcp__context$/);
    expect(err).toEqual([expect.stringMatching(/WARN  \[node\] DeprecationWarning \(DEP0005\) : Buffer\(\) is deprecated$/)]);
    // Le gestionnaire par défaut de Node (trace et conseil --trace-warnings sur stderr) est remplacé.
    expect(process.listenerCount('warning')).toBe(1);
  });
});
