/** Fréquences simples proposées pour une planification ; « custom » laisse saisir l'expression cron. */
export type CronPreset = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

export const cronPresetLabels: Record<CronPreset, string> = {
  hourly: 'Toutes les heures',
  daily: 'Tous les jours',
  weekdays: 'Du lundi au vendredi',
  weekly: 'Toutes les semaines',
  monthly: 'Tous les mois',
  custom: 'Expression cron…',
};

export const weekdayLabels = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** Construit l'expression cron d'une fréquence simple (heure « HH:MM », jour de semaine 0-6, jour du mois 1-31). */
export function buildCron(preset: CronPreset, time: string, weekday: number, monthDay: number, custom: string): string {
  const [h, m] = time.split(':').map((v) => Number(v));
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  switch (preset) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${weekday}`;
    case 'monthly':
      return `${minute} ${hour} ${monthDay} * *`;
    default:
      return custom.trim();
  }
}

/** Retrouve, si possible, la fréquence simple correspondant à une expression enregistrée. */
export function detectCronPreset(cron: string): { preset: CronPreset; time: string; weekday: number; monthDay: number } {
  const pad = (n: string) => n.padStart(2, '0');
  const f = cron.trim().split(/\s+/);
  const fallback = { preset: 'custom' as CronPreset, time: '09:00', weekday: 1, monthDay: 1 };
  if (f.length !== 5 || !/^\d+$/.test(f[0])) return fallback;
  if (f[1] === '*' && f[2] === '*' && f[3] === '*' && f[4] === '*') return { ...fallback, preset: 'hourly', time: `00:${pad(f[0])}` };
  if (!/^\d+$/.test(f[1])) return fallback;
  const time = `${pad(f[1])}:${pad(f[0])}`;
  if (f[2] === '*' && f[3] === '*' && f[4] === '*') return { ...fallback, preset: 'daily', time };
  if (f[2] === '*' && f[3] === '*' && f[4] === '1-5') return { ...fallback, preset: 'weekdays', time };
  if (f[2] === '*' && f[3] === '*' && /^[0-7]$/.test(f[4])) return { ...fallback, preset: 'weekly', time, weekday: Number(f[4]) % 7 };
  if (/^\d+$/.test(f[2]) && f[3] === '*' && f[4] === '*') return { ...fallback, preset: 'monthly', time, monthDay: Number(f[2]) };
  return fallback;
}

export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};
