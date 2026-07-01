import type { DriverId, RoutingProblemInput, TaskId, TaskNode } from "../input-contract";
import type { HistoricalTerritoryKey } from "./historical-territory-profiles";
import { effectiveTravelMin } from "./travel-matrix-utils";
import { hasTightCheckinDeadline } from "../priority-route-compatibility";
import {
  ROUTE_SEQUENCE_CONFIG,
  type RouteSequencePenaltyReason,
} from "./route-sequence-config";

const DEPOT_NODE_INDEX = 0;

export interface RouteSequenceArcPenaltyDetail {
  fromNodeIndex: number;
  toNodeIndex: number;
  fromTaskId: TaskId | null;
  toTaskId: TaskId | null;
  reason: RouteSequencePenaltyReason;
  penalty: number;
}

interface TerritorySweepContext {
  territoryIndex: number;
  territoryKey: HistoricalTerritoryKey;
  frontierSweepRank: number;
  sweepRankForTask: Map<TaskId, number>;
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)
  );
  return sorted[index];
}

function sweepRankForTerritory(
  territoryKey: HistoricalTerritoryKey,
  lat: number,
  lng: number
): number {
  switch (territoryKey) {
    case "north":
      return lat;
    case "center_south_west":
      return -lat - lng * 0.35;
    case "center_south_east":
      return -lat + lng * 0.35;
    default:
      return lat;
  }
}

function isTaskScheduleUrgent(task: TaskNode): boolean {
  if (task.hardWindow.latestStartMin <= ROUTE_SEQUENCE_CONFIG.tightLatestStartMin) {
    return true;
  }
  if (
    task.debug?.ruleTrace?.some(
      (trace) => trace.code === "EO_EARLY_URGENT" || trace.code === "EO_DRIVER_BEFORE_CLEANER_REQUIRED"
    )
  ) {
    return true;
  }
  const checkinMin = task.debug?.sourceTimes?.customerCheckinMin ?? null;
  if (
    hasTightCheckinDeadline({
      customerCheckinMin: checkinMin,
      latestStartMin: task.hardWindow.latestStartMin,
    })
  ) {
    return true;
  }
  return false;
}

function applyDiscount(penalty: number, urgent: boolean): number {
  if (!urgent) return penalty;
  return Math.max(0, Math.round(penalty * ROUTE_SEQUENCE_CONFIG.urgentTaskDiscount));
}

function buildTerritorySweepContexts(input: RoutingProblemInput): Map<number, TerritorySweepContext> {
  const assignment = input.metadata.dailyTerritoryAssignment;
  if (!assignment) return new Map();

  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const contexts = new Map<number, TerritorySweepContext>();

  for (const territory of assignment.territories) {
    if (!territory.territoryKey) continue;

    const sweepRanks = territory.taskIds
      .map((taskId) => {
        const task = taskById.get(taskId);
        if (!task) return null;
        return sweepRankForTerritory(territory.territoryKey!, task.location.lat, task.location.lng);
      })
      .filter((value): value is number => value !== null);

    const sweepRankForTask = new Map<TaskId, number>();
    for (const taskId of territory.taskIds) {
      const task = taskById.get(taskId);
      if (!task || !territory.territoryKey) continue;
      sweepRankForTask.set(
        taskId,
        sweepRankForTerritory(territory.territoryKey, task.location.lat, task.location.lng)
      );
    }

    contexts.set(territory.territoryIndex, {
      territoryIndex: territory.territoryIndex,
      territoryKey: territory.territoryKey,
      frontierSweepRank: percentile(sweepRanks, ROUTE_SEQUENCE_CONFIG.frontierPercentile),
      sweepRankForTask,
    });
  }

  return contexts;
}

function resolveTerritoryIndex(
  taskId: TaskId,
  territoryIndexByTaskId: Map<TaskId, number>
): number | undefined {
  return territoryIndexByTaskId.get(taskId);
}

function evaluateArcPenalty(args: {
  fromTask: TaskNode | null;
  toTask: TaskNode;
  travelMatrixMin: number[][];
  territoryIndexByTaskId: Map<TaskId, number>;
  sweepContexts: Map<number, TerritorySweepContext>;
  fromDepot: boolean;
}): RouteSequenceArcPenaltyDetail | null {
  const { fromTask, toTask, travelMatrixMin, territoryIndexByTaskId, sweepContexts, fromDepot } =
    args;
  const toTerritoryIndex = resolveTerritoryIndex(toTask.taskId, territoryIndexByTaskId);
  if (toTerritoryIndex === undefined) return null;

  const toContext = sweepContexts.get(toTerritoryIndex);
  if (!toContext) return null;

  const toSweepRank = toContext.sweepRankForTask.get(toTask.taskId);
  if (toSweepRank === undefined) return null;

  const toUrgent = isTaskScheduleUrgent(toTask);

  if (fromDepot) {
    if (toUrgent || toSweepRank >= toContext.frontierSweepRank) {
      return null;
    }
    return {
      fromNodeIndex: DEPOT_NODE_INDEX,
      toNodeIndex: toTask.nodeIndex,
      fromTaskId: null,
      toTaskId: toTask.taskId,
      reason: "FIRST_STOP_MISMATCH",
      penalty: applyDiscount(ROUTE_SEQUENCE_CONFIG.firstStopMismatchPenaltyMin, toUrgent),
    };
  }

  if (!fromTask) return null;

  const fromTerritoryIndex = resolveTerritoryIndex(fromTask.taskId, territoryIndexByTaskId);
  if (fromTerritoryIndex !== toTerritoryIndex) return null;

  const fromContext = sweepContexts.get(fromTerritoryIndex);
  if (!fromContext) return null;

  const fromSweepRank = fromContext.sweepRankForTask.get(fromTask.taskId);
  if (fromSweepRank === undefined) return null;

  const travelMin = effectiveTravelMin(travelMatrixMin, fromTask.nodeIndex, toTask.nodeIndex);
  if (travelMin === null) return null;

  if (
    toSweepRank > fromSweepRank + ROUTE_SEQUENCE_CONFIG.sweepBackwardTolerance
  ) {
    return {
      fromNodeIndex: fromTask.nodeIndex,
      toNodeIndex: toTask.nodeIndex,
      fromTaskId: fromTask.taskId,
      toTaskId: toTask.taskId,
      reason: "REVERSE_SWEEP",
      penalty: applyDiscount(ROUTE_SEQUENCE_CONFIG.reverseSweepPenaltyMin, toUrgent),
    };
  }

  if (travelMin >= ROUTE_SEQUENCE_CONFIG.veryLargeLateralJumpTravelMin) {
    return {
      fromNodeIndex: fromTask.nodeIndex,
      toNodeIndex: toTask.nodeIndex,
      fromTaskId: fromTask.taskId,
      toTaskId: toTask.taskId,
      reason: "VERY_LARGE_LATERAL_JUMP",
      penalty: applyDiscount(ROUTE_SEQUENCE_CONFIG.veryLargeLateralJumpPenaltyMin, toUrgent),
    };
  }

  if (travelMin >= ROUTE_SEQUENCE_CONFIG.lateralJumpTravelMin) {
    return {
      fromNodeIndex: fromTask.nodeIndex,
      toNodeIndex: toTask.nodeIndex,
      fromTaskId: fromTask.taskId,
      toTaskId: toTask.taskId,
      reason: "LARGE_LATERAL_JUMP",
      penalty: applyDiscount(ROUTE_SEQUENCE_CONFIG.largeLateralJumpPenaltyMin, toUrgent),
    };
  }

  return null;
}

export function buildVehicleArcPenalties(args: {
  input: RoutingProblemInput;
}): { penalties: number[][][]; details: RouteSequenceArcPenaltyDetail[] } | undefined {
  const assignment = args.input.metadata.dailyTerritoryAssignment;
  if (
    !assignment?.routingPenaltiesEnabled ||
    assignment.territoryMode !== "historical_template_3_drivers" ||
    assignment.territories.length === 0
  ) {
    return undefined;
  }

  const vehicleCount = args.input.drivers.length;
  const nodeCount = args.input.travelMatrixMin.length;
  const arcPenalties = Array.from({ length: vehicleCount }, () =>
    Array.from({ length: nodeCount }, () => Array(nodeCount).fill(0))
  );
  const details: RouteSequenceArcPenaltyDetail[] = [];

  const territoryIndexByTaskId = new Map(
    assignment.taskTerritoryIndex.map((entry) => [entry.taskId, entry.territoryIndex])
  );
  const sweepContexts = buildTerritorySweepContexts(args.input);

  for (const toTask of args.input.tasks) {
    const depotDetail = evaluateArcPenalty({
      fromTask: null,
      toTask,
      travelMatrixMin: args.input.travelMatrixMin,
      territoryIndexByTaskId,
      sweepContexts,
      fromDepot: true,
    });
    if (depotDetail && depotDetail.penalty > 0) {
      details.push(depotDetail);
      for (let vehicleIndex = 0; vehicleIndex < vehicleCount; vehicleIndex += 1) {
        arcPenalties[vehicleIndex][DEPOT_NODE_INDEX][toTask.nodeIndex] = depotDetail.penalty;
      }
    }
  }

  for (const fromTask of args.input.tasks) {
    for (const toTask of args.input.tasks) {
      if (fromTask.taskId === toTask.taskId) continue;

      const detail = evaluateArcPenalty({
        fromTask,
        toTask,
        travelMatrixMin: args.input.travelMatrixMin,
        territoryIndexByTaskId,
        sweepContexts,
        fromDepot: false,
      });
      if (!detail || detail.penalty <= 0) continue;

      details.push(detail);
      for (let vehicleIndex = 0; vehicleIndex < vehicleCount; vehicleIndex += 1) {
        arcPenalties[vehicleIndex][fromTask.nodeIndex][toTask.nodeIndex] = detail.penalty;
      }
    }
  }

  return { penalties: arcPenalties, details };
}

export function computeRouteSequenceDiagnostics(args: {
  input: RoutingProblemInput;
  solution: {
    routes: Array<{ driverId: DriverId; stops: Array<{ taskId: TaskId }> }>;
  };
  arcPenaltyDetails: RouteSequenceArcPenaltyDetail[];
}): Array<{
  driverId: DriverId;
  sequence: string;
  fromTaskId: TaskId | null;
  toTaskId: TaskId;
  fromCode: string;
  toCode: string;
  reason: RouteSequencePenaltyReason;
  penalty: number;
}> {
  const taskById = new Map(args.input.tasks.map((task) => [task.taskId, task]));
  const detailByArc = new Map<string, RouteSequenceArcPenaltyDetail>();
  for (const detail of args.arcPenaltyDetails) {
    detailByArc.set(`${detail.fromNodeIndex}:${detail.toNodeIndex}`, detail);
  }

  const diagnostics: Array<{
    driverId: DriverId;
    sequence: string;
    fromTaskId: TaskId | null;
    toTaskId: TaskId;
    fromCode: string;
    toCode: string;
    reason: RouteSequencePenaltyReason;
    penalty: number;
  }> = [];

  for (const route of args.solution.routes) {
    let previousTaskId: TaskId | null = null;
    let stopIndex = 0;

    for (const stop of route.stops) {
      stopIndex += 1;
      const fromNodeIndex =
        previousTaskId === null
          ? DEPOT_NODE_INDEX
          : args.input.tasks.find((task) => task.taskId === previousTaskId)?.nodeIndex;
      const toNodeIndex = args.input.tasks.find((task) => task.taskId === stop.taskId)?.nodeIndex;
      if (fromNodeIndex === undefined || toNodeIndex === undefined) {
        previousTaskId = stop.taskId;
        continue;
      }

      const detail = detailByArc.get(`${fromNodeIndex}:${toNodeIndex}`);
      if (detail && detail.penalty > 0) {
        diagnostics.push({
          driverId: route.driverId,
          sequence: `${stopIndex - 1} -> ${stopIndex}`,
          fromTaskId: detail.fromTaskId,
          toTaskId: detail.toTaskId ?? stop.taskId,
          fromCode:
            detail.fromTaskId === null
              ? "depot"
              : String(taskById.get(detail.fromTaskId)?.logisticCode ?? detail.fromTaskId),
          toCode: String(
            taskById.get(detail.toTaskId ?? stop.taskId)?.logisticCode ?? detail.toTaskId ?? stop.taskId
          ),
          reason: detail.reason,
          penalty: detail.penalty,
        });
      }

      previousTaskId = stop.taskId;
    }
  }

  return diagnostics;
}
