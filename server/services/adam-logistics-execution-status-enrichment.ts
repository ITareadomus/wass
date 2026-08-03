import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import {
  parseLogisticsPaused,
  resolveLogisticsTaskExecutionStatus,
  type LogisticsTaskExecutionStatus,
} from "../../shared/logistics-task-execution-status";

export type AdamLogisticsExecutionFields = {
  lg_real_start: string | null;
  lg_real_end: string | null;
  lg_paused: boolean;
  logistics_execution_status: LogisticsTaskExecutionStatus;
};

function normalizeAdamTime(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const hh = String(value.getUTCHours()).padStart(2, "0");
    const mm = String(value.getUTCMinutes()).padStart(2, "0");
    const ss = String(value.getUTCSeconds()).padStart(2, "0");
    const text = `${hh}:${mm}:${ss}`;
    return text === "00:00:00" ? null : text;
  }
  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8").trim();
    return text && text !== "00:00:00" ? text : null;
  }
  const text = String(value).trim();
  if (!text || text === "00:00:00") return null;
  // mysql2 may return "HH:MM:SS" or "HH:MM:SS.000000"
  const match = text.match(/^(\d{1,2}:\d{2}(?::\d{2})?)/);
  return match?.[1] ?? text;
}

export async function loadAdamLogisticsExecutionStatusByTaskIds(
  taskIds: number[]
): Promise<Map<number, AdamLogisticsExecutionFields>> {
  const ids = [...new Set(taskIds.filter((id) => Number.isFinite(id)))];
  const out = new Map<number, AdamLogisticsExecutionFields>();
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
        SELECT id, lg_real_start, lg_real_end, lg_paused
        FROM app_housekeeping
        WHERE id IN (${placeholders})
      `,
      ids
    );

    for (const row of rows as any[]) {
      const taskId = Number(row?.id);
      if (!Number.isFinite(taskId)) continue;
      const lg_real_start = normalizeAdamTime(row?.lg_real_start);
      const lg_real_end = normalizeAdamTime(row?.lg_real_end);
      const lg_paused = parseLogisticsPaused(row?.lg_paused);
      out.set(taskId, {
        lg_real_start,
        lg_real_end,
        lg_paused,
        logistics_execution_status: resolveLogisticsTaskExecutionStatus({
          lg_real_start,
          lg_real_end,
          lg_paused,
        }),
      });
    }
  } catch (error: any) {
    console.warn(
      "loadAdamLogisticsExecutionStatusByTaskIds:",
      error?.message || error
    );
  } finally {
    await connection?.end();
  }

  return out;
}

function collectTimelineTaskIds(timeline: any): number[] {
  const taskIds: number[] = [];
  for (const entry of timeline?.drivers_assignments || []) {
    for (const task of entry?.tasks || []) {
      const taskId = Number(task?.task_id ?? task?.id);
      if (Number.isFinite(taskId)) taskIds.push(taskId);
    }
  }
  return taskIds;
}

export function attachLogisticsExecutionStatusFields(
  task: any,
  fields: AdamLogisticsExecutionFields | undefined
): void {
  if (!task || !fields) return;
  task.lg_real_start = fields.lg_real_start;
  task.lg_real_end = fields.lg_real_end;
  task.lg_paused = fields.lg_paused;
  task.logistics_execution_status = fields.logistics_execution_status;
}

export async function enrichLogisticsTimelineExecutionStatus(
  timeline: any
): Promise<void> {
  if (!timeline?.drivers_assignments?.length) return;

  const taskIds = collectTimelineTaskIds(timeline);
  if (taskIds.length === 0) return;

  const byTaskId = await loadAdamLogisticsExecutionStatusByTaskIds(taskIds);
  if (byTaskId.size === 0) return;

  for (const entry of timeline.drivers_assignments) {
    for (const task of entry?.tasks || []) {
      const taskId = Number(task?.task_id ?? task?.id);
      if (!Number.isFinite(taskId)) continue;
      attachLogisticsExecutionStatusFields(task, byTaskId.get(taskId));
    }
  }
}
