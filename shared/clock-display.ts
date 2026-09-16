const MINUTES_PER_DAY = 24 * 60;

export function wrapHourOfDay(hours: number): number {
  if (!Number.isFinite(hours)) return 0;
  return ((Math.trunc(hours) % 24) + 24) % 24;
}

export function formatClockFromMinutes(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes)) return "00:00";
  const normalized =
    ((Math.round(totalMinutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Display-only wrap: "26:00" → "02:00". Non-clock strings are left unchanged. */
export function formatClockLabel(value: unknown): string {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const match = raw.match(/^(\d{1,3}):(\d{2})(?::\d{2})?$/);
  if (!match) return raw;
  const hours = wrapHourOfDay(Number(match[1]));
  return `${String(hours).padStart(2, "0")}:${match[2]}`;
}
