import {
  buildLogisticsTaskKindPayload,
  normalizeLogisticsTaskKind,
  type LogisticsContainerKindPatch,
} from "../../shared/logistics-task-kind";
import pool from "../../shared/pg-db";

export interface CleanerContextForTask {
  cleanerId: number | null;
  cleanerSequence: number | null;
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
  const manualKind = normalizeLogisticsTaskKind(
    task?.logistics_task_kind,
    task?.logistics_task_kind_source
  );
  if (task?.logistics_task_kind_source === "manual" && manualKind) {
    const kindPayload = buildLogisticsTaskKindPayload({
      logisticsTaskKind: manualKind,
      logisticsTaskKindSource: "manual",
    });
    return withoutBagPolicy({ ...task, ...kindPayload });
  }

  const kindPayload = buildLogisticsTaskKindPayload({
    cleanerId,
    cleanerSequence,
    premium: task?.premium,
    paxIn: task?.pax_in,
    logisticsTaskKind: task?.logistics_task_kind,
    logisticsTaskKindSource: task?.logistics_task_kind_source,
  });

  return withoutBagPolicy({
    ...task,
    ...kindPayload,
  });
}

export async function loadCleanerContextByTaskIds(
  workDate: string,
  taskIds: number[]
): Promise<Map<number, CleanerContextForTask>> {
  if (taskIds.length === 0) return new Map();

  const result = await pool.query(
    `
      SELECT DISTINCT ON (dac.task_id)
        dac.task_id AS "taskId",
        dac.cleaner_id AS "cleanerId",
        dac.sequence AS "cleanerSequence"
      FROM daily_assignments_current dac
      WHERE dac.work_date = $1
        AND dac.task_id = ANY($2::int[])
        AND (dac.scope = 'housekeeping' OR dac.scope IS NULL)
        AND dac.cleaner_id IS NOT NULL
      ORDER BY dac.task_id, dac.id DESC
    `,
    [workDate, taskIds]
  );

  return new Map(
    result.rows.map((row: any) => [
      Number(row.taskId),
      {
        cleanerId: row.cleanerId != null ? Number(row.cleanerId) : null,
        cleanerSequence: row.cleanerSequence != null ? Number(row.cleanerSequence) : null,
      },
    ])
  );
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
    return enrichLogisticsTimelineTask(
      task,
      context?.cleanerId ?? null,
      context?.cleanerSequence ?? null
    );
  });
}

export async function loadManualLogisticsContainerTaskKinds(
  workDate: string
): Promise<Map<number, { logistics_task_kind: string; logistics_task_kind_source: "manual" }>> {
  const result = await pool.query(
    `
      SELECT task_id, logistics_task_kind, logistics_task_kind_source
      FROM lg_containers
      WHERE work_date = $1
        AND logistics_task_kind_source = 'manual'
        AND logistics_task_kind IS NOT NULL
    `,
    [workDate]
  );

  return new Map(
    result.rows.map((row: any) => [
      Number(row.task_id),
      {
        logistics_task_kind: String(row.logistics_task_kind),
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
): Promise<Map<number, { logistics_task_kind: string; logistics_task_kind_source: "manual" }>> {
  const result = await pool.query(
    `
      SELECT task_id, logistics_task_kind, logistics_task_kind_source
      FROM lg_timeline
      WHERE work_date = $1
        AND logistics_task_kind_source = 'manual'
        AND logistics_task_kind IS NOT NULL
    `,
    [workDate]
  );

  return new Map(
    result.rows.map((row: any) => [
      Number(row.task_id),
      {
        logistics_task_kind: String(row.logistics_task_kind),
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
      if (cleanerCtx?.cleanerId != null) {
        enriched.cleaner_id = cleanerCtx.cleanerId;
      }
      if (cleanerCtx?.cleanerSequence != null) {
        enriched.cleaner_sequence = cleanerCtx.cleanerSequence;
      }
      return enriched;
    });
  }
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
