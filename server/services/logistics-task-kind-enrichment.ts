import {
  buildLogisticsTaskKindPayload,
  normalizeLogisticsTaskKind,
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
