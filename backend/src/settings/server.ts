import { AppError } from '../errors.js';
import { settingsRepository } from './repository.js';

const KEY = 'server';

/** Réglages du serveur persistés en base (clé `server` de app_settings). */
export interface ServerSettings {
  /**
   * Au démarrage, relancer les sessions interrompues pendant un tour (activité `busy`) par
   * l'arrêt précédent du serveur. Activé par défaut ; désactivable quand la mémoire manque (chaque
   * session relancée occupe plusieurs centaines de Mo).
   */
  autoResumeInterrupted: boolean;
  /**
   * Nombre maximal de sessions dont le processus tourne en même temps sur le serveur (0 : illimité).
   * Au-delà, une session qui devrait démarrer est mise en file d'attente (statut « queued ») et démarre
   * dès qu'une place se libère. Un projet peut fixer sa propre limite (runner_config.maxSessions).
   */
  maxConcurrentSessions: number;
  /** Une session en attente d'instructions depuis plus de N minutes est terminée pour libérer sa place et sa mémoire (0 : jamais). */
  idleSessionTimeoutMinutes: number;
  /** Les administrateurs sont notifiés quand la mémoire disponible passe sous ce seuil, en Mo (0 : jamais). */
  memoryAlertThresholdMb: number;
}

export const defaultServerSettings: ServerSettings = {
  autoResumeInterrupted: true,
  maxConcurrentSessions: 0,
  idleSessionTimeoutMinutes: 60,
  memoryAlertThresholdMb: 200,
};

/** Entier positif ou nul borné, pour les réglages numériques. */
function wholeNumber(value: unknown, label: string, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new AppError(`${label} : entier entre 0 et ${max} attendu`);
  return n;
}

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
    if (patch.maxConcurrentSessions !== undefined) next.maxConcurrentSessions = wholeNumber(patch.maxConcurrentSessions, 'Sessions simultanées', 100);
    if (patch.idleSessionTimeoutMinutes !== undefined) next.idleSessionTimeoutMinutes = wholeNumber(patch.idleSessionTimeoutMinutes, "Délai d'inactivité", 7 * 24 * 60);
    if (patch.memoryAlertThresholdMb !== undefined) next.memoryAlertThresholdMb = wholeNumber(patch.memoryAlertThresholdMb, "Seuil d'alerte mémoire", 1024 * 1024);
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
