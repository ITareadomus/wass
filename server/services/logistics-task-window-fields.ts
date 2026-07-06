import { formatWorkWindowLabel } from "../../shared/logistics-task-windows";
import type { CleanerContextForTask } from "./logistics-task-kind-enrichment";

export function attachLogisticsTaskWindowFields(
  task: any,
  cleanerCtx: CleanerContextForTask | undefined
): void {
  const hkStart = cleanerCtx?.cleanerTaskStartTime ?? null;
  const hkEnd = cleanerCtx?.cleanerTaskEndTime ?? null;

  task.hk_start_time = hkStart;
  task.hk_end_time = hkEnd;
  task.hk_window = formatWorkWindowLabel(hkStart, hkEnd);
  task.lg_window = formatWorkWindowLabel(task?.start_time ?? null, task?.end_time ?? null);
}
