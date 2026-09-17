import {
  LOGISTICS_HYPOTHESIS_IDS,
  logisticsHypothesisProfileById,
  type LogisticsHypothesisId,
  type LogisticsHypothesisSummary,
  type LogisticsHypothesisTimelinePreview,
} from "../../../shared/logistics-routing-hypotheses";
import type { DriverNode, RoutingProblemInput, TaskId, TaskNode } from "./input-contract";
import {
  ORTOOLS_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingDroppedTask,
  type RoutingRouteSolution,
  type RoutingSolution,
} from "./solution-contract";
import {
  partitionExclusiveWorkZones,
  type ExclusiveWorkZoneSpec,
} from "./exclusive-work-zones";
import { findBestFeasibleSequence } from "./route-sequencer";
import {
  simulateRouteTiming,
  simulateRouteTimingAllowingViolations,
} from "./route-timing";
import { classifyTaskNodeUrgency } from "./task-urgency";

const DEPOT_NODE_INDEX = 0;

export interface LogisticsRoutingHypothesis {
  summary: LogisticsHypothesisSummary;
  solution: RoutingSolution;
  preview?: LogisticsHypothesisTimelinePreview;
}

function travelBetween(
  input: RoutingProblemInput,
  fromNodeIndex: number,
  toNodeIndex: number
): number | null {
  const travel = input.travelMatrixMin[fromNodeIndex]?.[toNodeIndex];
  return Number.isFinite(travel) ? travel : null;
}

function pickDistinctFirstStops(args: {
  tasks: TaskNode[];
  input: RoutingProblemInput;
}): Partial<Record<LogisticsHypothesisId, TaskId>> {
  const { tasks, input } = args;
  if (tasks.length === 0) return {};

  const byUrgent = [...tasks].sort((left, right) => {
    const leftUrgency = classifyTaskNodeUrgency(left) === "urgent" ? 0 : 1;
    const rightUrgency = classifyTaskNodeUrgency(right) === "urgent" ? 0 : 1;
    if (leftUrgency !== rightUrgency) return leftUrgency - rightUrgency;
    if (left.hardWindow.latestStartMin !== right.hardWindow.latestStartMin) {
      return left.hardWindow.latestStartMin - right.hardWindow.latestStartMin;
    }
    return left.taskId - right.taskId;
  });

  const byFarthest = [...tasks].sort((left, right) => {
    const leftTravel = travelBetween(input, DEPOT_NODE_INDEX, left.nodeIndex) ?? 0;
    const rightTravel = travelBetween(input, DEPOT_NODE_INDEX, right.nodeIndex) ?? 0;
    if (leftTravel !== rightTravel) return rightTravel - leftTravel;
    return left.taskId - right.taskId;
  });

  const byNearest = [...tasks].sort((left, right) => {
    const leftTravel = travelBetween(input, DEPOT_NODE_INDEX, left.nodeIndex) ?? Number.POSITIVE_INFINITY;
    const rightTravel = travelBetween(input, DEPOT_NODE_INDEX, right.nodeIndex) ?? Number.POSITIVE_INFINITY;
    if (leftTravel !== rightTravel) return leftTravel - rightTravel;
    return left.taskId - right.taskId;
  });

  const byEarliest = [...tasks].sort((left, right) => {
    if (left.hardWindow.earliestStartMin !== right.hardWindow.earliestStartMin) {
      return left.hardWindow.earliestStartMin - right.hardWindow.earliestStartMin;
    }
    return left.taskId - right.taskId;
  });

  const used = new Set<TaskId>();
  const take = (ranked: TaskNode[]): TaskId => {
    const unused = ranked.find((task) => !used.has(task.taskId));
    const chosen = unused ?? ranked[0];
    used.add(chosen.taskId);
    return chosen.taskId;
  };

  return {
    "priority-strict": take(byUrgent),
    "proximity-strict": take(byFarthest),
    "balanced-urgent-start": take(byNearest),
    "balanced-geo-start": take(byEarliest),
  };
}

function nearestNeighborOrder(args: {
  input: RoutingProblemInput;
  tasks: TaskNode[];
  firstTaskId: TaskId;
}): TaskId[] {
  const remaining = new Map(args.tasks.map((task) => [task.taskId, task]));
  const first = remaining.get(args.firstTaskId) ?? args.tasks[0];
  if (!first) return [];
  remaining.delete(first.taskId);
  const order: TaskId[] = [first.taskId];
  let last = first;

  while (remaining.size > 0) {
    let best: TaskNode | null = null;
    let bestTravel = Number.POSITIVE_INFINITY;
    for (const candidate of remaining.values()) {
      const travel = travelBetween(args.input, last.nodeIndex, candidate.nodeIndex);
      if (travel == null) continue;
      if (travel < bestTravel || (travel === bestTravel && candidate.taskId < (best?.taskId ?? 0))) {
        best = candidate;
        bestTravel = travel;
      }
    }
    if (!best) {
      const fallback = [...remaining.values()].sort((left, right) => left.taskId - right.taskId)[0];
      remaining.delete(fallback.taskId);
      order.push(fallback.taskId);
      last = fallback;
      continue;
    }
    remaining.delete(best.taskId);
    order.push(best.taskId);
    last = best;
  }

  return order;
}

function deadlineFirstOrder(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  tasks: TaskNode[];
  firstTaskId: TaskId;
}): { order: TaskId[]; dropped: TaskId[] } {
  const remaining = new Map(args.tasks.map((task) => [task.taskId, task]));
  const order: TaskId[] = [];
  let lastNodeIndex = DEPOT_NODE_INDEX;
  let endMin = args.driver.workWindow.startMin;
  const first = remaining.get(args.firstTaskId);

  const tryAppend = (task: TaskNode): boolean => {
    const travel = travelBetween(args.input, lastNodeIndex, task.nodeIndex);
    if (travel == null) return false;
    const arrivalMin = endMin + travel;
    const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
    const finishMin = startMin + task.serviceDurationMin;
    if (startMin > task.hardWindow.latestStartMin) return false;
    if (finishMin > task.hardWindow.latestEndMin) return false;
    if (finishMin > args.driver.workWindow.endMin) return false;
    lastNodeIndex = task.nodeIndex;
    endMin = finishMin;
    order.push(task.taskId);
    remaining.delete(task.taskId);
    return true;
  };

  if (first && !tryAppend(first)) {
    remaining.delete(first.taskId);
  }

  while (remaining.size > 0) {
    const ranked = [...remaining.values()].sort((left, right) => {
      const leftUrgent = classifyTaskNodeUrgency(left) === "urgent" ? 0 : 1;
      const rightUrgent = classifyTaskNodeUrgency(right) === "urgent" ? 0 : 1;
      if (leftUrgent !== rightUrgent) return leftUrgent - rightUrgent;
      if (left.hardWindow.latestStartMin !== right.hardWindow.latestStartMin) {
        return left.hardWindow.latestStartMin - right.hardWindow.latestStartMin;
      }
      const leftTravel = travelBetween(args.input, lastNodeIndex, left.nodeIndex) ?? Number.POSITIVE_INFINITY;
      const rightTravel = travelBetween(args.input, lastNodeIndex, right.nodeIndex) ?? Number.POSITIVE_INFINITY;
      if (leftTravel !== rightTravel) return leftTravel - rightTravel;
      return left.taskId - right.taskId;
    });

    const nextFeasible = ranked.find((task) => {
      const travel = travelBetween(args.input, lastNodeIndex, task.nodeIndex);
      if (travel == null) return false;
      const arrivalMin = endMin + travel;
      const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
      const finishMin = startMin + task.serviceDurationMin;
      return (
        startMin <= task.hardWindow.latestStartMin &&
        finishMin <= task.hardWindow.latestEndMin &&
        finishMin <= args.driver.workWindow.endMin
      );
    });

    if (!nextFeasible) break;
    tryAppend(nextFeasible);
  }

  return { order, dropped: [...remaining.keys()] };
}

function sequenceZone(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  zone: ExclusiveWorkZoneSpec;
  profileId: LogisticsHypothesisId;
  firstTaskId: TaskId | undefined;
  taskById: Map<TaskId, TaskNode>;
}): { route: RoutingRouteSolution | null; dropped: TaskId[] } {
  const tasks = args.zone.taskIds
    .map((taskId) => args.taskById.get(taskId))
    .filter((task): task is TaskNode => task !== undefined);
  if (tasks.length === 0) return { route: null, dropped: [] };

  const firstTaskId = args.firstTaskId ?? tasks[0].taskId;

  if (args.profileId === "priority-strict") {
    const sequenced = deadlineFirstOrder({
      input: args.input,
      driver: args.driver,
      tasks,
      firstTaskId,
    });
    const route =
      sequenced.order.length > 0
        ? simulateRouteTiming({
            input: args.input,
            driver: args.driver,
            orderedTaskIds: sequenced.order,
            taskById: args.taskById,
          })
        : null;
    return { route, dropped: sequenced.dropped };
  }

  if (args.profileId === "proximity-strict") {
    const order = nearestNeighborOrder({
      input: args.input,
      tasks,
      firstTaskId,
    });
    const route = simulateRouteTimingAllowingViolations({
      input: args.input,
      driver: args.driver,
      orderedTaskIds: order,
      taskById: args.taskById,
    });
    return { route, dropped: route ? [] : order };
  }

  const beam = findBestFeasibleSequence({
    input: args.input,
    driver: args.driver,
    taskIds: tasks.map((task) => task.taskId),
    taskById: args.taskById,
    subZoneByTaskId: new Map(),
    ranking: "travel-first",
    forceFirstTaskId: firstTaskId,
  });
  if (beam) {
    const route = simulateRouteTiming({
      input: args.input,
      driver: args.driver,
      orderedTaskIds: beam.order,
      taskById: args.taskById,
    });
    const assigned = new Set(beam.order);
    return {
      route,
      dropped: tasks.map((task) => task.taskId).filter((taskId) => !assigned.has(taskId)),
    };
  }

  const fallback = deadlineFirstOrder({
    input: args.input,
    driver: args.driver,
    tasks,
    firstTaskId,
  });
  const route =
    fallback.order.length > 0
      ? simulateRouteTiming({
          input: args.input,
          driver: args.driver,
          orderedTaskIds: fallback.order,
          taskById: args.taskById,
        })
      : null;
  return { route, dropped: fallback.dropped };
}

function countWindowViolations(
  input: RoutingProblemInput,
  solution: RoutingSolution
): number {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  let count = 0;
  for (const route of solution.routes) {
    for (const stop of route.stops) {
      const task = taskById.get(stop.taskId);
      if (!task) continue;
      if (stop.startMin > task.hardWindow.latestStartMin) count += 1;
      else if (stop.endMin > task.hardWindow.latestEndMin) count += 1;
    }
  }
  return count;
}

function buildSolutionFromRoutes(args: {
  input: RoutingProblemInput;
  routes: RoutingRouteSolution[];
  dropped: RoutingDroppedTask[];
  profileId: LogisticsHypothesisId;
}): RoutingSolution {
  const assigned = new Set(args.routes.flatMap((route) => route.stops.map((stop) => stop.taskId)));
  const droppedTasks = [...args.dropped];
  const droppedIds = new Set(droppedTasks.map((dropped) => dropped.taskId));
  for (const task of args.input.tasks) {
    if (!assigned.has(task.taskId) && !droppedIds.has(task.taskId)) {
      droppedTasks.push({ taskId: task.taskId, reason: "NO_FEASIBLE_DRIVER" });
    }
  }

  const assignedTaskCount = args.routes.reduce((sum, route) => sum + route.stops.length, 0);
  const totalTravelMin = args.routes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = args.routes.reduce((sum, route) => sum + route.totalWaitMin, 0);

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: ORTOOLS_SOLVER_ID,
    workDate: args.input.workDate,
    status:
      assignedTaskCount === 0 ? "INFEASIBLE" : droppedTasks.length > 0 ? "PARTIAL" : "FEASIBLE",
    generatedAt: new Date().toISOString(),
    routes: args.routes.sort((left, right) => left.driverId - right.driverId),
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: assignedTaskCount,
      droppedTasks: droppedTasks.length,
      totalTravelMin,
      totalWaitMin,
    },
    diagnostics: {
      warnings: [],
      notes: [`routing-hypothesis:${args.profileId}`],
    },
  };
}

function buildSummary(args: {
  profileId: LogisticsHypothesisId;
  input: RoutingProblemInput;
  solution: RoutingSolution;
  zones: ExclusiveWorkZoneSpec[];
}): LogisticsHypothesisSummary {
  const meta = logisticsHypothesisProfileById(args.profileId);
  const zoneByDriver = new Map(args.zones.map((zone) => [zone.driverId, zone]));
  const taskById = new Map(args.input.tasks.map((task) => [task.taskId, task]));

  return {
    id: args.profileId,
    title: meta.title,
    description: meta.description,
    assignedTaskCount: args.solution.objectiveBreakdown?.assignedTasks ?? 0,
    droppedTaskCount: args.solution.droppedTasks.length,
    totalTravelMin: args.solution.objectiveBreakdown?.totalTravelMin ?? 0,
    totalWaitMin: args.solution.objectiveBreakdown?.totalWaitMin ?? 0,
    windowViolationCount: countWindowViolations(args.input, args.solution),
    zoneCount: args.zones.length,
    routes: args.solution.routes.map((route) => {
      const codes = route.stops.map((stop) => taskById.get(stop.taskId)?.logisticCode ?? stop.taskId);
      return {
        driverId: route.driverId,
        zoneLabel: zoneByDriver.get(route.driverId)?.label ?? `Driver ${route.driverId}`,
        logisticCodes: codes,
        travelMin: route.totalTravelMin,
        startMin: route.startMin,
        endMin: route.endMin,
        firstLogisticCode: codes[0] ?? null,
      };
    }),
  };
}

function fallbackSingleZone(input: RoutingProblemInput): ExclusiveWorkZoneSpec[] {
  if (input.drivers.length === 0) return [];
  return [
    {
      zoneIndex: 0,
      zoneId: "exclusive-zone:0",
      label: "Zona 1",
      driverId: input.drivers[0].id,
      taskIds: input.tasks.map((task) => task.taskId),
      centroid: { lat: 0, lng: 0 },
      color: "#4575b4",
    },
  ];
}

export function generateLogisticsRoutingHypotheses(
  input: RoutingProblemInput
): LogisticsRoutingHypothesis[] {
  const partitioned = partitionExclusiveWorkZones(input);
  const zones = partitioned.length > 0 ? partitioned : fallbackSingleZone(input);
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));

  const firstStopsByZone = new Map<number, Partial<Record<LogisticsHypothesisId, TaskId>>>();
  for (const zone of zones) {
    const zoneTasks = zone.taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is TaskNode => task !== undefined);
    firstStopsByZone.set(zone.zoneIndex, pickDistinctFirstStops({ tasks: zoneTasks, input }));
  }

  return LOGISTICS_HYPOTHESIS_IDS.map((profileId) => {
    const routes: RoutingRouteSolution[] = [];
    const dropped: RoutingDroppedTask[] = [];

    for (const zone of zones) {
      const driver = driverById.get(zone.driverId);
      if (!driver) {
        for (const taskId of zone.taskIds) {
          dropped.push({ taskId, reason: "NO_FEASIBLE_DRIVER" });
        }
        continue;
      }
      const sequenced = sequenceZone({
        input,
        driver,
        zone,
        profileId,
        firstTaskId: firstStopsByZone.get(zone.zoneIndex)?.[profileId],
        taskById,
      });
      if (sequenced.route) routes.push(sequenced.route);
      for (const taskId of sequenced.dropped) {
        dropped.push({ taskId, reason: "OUTSIDE_TIME_WINDOWS" });
      }
    }

    const solution = buildSolutionFromRoutes({
      input,
      routes,
      dropped,
      profileId,
    });
    return {
      summary: buildSummary({ profileId, input, solution, zones }),
      solution,
    };
  });
}
