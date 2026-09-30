/**
 * Expressions cron à cinq champs (minute, heure, jour du mois, mois, jour de la semaine), interprétées
 * dans un fuseau horaire IANA. Sans dépendance : on avance de champ en champ jusqu'à la prochaine
 * échéance, en heure locale du fuseau, puis on convertit en instant UTC.
 */

export interface CronSpec {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Jour du mois non restreint (`*`). */
  anyDay: boolean;
  /** Jour de la semaine non restreint (`*`). */
  anyWeekday: boolean;
  source: string;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export class CronError extends Error {}

function parseValue(raw: string, names: Record<string, number> | undefined, label: string): number {
  const lower = raw.toLowerCase();
  if (names && lower in names) return names[lower];
  if (!/^\d+$/.test(raw)) throw new CronError(`Valeur « ${raw} » invalide pour ${label}`);
  return Number(raw);
}

function parseField(field: string, min: number, max: number, label: string, names?: Record<string, number>): { values: Set<number>; any: boolean } {
  const values = new Set<number>();
  let any = false;
  for (const part of field.split(',')) {
    if (!part) throw new CronError(`Champ ${label} vide`);
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new CronError(`Pas « ${stepPart} » invalide pour ${label}`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
      if (stepPart === undefined) any = true;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = parseValue(a, names, label);
      hi = parseValue(b, names, label);
    } else {
      lo = parseValue(rangePart, names, label);
      hi = stepPart === undefined ? lo : max;
    }
    if (lo < min || hi > max || lo > hi) throw new CronError(`Valeur hors limites pour ${label} (${min}-${max}) : « ${part} »`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return { values, any };
}

/** Analyse une expression cron ; lève CronError si elle est invalide. */
export function parseCron(expression: string): CronSpec {
  const source = expression.trim();
  const expr = ALIASES[source.toLowerCase()] ?? source;
  const fields = expr.split(/\s+/);
  if (fields.length !== 5) throw new CronError('Une expression cron comporte cinq champs : minute heure jour mois jour-de-semaine');
  const minutes = parseField(fields[0], 0, 59, 'les minutes');
  const hours = parseField(fields[1], 0, 23, 'les heures');
  const days = parseField(fields[2], 1, 31, 'le jour du mois');
  const months = parseField(fields[3], 1, 12, 'le mois', MONTH_NAMES);
  const weekdays = parseField(fields[4], 0, 7, 'le jour de la semaine', DAY_NAMES);
  // 7 = dimanche, comme 0.
  if (weekdays.values.has(7)) {
    weekdays.values.delete(7);
    weekdays.values.add(0);
  }
  return { minutes: minutes.values, hours: hours.values, days: days.values, months: months.values, weekdays: weekdays.values, anyDay: days.any, anyWeekday: weekdays.any, source };
}

// ---- Fuseaux horaires ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Vérifie qu'un fuseau IANA est connu de Node (`Europe/Paris`, `UTC`...). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Heure locale d'un instant dans le fuseau, exprimée en millisecondes « comme si c'était de l'UTC ». */
function wallClock(instant: Date, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/** Instant correspondant à une heure locale du fuseau (ms « UTC » de l'heure locale). Une heure locale ambiguë (retour à l'heure d'hiver) donne l'une de ses deux occurrences. */
function fromWallClock(wall: number, timeZone: string): Date {
  let guess = wall - (wallClock(new Date(wall), timeZone) - wall);
  const offset = wallClock(new Date(guess), timeZone) - guess;
  if (guess + offset !== wall) guess = wall - offset;
  return new Date(guess);
}

// ---- Prochaine échéance ---------------------------------------------------------------------------

function dayMatches(spec: CronSpec, d: Date): boolean {
  const domOk = spec.days.has(d.getUTCDate());
  const dowOk = spec.weekdays.has(d.getUTCDay());
  if (spec.anyDay && spec.anyWeekday) return true;
  if (spec.anyDay) return dowOk;
  if (spec.anyWeekday) return domOk;
  return domOk || dowOk; // sémantique cron classique : les deux champs restreints s'additionnent
}

/** Première échéance strictement postérieure à `after` (null si aucune dans les cinq prochaines années). */
export function nextRun(spec: CronSpec, after: Date, timeZone: string): Date | null {
  const start = wallClock(after, timeZone);
  let t = start - (start % 60_000) + 60_000;
  const limit = start + 5 * 366 * 24 * 3_600_000;
  while (t <= limit) {
    const d = new Date(t);
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    if (!spec.months.has(m + 1)) {
      t = Date.UTC(y, m + 1, 1);
      continue;
    }
    if (!dayMatches(spec, d)) {
      t = Date.UTC(y, m, d.getUTCDate() + 1);
      continue;
    }
    if (!spec.hours.has(d.getUTCHours())) {
      t = Date.UTC(y, m, d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!spec.minutes.has(d.getUTCMinutes())) {
      t += 60_000;
      continue;
    }
    const instant = fromWallClock(t, timeZone);
    // Heure locale inexistante (passage à l'heure d'été) ou déjà passée : on continue.
    if (instant.getTime() > after.getTime() && wallClock(instant, timeZone) === t) return instant;
    t += 60_000;
  }
  return null;
}

/** Les `count` prochaines échéances après `after`. */
export function nextRuns(spec: CronSpec, after: Date, timeZone: string, count: number): Date[] {
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextRun(spec, cursor, timeZone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
