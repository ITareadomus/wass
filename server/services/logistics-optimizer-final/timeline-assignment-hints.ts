import { loadLogisticsTimeline } from "../workspace-files";
import type {
  DriverId,
  HardConstraintSpec,
  TaskId,
  TimelineAssignmentHint,
} from "./input-contract";

export async function loadTimelineAssignmentHints(workDate: string): Promise<TimelineAssignmentHint[]> {
  const timeline = await loadLogisticsTimeline(workDate);
  if (!Array.isArray(timeline?.drivers_assignments)) return [];

  const hints: TimelineAssignmentHint[] = [];
  for (const driverAssignment of timeline.drivers_assignments) {
    const driverId = Number(driverAssignment?.driver?.id);
    if (!Number.isFinite(driverId)) continue;

    const tasks = Array.isArray(driverAssignment?.tasks) ? driverAssignment.tasks : [];
    for (const task of tasks) {
      if (task?.locked === true) continue;

      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId)) continue;

      hints.push({
        taskId,
        driverId,
        source: "timeline",
        sequence: Number.isFinite(Number(task?.sequence)) ? Number(task.sequence) : null,
        manuallyMoved: task?.manually_moved === true,
      });
    }
  }

  return hints;
}

export interface BuildRequiredDriverConstraintsArgs {
  hints: TimelineAssignmentHint[];
  schedulableTaskIds: Iterable<TaskId>;
  selectedDriverIds: Iterable<DriverId>;
}

export interface RequiredDriverConstraintBuildError {
  code: "MULTIPLE_REQUIRED_DRIVERS_FOR_TASK";
  taskId: TaskId;
  driverIds: DriverId[];
}

export interface BuildRequiredDriverConstraintsResult {
  constraints: HardConstraintSpec[];
  skippedHints: TimelineAssignmentHint[];
  errors: RequiredDriverConstraintBuildError[];
}

export function buildRequiredDriverConstraints(
  args: BuildRequiredDriverConstraintsArgs
): BuildRequiredDriverConstraintsResult {
  const schedulableIds = new Set(args.schedulableTaskIds);
  const driverIds = new Set(args.selectedDriverIds);
  const hintsByTask = new Map<TaskId, TimelineAssignmentHint[]>();

  for (const hint of args.hints) {
    const list = hintsByTask.get(hint.taskId) ?? [];
    list.push(hint);
    hintsByTask.set(hint.taskId, list);
  }

  const constraints: HardConstraintSpec[] = [];
  const skippedHints: TimelineAssignmentHint[] = [];
  const errors: RequiredDriverConstraintBuildError[] = [];

  for (const [taskId, taskHints] of hintsByTask) {
    const uniqueDriverIds = [...new Set(taskHints.map((hint) => hint.driverId))];
    if (uniqueDriverIds.length > 1) {
      errors.push({
        code: "MULTIPLE_REQUIRED_DRIVERS_FOR_TASK",
        taskId,
        driverIds: uniqueDriverIds,
      });
      continue;
    }

    const hint = taskHints[0];
    if (!schedulableIds.has(hint.taskId) || !driverIds.has(hint.driverId)) {
      skippedHints.push(hint);
      continue;
    }

    constraints.push({
      type: "REQUIRED_DRIVER_TASK",
      taskId: hint.taskId,
      driverId: hint.driverId,
      source: "timeline_pre_assigned",
      ...(hint.manuallyMoved ? { manuallyMoved: true } : {}),
    });
  }

  return { constraints, skippedHints, errors };
}
