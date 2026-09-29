import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { RunningHandle, RunResult } from './provider.js';

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Appelé pour chaque ligne de stdout. */
  onStdout: (line: string) => void | Promise<void>;
  /** Appelé pour chaque ligne de stderr. */
  onStderr: (line: string) => void | Promise<void>;
  /** Contenu écrit sur stdin au démarrage, si fourni. */
  stdin?: string;
  /** Si true, stdin reste ouvert : `sendMessage` y écrit une ligne, `end` le ferme. */
  interactive?: boolean;
}

/**
 * Utilitaire commun aux providers basés sur un processus fils :
 * lance la commande, lit stdout/stderr ligne par ligne et expose une poignée wait/stop.
 */
export function spawnProcess(opts: SpawnOptions): RunningHandle {
  const child: ChildProcess = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (opts.stdin !== undefined) child.stdin?.write(opts.stdin);
  if (!opts.interactive) child.stdin?.end();

  // Sérialise les callbacks pour préserver l'ordre des événements persistés.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => void | Promise<void>) => {
    chain = chain.then(fn).catch((err) => console.error('[process] callback error', err));
  };

  const stdoutDone = new Promise<void>((resolve) => {
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => enqueue(() => opts.onStdout(line)));
    rl.on('close', resolve);
  });
  const stderrDone = new Promise<void>((resolve) => {
    const rl = createInterface({ input: child.stderr! });
    rl.on('line', (line) => enqueue(() => opts.onStderr(line)));
    rl.on('close', resolve);
  });

  let stopped = false;
  const exited = new Promise<RunResult>((resolve) => {
    child.on('error', (err) => resolve({ exitCode: null, error: err.message }));
    child.on('close', (code, signal) => {
      resolve({
        exitCode: code,
        error: stopped ? undefined : signal ? `Processus terminé par le signal ${signal}` : undefined,
      });
    });
  });

  const alive = () => child.exitCode === null && child.signalCode === null;

  return {
    async wait() {
      const result = await exited;
      await Promise.all([stdoutDone, stderrDone]);
      await chain;
      return result;
    },
    async stop() {
      if (!alive()) return;
      stopped = true;
      child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (alive()) child.kill('SIGKILL');
      }, 5000);
      await exited;
      clearTimeout(timer);
    },
    ...(opts.interactive
      ? {
          async sendMessage(text: string) {
            if (!alive() || !child.stdin?.writable) throw new Error("Le processus n'accepte plus d'entrée");
            child.stdin.write(text.endsWith('\n') ? text : `${text}\n`);
          },
          async end() {
            child.stdin?.end();
          },
        }
      : {}),
  };
}
