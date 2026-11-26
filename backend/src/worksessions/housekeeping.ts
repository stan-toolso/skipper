import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { envFileRepository } from '../envFiles/repository.js';
import { log } from '../log.js';
import { projectRepository } from '../projects/repository.js';
import type { Project } from '../projects/types.js';
import { git, isGitRepository, workspacePath } from '../projects/workspace.js';
import { forgetSize, gitState } from './disk.js';
import { worksessionRepository } from './repository.js';
import { projectService } from '../projects/service.js';
import { defaultStartPoint, worksessionPath, worksessionService } from './service.js';
import type { Worksession } from './types.js';

/**
 * Retrait des dossiers archivés (tâche périodique de l'instance meneuse). Chaque session a son dossier de travail, et
 * l'archivage le gardait pour toujours : 575 dossiers pour Curso en un mois, dont 553 sans un commit ni une modification.
 * Quelques jours après l'archivage, le dossier d'une work session est supprimé du disque s'il n'a rien d'unique :
 * aucune modification non commitée, aucun commit qui ne soit dans la branche principale ou sur origin, aucun fichier
 * ignoré par git qui ne se régénère pas. L'enregistrement reste archivé (transcript, coût, liens de tâche) et la branche
 * locale reste, sauf si elle n'a rien de plus que la branche principale ; restaurer la session recrée le dossier
 * (`worksessionService.ensureDir` : branche locale, sinon distante, sinon depuis la branche principale, dépendances liées,
 * fichiers d'environnement écrits).
 */

/** Délai après l'archivage avant de retirer le dossier (jours) : le temps de revenir sur une session sans attendre. */
export const PURGE_AFTER_DAYS = 3;
const PURGE_INTERVAL_MS = 60 * 60_000;
const FIRST_RUN_DELAY_MS = 5 * 60_000;

/** Dossiers ignorés par git qui se reconstituent tout seuls (dépendances, builds, caches, état d'exécution). */
const REGENERABLE = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', 'coverage', '.turbo', '.cache', '.vite', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'venv', '.tox', 'target', 'vendor',
  'var', 'tmp', '.tmp', 'log', 'logs',
]);
const REGENERABLE_FILES = [/\.tsbuildinfo$/, /\.pyc$/, /(^|\/)\.DS_Store$/, /(^|\/)\._/, /\.log$/, /(^|\/)\.claude\/settings\.local\.json$/];

/**
 * Fichiers ignorés par git qu'on perdrait en supprimant le dossier : ceux qui ne sont ni régénérables ni des fichiers
 * d'environnement du projet (réécrits à la recréation). Chemins de `git ls-files -o -i --directory` (dossiers en `x/`).
 */
export function precious(ignored: string[], envPaths: string[]): string[] {
  const env = new Set(envPaths.map((p) => p.replace(/^\.?\//, '')));
  return ignored.filter((p) => {
    const clean = p.replace(/\/$/, '');
    if (env.has(clean)) return false;
    if (clean.split('/').some((seg) => REGENERABLE.has(seg))) return false;
    return !REGENERABLE_FILES.some((re) => re.test(clean));
  });
}

/**
 * `git ls-files --directory` résume par `front/` un dossier non suivi dont tout est ignoré (`front/.env.local` seul) :
 * les dossiers jugés précieux sont parcourus pour n'en garder que les fichiers qui le sont vraiment (au plus `limit`).
 */
async function expandPrecious(root: string, entries: string[], envPaths: string[], limit = 20): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    if (out.length >= limit) return;
    const list = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => null);
    if (!list) {
      out.push(`${rel}/`);
      return;
    }
    for (const e of list) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (precious([`${child}/`], envPaths).length) await walk(child);
      } else if (precious([child], envPaths).length) out.push(child);
      if (out.length >= limit) return;
    }
  };
  for (const entry of entries) {
    if (entry.endsWith('/')) await walk(entry.replace(/\/$/, ''));
    else out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** Le dossier d'une work session archivée peut-il être retiré du disque sans rien perdre ? null : oui ; sinon pourquoi. */
export function assessPurge(s: { changes: number | null; aheadCount: number | null; unpushedCount: number | null; precious: string[] }): string | null {
  if (s.changes === null || s.aheadCount === null) return 'État git illisible';
  if (s.changes > 0) return `${s.changes} fichier(s) modifié(s) ou non suivi(s)`;
  if (s.aheadCount > 0 && s.unpushedCount !== 0) return s.unpushedCount === null ? 'Commits propres, branche absente d’origin' : `${s.unpushedCount} commit(s) absent(s) d’origin`;
  if (s.precious.length) return `Fichiers ignorés à garder : ${s.precious.slice(0, 3).join(', ')}${s.precious.length > 3 ? '…' : ''}`;
  return null;
}

export interface PurgeResult {
  removed: string[];
  kept: { name: string; reason: string }[];
}

interface FolderContext {
  main: string;
  base: string;
  envPaths: string[];
}

async function folderContext(project: Project): Promise<FolderContext | null> {
  const main = workspacePath(project);
  if (!project.gitUrl || !(await isGitRepository(main))) return null;
  return { main, base: await defaultStartPoint(main, project.gitBranch), envPaths: (await envFileRepository.listByProject(project.id)).map((f) => f.path) };
}

/** Ce que le dossier a d'unique (null : rien, il peut être supprimé) et son état git. */
async function folderVerdict(dir: string, ctx: FolderContext): Promise<{ reason: string | null; state: Awaited<ReturnType<typeof gitState>> }> {
  const state = await gitState(dir, ctx.base);
  const ignored = await git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], dir).then((out) => out.split('\n').filter(Boolean), () => null);
  const reason = ignored === null ? 'Fichiers ignorés illisibles' : assessPurge({ ...state, precious: await expandPrecious(dir, precious(ignored, ctx.envPaths), ctx.envPaths) });
  return { reason, state };
}

/** Supprime le dossier (worktree) ; la branche aussi si elle n'a rien de plus que la branche principale. */
async function removeFolder(dir: string, w: Worksession, state: Awaited<ReturnType<typeof gitState>>, ctx: FolderContext): Promise<void> {
  await git(['worktree', 'remove', '--force', dir], ctx.main).catch(() => rm(dir, { recursive: true, force: true }));
  // Branche sans rien de plus que la branche principale : la recréation repartira d'origin, inutile de la garder.
  if (state.aheadCount === 0 && state.branch === w.branch) await git(['branch', '-D', '--', w.branch], ctx.main).catch(() => undefined);
  forgetSize(dir);
}

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);

/** Réponse à « le dossier peut-il partir avec la session ? » : `reason` null si rien n'y serait perdu ; sinon pourquoi, et
 * `forcible` dit si la personne peut quand même choisir de le supprimer (travail unique qu'elle accepte de perdre) ou non
 * (autres sessions actives, dossier absent, projet sans git). */
export interface FolderRemovalCheck {
  reason: string | null;
  forcible: boolean;
}

/**
 * Le dossier d'une work session peut-il être supprimé avec elle sans rien perdre ? Posé avant d'archiver une session
 * (case « Supprimer aussi son dossier de travail », cochée seulement si rien n'y serait perdu). Ne regarde pas ce qui
 * tourne (l'archivage l'arrête) mais refuse si d'autres sessions actives que `exceptSessionId` y travaillent.
 */
export async function folderRemovalCheck(worksessionId: string, exceptSessionId: string | null = null): Promise<FolderRemovalCheck> {
  const blocked = (reason: string): FolderRemovalCheck => ({ reason, forcible: false });
  const w = await worksessionRepository.findById(worksessionId);
  if (!w) return blocked('Dossier de travail inconnu');
  const project = await projectService.get(w.projectId);
  const ctx = await folderContext(project);
  if (!ctx) return blocked('Projet sans dépôt git');
  const dir = worksessionPath(project, w);
  if (!(await isDir(dir))) return blocked('Dossier déjà absent du disque');
  const others = await worksessionRepository.countActiveSessions(worksessionId, exceptSessionId);
  if (others) return blocked(`${others} autre(s) session(s) active(s) y travaillent`);
  const { reason } = await folderVerdict(dir, ctx);
  return { reason, forcible: reason !== null };
}

/** Raccourci de `folderRemovalCheck` : null si le dossier peut partir sans rien perdre, sinon pourquoi. */
export async function folderRemovalBlocker(worksessionId: string, exceptSessionId: string | null = null): Promise<string | null> {
  return (await folderRemovalCheck(worksessionId, exceptSessionId)).reason;
}

/**
 * Supprime tout de suite le dossier d'une work session archivée, s'il n'a rien d'unique ; renvoie pourquoi il est gardé
 * sinon. `force` : la personne a choisi de le supprimer malgré tout (modifications non commitées et fichiers ignorés
 * perdus ; la branche locale et ses commits restent, la restauration recrée le dossier depuis elle).
 */
export async function removeArchivedFolderNow(worksessionId: string, opts: { force?: boolean } = {}): Promise<string | null> {
  const w = await worksessionRepository.findById(worksessionId);
  if (!w?.archivedAt) return "Le dossier n'est pas archivé : d'autres sessions y travaillent";
  await worksessionService.whenLightened(w.id);
  const project = await projectService.get(w.projectId);
  const ctx = await folderContext(project);
  if (!ctx) return 'Projet sans dépôt git';
  const dir = worksessionPath(project, w);
  if (!(await isDir(dir))) return null;
  const busy = await worksessionRepository.countBusy(w.id);
  if (busy.sessions || busy.terminals) return 'Une session ou un terminal y tourne encore';
  const { reason, state } = await folderVerdict(dir, ctx);
  if (reason && !opts.force) return reason;
  await removeFolder(dir, w, state, ctx);
  await git(['worktree', 'prune'], ctx.main).catch(() => undefined);
  log.info(`[worksessions] ${project.slug} : dossier de ${w.name} supprimé à l'archivage${reason ? ` malgré : ${reason}` : ''}`);
  return null;
}

/** Retire les dossiers des work sessions du projet archivées depuis plus de `afterDays` jours, quand rien n'y est unique. */
export async function purgeArchivedWorksessions(project: Project, afterDays = PURGE_AFTER_DAYS): Promise<PurgeResult> {
  const result: PurgeResult = { removed: [], kept: [] };
  const cutoff = Date.now() - afterDays * 86_400_000;
  const candidates = (await worksessionRepository.listByProject(project.id, { archived: 'only' })).filter((w) => w.archivedAt && w.archivedAt.getTime() < cutoff);
  if (!candidates.length) return result;
  const ctx = await folderContext(project);
  if (!ctx) return result;
  for (const w of candidates) {
    const dir = worksessionPath(project, w);
    if (!(await isDir(dir))) continue;
    // Relue juste avant : restaurée entre-temps, ou une session ou un terminal y a été rouvert.
    const current = await worksessionRepository.findById(w.id);
    if (!current?.archivedAt) continue;
    const busy = await worksessionRepository.countBusy(w.id);
    if (busy.sessions || busy.terminals) continue;
    try {
      const { reason, state } = await folderVerdict(dir, ctx);
      if (reason) {
        result.kept.push({ name: w.name, reason });
        continue;
      }
      await removeFolder(dir, w, state, ctx);
      result.removed.push(w.name);
    } catch (err) {
      result.kept.push({ name: w.name, reason: (err as Error).message });
    }
  }
  await git(['worktree', 'prune'], ctx.main).catch(() => undefined);
  if (result.removed.length) log.info(`[worksessions] ${project.slug} : ${result.removed.length} dossier(s) archivé(s) retiré(s) du disque (${result.removed.join(', ')})`);
  return result;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

async function purgeAll(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (const project of await projectRepository.list()) {
      await purgeArchivedWorksessions(project).catch((err) => log.warn(`[worksessions] retrait des dossiers archivés de ${project.slug} : ${(err as Error).message}`));
    }
  } finally {
    running = false;
  }
}

/** Tâche périodique (instance meneuse) : une première passe cinq minutes après le démarrage, puis toutes les heures. */
export const archivedWorksessionPurge = {
  start(): void {
    if (timer) return;
    timer = setTimeout(function tick() {
      void purgeAll().finally(() => {
        if (timer) {
          timer = setTimeout(tick, PURGE_INTERVAL_MS);
          timer.unref();
        }
      });
    }, FIRST_RUN_DELAY_MS);
    timer.unref();
  },
  stop(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  },
};
