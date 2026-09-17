import { formatWorkWindowLabel } from "../../shared/logistics-task-windows";
import type { CleanerContextForTask } from "./logistics-task-kind-enrichment";

export function attachLogisticsTaskWindowFields(
  task: any,
  cleanerCtx: CleanerContextForTask | undefined
): void {
  const hkStart =
    cleanerCtx?.cleanerTaskStartTime ??
    task?.hk_start_time ??
    task?.cleaner_task_start_time ??
    task?.cleanerTaskStartTime ??
    task?.cleaner_start_time ??
    task?.cleanerStartTime ??
    null;
  const hkEnd =
    cleanerCtx?.cleanerTaskEndTime ??
    task?.hk_end_time ??
    task?.cleaner_task_end_time ??
    task?.cleanerTaskEndTime ??
    task?.cleaner_end_time ??
    task?.cleanerEndTime ??
    null;

  task.hk_start_time = hkStart;
  task.hk_end_time = hkEnd;
  if (hkStart != null && task.cleaner_task_start_time == null) {
    task.cleaner_task_start_time = hkStart;
  }
  task.hk_window = formatWorkWindowLabel(hkStart, hkEnd);
  task.lg_window = formatWorkWindowLabel(task?.start_time ?? null, task?.end_time ?? null);
}
