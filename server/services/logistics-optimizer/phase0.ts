import pool from "../../../shared/pg-db";

export interface LogisticsTaskInputWithLock {
  taskId: number;
  logisticCode: number;
  priority: string | null;
  lat: number | null;
  lng: number | null;
  locked: boolean;
  lockedReason: string | null;
}

export interface LogisticsPhase0Result {
  canRun: boolean;
  phase: 0;
  workDate: string;
  totalLogisticsTasks: number;
  lockedTasksExcluded: number;
  unlockedTasks: number;
  unlockedTaskData: LogisticsTaskInputWithLock[];
}

async function loadLogisticsTasksWithLockStatus(workDate: string): Promise<LogisticsTaskInputWithLock[]> {
  const result = await pool.query(
    `
      SELECT
        lc.task_id AS "taskId",
        lc.logistic_code AS "logisticCode",
        lc.priority AS "priority",
        lc.lat AS "lat",
        lc.lng AS "lng",
        COALESCE(dtl.locked, lc.locked, false) AS "locked",
        COALESCE(dtl.locked_reason, lc.locked_reason) AS "lockedReason"
      FROM lg_containers lc
      LEFT JOIN daily_task_locks dtl
        ON dtl.work_date = lc.work_date
       AND dtl.task_id = lc.task_id
       AND dtl.locked = true
      WHERE lc.work_date = $1
      ORDER BY lc.task_id
    `,
    [workDate]
  );

  return result.rows.map((row: any) => ({
    taskId: Number(row.taskId),
    logisticCode: Number(row.logisticCode),
    priority: row.priority ? String(row.priority) : null,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    locked: row.locked === true,
    lockedReason: row.lockedReason ? String(row.lockedReason) : null,
  }));
}

export async function runLogisticsPhase0(workDate: string): Promise<LogisticsPhase0Result> {
  const allTasks = await loadLogisticsTasksWithLockStatus(workDate);
  const unlockedTaskData = allTasks.filter((task) => !task.locked);
  const lockedTasksExcluded = allTasks.length - unlockedTaskData.length;

  return {
    canRun: true,
    phase: 0,
    workDate,
    totalLogisticsTasks: allTasks.length,
    lockedTasksExcluded,
    unlockedTasks: unlockedTaskData.length,
    unlockedTaskData,
  };
}
