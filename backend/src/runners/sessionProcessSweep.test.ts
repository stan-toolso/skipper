import { execFileSync, spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GRACE_MS, KILL_SCRIPT, LIST_SCRIPT, parseSessionProcesses, processesToStop, type SessionState } from './sessionProcessSweep.js';

const A = '07996ba6-714a-4b18-96ba-e62c14f88fa0';
const B = '48f82e20-8c2f-4952-b4e5-d3a9f72b28c8';
const C = 'a01bd395-af77-44b5-9180-d493feeb558b';

describe('parseSessionProcesses', () => {
  it('lit pid, session, marque à garder et commande', () => {
    const out = `263802 ${A} 0 node index.js \n11817 ${C} 1 node /tmp/pgtest/server-ci.mjs\n1 ${A} 0 /sbin/docker-init\nbruit\n12 pas-un-uuid 0 x`;
    expect(parseSessionProcesses(out)).toEqual([
      { pid: 263802, sessionId: A, keepAlive: false, command: 'node index.js' },
      { pid: 11817, sessionId: C, keepAlive: true, command: 'node /tmp/pgtest/server-ci.mjs' },
    ]);
  });
});

describe('processesToStop', () => {
  const now = Date.parse('2026-11-25T23:00:00Z');
  const proc = (pid: number, sessionId: string, keepAlive = false) => ({ pid, sessionId, keepAlive, command: 'node' });
  const ended = (ago: number, status = 'completed'): SessionState => ({ status, endedAt: new Date(now - ago) });

  it('session finie depuis plus du délai de grâce, ou supprimée : arrêtés', () => {
    const sessions = new Map<string, SessionState>([[A, ended(GRACE_MS + 1000, 'stopped')], [B, ended(3600_000, 'failed')]]);
    expect(processesToStop([proc(1, A), proc(2, B), proc(3, C)], sessions, now).map((p) => p.pid)).toEqual([1, 2, 3]);
  });

  it('session en cours, interrompue, en file ou à peine finie : gardés', () => {
    const sessions = new Map<string, SessionState>([
      [A, { status: 'running', endedAt: null }],
      [B, ended(3600_000, 'interrupted')],
      [C, ended(GRACE_MS - 1000)],
    ]);
    expect(processesToStop([proc(1, A), proc(2, B), proc(3, C)], sessions, now)).toEqual([]);
  });

  it('SKIPPER_KEEP_ALIVE=1 : épargné même session supprimée', () => {
    expect(processesToStop([proc(1, A, true)], new Map(), now)).toEqual([]);
  });

  it('session finie sans date de fin : gardés (rien pour mesurer le délai)', () => {
    expect(processesToStop([proc(1, A)], new Map([[A, { status: 'completed', endedAt: null }]]), now)).toEqual([]);
  });
});

// Scripts réels sur la machine du test (sh, /proc) : un processus « laissé » par une session, un autre marqué à garder.
describe.skipIf(process.platform !== 'linux')('scripts de liste et d’arrêt', () => {
  it('retrouve les processus par leur variable de session, puis les arrête', async () => {
    const left = spawn('sleep', ['60'], { env: { ...process.env, SKIPPER_SESSION_ID: A }, stdio: 'ignore' });
    const kept = spawn('sleep', ['60'], { env: { ...process.env, SKIPPER_SESSION_ID: B, SKIPPER_KEEP_ALIVE: '1' }, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const listed = parseSessionProcesses(execFileSync('sh', ['-c', LIST_SCRIPT], { encoding: 'utf8' }));
      expect(listed).toContainEqual({ pid: left.pid, sessionId: A, keepAlive: false, command: 'sleep 60' });
      expect(listed).toContainEqual({ pid: kept.pid, sessionId: B, keepAlive: true, command: 'sleep 60' });
      const exited = new Promise((r) => left.once('exit', r));
      execFileSync('sh', ['-c', KILL_SCRIPT, 'sh', String(left.pid)]);
      await exited;
      expect(left.signalCode).toBe('SIGTERM');
      expect(kept.exitCode).toBeNull();
    } finally {
      left.kill('SIGKILL');
      kept.kill('SIGKILL');
    }
  });
});
