import pool from "../../../shared/pg-db";

export interface LogisticsTaskInputWithLock {
  taskId: number;
  logisticCode: number;
  priority: string | null;
  lat: number | null;
  lng: number | null;
  checkinDate: string | null;
  checkoutDate: string | null;
  checkinTime: string | null;
  checkoutTime: string | null;
  cleanerId: number | null;
  cleanerStartTime: string | null;
  cleanerSequence: number | null;
  premium: boolean;
  paxIn: number | null;
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
        lc.checkin_date AS "checkinDate",
        lc.checkout_date AS "checkoutDate",
        lc.checkin_time AS "checkinTime",
        lc.checkout_time AS "checkoutTime",
        lc.premium AS "premium",
        lc.pax_in AS "paxIn",
        cleaner_ctx.cleaner_id AS "cleanerId",
        cleaner_ctx.cleaner_start_time AS "cleanerStartTime",
        cleaner_ctx.cleaner_sequence AS "cleanerSequence",
        COALESCE(dtl.locked, lc.locked, false) AS "locked",
        COALESCE(dtl.locked_reason, lc.locked_reason) AS "lockedReason"
      FROM lg_containers lc
      LEFT JOIN daily_task_locks dtl
        ON dtl.work_date = lc.work_date
       AND dtl.task_id = lc.task_id
       AND dtl.locked = true
      LEFT JOIN LATERAL (
        SELECT
          dac.cleaner_id,
          dac.cleaner_start_time,
          dac.sequence AS cleaner_sequence
        FROM daily_assignments_current dac
        WHERE dac.work_date = lc.work_date
          AND dac.task_id = lc.task_id
          AND (dac.scope = 'housekeeping' OR dac.scope IS NULL)
          AND dac.cleaner_id IS NOT NULL
        ORDER BY dac.id DESC
        LIMIT 1
      ) cleaner_ctx ON true
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
    checkinDate: row.checkinDate ? String(row.checkinDate) : null,
    checkoutDate: row.checkoutDate ? String(row.checkoutDate) : null,
    checkinTime: row.checkinTime ? String(row.checkinTime).slice(0, 5) : null,
    checkoutTime: row.checkoutTime ? String(row.checkoutTime).slice(0, 5) : null,
    premium: row.premium === true,
    paxIn: row.paxIn != null ? Number(row.paxIn) : null,
    cleanerId: row.cleanerId != null ? Number(row.cleanerId) : null,
    cleanerStartTime: row.cleanerStartTime ? String(row.cleanerStartTime).slice(0, 5) : null,
    cleanerSequence: row.cleanerSequence != null ? Number(row.cleanerSequence) : null,
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
