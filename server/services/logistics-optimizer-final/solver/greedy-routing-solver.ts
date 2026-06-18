import type { Priority } from "../../optimizer/priorityWindows";
import type { DriverNode, RoutingProblemInput, TaskNode } from "../input-contract";
import {
  GREEDY_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingDroppedTask,
  type RoutingDroppedTaskReason,
  type RoutingRouteSolution,
  type RoutingSolution,
  type RoutingStopSolution,
} from "../solution-contract";

const DEPOT_NODE_INDEX = 0;

function priorityRank(priority: Priority | null): number {
  if (priority === "EO") return 0;
  if (priority === "HP") return 1;
  if (priority === "LP") return 2;
  return 3;
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

function sortTasks(
  tasks: TaskNode[],
  requiredDriverByTaskId: Map<number, number>
): TaskNode[] {
  return [...tasks].sort((left, right) => {
    const leftRequired = requiredDriverByTaskId.has(left.taskId) ? 0 : 1;
    const rightRequired = requiredDriverByTaskId.has(right.taskId) ? 0 : 1;
    if (leftRequired !== rightRequired) return leftRequired - rightRequired;

    const earliestDiff = left.hardWindow.earliestStartMin - right.hardWindow.earliestStartMin;
    if (earliestDiff !== 0) return earliestDiff;

    const latestEndDiff = left.hardWindow.latestEndMin - right.hardWindow.latestEndMin;
    if (latestEndDiff !== 0) return latestEndDiff;

    const priorityDiff = priorityRank(left.priority) - priorityRank(right.priority);
    if (priorityDiff !== 0) return priorityDiff;

    return left.taskId - right.taskId;
  });
}

function sortDrivers(drivers: DriverNode[]): DriverNode[] {
  return [...drivers].sort((left, right) => left.id - right.id);
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

interface SimulatedStop {
  stop: RoutingStopSolution;
  endMin: number;
  nodeIndex: number;
}

interface DriverRouteState {
  driver: DriverNode;
  stops: SimulatedStop[];
}

function simulateAppend(
  input: RoutingProblemInput,
  route: DriverRouteState,
  task: TaskNode
): { feasible: true; stop: SimulatedStop } | { feasible: false; reason: RoutingDroppedTaskReason } {
  const previous = route.stops[route.stops.length - 1];
  const prevEnd = previous ? previous.endMin : route.driver.workWindow.startMin;
  const prevNodeIndex = previous ? previous.nodeIndex : DEPOT_NODE_INDEX;

  const travel = getTravelMin(input, prevNodeIndex, task.nodeIndex);
  if (travel === null) {
    return { feasible: false, reason: "MISSING_TRAVEL_MATRIX" };
  }

  const arrivalMin = prevEnd + travel;
  const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
  const waitMin = startMin - arrivalMin;
  const endMin = startMin + task.serviceDurationMin;

  if (startMin > task.hardWindow.latestStartMin) {
    return { feasible: false, reason: "OUTSIDE_TIME_WINDOWS" };
  }

  if (endMin > task.hardWindow.latestEndMin) {
    return { feasible: false, reason: "OUTSIDE_TIME_WINDOWS" };
  }

  if (endMin > route.driver.workWindow.endMin) {
    return { feasible: false, reason: "OUTSIDE_TIME_WINDOWS" };
  }

  const stop: RoutingStopSolution = {
    sequence: route.stops.length + 1,
    taskId: task.taskId,
    arrivalMin,
    startMin,
    endMin,
    serviceDurationMin: task.serviceDurationMin,
    travelFromPreviousMin: travel,
    waitMin,
    previousTaskId: previous ? previous.stop.taskId : null,
  };

  return {
    feasible: true,
    stop: {
      stop,
      endMin,
      nodeIndex: task.nodeIndex,
    },
  };
}

function buildRouteSolution(route: DriverRouteState): RoutingRouteSolution {
  const stops = route.stops.map((entry) => entry.stop);
  const totalTravelMin = stops.reduce((sum, stop) => sum + stop.travelFromPreviousMin, 0);
  const totalWaitMin = stops.reduce((sum, stop) => sum + stop.waitMin, 0);
  const totalServiceMin = stops.reduce((sum, stop) => sum + stop.serviceDurationMin, 0);
  const endMin = stops.length > 0 ? stops[stops.length - 1].endMin : route.driver.workWindow.startMin;

  return {
    driverId: route.driver.id,
    startMin: route.driver.workWindow.startMin,
    endMin,
    totalServiceMin,
    totalTravelMin,
    totalWaitMin,
    stops,
  };
}

function resolveStatus(
  assignedCount: number,
  droppedCount: number,
  hasRequiredDropped: boolean
): RoutingSolution["status"] {
  if (hasRequiredDropped) return "INVALID";
  if (assignedCount === 0) return "INFEASIBLE";
  if (droppedCount > 0) return "PARTIAL";
  return "FEASIBLE";
}

export interface SolveGreedyRoutingOptions {
  generatedAt?: string;
  solveDurationMs?: number;
}

export function solveGreedyRouting(
  input: RoutingProblemInput,
  options: SolveGreedyRoutingOptions = {}
): RoutingSolution {
  const startedAt = Date.now();
  const requiredDriverByTaskId = buildRequiredDriverByTaskId(input);
  const sortedTasks = sortTasks(input.tasks, requiredDriverByTaskId);
  const sortedDrivers = sortDrivers(input.drivers);

  const routeStates: DriverRouteState[] = sortedDrivers.map((driver) => ({
    driver,
    stops: [],
  }));

  const droppedTasks: RoutingDroppedTask[] = [];
  let hasRequiredDropped = false;

  for (const task of sortedTasks) {
    if (sortedDrivers.length === 0) {
      const reason: RoutingDroppedTaskReason = requiredDriverByTaskId.has(task.taskId)
        ? "REQUIRED_DRIVER_INFEASIBLE"
        : "NO_FEASIBLE_DRIVER";
      droppedTasks.push({
        taskId: task.taskId,
        reason,
        details: "No selected drivers available",
      });
      if (requiredDriverByTaskId.has(task.taskId)) {
        hasRequiredDropped = true;
      }
      continue;
    }

    const requiredDriverId = requiredDriverByTaskId.get(task.taskId);
    if (requiredDriverId !== undefined) {
      const route = routeStates.find((entry) => entry.driver.id === requiredDriverId);
      if (!route) {
        droppedTasks.push({
          taskId: task.taskId,
          reason: "REQUIRED_DRIVER_INFEASIBLE",
          details: `Required driver ${requiredDriverId} is not selected`,
        });
        hasRequiredDropped = true;
        continue;
      }

      const simulation = simulateAppend(input, route, task);
      if (!simulation.feasible) {
        droppedTasks.push({
          taskId: task.taskId,
          reason: "REQUIRED_DRIVER_INFEASIBLE",
          details: simulation.reason,
        });
        hasRequiredDropped = true;
        continue;
      }

      route.stops.push(simulation.stop);
      continue;
    }

    let assigned = false;
    let lastReason: RoutingDroppedTaskReason = "NO_FEASIBLE_DRIVER";

    for (const route of routeStates) {
      const simulation = simulateAppend(input, route, task);
      if (!simulation.feasible) {
        lastReason = simulation.reason;
        continue;
      }

      route.stops.push(simulation.stop);
      assigned = true;
      break;
    }

    if (!assigned) {
      droppedTasks.push({
        taskId: task.taskId,
        reason: lastReason,
      });
    }
  }

  const routes = routeStates
    .filter((route) => route.stops.length > 0)
    .map((route) => buildRouteSolution(route));

  const assignedCount = routes.reduce((sum, route) => sum + route.stops.length, 0);
  const totalTravelMin = routes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = routes.reduce((sum, route) => sum + route.totalWaitMin, 0);

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: GREEDY_SOLVER_ID,
    workDate: input.workDate,
    status: resolveStatus(assignedCount, droppedTasks.length, hasRequiredDropped),
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    routes,
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: assignedCount,
      droppedTasks: droppedTasks.length,
      totalTravelMin,
      totalWaitMin,
    },
    diagnostics: {
      warnings: [],
      solveDurationMs: options.solveDurationMs ?? Date.now() - startedAt,
    },
  };
}
