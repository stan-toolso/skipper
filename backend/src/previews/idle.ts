import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { projectRepository } from '../projects/repository.js';
import { previewRepository } from './repository.js';
import { previewService, previewStateDir, SEEN_FILE, touchSeen } from './service.js';
import { deriveState, parseEvents, type PreviewEvent } from './state.js';

/**
 * Arrêt des aperçus sans visite.
 *
 * Un aperçu lancé tournait jusqu'à l'archivage de sa work session : 7 jours pour l'un d'eux le 25/11, sans personne
 * pour le regarder (un serveur de développement et ses observateurs de fichiers, 200 Mo ou plus). La dernière visite
 * est notée sur disque, dans le dossier d'état de l'aperçu (lisible de toutes les instances) : fichier `seen`, écrit
 * au plus une fois par minute par instance à chaque requête relayée, tant qu'une WebSocket (rechargement à chaud)
 * reste ouverte, et à chaque capture d'un agent. Toutes les dix minutes, l'instance meneuse arrête un aperçu vivant
 * sans visite ni lancement depuis PREVIEW_IDLE_HOURS (4 h par défaut) ; l'événement `stopped idle <h>` l'explique
 * dans l'onglet « Aperçu », et le relancer reste un clic.
 */

const SWEEP_MS = 10 * 60_000;
const TOUCH_MS = 60_000;
/** Une WebSocket ouverte (page affichée, rechargement à chaud) compte comme une visite à ce rythme. */
export const SOCKET_TOUCH_MS = 5 * 60_000;

const lastTouch = new Map<string, number>();

/** Visite d'un aperçu relayée par le proxy : au plus une écriture par minute et par aperçu. */
export function markVisited(projectId: string, worksessionId: string, now = Date.now()): void {
  if (now - (lastTouch.get(worksessionId) ?? 0) < TOUCH_MS) return;
  lastTouch.set(worksessionId, now);
  void projectRepository
    .findById(projectId)
    .then((project) => project && touchSeen(previewStateDir(project, worksessionId), now))
    .catch(() => undefined);
}

async function readSeen(state: string): Promise<number | null> {
  const text = await readFile(path.join(state, SEEN_FILE), 'utf8').catch(() => '');
  const n = Number(text.trim());
  return text.trim() && Number.isFinite(n) ? n : null;
}

/** Dernier signe de vie : visite, ou étape du dernier lancement (début, prêt). */
export function lastActivity(events: PreviewEvent[], seen: number | null): number | null {
  const times = events.filter((e) => e.name === 'begin' || e.name === 'ready' || e.name === 'starting').map((e) => e.at);
  if (seen !== null) times.push(seen);
  return times.length ? Math.max(...times) : null;
}

/** L'aperçu est-il à arrêter ? Il tourne (ou démarre) et rien ne s'est passé depuis `idleMs`. */
export function isIdle(events: PreviewEvent[], seen: number | null, idleMs: number, now = Date.now()): boolean {
  if (idleMs <= 0) return false;
  // Sans regarder le processus : un aperçu déjà arrêté, en échec ou terminé n'a rien à arrêter.
  const status = deriveState(events, true, true).status;
  if (status !== 'RUNNING' && status !== 'STARTING' && status !== 'INSTALLING') return false;
  const last = lastActivity(events, seen);
  return last !== null && now - last > idleMs;
}

let timer: NodeJS.Timeout | null = null;
let sweeping = false;

export const previewIdleSweep = {
  async sweep(now = Date.now()): Promise<number> {
    const idleMs = config.previewIdleHours * 3600_000;
    if (idleMs <= 0 || sweeping) return 0;
    sweeping = true;
    let stopped = 0;
    try {
      for (const row of await previewRepository.allStarted()) {
        try {
          const project = await projectRepository.findById(row.projectId);
          if (!project) continue;
          const state = previewStateDir(project, row.worksessionId);
          const events = parseEvents(await readFile(path.join(state, 'events'), 'utf8').catch(() => ''));
          if (!isIdle(events, await readSeen(state), idleMs, now)) continue;
          if (await previewService.stopProcess(project, state, `idle ${config.previewIdleHours}`)) {
            stopped++;
            log.info(`[previews] ${project.slug} : aperçu ${row.hostLabel} arrêté après ${config.previewIdleHours} h sans visite`);
          }
        } catch (err) {
          log.warn(`[previews] surveillance de l'aperçu ${row.hostLabel} : ${(err as Error).message}`);
        }
      }
      return stopped;
    } finally {
      sweeping = false;
    }
  },

  start(): void {
    if (timer) return;
    timer = setInterval(() => void this.sweep().catch((err) => log.error('[previews] arrêt des aperçus sans visite', err)), SWEEP_MS);
    timer.unref();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
