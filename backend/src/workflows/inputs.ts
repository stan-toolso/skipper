import { AppError } from '../errors.js';
import { CronError, isValidTimeZone, nextRun, parseCron } from '../schedules/cron.js';
import type { AutomationScheduleInput, InputVariable } from './types.js';

/** Variables d'un déclencheur de workflow et planification : assainissement, valeurs d'une exécution, échéances. */

const DEFAULT_TIMEZONE = 'UTC';
const KEY_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Assainit les variables déclarées d'un déclencheur : clés uniques, en forme d'identifiant. */
export function normalizeInputs(raw: InputVariable[] | null | undefined): InputVariable[] {
  const seen = new Set<string>();
  const out: InputVariable[] = [];
  for (const v of raw ?? []) {
    const key = String(v.key ?? '').trim();
    if (!key) continue;
    if (!KEY_PATTERN.test(key)) throw new AppError(`Nom de variable invalide « ${key} » : lettres, chiffres et soulignés seulement, sans commencer par un chiffre`);
    if (seen.has(key)) throw new AppError(`La variable « ${key} » est déclarée deux fois`);
    seen.add(key);
    out.push({ key, label: String(v.label ?? '').trim() || key, description: v.description?.trim() || null, required: Boolean(v.required), defaultValue: v.defaultValue == null || v.defaultValue === '' ? null : String(v.defaultValue) });
  }
  return out;
}

/**
 * Valeurs des variables déclarées pour une exécution : les valeurs données, sinon les défauts ; une
 * variable obligatoire manquante est refusée. Les clés inconnues sont gardées.
 */
export function resolveInputs(declared: InputVariable[], given: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(given ?? {}) };
  const missing: string[] = [];
  for (const v of declared) {
    const value = out[v.key];
    if (value === undefined || value === null || value === '') {
      if (v.defaultValue !== null) out[v.key] = v.defaultValue;
      else if (v.required) missing.push(v.label || v.key);
      else out[v.key] = '';
    }
  }
  if (missing.length) throw new AppError(`Variable${missing.length > 1 ? 's' : ''} obligatoire${missing.length > 1 ? 's' : ''} manquante${missing.length > 1 ? 's' : ''} : ${missing.join(', ')}`);
  return out;
}

export function parseCronOrThrow(cron: string) {
  try {
    return parseCron(cron);
  } catch (err) {
    if (err instanceof CronError) throw new AppError(err.message);
    throw err;
  }
}

/** Valide une planification et calcule sa première échéance. */
export function prepareSchedule(input: AutomationScheduleInput): { cron: string; timezone: string; enabled: boolean; nextRunAt: Date | null } {
  const timezone = input.timezone?.trim() || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) throw new AppError(`Fuseau horaire inconnu : ${timezone}`);
  const spec = parseCronOrThrow(input.cron);
  const enabled = input.enabled ?? true;
  return { cron: spec.source, timezone, enabled, nextRunAt: enabled ? nextRun(spec, new Date(), timezone) : null };
}
