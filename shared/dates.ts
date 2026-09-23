// 読書の日付は JST の日付（'YYYY-MM-DD'）で扱う。Worker と画面で共有

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** その時点の JST の日付 */
export function jstToday(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' として実在する日付か */
export function isDateOnly(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 日付に n 日足す */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 両端を含む日数（9/10〜9/23 → 14） */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

// ---- カレンダー（月表示）用。'YYYY-MM' を月として扱う

/** その日付の月（'2026-09-23' → '2026-09'） */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** 月に n か月足す */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${String(Math.floor(t / 12)).padStart(4, "0")}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** 曜日（0＝日曜）。日付は JST の日付として扱う */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** その月の日付を1日から順に */
export function monthDays(month: string): string[] {
  const out: string[] = [];
  for (let d = `${month}-01`; monthOf(d) === month; d = addDays(d, 1)) out.push(d);
  return out;
}
