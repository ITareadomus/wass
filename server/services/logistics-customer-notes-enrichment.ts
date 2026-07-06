import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import pool from "../../shared/pg-db";

export function sanitizeHousekeepingNotes(value: unknown): string {
  return String(value ?? "")
    .replace(/<\s*\/?\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function extractLatestNoteFromHistory(history: unknown): string | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  for (let idx = history.length - 1; idx >= 0; idx--) {
    const entry = history[idx];
    if (!entry || typeof entry !== "object") continue;
    const normalized = sanitizeHousekeepingNotes((entry as any).text);
    if (normalized) return normalized;
  }
  return null;
}

function resolveNoteFromRow(row: {
  customer_note?: unknown;
  customer_note_history?: unknown;
}): string | null {
  const fromHistory = extractLatestNoteFromHistory(row.customer_note_history);
  if (fromHistory) return fromHistory;
  const direct = sanitizeHousekeepingNotes(row.customer_note);
  return direct || null;
}

export async function loadCustomerNotesByTaskIds(
  workDate: string,
  taskIds: number[]
): Promise<Map<number, string>> {
  const ids = [...new Set(taskIds.filter((id) => Number.isFinite(id)))];
  const out = new Map<number, string>();
  if (ids.length === 0) return out;

  const result = await pool.query(
    `
      WITH candidates(task_id) AS (
        SELECT UNNEST($2::int[])
      ),
      notes AS (
        SELECT dac.task_id, dac.customer_note, dac.customer_note_history, 1 AS src_order
        FROM daily_assignments_current dac
        INNER JOIN candidates c ON c.task_id = dac.task_id
        WHERE dac.work_date = $1
          AND (dac.scope = 'housekeeping' OR dac.scope IS NULL)
        UNION ALL
        SELECT dc.task_id, dc.customer_note, dc.customer_note_history, 2 AS src_order
        FROM daily_containers dc
        INNER JOIN candidates c ON c.task_id = dc.task_id
        WHERE dc.work_date = $1
          AND (dc.scope = 'housekeeping' OR dc.scope IS NULL)
        UNION ALL
        SELECT lt.task_id, lt.customer_note, lt.customer_note_history, 3 AS src_order
        FROM lg_timeline lt
        INNER JOIN candidates c ON c.task_id = lt.task_id
        WHERE lt.work_date = $1
        UNION ALL
        SELECT lc.task_id, lc.customer_note, lc.customer_note_history, 4 AS src_order
        FROM lg_containers lc
        INNER JOIN candidates c ON c.task_id = lc.task_id
        WHERE lc.work_date = $1
      )
      SELECT DISTINCT ON (task_id)
        task_id AS "taskId",
        customer_note,
        customer_note_history
      FROM notes
      ORDER BY task_id, src_order ASC
    `,
    [workDate, ids]
  );

  for (const row of result.rows as any[]) {
    const taskId = Number(row.taskId);
    const note = resolveNoteFromRow(row);
    if (Number.isFinite(taskId) && note) {
      out.set(taskId, note);
    }
  }

  return out;
}

async function loadAdamHousekeepingNotesByTaskIds(
  taskIds: number[]
): Promise<Map<number, string>> {
  const ids = [...new Set(taskIds.filter((id) => Number.isFinite(id)))];
  const out = new Map<number, string>();
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
        SELECT id, notes
        FROM app_housekeeping
        WHERE id IN (${placeholders})
      `,
      ids
    );

    for (const row of rows as any[]) {
      const taskId = Number(row?.id);
      const note = sanitizeHousekeepingNotes(row?.notes);
      if (Number.isFinite(taskId) && note) {
        out.set(taskId, note);
      }
    }
  } catch (error: any) {
    console.warn(
      "loadAdamHousekeepingNotesByTaskIds:",
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
      const taskId = Number(task?.task_id);
      if (Number.isFinite(taskId)) taskIds.push(taskId);
    }
  }
  return taskIds;
}

export async function enrichLogisticsTimelineCustomerNotes(
  workDate: string,
  timeline: any
): Promise<void> {
  if (!timeline?.drivers_assignments?.length) return;

  const taskIds = collectTimelineTaskIds(timeline);
  if (taskIds.length === 0) return;

  const pgNotesByTaskId = await loadCustomerNotesByTaskIds(workDate, taskIds);
  const missingForAdam = taskIds.filter((taskId) => !pgNotesByTaskId.has(taskId));
  const adamNotesByTaskId =
    missingForAdam.length > 0
      ? await loadAdamHousekeepingNotesByTaskIds(missingForAdam)
      : new Map<number, string>();

  for (const entry of timeline.drivers_assignments) {
    for (const task of entry?.tasks || []) {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId)) continue;

      const existing = sanitizeHousekeepingNotes(task?.customer_note);
      if (existing) {
        task.customer_note = existing;
        continue;
      }

      const note = pgNotesByTaskId.get(taskId) ?? adamNotesByTaskId.get(taskId) ?? null;
      if (note) {
        task.customer_note = note;
      }
    }
  }
}
