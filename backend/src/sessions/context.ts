import { pool } from '../db/pool.js';
import type { Session, SessionCleanup } from './types.js';

/**
 * Seuil (tokens) au-delà duquel l'interface signale le contexte d'une session et propose de le nettoyer :
 * jauge en couleur dans l'en-tête, pastille dans la sidebar, bandeau « Compacter / Repartir de zéro / Ignorer ».
 * Aucune action automatique : une session manuelle n'est jamais compactée sans l'accord de l'utilisateur.
 */
export const CONTEXT_WARN_TOKENS = 150_000;
/** Seuil de compaction proposé par défaut pour une planification (option « compacter au-delà de… »). */
export const DEFAULT_SCHEDULE_CONTEXT_MAX_TOKENS = 100_000;
/** Nettoyage appliqué par défaut à une nouvelle planification : conversation neuve à chaque exécution. */
export const DEFAULT_SCHEDULE_CLEANUP: SessionCleanup = { contextAction: 'fresh' };

export interface ModelProfile {
  /** Fenêtre de contexte (tokens). */
  windowTokens: number;
  /** Prix des tokens d'entrée non mis en cache (dollars par million). */
  inputUsdPerMTok: number;
}

const M = 1_000_000;
/**
 * Profils par famille de modèle, du plus spécifique au plus général (tarif API Anthropic, octobre 2026).
 * Les alias du CLI (« opus », « sonnet », « haiku », « default ») sont rattachés à la génération courante.
 */
const PROFILES: Array<[RegExp, ModelProfile]> = [
  [/fable|mythos/, { windowTokens: M, inputUsdPerMTok: 10 }],
  [/opus-5-5/, { windowTokens: M, inputUsdPerMTok: 4 }],
  [/opus-[45]/, { windowTokens: M, inputUsdPerMTok: 5 }],
  [/opus/, { windowTokens: M, inputUsdPerMTok: 4 }],
  [/sonnet-4/, { windowTokens: M, inputUsdPerMTok: 3 }],
  [/sonnet/, { windowTokens: M, inputUsdPerMTok: 2 }],
  [/haiku-4/, { windowTokens: 200_000, inputUsdPerMTok: 1 }],
  [/haiku/, { windowTokens: M, inputUsdPerMTok: 0.1 }],
];
/** Modèle inconnu ou alias « default » : Opus, le modèle par défaut des sessions Skipper. */
const DEFAULT_PROFILE: ModelProfile = { windowTokens: M, inputUsdPerMTok: 4 };

export function modelProfile(model: string | null | undefined): ModelProfile {
  const name = (model ?? '').toLowerCase();
  for (const [pattern, profile] of PROFILES) if (pattern.test(name)) return profile;
  return DEFAULT_PROFILE;
}

export interface ContextEstimate {
  tokens: number | null;
  warnTokens: number;
  overThreshold: boolean;
  windowTokens: number;
  /** Part de la fenêtre occupée (0..1), null si la taille est inconnue. */
  share: number | null;
  /** Coût approximatif de la relecture du contexte à froid (cache expiré) au prochain tour, en dollars. */
  coldTurnUsd: number | null;
}

/** Estimation pure : taille du contexte rapportée à la fenêtre du modèle et au tarif de ses tokens d'entrée. */
export function contextEstimate(tokens: number | null, model: string | null | undefined): ContextEstimate {
  const profile = modelProfile(model);
  return {
    tokens,
    warnTokens: CONTEXT_WARN_TOKENS,
    overThreshold: tokens !== null && tokens >= CONTEXT_WARN_TOKENS,
    windowTokens: profile.windowTokens,
    share: tokens === null ? null : Math.min(1, tokens / profile.windowTokens),
    coldTurnUsd: tokens === null ? null : (tokens / M) * profile.inputUsdPerMTok,
  };
}

const ALIASES = new Set(['default', 'opus', 'sonnet', 'haiku']);

/**
 * Modèle d'une session pour l'estimation : le dernier modèle facturé (relevé de consommation, identifiant
 * complet), sinon le modèle de sa configuration (alias du CLI), sinon null.
 */
export async function contextModel(session: Session): Promise<string | null> {
  const { rows } = await pool.query<{ models: Record<string, number> }>('SELECT models FROM usage_ledger WHERE session_id = $1 ORDER BY recorded_at DESC LIMIT 1', [session.id]);
  const billed = Object.entries(rows[0]?.models ?? {})
    .filter(([name]) => !ALIASES.has(name))
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  if (billed) return billed;
  return typeof session.config.model === 'string' && session.config.model ? session.config.model : null;
}
