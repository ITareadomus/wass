import { query } from "../../shared/pg-db";
import { pgDailyAssignmentsService } from "./pg-daily-assignments-service";

export type DayTriadeOverride = {
  task_id: number;
  weight: number;
};

function asWeight(value: unknown): number | null {
  const weight = Number(value);
  if (!Number.isInteger(weight) || weight < 1 || weight > 3) return null;
  return weight;
}

export async function listDayTriadeOverrides(workDate: string): Promise<DayTriadeOverride[]> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  const result = await query(
    `SELECT task_id, weight
     FROM daily_task_triade_override
     WHERE work_date = $1
     ORDER BY task_id ASC`,
    [workDate]
  );
  const overrides: DayTriadeOverride[] = [];
  for (const row of result.rows) {
    const taskId = Number(row.task_id);
    const weight = asWeight(row.weight);
    if (!Number.isFinite(taskId) || taskId <= 0 || weight == null) continue;
    overrides.push({ task_id: taskId, weight });
  }
  return overrides;
}

/** weight null cancella l'eccezione e il task torna al livello ADAM. */
export async function saveDayTriadeOverride(
  workDate: string,
  taskId: number,
  weight: number | null
): Promise<void> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  if (weight == null) {
    await query(
      `DELETE FROM daily_task_triade_override WHERE work_date = $1 AND task_id = $2`,
      [workDate, taskId]
    );
    return;
  }
  await query(
    `INSERT INTO daily_task_triade_override (work_date, task_id, weight, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (work_date, task_id)
     DO UPDATE SET weight = EXCLUDED.weight, updated_at = NOW()`,
    [workDate, taskId, weight]
  );
}
