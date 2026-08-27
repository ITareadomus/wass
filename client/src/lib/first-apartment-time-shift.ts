export const FIRST_APT_SNAP_MINUTES = 30;
export const FIRST_APT_TIME_SHIFT_ATTRIBUTE = "data-first-apt-time-shift";

export function clockToMinutes(value?: string | null): number | null {
  if (!value) return null;
  const parts = String(value).split(":");
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

export function minutesToClock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 30, Math.round(totalMinutes)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function snapToHalfHour(minutes: number): number {
  return Math.round(minutes / FIRST_APT_SNAP_MINUTES) * FIRST_APT_SNAP_MINUTES;
}

export function clampFirstApartmentStart(
  minutes: number,
  cleanerStartMin: number,
  cleanerEndMin: number,
): number {
  const snapped = snapToHalfHour(minutes);
  const maxStart = Math.max(cleanerStartMin, cleanerEndMin - FIRST_APT_SNAP_MINUTES);
  return Math.max(cleanerStartMin, Math.min(maxStart, snapped));
}
