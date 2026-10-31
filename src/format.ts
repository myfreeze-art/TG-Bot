const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function truncate(input: string, max: number): string {
  const text = input.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** 1234567 -> "1 234 567" (без зависимости от Intl). */
export function fmtInt(value: number): string {
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return '';
  const max = Math.max(...values);
  if (max <= 0) return BARS[0].repeat(values.length);
  return values
    .map((value) => {
      if (value <= 0) return BARS[0];
      const index = Math.min(BARS.length - 1, Math.max(0, Math.round((value / max) * (BARS.length - 1))));
      return BARS[index];
    })
    .join('');
}

/** '2026-10-31' -> '31.10' */
export function shortDay(isoDay: string): string {
  const [, month, day] = isoDay.split('-');
  return `${day}.${month}`;
}

export function formatDateTime(ts: number): string {
  const date = new Date(ts * 1000);
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatTime(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(11, 16);
}

export function displayName(username: string | null | undefined, firstName: string | null | undefined): string {
  if (username) return `@${username}`;
  if (firstName) return firstName;
  return '—';
}

export function isoDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function csvEscape(value: string | number): string {
  let text = String(value);
  // Защита от CSV/Excel-инъекций через имена пользователей.
  if (/^[=+\-]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildCsv(rows: ReadonlyArray<ReadonlyArray<string | number>>): string {
  return `\uFEFF${rows.map((row) => row.map(csvEscape).join(',')).join('\r\n')}`;
}
