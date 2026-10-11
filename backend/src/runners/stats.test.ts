import { describe, expect, it } from 'vitest';
import { parseContainerStats, parseDockerSize } from './stats.js';

const sample = [
  'cpu 1000000 1000000000 1250000 1500000000',
  'memory.current 1610612736',
  'memory.max 2147483648',
  'inactive_file 536870912',
  'memory.swap.current 104857600',
  'cpu.max 200000 100000',
  'oom_kill 3',
  'session 101 aaaa-1111 /w/projet.worktrees/branche',
  'session 150 aaaa-1111 /w/projet.worktrees/branche',
  'session 151 aaaa-1111 /w/projet.worktrees/branche',
  'session 102 bbbb-2222 /w/projet',
  'ps',
  '    1     1000  9000 /sbin/docker-init -- sleep infinity',
  '  101   307200  3600 claude --output-format stream-json --verbose',
  '  150   102400    60 node node_modules/typescript/lib/tsc.js --noEmit',
  '  151     2048    60 /bin/bash -c npm run typecheck',
  '  102   256000   120 claude --output-format stream-json --verbose',
  '  103   204800    30 claude',
].join('\n');

describe('mesure du conteneur', () => {
  it('lit mémoire, CPU, OOM et rattache les processus Claude à leur session', () => {
    const stats = parseContainerStats(sample, new Date(0));
    expect(stats).toMatchObject({
      // 1,5 Go moins 512 Mo de cache inactif.
      memoryUsedMb: 1024,
      memoryLimitMb: 2048,
      memoryPercent: 50,
      swapUsedMb: 100,
      // 0,25 s de CPU en 0,5 s.
      cpuPercent: 50,
      cpuLimit: 2,
      oomKills: 3,
    });
    expect(stats.claudeProcesses).toEqual([
      { pid: 101, rssMb: 300, elapsedSeconds: 3600, sessionId: 'aaaa-1111', childrenRssMb: 102, cwd: '/w/projet.worktrees/branche' },
      { pid: 102, rssMb: 250, elapsedSeconds: 120, sessionId: 'bbbb-2222', childrenRssMb: 0, cwd: '/w/projet' },
      { pid: 103, rssMb: 200, elapsedSeconds: 30, sessionId: null, childrenRssMb: 0, cwd: null },
    ]);
  });

  it('accepte un conteneur sans limite ni mesure CPU', () => {
    const stats = parseContainerStats('memory.current 1048576\nmemory.max max\ncpu.max max 100000\noom_kill\nps\n');
    expect(stats).toMatchObject({ memoryUsedMb: 1, memoryLimitMb: null, memoryPercent: null, cpuPercent: null, cpuLimit: null, oomKills: 0, claudeProcesses: [] });
  });

  it('convertit les tailles Docker', () => {
    expect(parseDockerSize('2g')).toBe(2 * 1024 ** 3);
    expect(parseDockerSize('1500m')).toBe(1500 * 1024 ** 2);
    expect(parseDockerSize('1.5G')).toBe(1.5 * 1024 ** 3);
    expect(parseDockerSize('768mb')).toBe(768 * 1024 ** 2);
    expect(parseDockerSize('beaucoup')).toBeNull();
  });
});
