import type { DriverNode, RoutingProblemInput, TaskId, TaskNode } from "./input-contract";
import type { RoutingRouteSolution, RoutingSolution, RoutingStopSolution } from "./solution-contract";
import {
  buildVehicleArcPenalties,
  type RouteSequenceArcPenaltyDetail,
} from "./groups/route-sequence-penalties";

const DEPOT_NODE_INDEX = 0;
const EPSILON = 0.001;

const ROUTE_POLISHING_CONFIG = {
  maxIterationsPerRoute: 200,
  sequencePenaltyMultiplier: 3,
  waitPenaltyWeight: 0.1,
} as const;

interface SimulatedRoute {
  route: RoutingRouteSolution;
  objective: number;
}

function travelMin(input: RoutingProblemInput, fromNodeIndex: number, toNodeIndex: number): number | null {
  const travel = input.travelMatrixMin[fromNodeIndex]?.[toNodeIndex];
  return Number.isFinite(travel) ? travel : null;
}

function buildArcPenaltyLookup(details: RouteSequenceArcPenaltyDetail[]): Map<string, number> {
  const lookup = new Map<string, number>();
  for (const detail of details) {
    const key = `${detail.fromNodeIndex}:${detail.toNodeIndex}`;
    lookup.set(key, Math.max(lookup.get(key) ?? 0, detail.penalty));
  }
  return lookup;
}

function routeSequencePenalty(
  penaltyLookup: Map<string, number>,
  fromNodeIndex: number,
  toNodeIndex: number
): number {
  return penaltyLookup.get(`${fromNodeIndex}:${toNodeIndex}`) ?? 0;
}

function simulateRoute(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  orderedTaskIds: TaskId[];
  taskById: Map<TaskId, TaskNode>;
  penaltyLookup: Map<string, number>;
}): SimulatedRoute | null {
  const { input, driver, orderedTaskIds, taskById, penaltyLookup } = args;
  const stops: RoutingStopSolution[] = [];
  let previousNodeIndex = DEPOT_NODE_INDEX;
  let previousTaskId: TaskId | null = null;
  let previousEndMin = driver.workWindow.startMin;
  let totalTravelMin = 0;
  let totalWaitMin = 0;
  let totalServiceMin = 0;
  let routePenalty = 0;

  for (let index = 0; index < orderedTaskIds.length; index += 1) {
    const taskId = orderedTaskIds[index];
    const task = taskById.get(taskId);
    if (!task) return null;

    const travel = travelMin(input, previousNodeIndex, task.nodeIndex);
    if (travel === null) return null;

    const arrivalMin = previousEndMin + travel;
    const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
    const endMin = startMin + task.serviceDurationMin;

    if (startMin > task.hardWindow.latestStartMin) return null;
    if (endMin > task.hardWindow.latestEndMin) return null;
    if (endMin > driver.workWindow.endMin) return null;

    const waitMin = Math.max(0, startMin - arrivalMin);
    const sequencePenalty = routeSequencePenalty(penaltyLookup, previousNodeIndex, task.nodeIndex);

    stops.push({
      sequence: index + 1,
      taskId,
      arrivalMin,
      startMin,
      endMin,
      serviceDurationMin: task.serviceDurationMin,
      travelFromPreviousMin: travel,
      waitMin,
      previousTaskId,
    });

    totalTravelMin += travel;
    totalWaitMin += waitMin;
    totalServiceMin += task.serviceDurationMin;
    routePenalty += sequencePenalty;
    previousNodeIndex = task.nodeIndex;
    previousTaskId = taskId;
    previousEndMin = endMin;
  }

  if (stops.length === 0) return null;

  return {
    route: {
      driverId: driver.id,
      startMin: driver.workWindow.startMin,
      endMin: stops[stops.length - 1].endMin,
      totalServiceMin,
      totalTravelMin,
      totalWaitMin,
      stops,
    },
    objective:
      totalTravelMin +
      totalWaitMin * ROUTE_POLISHING_CONFIG.waitPenaltyWeight +
      routePenalty * ROUTE_POLISHING_CONFIG.sequencePenaltyMultiplier,
  };
}

function moveItem<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  const next = [...items];
  const [item] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, item);
  return next;
}

function moveBlock<T>(items: T[], fromIndex: number, length: number, toIndex: number): T[] {
  const next = [...items];
  const block = next.splice(fromIndex, length);
  const adjustedToIndex = toIndex > fromIndex ? toIndex - length : toIndex;
  next.splice(adjustedToIndex, 0, ...block);
  return next;
}

function reverseSegment<T>(items: T[], fromIndex: number, toIndex: number): T[] {
  return [
    ...items.slice(0, fromIndex),
    ...items.slice(fromIndex, toIndex + 1).reverse(),
    ...items.slice(toIndex + 1),
  ];
}

function candidateOrders(order: TaskId[]): TaskId[][] {
  const candidates: TaskId[][] = [];
  const n = order.length;

  for (let from = 0; from < n; from += 1) {
    for (let to = 0; to < n; to += 1) {
      if (from === to) continue;
      candidates.push(moveItem(order, from, to));
    }
  }

  for (let from = 0; from < n - 1; from += 1) {
    for (let to = 0; to <= n; to += 1) {
      if (to >= from && to <= from + 2) continue;
      candidates.push(moveBlock(order, from, 2, to));
    }
  }

  for (let from = 0; from < n - 2; from += 1) {
    for (let to = from + 2; to < n; to += 1) {
      candidates.push(reverseSegment(order, from, to));
    }
  }

  return candidates;
}

function polishRoute(args: {
  input: RoutingProblemInput;
  route: RoutingRouteSolution;
  driver: DriverNode;
  taskById: Map<TaskId, TaskNode>;
  penaltyLookup: Map<string, number>;
}): { route: RoutingRouteSolution; improved: boolean; beforeObjective: number; afterObjective: number } {
  const initialOrder = args.route.stops.map((stop) => stop.taskId);
  const initial = simulateRoute({
    input: args.input,
    driver: args.driver,
    orderedTaskIds: initialOrder,
    taskById: args.taskById,
    penaltyLookup: args.penaltyLookup,
  });

  if (!initial) {
    return {
      route: args.route,
      improved: false,
      beforeObjective: Number.POSITIVE_INFINITY,
      afterObjective: Number.POSITIVE_INFINITY,
    };
  }

  let bestOrder = initialOrder;
  let best = initial;
  const beforeObjective = initial.objective;

  for (let iteration = 0; iteration < ROUTE_POLISHING_CONFIG.maxIterationsPerRoute; iteration += 1) {
    let improvedThisIteration = false;

    for (const candidate of candidateOrders(bestOrder)) {
      const simulated = simulateRoute({
        input: args.input,
        driver: args.driver,
        orderedTaskIds: candidate,
        taskById: args.taskById,
        penaltyLookup: args.penaltyLookup,
      });
      if (!simulated) continue;

      if (simulated.objective + EPSILON < best.objective) {
        bestOrder = candidate;
        best = simulated;
        improvedThisIteration = true;
        break;
      }
    }

    if (!improvedThisIteration) break;
  }

  return {
    route: best.route,
    improved: best.objective + EPSILON < beforeObjective,
    beforeObjective,
    afterObjective: best.objective,
  };
}

export function polishRoutingSolution(
  input: RoutingProblemInput,
  solution: RoutingSolution
): RoutingSolution {
  if (solution.routes.length === 0) return solution;

  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));
  const arcPenaltyBuild = buildVehicleArcPenalties({ input });
  const penaltyLookup = buildArcPenaltyLookup(arcPenaltyBuild?.details ?? []);
  const notes = [...(solution.diagnostics?.notes ?? [])];
  const polishedRoutes: RoutingRouteSolution[] = [];
  let improvedRouteCount = 0;

  for (const route of solution.routes) {
    const driver = driverById.get(route.driverId);
    if (!driver || route.stops.length < 3) {
      polishedRoutes.push(route);
      continue;
    }

    const polished = polishRoute({
      input,
      route,
      driver,
      taskById,
      penaltyLookup,
    });

    polishedRoutes.push(polished.route);
    if (polished.improved) {
      improvedRouteCount += 1;
      notes.push(
        `route-polishing driver=${route.driverId} objective=${polished.beforeObjective.toFixed(2)}->${polished.afterObjective.toFixed(2)}`
      );
    }
  }

  if (improvedRouteCount === 0) return solution;

  const totalTravelMin = polishedRoutes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = polishedRoutes.reduce((sum, route) => sum + route.totalWaitMin, 0);

  return {
    ...solution,
    routes: polishedRoutes,
    objectiveBreakdown: solution.objectiveBreakdown
      ? {
          ...solution.objectiveBreakdown,
          totalTravelMin,
          totalWaitMin,
        }
      : solution.objectiveBreakdown,
    diagnostics: {
      warnings: solution.diagnostics?.warnings ?? [],
      notes,
      solveDurationMs: solution.diagnostics?.solveDurationMs,
    },
  };
}
