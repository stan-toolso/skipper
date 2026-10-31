import type { Project } from '../projects/types.js';
import { runner } from '../runners/index.js';
import { HISTORY_LIMIT, terminalRepository } from './repository.js';
import { log } from '../log.js';

/**
 * Historique des commandes d'un terminal, par projet et par utilisateur : chargé dans le shell à l'ouverture
 * (fichier d'historique et rcfile écrits dans le conteneur), relu toutes les 30 secondes et à la fermeture,
 * les lignes nouvelles étant ajoutées en base. Le shell retrouve ainsi ↑ et Ctrl+R d'un terminal à l'autre.
 */

export const FLUSH_INTERVAL_MS = 30_000;

export interface HistoryFiles {
  dir: string;
  histfile: string;
  rcfile: string;
}

const bashrc = (histfile: string) => `# Écrit par Skipper : fichiers de démarrage de connexion, puis l'historique des commandes du projet.
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r ~/.bash_profile ]; then . ~/.bash_profile; elif [ -r ~/.bash_login ]; then . ~/.bash_login; elif [ -r ~/.profile ]; then . ~/.profile; fi
HISTFILE='${histfile}'
HISTSIZE=10000
HISTFILESIZE=-1
shopt -s histappend
PROMPT_COMMAND="history -a\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
`;

/** Suivi d'un terminal : décalage déjà enregistré dans le fichier d'historique. */
export class TerminalHistory {
  private offset = 0;
  private flushing: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly project: Project,
    private readonly projectId: string,
    private readonly userId: string,
    readonly files: HistoryFiles,
  ) {}

  /** Prépare les fichiers dans l'environnement du projet ; null si le runner ne sait pas écrire de fichiers. */
  static async prepare(project: Project, terminalId: string, userId: string): Promise<TerminalHistory | null> {
    const dir = `/tmp/skipper-term-${terminalId.slice(0, 8)}`;
    const files: HistoryFiles = { dir, histfile: `${dir}/history`, rcfile: `${dir}/bashrc` };
    const lines = await terminalRepository.history(project.id, userId);
    const seed = lines.length ? `${lines.join('\n')}\n` : '';
    try {
      await runner.putFile(project, files.histfile, seed);
      await runner.putFile(project, files.rcfile, bashrc(files.histfile));
    } catch (err) {
      log.warn(`[terminals] historique non chargé : ${(err as Error).message}`);
      return null;
    }
    const h = new TerminalHistory(project, project.id, userId, files);
    h.offset = Buffer.byteLength(seed, 'utf8');
    return h;
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Lit les lignes ajoutées depuis le dernier relevé et les enregistre (une lecture à la fois). */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const content = await runner.getFile(this.project, this.files.histfile).catch(() => null);
      if (content === null) return;
      const buf = Buffer.from(content, 'utf8');
      if (buf.length < this.offset) this.offset = 0; // fichier réécrit (history -w)
      const fresh = buf.subarray(this.offset).toString('utf8');
      const end = fresh.lastIndexOf('\n');
      if (end < 0) return;
      const complete = fresh.slice(0, end + 1);
      const lines = complete.split('\n').filter((l) => l.trim());
      if (lines.length) await terminalRepository.appendHistory(this.projectId, this.userId, lines.slice(-HISTORY_LIMIT));
      this.offset += Buffer.byteLength(complete, 'utf8');
    })()
      .catch((err) => log.warn(`[terminals] historique non enregistré : ${(err as Error).message}`))
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  /** Dernier relevé puis suppression des fichiers (fermeture du shell). */
  async dispose(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    await runner.removePath(this.project, this.files.dir).catch(() => undefined);
  }
}
