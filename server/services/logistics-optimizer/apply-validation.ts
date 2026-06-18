import fs from "fs/promises";
import path from "path";
import { getLogisticsTimelineViolations } from "../../../shared/logistics-scheduling-constraints";

export interface LogisticsCheckinViolationRow {
  taskId: number;
  logisticCode: number;
  driverId: number;
  sequence: number;
  startTime: string;
  endTime: string;
  checkinTime: string;
  checkinDate: string | null;
  checkinViolated: boolean;
  startAtOrAfterCheckin: boolean;
}

export interface LogisticsCheckoutWaitViolationRow {
  taskId: number;
  logisticCode: number;
  driverId: number;
  sequence: number;
  startTime: string;
  checkoutTime: string;
  checkoutWaitMinutes: number;
}

export interface LogisticsFinalDriverPlanRow {
  driverId: number;
  driverName: string;
  tasks: Array<{
    taskId: number;
    logisticCode: number;
    sequence: number;
    startTime: string | null;
    endTime: string | null;
    checkoutTime: string | null;
    checkinTime: string | null;
    checkinDate: string | null;
    travelTime: number;
    checkoutWaitMinutes: number;
    checkinViolated: boolean;
    startAtOrAfterCheckin: boolean;
    checkoutWaitExceeded: boolean;
  }>;
}

export interface LogisticsFinalTimelineValidation {
  workDate: string;
  checkinViolations: LogisticsCheckinViolationRow[];
  checkoutWaitExceeded: LogisticsCheckoutWaitViolationRow[];
  finalDriverPlans: LogisticsFinalDriverPlanRow[];
}

export function buildFinalTimelineValidation(
  timeline: { drivers_assignments?: unknown[] },
  workDate: string
): LogisticsFinalTimelineValidation {
  const checkinViolations: LogisticsCheckinViolationRow[] = [];
  const checkoutWaitExceeded: LogisticsCheckoutWaitViolationRow[] = [];
  const finalDriverPlans: LogisticsFinalDriverPlanRow[] = [];

  for (const entry of ensureArray(timeline?.drivers_assignments)) {
    const driver = (entry as any)?.driver ?? {};
    const driverId = Number(driver?.id);
    const driverName = `${String(driver?.name ?? "").trim()} ${String(driver?.lastname ?? "").trim()}`.trim();
    const planTasks: LogisticsFinalDriverPlanRow["tasks"] = [];

    for (const task of ensureArray((entry as any)?.tasks)) {
      const taskId = Number(task?.task_id);
      const logisticCode = Number(task?.logistic_code);
      const sequence = Number(task?.sequence ?? 0);
      const violations = getLogisticsTimelineViolations(
        {
          start_time: task?.start_time,
          end_time: task?.end_time,
          checkout_time: task?.checkout_time,
          checkout_date: task?.checkout_date,
          checkin_time: task?.checkin_time,
          checkin_date: task?.checkin_date,
          checkout_wait_minutes: task?.checkout_wait_minutes,
        },
        workDate
      );

      const row = {
        taskId,
        logisticCode,
        sequence,
        startTime: task?.start_time ?? null,
        endTime: task?.end_time ?? null,
        checkoutTime: task?.checkout_time ?? null,
        checkinTime: task?.checkin_time ?? null,
        checkinDate: task?.checkin_date ?? null,
        travelTime: Number(task?.travel_time ?? 0),
        checkoutWaitMinutes: Number(task?.checkout_wait_minutes ?? 0),
        checkinViolated: violations.checkinViolated,
        startAtOrAfterCheckin: violations.startAtOrAfterCheckin,
        checkoutWaitExceeded: violations.checkoutWaitExceeded,
      };
      planTasks.push(row);

      if (violations.checkinViolated || violations.startAtOrAfterCheckin) {
        checkinViolations.push({
          taskId,
          logisticCode,
          driverId,
          sequence,
          startTime: String(task?.start_time ?? ""),
          endTime: String(task?.end_time ?? ""),
          checkinTime: String(task?.checkin_time ?? ""),
          checkinDate: task?.checkin_date ?? null,
          checkinViolated: violations.checkinViolated,
          startAtOrAfterCheckin: violations.startAtOrAfterCheckin,
        });
      }

      if (violations.checkoutWaitExceeded) {
        checkoutWaitExceeded.push({
          taskId,
          logisticCode,
          driverId,
          sequence,
          startTime: String(task?.start_time ?? ""),
          checkoutTime: String(task?.checkout_time ?? ""),
          checkoutWaitMinutes: Number(task?.checkout_wait_minutes ?? 0),
        });
      }
    }

    if (planTasks.length > 0) {
      finalDriverPlans.push({
        driverId,
        driverName,
        tasks: planTasks,
      });
    }
  }

  return {
    workDate,
    checkinViolations,
    checkoutWaitExceeded,
    finalDriverPlans,
  };
}

export function assertLogisticsTimelineValidAfterRecalc(
  validation: LogisticsFinalTimelineValidation
): void {
  if (validation.checkinViolations.length === 0) return;

  const msg = validation.checkinViolations
    .map((v) => {
      const flags = [
        v.checkinViolated ? `fine ${v.endTime} > check-in ${v.checkinTime}` : null,
        v.startAtOrAfterCheckin ? `inizio ${v.startTime} >= check-in ${v.checkinTime}` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `Task ${v.logisticCode} (driver ${v.driverId}, seq ${v.sequence}): ${flags}`;
    })
    .join("; ");

  throw new Error(
    `Invariant violation: optimizer produced invalid check-in plan after final recalculation. ${msg}`
  );
}

export async function writeFinalTimelineValidationDebugFile(
  debugDir: string,
  validation: LogisticsFinalTimelineValidation
): Promise<void> {
  const filePath = path.join(debugDir, "05-final-timeline-validation.json");
  await fs.writeFile(
    filePath,
    JSON.stringify(
      {
        ...validation,
        phase2PlanValid: true,
        finalTimelineValid: validation.checkinViolations.length === 0,
        note:
          "Validazione post-recalculateLogisticsTimeline (apply). Diverge da 04-summary (solo Phase2).",
      },
      null,
      2
    ),
    "utf8"
  );

  const manifestPath = path.join(debugDir, "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(raw) as { files?: string[] };
    if (!manifest.files?.includes("05-final-timeline-validation.json")) {
      manifest.files = [...(manifest.files ?? []), "05-final-timeline-validation.json"];
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    }
  } catch {
    /* manifest opzionale */
  }
}

function ensureArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
