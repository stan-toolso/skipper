import { AppError } from '../errors.js';
import { settingsRepository } from './repository.js';

const KEY = 'server';

/** Réglages du serveur persistés en base (clé `server` de app_settings). */
export interface ServerSettings {
  /**
   * Au démarrage, relancer les sessions interrompues pendant un tour (activité `busy`) par
   * l'arrêt précédent du serveur. Désactivé par défaut : chaque session relancée occupe de la mémoire.
   */
  autoResumeInterrupted: boolean;
}

export const defaultServerSettings: ServerSettings = { autoResumeInterrupted: false };

/** Mode maintenance : tant qu'il est actif, aucune session ne démarre (mémoire uniquement, levé par un redémarrage). */
export interface MaintenanceState {
  since: Date;
  message: string | null;
  byUserId: string | null;
}

let settings: ServerSettings = { ...defaultServerSettings };
let maintenance: MaintenanceState | null = null;

export const serverSettings = {
  /** À appeler au démarrage, après les migrations. */
  async load(): Promise<void> {
    settings = { ...defaultServerSettings, ...((await settingsRepository.get<Partial<ServerSettings>>(KEY)) ?? {}) };
  },

  get current(): ServerSettings {
    return settings;
  },

  async update(patch: Partial<ServerSettings>): Promise<ServerSettings> {
    const next = { ...settings };
    if (patch.autoResumeInterrupted !== undefined) next.autoResumeInterrupted = Boolean(patch.autoResumeInterrupted);
    await settingsRepository.set(KEY, next);
    settings = next;
    return settings;
  },

  get maintenance(): MaintenanceState | null {
    return maintenance;
  },

  setMaintenance(enabled: boolean, message: string | null, byUserId: string | null): MaintenanceState | null {
    maintenance = enabled ? { since: maintenance?.since ?? new Date(), message: message?.trim() || null, byUserId } : null;
    return maintenance;
  },

  /** Refuse le démarrage d'une session pendant la maintenance. */
  assertNotInMaintenance(): void {
    if (!maintenance) return;
    throw new AppError(
      `Le serveur est en maintenance, aucune session ne peut démarrer pour l'instant${maintenance.message ? ` : ${maintenance.message}` : ' (redémarrage imminent)'}.`,
      'MAINTENANCE',
    );
  },
};
