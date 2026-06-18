/**
 * @deprecated Legacy comparison script for the old bag_policy vocabulary.
 *
 * The active model is now `logistics_task_kind`
 * (`pick-up` / `delivery` / `delivery/pick-up` / null).
 * Keep this script only as historical diagnostics for legacy `phase2.ts`.
 */
import { parseHmToMinutes } from "../shared/logistics-scheduling-constraints";
import pool from "../shared/pg-db";
import { computeBagHandling } from "../server/services/logistics-optimizer-final/bag-handling";
import { computeBagPolicy } from "../server/services/logistics-optimizer/bag-rule";
import { resolveDriverBringsBagLatestStartMin } from "../server/services/logistics-optimizer-final/business-rules";
import { loadLogisticsTimeline } from "../server/services/workspace-files";

const workDate = process.argv[2] || "2026-06-18";

interface CleanerContextRow {
  taskId: number;
  cleanerId: number | null;
  cleanerSequence: number | null;
  cleanerStartTime: string | null;
  cleanerTaskStartTime: string | null;
}

async function loadCleanerContextByTaskId(
  workDate: string,
  taskIds: number[]
): Promise<Map<number, CleanerContextRow>> {
  if (taskIds.length === 0) return new Map();

  const result = await pool.query(
    `
      SELECT DISTINCT ON (dac.task_id)
        dac.task_id AS "taskId",
        dac.cleaner_id AS "cleanerId",
        dac.cleaner_start_time AS "cleanerStartTime",
        dac.start_time AS "cleanerTaskStartTime",
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
    result.rows.map((row: CleanerContextRow) => [
      Number(row.taskId),
      {
        taskId: Number(row.taskId),
        cleanerId: row.cleanerId != null ? Number(row.cleanerId) : null,
        cleanerSequence: row.cleanerSequence != null ? Number(row.cleanerSequence) : null,
        cleanerStartTime: row.cleanerStartTime ? String(row.cleanerStartTime).slice(0, 5) : null,
        cleanerTaskStartTime: row.cleanerTaskStartTime
          ? String(row.cleanerTaskStartTime).slice(0, 5)
          : null,
      },
    ])
  );
}

interface Violation {
  taskId: number;
  logisticCode: number;
  driverId: number;
  type: "CLEANER_BAG_DEADLINE" | "BAG_POLICY_MISMATCH" | "MISSING_CLEANER_CONTEXT";
  expectedBagPolicy: string;
  computedBagPolicy: string;
  startTime: string;
  latestAllowedStart: string;
  cleanerTaskStart: string | null;
  overflowMin: number;
  details?: string;
}

async function main() {
  const timeline = await loadLogisticsTimeline(workDate);

  if (!timeline?.drivers_assignments?.length) {
    console.error("No logistics timeline for", workDate);
    process.exit(1);
  }

  const timelineTaskIds = timeline.drivers_assignments.flatMap((da) =>
    (da.tasks || [])
      .map((task) => Number(task.task_id))
      .filter((taskId) => Number.isFinite(taskId))
  );
  const cleanerContextByTaskId = await loadCleanerContextByTaskId(workDate, timelineTaskIds);

  const violations: Violation[] = [];
  const summary = {
    totalTimelineTasks: 0,
    withCleanerContext: 0,
    driverBringsBag: 0,
    cleanerHasBag: 0,
    normalTask: 0,
    checkedBagDeadline: 0,
  };

  for (const da of timeline.drivers_assignments) {
    const driverId = Number(da.driver?.id);
    for (const task of da.tasks || []) {
      summary.totalTimelineTasks += 1;
      const taskId = Number(task.task_id);
      const cleanerCtx = cleanerContextByTaskId.get(taskId);
      const cleanerId = cleanerCtx?.cleanerId ?? null;
      const cleanerSequence = cleanerCtx?.cleanerSequence ?? null;
      const premium = task.premium === true;
      const paxIn = task.pax_in != null ? Number(task.pax_in) : null;

      const bagPolicy = computeBagPolicy({
        cleanerId,
        sequence: cleanerSequence,
        premium,
        paxIn,
      });
      const bagHandling = String(computeBagHandling({
        cleanerId,
        sequence: cleanerSequence,
        premium,
        paxIn,
      }) ?? "NO_CLEANER_CONTEXT");

      if (cleanerId != null && cleanerSequence != null) {
        summary.withCleanerContext += 1;
      }
      if (bagPolicy === "DRIVER_BRINGS_BAG") summary.driverBringsBag += 1;
      else if (bagPolicy === "CLEANER_HAS_BAG") summary.cleanerHasBag += 1;
      else summary.normalTask += 1;

      if (bagPolicy === "DRIVER_BRINGS_BAG" && bagHandling !== "DRIVER_BRINGS_BAG") {
        violations.push({
          taskId,
          logisticCode: Number(task.logistic_code),
          driverId,
          type: "BAG_POLICY_MISMATCH",
          expectedBagPolicy: bagPolicy,
          computedBagPolicy: bagHandling,
          startTime: String(task.start_time ?? ""),
          latestAllowedStart: "",
          cleanerTaskStart: null,
          overflowMin: 0,
          details: `bagHandling=${bagHandling} vs computeBagPolicy=${bagPolicy}`,
        });
      }

      if (bagPolicy !== "DRIVER_BRINGS_BAG") continue;

      summary.checkedBagDeadline += 1;
      const cleanerTaskStartTime =
        cleanerCtx?.cleanerTaskStartTime ?? cleanerCtx?.cleanerStartTime ?? null;
      const cleanerTaskStartMin = parseHmToMinutes(cleanerTaskStartTime, null);
      const startMin = parseHmToMinutes(task.start_time, null);

      if (cleanerTaskStartMin === null || startMin === null) {
        violations.push({
          taskId,
          logisticCode: Number(task.logistic_code),
          driverId,
          type: "MISSING_CLEANER_CONTEXT",
          expectedBagPolicy: bagPolicy,
          computedBagPolicy: bagPolicy,
          startTime: String(task.start_time ?? ""),
          latestAllowedStart: "",
          cleanerTaskStart: cleanerTaskStartTime,
          overflowMin: 0,
          details: "DRIVER_BRINGS_BAG but missing cleaner start or task start time",
        });
        continue;
      }

      const latest = resolveDriverBringsBagLatestStartMin({
        cleanerTaskStartMin,
        cleaningTimeMin: task.cleaning_time != null ? Number(task.cleaning_time) : null,
      });
      const latestStartMin = latest.value;
      const overflowMin = Math.max(0, startMin - latestStartMin);

      if (startMin > latestStartMin) {
        violations.push({
          taskId,
          logisticCode: Number(task.logistic_code),
          driverId,
          type: "CLEANER_BAG_DEADLINE",
          expectedBagPolicy: bagPolicy,
          computedBagPolicy: bagPolicy,
          startTime: String(task.start_time),
          latestAllowedStart: minutesToHm(latestStartMin),
          cleanerTaskStart: cleanerTaskStartTime,
          overflowMin,
          details: latest.trace.map((t) => t.code).join(", "),
        });
      }
    }
  }

  console.log(JSON.stringify({ workDate, summary, violationCount: violations.length, violations }, null, 2));
  process.exit(violations.length > 0 ? 1 : 0);
}

function minutesToHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
