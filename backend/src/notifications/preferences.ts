import { pool } from '../db/pool.js';
import { AppError } from '../errors.js';
import { userSettingsStore } from '../settings/userStore.js';

/**
 * Ce que chaque personne reçoit en notification push (et en notification du navigateur) : les
 * notifications sont regroupées en familles, chacune activable ou non. La cloche, elle, affiche tout.
 * Le choix est rangé dans user_settings (clé `notifications.push`) sous la forme des familles coupées :
 * une famille ajoutée plus tard est donc reçue par défaut.
 */

export interface PushCategory {
  key: string;
  label: string;
  description: string;
  /** Types de notification (`Notification.type`) de la famille. */
  types: string[];
  /** Famille réservée aux administrateurs de l'application. */
  adminsOnly: boolean;
}

export const PUSH_CATEGORIES: readonly PushCategory[] = [
  { key: 'requests', label: 'Demandes d’un agent', description: 'Autorisation d’un outil, question ou saisie attendue : la session reste en attente jusqu’à votre réponse.', types: ['request.created'], adminsOnly: false },
  { key: 'sessions', label: 'Sessions terminées ou en erreur', description: 'Fin de tour d’une session, ou arrêt sur une erreur.', types: ['session.completed', 'session.failed'], adminsOnly: false },
  { key: 'subagents', label: 'Sessions lancées par un agent', description: 'Un agent a délégué du travail à une autre session.', types: ['session.created'], adminsOnly: false },
  { key: 'tasks', label: 'Tâches', description: 'Tâche créée ou terminée par un agent.', types: ['task.created', 'task.completed'], adminsOnly: false },
  { key: 'mentions', label: 'Mentions et réponses', description: 'Quelqu’un vous mentionne dans le fil d’une tâche, ou répond à l’un de vos messages.', types: ['task.mentioned', 'task.replied'], adminsOnly: false },
  { key: 'pull_requests', label: 'Pull requests', description: 'Pull request ouverte, fusionnée ou fermée.', types: ['pull_request.opened', 'pull_request.merged', 'pull_request.closed'], adminsOnly: false },
  { key: 'schedules', label: 'Planifications', description: 'Compte rendu d’une exécution planifiée : terminée, bloquée par une autorisation refusée, ignorée ou en erreur.', types: ['schedule.run', 'schedule.blocked', 'schedule.skipped', 'schedule.failed'], adminsOnly: false },
  { key: 'workflows', label: 'Workflows', description: 'Fin d’une exécution de workflow, réussie ou en erreur.', types: ['workflow.run', 'workflow.failed'], adminsOnly: false },
  { key: 'context', label: 'Contexte', description: 'Instruction ajoutée à la bibliothèque de contexte par un agent.', types: ['context.created'], adminsOnly: false },
  { key: 'pages', label: 'Pages partagées', description: 'Une page a été partagée avec vous.', types: ['page.shared'], adminsOnly: false },
  { key: 'containers', label: 'Ressources des projets', description: 'Conteneur d’un projet proche de sa limite mémoire ou saturé en CPU.', types: ['container.memory_high', 'container.cpu_saturated'], adminsOnly: false },
  { key: 'server', label: 'Alertes du serveur et de l’abonnement', description: 'Mémoire du serveur basse, limites de l’abonnement Claude approchées ou atteintes.', types: ['claude.rate_limit', 'server.memory_low'], adminsOnly: true },
];

const PREFS_KEY = 'notifications.push';

interface StoredPrefs {
  /** Clés des familles coupées. */
  muted: string[];
}

const categoryByType = new Map(PUSH_CATEGORIES.flatMap((c) => c.types.map((t) => [t, c.key] as const)));

/** Famille d'un type de notification ; null pour un type inconnu (toujours envoyé). */
export const categoryOf = (type: string): string | null => categoryByType.get(type) ?? null;

/** Une personne reçoit-elle en push les notifications de ce type, d'après ses familles coupées ? */
export function wantsPush(type: string, muted: readonly string[]): boolean {
  const category = categoryOf(type);
  return category === null || !muted.includes(category);
}

const normalize = (value: unknown): string[] => {
  const muted = (value as Partial<StoredPrefs> | null)?.muted;
  return Array.isArray(muted) ? muted.filter((k): k is string => typeof k === 'string') : [];
};

export interface PushPreference extends PushCategory {
  enabled: boolean;
}

const view = (muted: string[], admin: boolean): PushPreference[] =>
  PUSH_CATEGORIES.filter((c) => admin || !c.adminsOnly).map((c) => ({ ...c, enabled: !muted.includes(c.key) }));

export const pushPreferencesService = {
  /** Familles visibles par la personne, avec leur état. */
  async list(userId: string, admin: boolean): Promise<PushPreference[]> {
    return view(normalize(await userSettingsStore.get(userId, PREFS_KEY)), admin);
  },

  async set(userId: string, admin: boolean, category: string, enabled: boolean): Promise<PushPreference[]> {
    if (!PUSH_CATEGORIES.some((c) => c.key === category)) throw new AppError(`Famille de notifications inconnue : ${category}`);
    const muted = new Set(normalize(await userSettingsStore.get(userId, PREFS_KEY)));
    if (enabled) muted.delete(category);
    else muted.add(category);
    const next = [...muted].sort();
    if (next.length) await userSettingsStore.set<StoredPrefs>(userId, PREFS_KEY, { muted: next });
    else await userSettingsStore.delete(userId, PREFS_KEY);
    return view(next, admin);
  },

  /** Familles coupées de plusieurs personnes à la fois (envoi d'une notification) ; absent = rien de coupé. */
  async mutedOf(userIds: string[]): Promise<Map<string, string[]>> {
    const result = new Map<string, string[]>();
    if (!userIds.length) return result;
    const { rows } = await pool.query<{ user_id: string; value: unknown }>('SELECT user_id, value FROM user_settings WHERE key = $1 AND user_id = ANY($2::uuid[])', [PREFS_KEY, userIds]);
    for (const row of rows) result.set(row.user_id, normalize(row.value));
    return result;
  },
};
