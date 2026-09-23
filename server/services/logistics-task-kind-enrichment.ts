import {
  buildLogisticsTaskKindPayload,
  resolveAutoLogisticsTaskKind,
  type LogisticsContainerKindPatch,
} from "../../shared/logistics-task-kind";
import * as mysql from "mysql2/promise";
import { databaseConfig } from "../../config/database";
import pool from "../../shared/pg-db";
import { formatHmTime } from "../../shared/logistics-task-windows";
import { pickCleanerPhone } from "../../shared/cleaner-phone";
import { attachLogisticsTaskWindowFields } from "./logistics-task-window-fields";
import { enrichLogisticsTimelineStructureSofabeds } from "./adam-structure-sofabeds";
import { enrichLogisticsTimelineStructureKeys } from "./adam-structure-keys";
import { enrichLogisticsTimelineCustomerNotes } from "./logistics-customer-notes-enrichment";
import { enrichLogisticsTimelineExecutionStatus } from "./adam-logistics-execution-status-enrichment";

export interface CleanerContextForTask {
  cleanerId: number | null;
  cleanerSequence: number | null;
  cleanerName: string | null;
  cleanerLastname: string | null;
  cleanerAlias: string | null;
  cleanerPhone: string | null;
  cleanerStartTime: string | null;
  cleanerEndTime: string | null;
  cleanerTaskStartTime: string | null;
  cleanerTaskEndTime: string | null;
}

export function attachCleanerContextFields(
  task: any,
  context: CleanerContextForTask | null | undefined
): void {
  if (!task || !context) return;
  if (context.cleanerId != null) task.cleaner_id = context.cleanerId;
  if (context.cleanerSequence != null) task.cleaner_sequence = context.cleanerSequence;
  if (context.cleanerName) task.cleaner_name = context.cleanerName;
  if (context.cleanerLastname) task.cleaner_lastname = context.cleanerLastname;
  if (context.cleanerAlias) task.cleaner_alias = context.cleanerAlias;
  if (context.cleanerPhone) task.cleaner_phone = context.cleanerPhone;
}

function withoutBagPolicy(task: any): any {
  const { bag_policy: _removed, ...rest } = task ?? {};
  return rest;
}

export function enrichLogisticsTimelineTask(
  task: any,
  cleanerId: number | null,
  cleanerSequence: number | null
): any {
  if (task?.logistics_task_kind_source === "manual") {
    const kindPayload = buildLogisticsTaskKindPayload({
      logisticsTaskKind: task?.logistics_task_kind,
      logisticsTaskKindSource: "manual",
    });
    return withoutBagPolicy({ ...task, ...kindPayload });
  }

  // Il tipo auto salvato non è una fonte: sequenza HK, pax e premium possono essere cambiati.
  const kind = resolveAutoLogisticsTaskKind({
    cleanerId,
    cleanerSequence,
    premium: task?.premium,
    paxIn: task?.pax_in,
  });

  return withoutBagPolicy({
    ...task,
    logistics_task_kind: kind,
    logistics_task_kind_source: kind ? "auto" : null,
  });
}

/**
 * Contesto cleaner già trasferito su ADAM.
 * Non legge daily_assignments_current: una sequenza cambiata solo in WASS
 * housekeeping non deve ricalcolare la logistica prima del transfer.
 */
export async function loadCleanerContextByTaskIds(
  workDate: string,
  taskIds: number[]
): Promise<Map<number, CleanerContextForTask>> {
  if (taskIds.length === 0) return new Map();

  const uniqueIds = Array.from(
    new Set(taskIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))
  );
  if (uniqueIds.length === 0) return new Map();

  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });

    const placeholders = uniqueIds.map(() => "?").join(",");
    const [rows]: any = await connection.execute(
      `
        SELECT
          h.id AS taskId,
          h.cleaned_by_us AS cleanerId,
          h.sequence AS cleanerSequence,
          u.name AS cleanerName,
          u.lastname AS cleanerLastname,
          u.phone AS cleanerPhone,
          u.mobile AS cleanerMobile,
          u.tw_start AS cleanerStartTime,
          h.start_time AS cleanerTaskStartTime,
          h.end_time AS cleanerTaskEndTime
        FROM app_housekeeping h
        LEFT JOIN app_users u ON u.id = h.cleaned_by_us
        WHERE h.checkout = ?
          AND h.id IN (${placeholders})
          AND h.deleted_at IS NULL
          AND h.deleted_at_client IS NULL
          AND h.cleaned_by_us IS NOT NULL
          AND h.cleaned_by_us > 0
      `,
      [workDate, ...uniqueIds]
    );

    const list = Array.isArray(rows) ? rows : [];
    return new Map(
      list.map((row: any) => {
        const taskId = Number(row.taskId);
        const cleanerId = Number(row.cleanerId);
        const sequence = Number(row.cleanerSequence);
        return [
          taskId,
          {
            cleanerId: Number.isFinite(cleanerId) && cleanerId > 0 ? cleanerId : null,
            cleanerSequence: Number.isFinite(sequence) && sequence > 0 ? sequence : null,
            cleanerName: row.cleanerName != null ? String(row.cleanerName).trim() || null : null,
            cleanerLastname:
              row.cleanerLastname != null ? String(row.cleanerLastname).trim() || null : null,
            cleanerAlias: null,
            cleanerPhone: pickCleanerPhone({
              phone: row.cleanerPhone,
              mobile: row.cleanerMobile,
            }),
            cleanerStartTime: formatHmTime(row.cleanerStartTime),
            cleanerEndTime: null,
            cleanerTaskStartTime: formatHmTime(row.cleanerTaskStartTime),
            cleanerTaskEndTime: formatHmTime(row.cleanerTaskEndTime),
          },
        ] as const;
      })
    );
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        /* ignore */
      }
    }
  }
}

export async function enrichDriverTasksWithLogisticsKind(
  driverEntry: { tasks: any[] },
  workDate: string
): Promise<void> {
  const taskIds = driverEntry.tasks
    .map((task) => Number(task?.task_id))
    .filter((id) => Number.isFinite(id));

  const contextByTaskId = await loadCleanerContextByTaskIds(workDate, taskIds);

  driverEntry.tasks = driverEntry.tasks.map((task) => {
    const taskId = Number(task?.task_id);
    const context = contextByTaskId.get(taskId);
    const enrichedTask = enrichLogisticsTimelineTask(
      task,
      context?.cleanerId ?? null,
      context?.cleanerSequence ?? null
    );
    attachLogisticsTaskWindowFields(enrichedTask, context);
    attachCleanerContextFields(enrichedTask, context ?? undefined);
    return enrichedTask;
  });
}

export async function loadManualLogisticsContainerTaskKinds(
  workDate: string
): Promise<Map<number, { logistics_task_kind: string | null; logistics_task_kind_source: "manual" }>> {
  const result = await pool.query(
    `
      SELECT task_id, logistics_task_kind, logistics_task_kind_source
      FROM lg_containers
      WHERE work_date = $1
        AND logistics_task_kind_source = 'manual'
    `,
    [workDate]
  );

  return new Map(
    result.rows.map((row: any) => [
      Number(row.task_id),
      {
        logistics_task_kind:
          row.logistics_task_kind != null ? String(row.logistics_task_kind) : null,
        logistics_task_kind_source: "manual" as const,
      },
    ])
  );
}

export function enrichLogisticsContainerTask(
  task: any,
  cleanerId: number | null,
  cleanerSequence: number | null
): any {
  return enrichLogisticsTimelineTask(task, cleanerId, cleanerSequence);
}

export async function syncLogisticsContainerAutoKinds(
  workDate: string,
  patches: LogisticsContainerKindPatch[]
): Promise<number> {
  if (patches.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const patch of patches) {
      await client.query(
        `
          UPDATE lg_containers
          SET logistics_task_kind = $1,
              logistics_task_kind_source = $2,
              updated_at = NOW()
          WHERE work_date = $3
            AND task_id = $4
            AND COALESCE(logistics_task_kind_source, '') <> 'manual'
        `,
        [patch.logistics_task_kind, patch.logistics_task_kind_source, workDate, patch.taskId]
      );
    }
    await client.query("COMMIT");
    return patches.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function loadManualLogisticsTimelineTaskKinds(
  workDate: string
): Promise<Map<number, { logistics_task_kind: string | null; logistics_task_kind_source: "manual" }>> {
  const result = await pool.query(
    `
      SELECT task_id, logistics_task_kind, logistics_task_kind_source
      FROM lg_timeline
      WHERE work_date = $1
        AND logistics_task_kind_source = 'manual'
    `,
    [workDate]
  );

  return new Map(
    result.rows.map((row: any) => [
      Number(row.task_id),
      {
        logistics_task_kind:
          row.logistics_task_kind != null ? String(row.logistics_task_kind) : null,
        logistics_task_kind_source: "manual" as const,
      },
    ])
  );
}

export async function syncLogisticsTimelineAutoKinds(
  workDate: string,
  patches: LogisticsContainerKindPatch[]
): Promise<number> {
  if (patches.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const patch of patches) {
      await client.query(
        `
          UPDATE lg_timeline
          SET logistics_task_kind = $1,
              logistics_task_kind_source = $2,
              updated_at = NOW()
          WHERE work_date = $3
            AND task_id = $4
            AND COALESCE(logistics_task_kind_source, '') <> 'manual'
        `,
        [patch.logistics_task_kind, patch.logistics_task_kind_source, workDate, patch.taskId]
      );
    }
    await client.query("COMMIT");
    return patches.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

export async function enrichLogisticsTimelineData(
  workDate: string,
  timeline: any,
  options?: {
    manualKindsByTaskId?: Map<
      number,
      { logistics_task_kind: string; logistics_task_kind_source: "manual" }
    >;
  }
): Promise<void> {
  if (!timeline?.drivers_assignments?.length) return;

  const taskIds = collectTimelineTaskIds(timeline);
  const [manualKindsByTaskId, cleanerContextByTaskId] = await Promise.all([
    options?.manualKindsByTaskId
      ? Promise.resolve(options.manualKindsByTaskId)
      : loadManualLogisticsTimelineTaskKinds(workDate),
    loadCleanerContextByTaskIds(workDate, taskIds),
  ]);

  for (const entry of timeline.drivers_assignments) {
    entry.tasks = (entry.tasks || []).map((task: any) => {
      const taskId = Number(task?.task_id);
      const manualKind = manualKindsByTaskId.get(taskId);
      const taskForEnrich =
        manualKind && task?.logistics_task_kind_source !== "manual"
          ? { ...task, ...manualKind }
          : task;
      const cleanerCtx = cleanerContextByTaskId.get(taskId);
      const enriched = enrichLogisticsTimelineTask(
        taskForEnrich,
        cleanerCtx?.cleanerId ?? null,
        cleanerCtx?.cleanerSequence ?? null
      );
      attachCleanerContextFields(enriched, cleanerCtx);
      attachLogisticsTaskWindowFields(enriched, cleanerCtx);
      return enriched;
    });
  }

  await enrichLogisticsTimelineStructureSofabeds(timeline);
  await enrichLogisticsTimelineStructureKeys(timeline);
  await enrichLogisticsTimelineCustomerNotes(workDate, timeline);
  await enrichLogisticsTimelineExecutionStatus(timeline);
}

async function buildAutoKindPatchesFromTaskRows(
  workDate: string,
  rows: Array<{
    task_id: number;
    logistics_task_kind: string | null;
    logistics_task_kind_source: string | null;
    premium?: boolean | null;
    pax_in?: number | null;
  }>
): Promise<LogisticsContainerKindPatch[]> {
  if (rows.length === 0) return [];

  const { buildLogisticsContainerAutoKindPatches } = await import(
    "../../shared/logistics-task-kind"
  );
  const taskIds = rows.map((row) => Number(row.task_id)).filter((id) => Number.isFinite(id));
  const cleanerContextByTaskId = await loadCleanerContextByTaskIds(workDate, taskIds);
  const enrichedTasksById = new Map<number, any>();

  for (const row of rows) {
    const task: any = {
      task_id: row.task_id,
      premium: row.premium ?? null,
      pax_in: row.pax_in ?? null,
    };
    if (row.logistics_task_kind != null) {
      task.logistics_task_kind = String(row.logistics_task_kind);
    }
    if (row.logistics_task_kind_source != null) {
      task.logistics_task_kind_source = String(row.logistics_task_kind_source);
    }
    const cleanerCtx = cleanerContextByTaskId.get(Number(row.task_id));
    enrichedTasksById.set(
      Number(row.task_id),
      enrichLogisticsContainerTask(
        task,
        cleanerCtx?.cleanerId ?? null,
        cleanerCtx?.cleanerSequence ?? null
      )
    );
  }

  return buildLogisticsContainerAutoKindPatches(rows, enrichedTasksById);
}

export async function persistLogisticsContainerAutoKindsForDate(
  workDate: string
): Promise<number> {
  const result = await pool.query(
    `
      SELECT task_id, logistics_task_kind, logistics_task_kind_source, premium, pax_in
      FROM lg_containers
      WHERE work_date = $1
      ORDER BY priority, task_id
    `,
    [workDate]
  );
  const patches = await buildAutoKindPatchesFromTaskRows(workDate, result.rows);
  return syncLogisticsContainerAutoKinds(workDate, patches);
}

export async function persistLogisticsTimelineAutoKindsForDate(
  workDate: string
): Promise<number> {
  const result = await pool.query(
    `
      SELECT task_id, logistics_task_kind, logistics_task_kind_source, premium, pax_in
      FROM lg_timeline
      WHERE work_date = $1
      ORDER BY driver_id, sequence
    `,
    [workDate]
  );
  const patches = await buildAutoKindPatchesFromTaskRows(workDate, result.rows);
  return syncLogisticsTimelineAutoKinds(workDate, patches);
}
