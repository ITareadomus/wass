/** Orario base housekeeping per un codice logistico ADAM. Vale per ogni giorno. */

export type HkPreassignedSchedule = {
  logisticCode: string;
  startTime: string;
  endTime: string;
};

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClockMinutes(value: unknown): number | null {
  const match = String(value ?? "").trim().match(CLOCK);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function durationLabelFromWindow(startTime: string, endTime: string): string | null {
  const start = parseClockMinutes(startTime);
  const end = parseClockMinutes(endTime);
  if (start == null || end == null || end <= start) return null;
  const diff = end - start;
  const hours = Math.floor(diff / 60);
  const minutes = diff % 60;
  return `${hours}.${String(minutes).padStart(2, "0")}`;
}

function normalizeEntry(raw: unknown): HkPreassignedSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const logisticCode = String(row.logisticCode ?? row.logistic_code ?? "").trim();
  const startTime = String(row.startTime ?? row.start_time ?? "").trim();
  const endTime = String(row.endTime ?? row.end_time ?? "").trim();
  if (!logisticCode || !/^\d+$/.test(logisticCode)) return null;
  if (!durationLabelFromWindow(startTime, endTime)) return null;
  return { logisticCode, startTime, endTime };
}

export function parseHkPreassignedSchedules(raw: unknown): HkPreassignedSchedule[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { entries?: unknown }).entries)
      ? (raw as { entries: unknown[] }).entries
      : [];
  const byCode = new Map<string, HkPreassignedSchedule>();
  for (const item of list) {
    const entry = normalizeEntry(item);
    if (entry) byCode.set(entry.logisticCode, entry);
  }
  return [...byCode.values()];
}

export function hkPreassignedScheduleForTask(
  task: { logistic_code?: unknown; logisticCode?: unknown; name?: unknown },
  schedules: readonly HkPreassignedSchedule[],
): HkPreassignedSchedule | null {
  const code = String(task.logistic_code ?? task.logisticCode ?? task.name ?? "").trim();
  if (!code) return null;
  return schedules.find((entry) => entry.logisticCode === code) ?? null;
}

export function applyHkPreassignedSchedule<T extends Record<string, unknown>>(
  task: T,
  schedules: readonly HkPreassignedSchedule[],
): T {
  const entry = hkPreassignedScheduleForTask(task, schedules);
  if (!entry) return task;
  const duration = durationLabelFromWindow(entry.startTime, entry.endTime);
  const start = parseClockMinutes(entry.startTime);
  const end = parseClockMinutes(entry.endTime);
  if (!duration || start == null || end == null) return task;
  return {
    ...task,
    start_time: entry.startTime,
    end_time: entry.endTime,
    startTime: entry.startTime,
    endTime: entry.endTime,
    duration,
    cleaning_time: end - start,
  };
}
