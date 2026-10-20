import pool from "../../../shared/pg-db";
import {
  HK_HYPOTHESIS_IDS,
  hkHypothesisProfileById,
  type HkHypothesisAssignment,
  type HkHypothesisPickerItem,
} from "../../../shared/hk-assignment-hypotheses";
import { runAllPhases } from "./runAllPhases";

async function loadHypothesisAssignments(runId: string): Promise<{
  assignments: HkHypothesisAssignment[];
  totalTravelMin: number;
}> {
  const rows = await pool.query<{
    task_id: number;
    cleaner_id: number;
    sequence: number | null;
    start_time: string | null;
    end_time: string | null;
    travel_minutes_from_prev: number | null;
    priority_type: string | null;
  }>(
    `SELECT task_id, cleaner_id, sequence, start_time::text, end_time::text,
            travel_minutes_from_prev, priority_type
     FROM optimizer.optimizer_assignment
     WHERE run_id = $1
     ORDER BY cleaner_id, sequence`,
    [runId]
  );
  const assignments = rows.rows.map((row) => ({
    taskId: Number(row.task_id),
    cleanerId: Number(row.cleaner_id),
    sequence: Number(row.sequence ?? 0),
    startTime: row.start_time,
    endTime: row.end_time,
    travelMin: Number(row.travel_minutes_from_prev ?? 0),
    priority: row.priority_type,
  }));
  const totalTravelMin = assignments.reduce((sum, row) => sum + row.travelMin, 0);
  return { assignments, totalTravelMin };
}

export async function runHkAssignmentHypotheses(workDate: string): Promise<HkHypothesisPickerItem[]> {
  const hypotheses: HkHypothesisPickerItem[] = [];
  for (const hypothesisId of HK_HYPOTHESIS_IDS) {
    const profile = hkHypothesisProfileById(hypothesisId);
    console.log(`[hk-hypotheses] Calcolo ipotesi ${profile.title} per ${workDate}`);
    const result = await runAllPhases(workDate, {
      hypothesisId,
      applyToProduction: false,
      recordPlan: false,
      skipPhase4: false,
    });
    if (result.status === "failed") {
      throw new Error(result.error || `Ipotesi ${profile.title} non calcolata`);
    }
    const loaded = await loadHypothesisAssignments(result.runId);
    hypotheses.push({
      summary: {
        id: profile.id,
        title: profile.title,
        description: profile.description,
        assignedTaskCount: result.summary.tasksAssigned,
        droppedTaskCount: result.summary.tasksUnassigned,
        totalTravelMin: Math.round(loaded.totalTravelMin),
      },
      runId: result.runId,
      assignments: loaded.assignments,
    });
  }
  return hypotheses;
}
