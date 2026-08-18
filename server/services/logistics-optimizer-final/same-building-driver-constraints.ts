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

/**
 * Product rule: logistics never hard-locks a task to a specific driver.
 * Same-building co-location stays a soft preference via business groups.
 */
export const ENABLE_SAME_BUILDING_REQUIRED_DRIVER_LOCKS = false;

export interface BuildSameBuildingDriverConstraintsArgs {
  businessGroups: RoutingBusinessGroup[];
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  existingRequiredDriverByTaskId: Map<TaskId, DriverId>;
  /**
   * Territory-level preference calculated before synthetic same-building locks.
   * It is deliberately soft here: a different feasible driver may be selected
   * when the preferred one cannot serve the group.
   */
  preferredDriverByTaskId?: Map<TaskId, DriverId>;
  /** Test-only override; production uses ENABLE_SAME_BUILDING_REQUIRED_DRIVER_LOCKS. */
  enableSameBuildingRequiredDriverLocks?: boolean;
}

export interface BuildSameBuildingDriverConstraintsResult {
  constraints: HardConstraintSpec[];
  lockedGroupCount: number;
  skippedGroups: SkippedSameBuildingGroup[];
}

interface DriverGroupScore {
  territoryPreferenceDeficit: number;
  provisionalLoadMin: number;
  travelToFirstMin: number;
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
  orderedTasks: TaskNode[],
  territoryPreferenceDeficit: number,
  provisionalLoadMin: number
): DriverGroupScore | null {
  if (!tryScheduleTasksOnDriver(travelMatrixMin, driver, orderedTasks)) {
    return null;
  }

  const travelToFirstMin = travelMatrixMin[DEPOT_NODE_INDEX]?.[orderedTasks[0].nodeIndex];
  if (!Number.isFinite(travelToFirstMin)) return null;

  return {
    territoryPreferenceDeficit,
    provisionalLoadMin,
    travelToFirstMin,
  };
}

function isBetterDriverScore(
  candidate: DriverGroupScore,
  candidateDriverId: DriverId,
  best: DriverGroupScore | null,
  bestDriverId: DriverId | null
): boolean {
  if (best === null || bestDriverId === null) return true;

  if (candidate.territoryPreferenceDeficit !== best.territoryPreferenceDeficit) {
    return candidate.territoryPreferenceDeficit < best.territoryPreferenceDeficit;
  }
  if (candidate.provisionalLoadMin !== best.provisionalLoadMin) {
    return candidate.provisionalLoadMin < best.provisionalLoadMin;
  }
  if (candidate.travelToFirstMin !== best.travelToFirstMin) {
    return candidate.travelToFirstMin < best.travelToFirstMin;
  }
  return candidateDriverId < bestDriverId;
}

function buildTerritoryPreferenceVotes(
  drivers: DriverNode[],
  orderedTasks: TaskNode[],
  preferredDriverByTaskId?: Map<TaskId, DriverId>
): Map<DriverId, number> {
  const selectedDriverIds = new Set(drivers.map((driver) => driver.id));
  const votes = new Map<DriverId, number>();

  if (!preferredDriverByTaskId) return votes;

  for (const task of orderedTasks) {
    const driverId = preferredDriverByTaskId.get(task.taskId);
    if (driverId === undefined || !selectedDriverIds.has(driverId)) continue;
    votes.set(driverId, (votes.get(driverId) ?? 0) + 1);
  }

  return votes;
}

function pickDriverForGroup(args: {
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  orderedTasks: TaskNode[];
  requiredDriverId?: DriverId;
  preferredDriverByTaskId?: Map<TaskId, DriverId>;
  provisionalLoadMinByDriver: Map<DriverId, number>;
}): DriverId | null {
  if (args.requiredDriverId !== undefined) {
    const requiredDriver = args.drivers.find((driver) => driver.id === args.requiredDriverId);
    if (
      requiredDriver &&
      tryScheduleTasksOnDriver(args.travelMatrixMin, requiredDriver, args.orderedTasks)
    ) {
      return args.requiredDriverId;
    }
    return null;
  }

  const territoryVotes = buildTerritoryPreferenceVotes(
    args.drivers,
    args.orderedTasks,
    args.preferredDriverByTaskId
  );
  const maxTerritoryVotes = Math.max(0, ...territoryVotes.values());

  let bestDriverId: DriverId | null = null;
  let bestScore: DriverGroupScore | null = null;

  for (const driver of args.drivers) {
    const score = scoreDriverForGroup(
      args.travelMatrixMin,
      driver,
      args.orderedTasks,
      maxTerritoryVotes - (territoryVotes.get(driver.id) ?? 0),
      args.provisionalLoadMinByDriver.get(driver.id) ?? 0
    );
    if (score === null) continue;

    if (isBetterDriverScore(score, driver.id, bestScore, bestDriverId)) {
      bestScore = score;
      bestDriverId = driver.id;
    }
  }

  return bestDriverId;
}

function buildInitialProvisionalLoadMinByDriver(args: {
  tasks: TaskNode[];
  drivers: DriverNode[];
  existingRequiredDriverByTaskId: Map<TaskId, DriverId>;
}): Map<DriverId, number> {
  const provisionalLoadMinByDriver = new Map<DriverId, number>(
    args.drivers.map((driver) => [driver.id, 0])
  );

  for (const task of args.tasks) {
    const driverId = args.existingRequiredDriverByTaskId.get(task.taskId);
    if (driverId === undefined || !provisionalLoadMinByDriver.has(driverId)) continue;
    provisionalLoadMinByDriver.set(
      driverId,
      (provisionalLoadMinByDriver.get(driverId) ?? 0) + task.serviceDurationMin
    );
  }

  return provisionalLoadMinByDriver;
}

function estimateIncrementalGroupLoadMin(
  travelMatrixMin: number[][],
  orderedTasks: TaskNode[]
): number {
  let estimatedLoadMin = 0;
  let previousNodeIndex = DEPOT_NODE_INDEX;

  for (const task of orderedTasks) {
    const travelMin = travelMatrixMin[previousNodeIndex]?.[task.nodeIndex];
    if (Number.isFinite(travelMin)) {
      estimatedLoadMin += travelMin;
    }
    estimatedLoadMin += task.serviceDurationMin;
    previousNodeIndex = task.nodeIndex;
  }

  return estimatedLoadMin;
}

export function buildSameBuildingDriverConstraints(
  args: BuildSameBuildingDriverConstraintsArgs
): BuildSameBuildingDriverConstraintsResult {
  const enabled =
    args.enableSameBuildingRequiredDriverLocks ?? ENABLE_SAME_BUILDING_REQUIRED_DRIVER_LOCKS;
  if (!enabled) {
    return { constraints: [], lockedGroupCount: 0, skippedGroups: [] };
  }

  const taskById = new Map(args.tasks.map((task) => [task.taskId, task]));
  const constraints: HardConstraintSpec[] = [];
  const skippedGroups: SkippedSameBuildingGroup[] = [];
  const provisionalLoadMinByDriver = buildInitialProvisionalLoadMinByDriver(args);
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

    const requiredDriverId = preAssignedDriverIds[0];
    const selectedDriverId = pickDriverForGroup({
      drivers: args.drivers,
      travelMatrixMin: args.travelMatrixMin,
      orderedTasks,
      requiredDriverId,
      preferredDriverByTaskId: args.preferredDriverByTaskId,
      provisionalLoadMinByDriver,
    });

    if (selectedDriverId === null) {
      skippedGroups.push({
        groupId: group.groupId,
        taskIds: [...group.taskIds],
        reason:
          requiredDriverId !== undefined
            ? "PRE_ASSIGNED_DRIVER_INFEASIBLE_FOR_GROUP"
            : "NO_DRIVER_CAN_SERVE_GROUP",
        ...(requiredDriverId !== undefined ? { driverIds: [requiredDriverId] } : {}),
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

    provisionalLoadMinByDriver.set(
      selectedDriverId,
      (provisionalLoadMinByDriver.get(selectedDriverId) ?? 0) +
        estimateIncrementalGroupLoadMin(args.travelMatrixMin, tasksNeedingLock)
    );
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
