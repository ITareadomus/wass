import type { Connection } from "mysql2/promise";
import { toAdamLogisticsOperation } from "../../shared/logistics-task-kind";

/** `driven_by_us` è NOT NULL DEFAULT 0 su ADAM: 0 = nessun driver assegnato. */
export const ADAM_LOGISTICS_UNASSIGNED_DRIVER = 0;

export interface LogisticsAdamUpdate {
  taskId: number;
  driverId: number;
  /** Ordine sul giro del driver → ADAM `lg_sequence` (non la `sequence` cleaner). */
  sequence: number;
  travelTime: number | null;
  startTime: string | null;
  endTime: string | null;
  operation: string | null;
}

export interface LogisticsAdamSyncResult {
  updated: number;
  cleared: number;
  /** Errori sulle task assegnate: critici (come `taskErrors` del transfer housekeeping). */
  errors: string[];
  clearErrors: string[];
}

/** HH:MM o HH:MM:SS (anche Date) → HH:MM:SS per le colonne MySQL TIME. */
export function formatLogisticsTimeForMySQL(value: unknown): string | null {
  if (value == null || value === "") return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }

  const trimmed = String(value).trim();
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] != null ? Number(match[3]) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function toTravelMinutes(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/** Sequenza sul giro driver → `lg_sequence` (NOT NULL DEFAULT 0). */
function toLogisticsSequence(value: unknown): number {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n);
}

function parseHmSortKey(value: unknown): number {
  const raw = String(value ?? "").trim();
  const match = /^(\d{1,2}):(\d{2})/.exec(raw);
  if (!match) return Number.POSITIVE_INFINITY;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Ordine di giro: sequence > 0, altrimenti start_time, altrimenti task_id. */
function compareLogisticsRouteOrder(left: any, right: any): number {
  const leftSeq = toLogisticsSequence(left?.sequence);
  const rightSeq = toLogisticsSequence(right?.sequence);
  if (leftSeq > 0 && rightSeq > 0 && leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  if (leftSeq > 0 && rightSeq <= 0) return -1;
  if (rightSeq > 0 && leftSeq <= 0) return 1;

  const byStart =
    parseHmSortKey(left?.start_time ?? left?.startTime) -
    parseHmSortKey(right?.start_time ?? right?.startTime);
  if (byStart !== 0) return byStart;

  return Number(left?.task_id ?? 0) - Number(right?.task_id ?? 0);
}

/**
 * Appiattisce la timeline logistica nelle righe da scrivere su `app_housekeeping`.
 * Una task assegnata a più driver non può esistere: vince la prima occorrenza.
 * `lg_sequence` usa la `sequence` di `lg_timeline` (PG); se manca, fallback 1..n
 * sull'ordine di giro del driver.
 */
export function buildLogisticsAdamUpdates(
  timeline: { drivers_assignments?: any[] } | null | undefined
): LogisticsAdamUpdate[] {
  const updates: LogisticsAdamUpdate[] = [];
  const seen = new Set<number>();

  for (const entry of timeline?.drivers_assignments ?? []) {
    const driverId = Number(entry?.driver?.id);
    if (!Number.isFinite(driverId) || driverId <= 0) continue;

    const tasks = [...(entry?.tasks ?? [])].sort(compareLogisticsRouteOrder);
    let routeSequence = 0;

    for (const task of tasks) {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId) || taskId <= 0 || seen.has(taskId)) continue;
      seen.add(taskId);
      routeSequence += 1;

      const persistedSequence = toLogisticsSequence(task?.sequence);

      updates.push({
        taskId,
        driverId,
        sequence: persistedSequence > 0 ? persistedSequence : routeSequence,
        travelTime: toTravelMinutes(task?.travel_time ?? task?.travelTime),
        startTime: formatLogisticsTimeForMySQL(task?.start_time ?? task?.startTime),
        endTime: formatLogisticsTimeForMySQL(task?.end_time ?? task?.endTime),
        operation: toAdamLogisticsOperation(task?.logistics_task_kind),
      });
    }
  }

  return updates;
}

/**
 * Task del giorno che risultano ancora assegnate a un driver su ADAM.
 * `driven_by_us` è scritto solo da WASS, quindi ogni valore non presente nella
 * timeline corrente è residuo di un transfer precedente.
 */
async function listDrivenHousekeepingTaskIds(
  connection: Connection,
  workDate: string
): Promise<number[]> {
  const [rows]: any = await connection.execute(
    `SELECT id
     FROM app_housekeeping
     WHERE checkout = ?
       AND deleted_at IS NULL
       AND deleted_at_client IS NULL
       AND driven_by_us IS NOT NULL
       AND driven_by_us <> ?
     ORDER BY id`,
    [workDate, ADAM_LOGISTICS_UNASSIGNED_DRIVER]
  );

  return (Array.isArray(rows) ? rows : [])
    .map((r: any) => Number(r?.id))
    .filter((n: number) => Number.isFinite(n));
}

/**
 * Scrive su ADAM `app_housekeeping` i dati generati dalla logistica
 * (`driven_by_us`, `lg_sequence`, `lg_travel_time`, `lg_start_time`, `lg_end_time`, `lg_operation`)
 * e azzera le task non più assegnate. Non tocca le colonne housekeeping
 * (`cleaned_by_us`, `travel_time`, `start_time`, `end_time`, `sequence`).
 */
export async function syncLogisticsTimelineToAdam(
  connection: Connection,
  params: {
    workDate: string;
    timeline: { drivers_assignments?: any[] } | null | undefined;
    adamUpdatedBy: string;
    nowRome: string;
  }
): Promise<LogisticsAdamSyncResult> {
  const { workDate, timeline, adamUpdatedBy, nowRome } = params;

  const updates = buildLogisticsAdamUpdates(timeline);
  const assignedTaskIds = new Set(updates.map((u) => u.taskId));
  const errors: string[] = [];
  const clearErrors: string[] = [];
  let updated = 0;
  let cleared = 0;

  for (const u of updates) {
    try {
      await connection.execute(
        `UPDATE app_housekeeping
         SET
           driven_by_us = ?,
           lg_sequence = ?,
           lg_travel_time = ?,
           lg_start_time = ?,
           lg_end_time = ?,
           lg_operation = ?,
           updated_by = ?,
           updated_at = ?
         WHERE id = ?`,
        [
          u.driverId,
          u.sequence,
          u.travelTime,
          u.startTime,
          u.endTime,
          u.operation,
          adamUpdatedBy,
          nowRome,
          u.taskId,
        ]
      );
      updated++;
    } catch (e: any) {
      errors.push(`task ${u.taskId}: ${e?.message || e}`);
    }
  }

  let staleTaskIds: number[] = [];
  try {
    staleTaskIds = (await listDrivenHousekeepingTaskIds(connection, workDate)).filter(
      (id) => !assignedTaskIds.has(id)
    );
  } catch (e: any) {
    clearErrors.push(`lettura task da liberare: ${e?.message || e}`);
  }

  for (const taskId of staleTaskIds) {
    try {
      await connection.execute(
        `UPDATE app_housekeeping
         SET
           driven_by_us = ?,
           lg_sequence = 0,
           lg_travel_time = NULL,
           lg_start_time = NULL,
           lg_end_time = NULL,
           lg_operation = NULL,
           updated_by = ?,
           updated_at = ?
         WHERE id = ?`,
        [ADAM_LOGISTICS_UNASSIGNED_DRIVER, adamUpdatedBy, nowRome, taskId]
      );
      cleared++;
    } catch (e: any) {
      clearErrors.push(`clear task ${taskId}: ${e?.message || e}`);
    }
  }

  return { updated, cleared, errors, clearErrors };
}
