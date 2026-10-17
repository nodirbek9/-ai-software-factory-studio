/** The UI is English; dates use one fixed locale instead of the browser's (which may be Russian or Uzbek). */
export const UI_LOCALE = 'en-GB';

/** Wall time in ms as "42s", "3m 05s" or "1h 02m". */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export interface TokenDelta {
  text: string;
  direction: 'up' | 'down' | 'flat' | 'none';
}

/** Change of the last 24 h against the 24 h before it. Without a previous window there is no honest percentage. */
export function tokenDelta(total: number, previous: number): TokenDelta {
  if (previous <= 0) return { text: total > 0 ? 'no usage in the previous 24 h' : 'no usage recorded yet', direction: 'none' };
  const change = Math.round(((total - previous) / previous) * 100);
  if (change === 0) return { text: '0% vs previous 24 h', direction: 'flat' };
  return { text: `${change > 0 ? '↑' : '↓'} ${Math.abs(change)}% vs previous 24 h`, direction: change > 0 ? 'up' : 'down' };
}

/** Short day label ("Mon") of a local YYYY-MM-DD date. */
export function weekdayLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(UI_LOCALE, { weekday: 'short' });
}
