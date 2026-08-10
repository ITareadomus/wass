import { loadLogisticsTimeline } from "../workspace-files";
import type {
  DriverId,
  HardConstraintSpec,
  TaskId,
  TimelineAssignmentHint,
} from "./input-contract";

export interface PreAssignedTimelineParseResult {
  hints: TimelineAssignmentHint[];
  driverIdsWithPreAssignedTasks: number[];
}

export function parsePreAssignedTimelineEntries(timeline: unknown): PreAssignedTimelineParseResult {
  const hints: TimelineAssignmentHint[] = [];
  const driverIdsWithPreAssignedTasks = new Set<number>();

  const driversAssignments = (timeline as { drivers_assignments?: unknown })?.drivers_assignments;
  if (!Array.isArray(driversAssignments)) {
    return { hints, driverIdsWithPreAssignedTasks: [] };
  }

  for (const driverAssignment of driversAssignments) {
    const driverId = Number((driverAssignment as { driver?: { id?: unknown } })?.driver?.id);
    if (!Number.isFinite(driverId)) continue;

    const tasks = Array.isArray((driverAssignment as { tasks?: unknown }).tasks)
      ? (driverAssignment as { tasks: unknown[] }).tasks
      : [];
    let driverHasPreAssignedTask = false;

    for (const task of tasks) {
      // Defensive guard only: container-locked tasks must not appear on timeline (§22).
      // There is no separate "locked on timeline" class in logistics.
      if ((task as { locked?: boolean })?.locked === true) continue;

      const taskId = Number((task as { task_id?: unknown })?.task_id);
      if (!Number.isFinite(taskId)) continue;

      driverHasPreAssignedTask = true;
      hints.push({
        taskId,
        driverId,
        source: "timeline",
        sequence: Number.isFinite(Number((task as { sequence?: unknown }).sequence))
          ? Number((task as { sequence?: unknown }).sequence)
          : null,
        manuallyMoved: (task as { manually_moved?: boolean })?.manually_moved === true,
      });
    }

    if (driverHasPreAssignedTask) {
      driverIdsWithPreAssignedTasks.add(driverId);
    }
  }

  return {
    hints,
    driverIdsWithPreAssignedTasks: [...driverIdsWithPreAssignedTasks].sort((left, right) => left - right),
  };
}

export async function loadTimelineAssignmentHints(workDate: string): Promise<TimelineAssignmentHint[]> {
  const timeline = await loadLogisticsTimeline(workDate);
  return parsePreAssignedTimelineEntries(timeline).hints;
}

/**
 * Product rule: logistics has no "mandatory for a specific driver" lock.
 * Timeline assignments stay re-optimizable and must not become hard
 * REQUIRED_DRIVER_TASK constraints (those made the solver INVALID via
 * REQUIRED_DRIVER_DROPPED when a task could not stay on that driver).
 * Hints remain used for auto-convoke / metadata only.
 */
export const ENABLE_TIMELINE_REQUIRED_DRIVER_LOCKS = false;

export interface BuildRequiredDriverConstraintsArgs {
  hints: TimelineAssignmentHint[];
  schedulableTaskIds: Iterable<TaskId>;
  selectedDriverIds: Iterable<DriverId>;
  /** Test-only override; production uses ENABLE_TIMELINE_REQUIRED_DRIVER_LOCKS. */
  enableTimelineRequiredDriverLocks?: boolean;
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
  const enabled =
    args.enableTimelineRequiredDriverLocks ?? ENABLE_TIMELINE_REQUIRED_DRIVER_LOCKS;
  if (!enabled) {
    return { constraints: [], skippedHints: [], errors: [] };
  }

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
