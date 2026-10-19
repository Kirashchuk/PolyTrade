import type { SessionName, Settings } from './config.ts';

const NY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' });

/**
 * Market-session profile (spec §5.7). The API does not publish a session state, so equities follow the
 * NYSE weekly schedule (09:30–16:00 America/New_York, Mon–Fri). Exchange holidays are not modeled.
 * Non-equity instruments always use the regular profile.
 */
export function currentSession(nowMs: number, category: string, schedule: Settings['sessions']['schedule']): SessionName {
  if (schedule === 'regular' || category !== 'equity') return 'regular';
  const parts = Object.fromEntries(NY.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]));
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return 'weekend';
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60 ? 'regular' : 'overnight';
}
