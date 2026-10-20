import { query } from "../../shared/pg-db";
import { pgDailyAssignmentsService } from "./pg-daily-assignments-service";

export type DayCleanerTriadeOverride = {
  cleaner_id: number;
  weight: number;
};

function asWeight(value: unknown): number | null {
  const weight = Number(value);
  if (!Number.isInteger(weight) || weight < 1) return null;
  return weight;
}

export async function listDayCleanerTriadeOverrides(workDate: string): Promise<DayCleanerTriadeOverride[]> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  const result = await query(
    `SELECT cleaner_id, weight
     FROM daily_cleaner_triade_override
     WHERE work_date = $1
     ORDER BY cleaner_id ASC`,
    [workDate]
  );
  const overrides: DayCleanerTriadeOverride[] = [];
  for (const row of result.rows) {
    const cleanerId = Number(row.cleaner_id);
    const weight = asWeight(row.weight);
    if (!Number.isFinite(cleanerId) || cleanerId <= 0 || weight == null) continue;
    overrides.push({ cleaner_id: cleanerId, weight });
  }
  return overrides;
}

/** weight null cancella l'eccezione e il cleaner torna al livello ADAM. */
export async function saveDayCleanerTriadeOverride(
  workDate: string,
  cleanerId: number,
  weight: number | null
): Promise<void> {
  await pgDailyAssignmentsService.ensureTriadeOverrideTable();
  if (weight == null) {
    await query(
      `DELETE FROM daily_cleaner_triade_override WHERE work_date = $1 AND cleaner_id = $2`,
      [workDate, cleanerId]
    );
    return;
  }
  await query(
    `INSERT INTO daily_cleaner_triade_override (work_date, cleaner_id, weight, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (work_date, cleaner_id)
     DO UPDATE SET weight = EXCLUDED.weight, updated_at = NOW()`,
    [workDate, cleanerId, weight]
  );
}
