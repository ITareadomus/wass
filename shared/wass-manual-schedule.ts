/** Marker WASS: start/end impostati a mano. ADAM non li sovrascrive e non li riceve. */
export const WASS_MANUAL_SCHEDULE_REASON = "wass_manual_schedule";

function reasonsOf(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return (value as { reasons?: unknown }).reasons;
  return [];
}

function hasReason(taskOrReasons: unknown, marker: string): boolean {
  const reasons = reasonsOf(taskOrReasons);
  if (!Array.isArray(reasons)) return false;
  return reasons.some((entry) => String(entry ?? "").trim() === marker);
}

function withReason(reasons: unknown, marker: string): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  if (Array.isArray(reasons)) {
    for (const entry of reasons) {
      const reason = String(entry ?? "").trim();
      if (!reason || seen.has(reason)) continue;
      seen.add(reason);
      next.push(reason);
    }
  }
  if (!seen.has(marker)) next.push(marker);
  return next;
}

export function hasManualSchedule(taskOrReasons: unknown): boolean {
  return hasReason(taskOrReasons, WASS_MANUAL_SCHEDULE_REASON);
}

export function withManualScheduleReason(reasons: unknown): string[] {
  return withReason(reasons, WASS_MANUAL_SCHEDULE_REASON);
}

export function withoutManualScheduleReason(reasons: unknown): string[] {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .map((entry) => String(entry ?? "").trim())
    .filter((reason) => reason && reason !== WASS_MANUAL_SCHEDULE_REASON);
}

/** HH:mm, oppure null se l'orario non è valido. */
export function normalizeScheduleClock(value: unknown): string | null {
  const match = String(value ?? "").trim().match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function scheduleClockToMinutes(value: unknown): number | null {
  const clock = normalizeScheduleClock(value);
  if (!clock) return null;
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

/** Minuti fra start e end se l'orario è stato fissato a mano. Altrimenti null. */
export function manualScheduleSpanMinutes(task: unknown): number | null {
  if (!task || typeof task !== "object" || !hasManualSchedule(task)) return null;
  const record = task as { start_time?: unknown; startTime?: unknown; end_time?: unknown; endTime?: unknown };
  const start = scheduleClockToMinutes(record.start_time ?? record.startTime);
  const end = scheduleClockToMinutes(record.end_time ?? record.endTime);
  if (start == null || end == null || end <= start) return null;
  return end - start;
}

/** Durata "H.MM" usata dalla larghezza delle card in timeline. */
export function formatScheduleDurationLabel(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  return `${Math.floor(total / 60)}.${String(total % 60).padStart(2, "0")}`;
}
