import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import {
  normalizeHousekeepingStartworkAt,
  parseHousekeepingFlag,
  resolveHousekeepingTaskExecutionStatus,
  type HousekeepingTaskExecutionStatus,
} from "../../shared/housekeeping-task-execution-status";

export type AdamHousekeepingExecutionFields = {
  startwork: boolean;
  cleaned: boolean;
  startwork_at: string | null;
  housekeeping_execution_status: HousekeepingTaskExecutionStatus;
};

export function collectNumericHousekeepingTaskIds(
  values: Array<{ task_id?: unknown; id?: unknown } | string | number | null | undefined>
): number[] {
  const ids: number[] = [];
  for (const value of values) {
    if (value == null) continue;
    const raw =
      typeof value === "object" ? (value.task_id ?? value.id) : value;
    const id = Number(raw);
    if (Number.isFinite(id) && id > 0) ids.push(id);
  }
  return [...new Set(ids)];
}

export async function findFirstCleanedHousekeepingTaskId(
  taskIds: Array<{ task_id?: unknown; id?: unknown } | string | number | null | undefined>
): Promise<number | null> {
  const ids = collectNumericHousekeepingTaskIds(taskIds);
  if (ids.length === 0) return null;
  const byId = await loadAdamHousekeepingExecutionStatusByTaskIds(ids);
  for (const id of ids) {
    if (byId.get(id)?.cleaned) return id;
  }
  return null;
}

export async function loadAdamHousekeepingExecutionStatusByTaskIds(
  taskIds: number[]
): Promise<Map<number, AdamHousekeepingExecutionFields>> {
  const ids = [...new Set(taskIds.filter((id) => Number.isFinite(id)))];
  const out = new Map<number, AdamHousekeepingExecutionFields>();
  if (ids.length === 0) return out;

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });

    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await connection.execute(
      `
        SELECT id, startwork, cleaned, DATE_FORMAT(startwork_at, '%Y-%m-%dT%H:%i:%s') AS startwork_at
        FROM app_housekeeping
        WHERE id IN (${placeholders})
      `,
      ids
    );

    for (const row of rows as any[]) {
      const taskId = Number(row?.id);
      if (!Number.isFinite(taskId)) continue;
      const startwork = parseHousekeepingFlag(row?.startwork);
      const cleaned = parseHousekeepingFlag(row?.cleaned);
      const startwork_at = normalizeHousekeepingStartworkAt(row?.startwork_at);
      out.set(taskId, {
        startwork,
        cleaned,
        startwork_at,
        housekeeping_execution_status: resolveHousekeepingTaskExecutionStatus({
          startwork,
          cleaned,
        }),
      });
    }
  } catch (error: any) {
    console.warn(
      "loadAdamHousekeepingExecutionStatusByTaskIds:",
      error?.message || error
    );
  } finally {
    await connection?.end();
  }

  return out;
}

export function collectHousekeepingTimelineTaskIds(timeline: any): number[] {
  const taskIds: number[] = [];
  for (const entry of timeline?.cleaners_assignments || []) {
    for (const task of entry?.tasks || []) {
      const taskId = Number(task?.task_id ?? task?.id);
      if (Number.isFinite(taskId)) taskIds.push(taskId);
    }
  }
  return taskIds;
}

export function serializeHousekeepingExecutionStatusMap(
  byTaskId: Map<number, AdamHousekeepingExecutionFields>
): Record<string, AdamHousekeepingExecutionFields> {
  const statuses: Record<string, AdamHousekeepingExecutionFields> = {};
  for (const [taskId, fields] of byTaskId) {
    statuses[String(taskId)] = fields;
  }
  return statuses;
}

export function attachHousekeepingExecutionStatusFields(
  task: any,
  fields: AdamHousekeepingExecutionFields | undefined
): void {
  if (!task || !fields) return;
  task.startwork = fields.startwork;
  task.cleaned = fields.cleaned;
  task.startwork_at = fields.startwork_at;
  task.housekeeping_execution_status = fields.housekeeping_execution_status;
}

export async function enrichHousekeepingTimelineExecutionStatus(
  timeline: any
): Promise<void> {
  if (!timeline?.cleaners_assignments?.length) return;

  const taskIds = collectHousekeepingTimelineTaskIds(timeline);
  if (taskIds.length === 0) return;

  const byTaskId = await loadAdamHousekeepingExecutionStatusByTaskIds(taskIds);
  if (byTaskId.size === 0) return;

  for (const entry of timeline.cleaners_assignments) {
    for (const task of entry?.tasks || []) {
      const taskId = Number(task?.task_id ?? task?.id);
      if (!Number.isFinite(taskId)) continue;
      attachHousekeepingExecutionStatusFields(task, byTaskId.get(taskId));
    }
  }
}

/** Carica solo gli stati esecuzione Adam per i task già in timeline (niente ricalcolo). */
export async function loadHousekeepingTimelineExecutionStatusByDate(
  workDate: string,
  scope: "housekeeping" | "office" = "housekeeping"
): Promise<Record<string, AdamHousekeepingExecutionFields>> {
  const { loadTimeline } = await import("./workspace-files");
  const timeline = await loadTimeline(workDate, scope);
  const taskIds = collectHousekeepingTimelineTaskIds(timeline);
  if (taskIds.length === 0) return {};
  const byTaskId = await loadAdamHousekeepingExecutionStatusByTaskIds(taskIds);
  return serializeHousekeepingExecutionStatusMap(byTaskId);
}
