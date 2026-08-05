export type LogisticsTaskExecutionStatus =
  | "not_started"
  | "in_progress"
  | "paused"
  | "completed";

/** True when Adam time/value is present (not null/empty). */
export function isLogisticsExecutionFieldSet(value: unknown): boolean {
  if (value == null) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "number") return Number.isFinite(value);
  const text = String(value).trim();
  if (!text) return false;
  // MySQL TIME zero / empty placeholders
  if (text === "00:00:00" || text === "0") return false;
  return true;
}

export function parseLogisticsPaused(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value == null) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  }
  return Boolean(value);
}

/**
 * Stato esecuzione task logistica da campi Adam:
 * - non iniziato: start null, end null, paused false
 * - in corso: start valorizzato, end null, paused false
 * - in pausa: start valorizzato, end null, paused true
 * - completato: start e end valorizzati (paused pulito)
 */
export function resolveLogisticsTaskExecutionStatus(input: {
  lgRealStart?: unknown;
  lgRealEnd?: unknown;
  lgPaused?: unknown;
  lg_real_start?: unknown;
  lg_real_end?: unknown;
  lg_paused?: unknown;
}): LogisticsTaskExecutionStatus {
  const hasStart = isLogisticsExecutionFieldSet(
    input.lgRealStart ?? input.lg_real_start
  );
  const hasEnd = isLogisticsExecutionFieldSet(
    input.lgRealEnd ?? input.lg_real_end
  );
  const paused = parseLogisticsPaused(input.lgPaused ?? input.lg_paused);

  if (hasStart && hasEnd) return "completed";
  if (hasStart && !hasEnd && paused) return "paused";
  if (hasStart && !hasEnd && !paused) return "in_progress";
  return "not_started";
}

/** Campi Adam da preservare nei mapper UI timeline/container. */
export function pickLogisticsExecutionStatusFields(task: any): {
  lg_real_start: string | null;
  lg_real_end: string | null;
  lg_paused: boolean;
  logistics_execution_status: LogisticsTaskExecutionStatus;
} {
  const rawStart = task?.lg_real_start ?? task?.lgRealStart;
  const rawEnd = task?.lg_real_end ?? task?.lgRealEnd;
  const lg_real_start =
    rawStart == null || String(rawStart).trim() === "" ? null : String(rawStart);
  const lg_real_end =
    rawEnd == null || String(rawEnd).trim() === "" ? null : String(rawEnd);
  const lg_paused = parseLogisticsPaused(task?.lg_paused ?? task?.lgPaused);
  const logistics_execution_status =
    (task?.logistics_execution_status as LogisticsTaskExecutionStatus | undefined) ??
    resolveLogisticsTaskExecutionStatus({
      lg_real_start,
      lg_real_end,
      lg_paused,
    });

  return {
    lg_real_start,
    lg_real_end,
    lg_paused,
    logistics_execution_status,
  };
}
