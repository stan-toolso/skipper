import { describe, expect, it } from 'vitest';
import { buildCron, detectCronPreset } from './cron';

describe('buildCron / detectCronPreset', () => {
  it('construit les fréquences simples', () => {
    expect(buildCron('hourly', '09:30', 1, 1, '')).toBe('30 * * * *');
    expect(buildCron('daily', '09:30', 1, 1, '')).toBe('30 9 * * *');
    expect(buildCron('weekdays', '08:00', 1, 1, '')).toBe('0 8 * * 1-5');
    expect(buildCron('weekly', '18:15', 5, 1, '')).toBe('15 18 * * 5');
    expect(buildCron('monthly', '07:00', 1, 15, '')).toBe('0 7 15 * *');
    expect(buildCron('custom', '07:00', 1, 15, ' */10 * * * * ')).toBe('*/10 * * * *');
  });
  it('retrouve la fréquence simple d’une expression, sinon « custom »', () => {
    expect(detectCronPreset('30 * * * *')).toMatchObject({ preset: 'hourly', time: '00:30' });
    expect(detectCronPreset('0 9 * * 1-5')).toMatchObject({ preset: 'weekdays', time: '09:00' });
    expect(detectCronPreset('15 18 * * 5')).toMatchObject({ preset: 'weekly', time: '18:15', weekday: 5 });
    expect(detectCronPreset('0 7 15 * *')).toMatchObject({ preset: 'monthly', time: '07:00', monthDay: 15 });
    expect(detectCronPreset('*/10 * * * *').preset).toBe('custom');
    const d = detectCronPreset('5 6 * * *');
    expect(buildCron(d.preset, d.time, d.weekday, d.monthDay, '')).toBe('5 6 * * *');
  });
});
