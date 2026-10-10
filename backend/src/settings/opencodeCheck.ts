import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { AppError } from '../errors.js';

const execFileAsync = promisify(execFile);

/**
 * Modèles qu'OpenCode offre avec les clés d'une personne (`opencode models`), exécuté dans un conteneur
 * jetable de l'image des environnements de projet (l'image embarque OpenCode) : rien ne tourne sur le
 * serveur et rien de la personne n'y reste.
 */
export async function listOpencodeModels(auth: Record<string, unknown>): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['run', '--rm', '--network', 'bridge', '-e', 'OPENCODE_AUTH_CONTENT', '-e', 'OPENCODE_DISABLE_AUTOUPDATE=1', '-e', 'HOME=/tmp/home', config.runnerImage, 'opencode', 'models'],
      { env: { ...process.env, OPENCODE_AUTH_CONTENT: JSON.stringify(auth) }, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[a-z0-9][a-z0-9._-]*\/\S+$/i.test(l));
  } catch (err) {
    const e = err as { code?: string | number; stderr?: string; message: string };
    if (e.code === 'ENOENT') throw new AppError("Docker n'est pas installé sur le serveur (commande docker introuvable)");
    const tail = (e.stderr || e.message).trim().split('\n').slice(-2).join(' ');
    if (/executable file not found|not found/i.test(tail)) throw new AppError("OpenCode n'est pas installé dans l'image des environnements : reconstruisez l'image skipper-runner");
    throw new AppError(`opencode models a échoué : ${tail}`);
  }
}
