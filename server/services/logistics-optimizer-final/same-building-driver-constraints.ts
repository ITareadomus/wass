import type {
  DriverId,
  DriverNode,
  HardConstraintSpec,
  RoutingProblemInput,
  TaskId,
  TaskNode,
} from "./input-contract";
import type { RoutingBusinessGroup } from "./groups/group-contract";

const DEPOT_NODE_INDEX = 0;

export type SkippedSameBuildingGroupReason =
  | "CONFLICTING_PRE_ASSIGNED_DRIVERS"
  | "PRE_ASSIGNED_DRIVER_INFEASIBLE_FOR_GROUP"
  | "NO_DRIVER_CAN_SERVE_GROUP";

export interface SkippedSameBuildingGroup {
  groupId: string;
  taskIds: TaskId[];
  reason: SkippedSameBuildingGroupReason;
  driverIds?: DriverId[];
}

export interface BuildSameBuildingDriverConstraintsArgs {
  businessGroups: RoutingBusinessGroup[];
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  existingRequiredDriverByTaskId: Map<TaskId, DriverId>;
}

export interface BuildSameBuildingDriverConstraintsResult {
  constraints: HardConstraintSpec[];
  lockedGroupCount: number;
  skippedGroups: SkippedSameBuildingGroup[];
}

function orderTasksForSameBuildingVisit(tasks: TaskNode[]): TaskNode[] {
  return [...tasks].sort((left, right) => {
    const earliestDiff = left.hardWindow.earliestStartMin - right.hardWindow.earliestStartMin;
    if (earliestDiff !== 0) return earliestDiff;

    const latestStartDiff = left.hardWindow.latestStartMin - right.hardWindow.latestStartMin;
    if (latestStartDiff !== 0) return latestStartDiff;

    return left.taskId - right.taskId;
  });
}

function tryScheduleTasksOnDriver(
  travelMatrixMin: number[][],
  driver: DriverNode,
  orderedTasks: TaskNode[]
): boolean {
  let prevEnd = driver.workWindow.startMin;
  let prevNodeIndex = DEPOT_NODE_INDEX;

  for (const task of orderedTasks) {
    const travel = travelMatrixMin[prevNodeIndex]?.[task.nodeIndex];
    if (!Number.isFinite(travel)) return false;

    const arrivalMin = prevEnd + travel;
    const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
    const endMin = startMin + task.serviceDurationMin;

    if (startMin > task.hardWindow.latestStartMin) return false;
    if (endMin > task.hardWindow.latestEndMin) return false;
    if (endMin > driver.workWindow.endMin) return false;

    prevEnd = endMin;
    prevNodeIndex = task.nodeIndex;
  }

  return true;
}

function scoreDriverForGroup(
  travelMatrixMin: number[][],
  driver: DriverNode,
  orderedTasks: TaskNode[]
): number | null {
  if (!tryScheduleTasksOnDriver(travelMatrixMin, driver, orderedTasks)) {
    return null;
  }

  const travelToFirst = travelMatrixMin[DEPOT_NODE_INDEX]?.[orderedTasks[0].nodeIndex];
  return Number.isFinite(travelToFirst) ? travelToFirst : null;
}

function pickDriverForGroup(
  drivers: DriverNode[],
  travelMatrixMin: number[][],
  orderedTasks: TaskNode[],
  preferredDriverId?: DriverId
): DriverId | null {
  if (preferredDriverId !== undefined) {
    const preferred = drivers.find((driver) => driver.id === preferredDriverId);
    if (
      preferred &&
      tryScheduleTasksOnDriver(travelMatrixMin, preferred, orderedTasks)
    ) {
      return preferredDriverId;
    }
    return null;
  }

  let bestDriverId: DriverId | null = null;
  let bestScore: number | null = null;

  for (const driver of drivers) {
    const score = scoreDriverForGroup(travelMatrixMin, driver, orderedTasks);
    if (score === null) continue;

    if (
      bestScore === null ||
      score < bestScore ||
      (score === bestScore && (bestDriverId === null || driver.id < bestDriverId))
    ) {
      bestScore = score;
      bestDriverId = driver.id;
    }
  }

  return bestDriverId;
}

export function buildSameBuildingDriverConstraints(
  args: BuildSameBuildingDriverConstraintsArgs
): BuildSameBuildingDriverConstraintsResult {
  const taskById = new Map(args.tasks.map((task) => [task.taskId, task]));
  const constraints: HardConstraintSpec[] = [];
  const skippedGroups: SkippedSameBuildingGroup[] = [];
  let lockedGroupCount = 0;

  for (const group of args.businessGroups) {
    if (group.type !== "SAME_COORDINATES_BUILDING" || group.taskIds.length < 2) {
      continue;
    }

    const groupTasks = group.taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is TaskNode => task !== undefined);

    if (groupTasks.length < 2) continue;

    const orderedTasks = orderTasksForSameBuildingVisit(groupTasks);
    const preAssignedDriverIds = [
      ...new Set(
        orderedTasks
          .map((task) => args.existingRequiredDriverByTaskId.get(task.taskId))
          .filter((driverId): driverId is DriverId => driverId !== undefined)
      ),
    ];

    if (preAssignedDriverIds.length > 1) {
      skippedGroups.push({
        groupId: group.groupId,
        taskIds: [...group.taskIds],
        reason: "CONFLICTING_PRE_ASSIGNED_DRIVERS",
        driverIds: preAssignedDriverIds,
      });
      continue;
    }

    const tasksNeedingLock = orderedTasks.filter(
      (task) => !args.existingRequiredDriverByTaskId.has(task.taskId)
    );

    if (tasksNeedingLock.length === 0) {
      continue;
    }

    const preferredDriverId = preAssignedDriverIds[0];
    const selectedDriverId = pickDriverForGroup(
      args.drivers,
      args.travelMatrixMin,
      orderedTasks,
      preferredDriverId
    );

    if (selectedDriverId === null) {
      skippedGroups.push({
        groupId: group.groupId,
        taskIds: [...group.taskIds],
        reason:
          preferredDriverId !== undefined
            ? "PRE_ASSIGNED_DRIVER_INFEASIBLE_FOR_GROUP"
            : "NO_DRIVER_CAN_SERVE_GROUP",
        ...(preferredDriverId !== undefined ? { driverIds: [preferredDriverId] } : {}),
      });
      continue;
    }

    for (const task of tasksNeedingLock) {
      constraints.push({
        type: "REQUIRED_DRIVER_TASK",
        taskId: task.taskId,
        driverId: selectedDriverId,
        source: "same_coordinates_building",
      });
    }

    lockedGroupCount += 1;
  }

  return { constraints, lockedGroupCount, skippedGroups };
}

export function buildRequiredDriverByTaskIdFromConstraints(
  hardConstraints: HardConstraintSpec[]
): Map<TaskId, DriverId> {
  const requiredDriverByTaskId = new Map<TaskId, DriverId>();
  for (const constraint of hardConstraints) {
    if (constraint.type === "REQUIRED_DRIVER_TASK") {
      requiredDriverByTaskId.set(constraint.taskId, constraint.driverId);
    }
  }
  return requiredDriverByTaskId;
}

/** Greedy feasibility check for a full group on one driver (used by tests). */
export function canDriverServeSameBuildingGroup(
  input: Pick<RoutingProblemInput, "travelMatrixMin">,
  driver: DriverNode,
  tasks: TaskNode[]
): boolean {
  return tryScheduleTasksOnDriver(
    input.travelMatrixMin,
    driver,
    orderTasksForSameBuildingVisit(tasks)
  );
}
