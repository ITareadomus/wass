import type { RoutingProblemInput } from "../../input-contract";
import {
  ORTOOLS_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingDroppedTask,
  type RoutingSolution,
} from "../../solution-contract";
import { buildOrToolsMaps } from "./ortools-adapter";

const DEPOT_NODE_INDEX = 0;

export interface MissingRequiredVehicleTask {
  taskId: number;
  requiredDriverId: number;
}

export function findTasksWithMissingRequiredVehicle(
  input: RoutingProblemInput
): MissingRequiredVehicleTask[] {
  const maps = buildOrToolsMaps(input);
  const missing: MissingRequiredVehicleTask[] = [];

  for (const task of input.tasks) {
    const requiredDriverId = maps.requiredDriverByTaskId.get(task.taskId);
    if (requiredDriverId === undefined) continue;
    if (!maps.driverIdToVehicleIndex.has(requiredDriverId)) {
      missing.push({ taskId: task.taskId, requiredDriverId });
    }
  }

  return missing;
}

export function buildRequiredDriverNotSelectedSolution(
  input: RoutingProblemInput,
  missingTasks: MissingRequiredVehicleTask[],
  options?: { generatedAt?: string; solveDurationMs?: number }
): RoutingSolution {
  const missingByTaskId = new Map(missingTasks.map((entry) => [entry.taskId, entry]));
  const droppedTasks: RoutingDroppedTask[] = [];

  for (const task of input.tasks) {
    const missing = missingByTaskId.get(task.taskId);
    if (missing) {
      droppedTasks.push({
        taskId: task.taskId,
        reason: "REQUIRED_DRIVER_INFEASIBLE",
        details: `REQUIRED_DRIVER_NOT_SELECTED:${missing.requiredDriverId}`,
      });
      continue;
    }

    droppedTasks.push({
      taskId: task.taskId,
      reason: "NO_FEASIBLE_DRIVER",
      details: "Solve skipped: required driver not among selected drivers",
    });
  }

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: ORTOOLS_SOLVER_ID,
    workDate: input.workDate,
    status: "INVALID",
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    routes: [],
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: 0,
      droppedTasks: droppedTasks.length,
      totalTravelMin: 0,
      totalWaitMin: 0,
    },
    diagnostics: {
      warnings: [],
      notes: ["required_driver_not_selected"],
      solveDurationMs: options?.solveDurationMs ?? 0,
    },
  };
}

function getTravelMin(matrix: number[][], fromNodeIndex: number, toNodeIndex: number): number | null {
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

function isRequiredTaskFeasibleOnEmptyRoute(
  input: RoutingProblemInput,
  taskId: number,
  driverId: number
): { feasible: boolean; reason?: string } {
  const task = input.tasks.find((entry) => entry.taskId === taskId);
  const driver = input.drivers.find((entry) => entry.id === driverId);
  if (!task || !driver) {
    return { feasible: false, reason: "UNKNOWN_DRIVER_OR_TASK" };
  }

  const travel = getTravelMin(input.travelMatrixMin, DEPOT_NODE_INDEX, task.nodeIndex);
  if (travel === null) {
    return { feasible: false, reason: "MISSING_TRAVEL_MATRIX" };
  }

  const arrivalMin = driver.workWindow.startMin + travel;
  const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
  const endMin = startMin + task.serviceDurationMin;

  if (startMin > task.hardWindow.latestStartMin) {
    return { feasible: false, reason: "OUTSIDE_TIME_WINDOWS" };
  }
  if (endMin > task.hardWindow.latestEndMin) {
    return { feasible: false, reason: "OUTSIDE_TIME_WINDOWS" };
  }
  if (endMin > driver.workWindow.endMin) {
    return { feasible: false, reason: "OUTSIDE_TIME_WINDOWS" };
  }

  return { feasible: true };
}

export function buildRequiredInfeasibleSolution(
  input: RoutingProblemInput,
  options?: { generatedAt?: string; solveDurationMs?: number; note?: string }
): RoutingSolution {
  const maps = buildOrToolsMaps(input);
  const droppedTasks: RoutingDroppedTask[] = [];
  let hasRequiredDropped = false;

  for (const task of input.tasks) {
    const requiredDriverId = maps.requiredDriverByTaskId.get(task.taskId);
    if (requiredDriverId !== undefined) {
      const check = isRequiredTaskFeasibleOnEmptyRoute(input, task.taskId, requiredDriverId);
      droppedTasks.push({
        taskId: task.taskId,
        reason: "REQUIRED_DRIVER_INFEASIBLE",
        details: check.feasible
          ? "Global OR-Tools infeasible with hard required constraints"
          : check.reason,
      });
      hasRequiredDropped = true;
      continue;
    }

    droppedTasks.push({
      taskId: task.taskId,
      reason: "NO_FEASIBLE_DRIVER",
      details: "Global OR-Tools infeasible",
    });
  }

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: ORTOOLS_SOLVER_ID,
    workDate: input.workDate,
    status: hasRequiredDropped ? "INVALID" : "INFEASIBLE",
    generatedAt: options?.generatedAt ?? new Date().toISOString(),
    routes: [],
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: 0,
      droppedTasks: droppedTasks.length,
      totalTravelMin: 0,
      totalWaitMin: 0,
    },
    diagnostics: {
      warnings: [],
      notes: [options?.note ?? "ortools_infeasible_fallback"],
      solveDurationMs: options?.solveDurationMs,
    },
  };
}
