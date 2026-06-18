import type { DriverNode, RoutingProblemInput, TaskNode } from "./input-contract";
import type { RoutingDroppedTask, RoutingSolution } from "./solution-contract";

const DEPOT_NODE_INDEX = 0;

export type LegacyDroppedTaskReason =
  | "CHECKIN_CHECKOUT_CONSTRAINT"
  | "CLEANER_TIME_CONSTRAINT"
  | "NO_DRIVER_FEASIBLE"
  | "TRULY_IMPOSSIBLE"
  | "REQUIRED_DRIVER_INFEASIBLE"
  | "MISSING_TRAVEL_MATRIX"
  | "UNKNOWN";

export interface DroppedTaskDriverDiagnostic {
  driverId: number;
  reason: LegacyDroppedTaskReason;
  details?: string;
}

export interface DroppedTaskDiagnostic {
  taskId: number;
  reason: LegacyDroppedTaskReason;
  solverReason?: RoutingDroppedTask["reason"];
  diagnostics: {
    failedDrivers: DroppedTaskDriverDiagnostic[];
  };
}

function buildRequiredDriverByTaskId(input: RoutingProblemInput): Map<number, number> {
  const requiredDriverByTaskId = new Map<number, number>();
  for (const constraint of input.hardConstraints) {
    if (constraint.type === "REQUIRED_DRIVER_TASK") {
      requiredDriverByTaskId.set(constraint.taskId, constraint.driverId);
    }
  }
  return requiredDriverByTaskId;
}

function getTravelMin(
  input: RoutingProblemInput,
  fromNodeIndex: number,
  toNodeIndex: number
): number | null {
  const matrix = input.travelMatrixMin;
  if (
    fromNodeIndex < 0 ||
    fromNodeIndex >= matrix.length ||
    toNodeIndex < 0 ||
    toNodeIndex >= (matrix[fromNodeIndex]?.length ?? 0)
  ) {
    return null;
  }
  const travel = matrix[fromNodeIndex][toNodeIndex];
  return Number.isFinite(travel) ? travel : null;
}

function classifyWindowFailure(
  task: TaskNode,
  startMin: number,
  endMin: number
): LegacyDroppedTaskReason {
  const hasCheckinConstraint = Boolean(task.rawTimes.checkinTime && task.rawTimes.checkinDate);
  const hasCleanerConstraint = Boolean(
    task.rawTimes.cleanerTaskStartTime || task.rawTimes.cleanerStartTime
  );

  if (hasCheckinConstraint && endMin > task.hardWindow.latestEndMin) {
    return "CHECKIN_CHECKOUT_CONSTRAINT";
  }
  if (hasCleanerConstraint && startMin > task.hardWindow.latestStartMin) {
    return "CLEANER_TIME_CONSTRAINT";
  }
  return "CHECKIN_CHECKOUT_CONSTRAINT";
}

function simulateSingleTaskOnDriver(
  input: RoutingProblemInput,
  driver: DriverNode,
  task: TaskNode
): { feasible: true } | { feasible: false; reason: LegacyDroppedTaskReason; details?: string } {
  const travel = getTravelMin(input, DEPOT_NODE_INDEX, task.nodeIndex);
  if (travel === null) {
    return { feasible: false, reason: "MISSING_TRAVEL_MATRIX" };
  }

  const arrivalMin = driver.workWindow.startMin + travel;
  const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
  const endMin = startMin + task.serviceDurationMin;

  if (startMin > task.hardWindow.latestStartMin || endMin > task.hardWindow.latestEndMin) {
    return {
      feasible: false,
      reason: classifyWindowFailure(task, startMin, endMin),
      details: "Task hard window violated",
    };
  }

  if (endMin > driver.workWindow.endMin) {
    return {
      feasible: false,
      reason: "NO_DRIVER_FEASIBLE",
      details: "Driver work window exceeded",
    };
  }

  return { feasible: true };
}

function mapLegacyReason(args: {
  task: TaskNode;
  requiredDriverId?: number;
  failedDrivers: DroppedTaskDriverDiagnostic[];
  checkedDriverCount: number;
  solverReason?: RoutingDroppedTask["reason"];
}): LegacyDroppedTaskReason {
  if (args.requiredDriverId !== undefined) {
    return "REQUIRED_DRIVER_INFEASIBLE";
  }

  if (
    args.failedDrivers.length > 0 &&
    args.failedDrivers.every((entry) => entry.reason === "MISSING_TRAVEL_MATRIX")
  ) {
    return "MISSING_TRAVEL_MATRIX";
  }

  const failedDriverCount = args.failedDrivers.length;

  if (args.checkedDriverCount > 0 && failedDriverCount === args.checkedDriverCount) {
    return "TRULY_IMPOSSIBLE";
  }

  if (failedDriverCount > 0 && failedDriverCount < args.checkedDriverCount) {
    return "NO_DRIVER_FEASIBLE";
  }

  if (failedDriverCount === 0 && args.checkedDriverCount > 0) {
    return "NO_DRIVER_FEASIBLE";
  }

  return args.solverReason === "OUTSIDE_TIME_WINDOWS"
    ? "CHECKIN_CHECKOUT_CONSTRAINT"
    : "UNKNOWN";
}

export function diagnoseDroppedTasks(
  input: RoutingProblemInput,
  solution: RoutingSolution
): DroppedTaskDiagnostic[] {
  if (solution.droppedTasks.length === 0) return [];

  const requiredDriverByTaskId = buildRequiredDriverByTaskId(input);
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const drivers = [...input.drivers].sort((left, right) => left.id - right.id);

  return solution.droppedTasks.map((dropped) => {
    const task = taskById.get(dropped.taskId);
    const requiredDriverId = requiredDriverByTaskId.get(dropped.taskId);
    const failedDrivers: DroppedTaskDriverDiagnostic[] = [];

    if (!task) {
      return {
        taskId: dropped.taskId,
        reason: "UNKNOWN" as const,
        solverReason: dropped.reason,
        diagnostics: { failedDrivers },
      };
    }

    const driversToCheck =
      requiredDriverId !== undefined
        ? drivers.filter((driver) => driver.id === requiredDriverId)
        : drivers;

    for (const driver of driversToCheck) {
      const simulation = simulateSingleTaskOnDriver(input, driver, task);
      if (!simulation.feasible) {
        failedDrivers.push({
          driverId: driver.id,
          reason: simulation.reason,
          details: simulation.details,
        });
      }
    }

    if (requiredDriverId !== undefined && driversToCheck.length === 0) {
      failedDrivers.push({
        driverId: requiredDriverId,
        reason: "REQUIRED_DRIVER_INFEASIBLE",
        details: "Required driver is not selected",
      });
    }

    const reason = mapLegacyReason({
      task,
      requiredDriverId,
      failedDrivers,
      checkedDriverCount: driversToCheck.length,
      solverReason: dropped.reason,
    });

    return {
      taskId: dropped.taskId,
      reason,
      solverReason: dropped.reason,
      diagnostics: { failedDrivers },
    };
  });
}
