export interface ClaudeProcess {
  pid: number;
  rssMb: number;
  /** Durée de vie du processus, en secondes. */
  elapsedSeconds: number;
}

/**
 * Processus du CLI Claude Code (ceux des conteneurs sont visibles depuis l'hôte). Les relais
 * `docker exec … claude` et le CLI de connexion du compte sont exclus : seul le processus de l'agent compte.
 */
export function parseClaudeProcesses(psOutput: string): ClaudeProcess[] {
  const result: ClaudeProcess[] = [];
  for (const raw of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(raw);
    if (!m) continue;
    const args = m[4];
    const [argv0 = '', argv1 = ''] = args.split(/\s+/);
    if (/(^|\/)(docker|sudo|bash|sh|dash)$/.test(argv0) || args.includes('/.runners/')) continue;
    // Binaire `claude` (natif, ou script lancé par node), ou CLI JavaScript du SDK.
    const isClaude = [argv0, argv1].some((t) => /(^|\/)claude(\.exe)?$/.test(t) || /claude-(code|agent-sdk)\/(cli\.js|bin\/claude)/.test(t));
    if (!isClaude || /\sauth\s/.test(` ${args} `)) continue;
    result.push({ pid: Number(m[1]), rssMb: Math.round(Number(m[2]) / 1024), elapsedSeconds: Number(m[3]) });
  }
  return result;
}
