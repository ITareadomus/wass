import { parseHousekeepingDurationLabel } from "./housekeeping-timeline-layout";
import { formatScheduleDurationLabel, scheduleClockToMinutes } from "./wass-manual-schedule";
import { hasManualCleaningTime } from "./wass-cleaning-time";

/** Minuti fittizi per operation_id. Valgono solo se ADAM manda la durata a 0. */
export function parseOperationBaseMinutes(settings: unknown): Map<number, number> {
  const source =
    settings && typeof settings === "object"
      ? (settings as { operation_base_minutes?: unknown }).operation_base_minutes
      : null;
  const out = new Map<number, number>();
  if (!source || typeof source !== "object") return out;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const operationId = Number(key);
    const minutes = Math.round(Number(value));
    if (!Number.isFinite(operationId) || operationId <= 0) continue;
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    out.set(operationId, minutes);
  }
  return out;
}

export function normalizeOperationBaseMinutes(value: unknown): Record<string, number> {
  const parsed = parseOperationBaseMinutes({ operation_base_minutes: value });
  const out: Record<string, number> = {};
  for (const [operationId, minutes] of parsed) {
    out[String(operationId)] = minutes;
  }
  return out;
}

function cleaningMinutes(task: any): number {
  const minutes = Number(task?.cleaning_time ?? task?.cleaningTime ?? 0);
  return Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
}

function operationIdOf(task: any): number | null {
  const operationId = Number(task?.operation_id ?? task?.operationId);
  return Number.isFinite(operationId) && operationId > 0 ? operationId : null;
}

/** Durata da usare al posto dello 0 di ADAM. Null se non va applicata. */
export function fictionalScheduleMinutes(task: any, bases: Map<number, number>): number | null {
  if (hasManualCleaningTime(task)) return null;
  if (cleaningMinutes(task) > 0) return null;
  const operationId = operationIdOf(task);
  if (operationId == null) return null;
  const base = bases.get(operationId);
  return base != null && base > 0 ? base : null;
}

export function usesFictionalOperationDuration(task: any, bases: Map<number, number>): boolean {
  return fictionalScheduleMinutes(task, bases) != null;
}

/** Copia le task aggiungendo il blocco fittizio, senza toccare cleaning_time. */
export function attachScheduleBlockMinutes<T extends { tasks?: any[] }>(
  cleanerData: T,
  settings: unknown,
): T {
  const bases = parseOperationBaseMinutes(settings);
  if (!Array.isArray(cleanerData?.tasks) || bases.size === 0) return cleanerData;
  return {
    ...cleanerData,
    tasks: cleanerData.tasks.map((task) => {
      const block = fictionalScheduleMinutes(task, bases);
      if (block == null) return task;
      return { ...task, schedule_block_minutes: block };
    }),
  };
}

/**
 * Se la durata ADAM è 0 ma start/end occupano già un blocco, la barra usa quello.
 * La durata mostrata nel dialog resta quella di ADAM.
 */
export function timelineBarDurationLabel(task: {
  duration?: unknown;
  start_time?: unknown;
  startTime?: unknown;
  end_time?: unknown;
  endTime?: unknown;
}): string | null {
  if (parseHousekeepingDurationLabel(task.duration as string | number | null | undefined) > 0) {
    return null;
  }
  const start = scheduleClockToMinutes(task.start_time ?? task.startTime);
  const end = scheduleClockToMinutes(task.end_time ?? task.endTime);
  if (start == null || end == null || end <= start) return null;
  return formatScheduleDurationLabel(end - start);
}
