import type { DriverId, DriverNode, RoutingProblemInput, TaskId, TaskNode } from "./input-contract";
import type { RoutingRouteSolution, RoutingSolution, RoutingStopSolution } from "./solution-contract";
import {
  buildVehicleArcPenalties,
  type RouteSequenceArcPenaltyDetail,
} from "./groups/route-sequence-penalties";
import type { HistoricalTerritoryKey } from "./groups/historical-territory-profiles";

const DEPOT_NODE_INDEX = 0;
const EPSILON = 0.001;

const ROUTE_POLISHING_CONFIG = {
  maxIterationsPerRoute: 200,
  maxTravelOnlyIterationsPerRoute: 100,
  maxMoveBlockLength: 5,
  sequencePenaltyMultiplier: 3,
  waitPenaltyWeight: 0.1,
  initialDepotWaitPenaltyWeight: 0,
  routePenaltyWeight: 0.4,
  subZonePenaltyWeight: 1,
  subZoneBackwardPenaltyMin: 18,
  subZoneSkipPenaltyMin: 8,
  subZoneSkipMinTravelMin: 6,
  bucketRevisitPenaltyMin: 35,
  bucketFragmentationPenaltyMin: 20,
  bucketDirectionChangePenaltyMin: 35,
  bucketDirectionRegressionPenaltyMin: 35,
  bucketDirectionSkipPenaltyMin: 12,
  bucketMiddleStartPenaltyMin: 16,
  maxShapeFirstTravelIncreaseMin: 5,
  minShapePenaltyImprovementMin: 30,
  northStartCentralPenaltyMin: 10,
  northStartEastPenaltyMin: 16,
  rejectedSequenceCandidateLimit: 5,
  rejectedShapeCandidateLimit: 5,
  rejectedTravelOnlyCandidateLimit: 5,
} as const;

type CandidateMoveType =
  | "move-item"
  | "move-block-2"
  | "move-block-3"
  | "move-block-4"
  | "move-block-5"
  | "move-subzone-block"
  | "canonical-bucket-order"
  | "reverse-segment";
type PolishPass = "sequence-objective" | "travel-only";

interface RoutePolishingMetrics {
  objective: number;
  totalTravelMin: number;
  totalWaitMin: number;
  initialDepotWaitMin: number;
  inRouteWaitMin: number;
  totalServiceMin: number;
  routePenaltyMin: number;
  weightedRoutePenaltyMin: number;
  subZoneArcPenaltyMin: number;
  startBucketPenaltyMin: number;
  bucketRevisitPenaltyMin: number;
  bucketFragmentationPenaltyMin: number;
  bucketOrderPenaltyMin: number;
  sequentialShapePenaltyMin: number;
  subZonePenaltyMin: number;
  sequenceScoreMin: number;
}

interface SimulatedRoute {
  route: RoutingRouteSolution;
  objective: number;
  metrics: RoutePolishingMetrics;
  bucketSequence: string[];
}

interface CandidateOrder {
  order: TaskId[];
  moveType: CandidateMoveType;
  fromIndex: number;
  toIndex: number;
  length: number;
}

interface SubZoneAssignment {
  territoryIndex: number;
  territoryKey: HistoricalTerritoryKey;
  bucketIndex: number;
  bucketLabel: string;
}

interface RoutePolishingMoveDiagnostic {
  pass: PolishPass;
  iteration: number;
  moveType: CandidateMoveType;
  fromIndex: number;
  toIndex: number;
  length: number;
  orderBefore: TaskId[];
  orderAfter: TaskId[];
  deltaObjective: number;
  deltaTravelMin: number;
  deltaInitialDepotWaitMin: number;
  deltaInRouteWaitMin: number;
  deltaRoutePenaltyMin: number;
  deltaSubZonePenaltyMin: number;
  deltaBucketRevisitPenaltyMin: number;
  deltaBucketFragmentationPenaltyMin: number;
  deltaBucketOrderPenaltyMin: number;
  deltaSequentialShapePenaltyMin: number;
  deltaSequenceScoreMin: number;
}

type RejectedTravelOnlyReason =
  | "infeasible"
  | "not_travel_improving"
  | "subZonePenalty_would_increase"
  | "inRouteWait_would_increase";

type RejectedSequenceReason = "infeasible" | "objective_not_improving" | "not_best_improving";
type RejectedShapeReason =
  | "infeasible"
  | "shape_not_improved"
  | "shape_improved_but_travel_too_high"
  | "shape_improved_but_wait_worse"
  | "not_best_shape_candidate";

interface RejectedSequenceCandidateDiagnostic {
  iteration: number;
  moveType: CandidateMoveType;
  fromIndex: number;
  toIndex: number;
  length: number;
  orderBefore: TaskId[];
  orderAfter: TaskId[];
  deltaObjective: number | null;
  deltaTravelMin: number | null;
  deltaRoutePenaltyMin: number | null;
  deltaSubZonePenaltyMin: number | null;
  deltaSequentialShapePenaltyMin: number | null;
  deltaInRouteWaitMin: number | null;
  rejectedBecause: RejectedSequenceReason;
}

interface ShapeCandidateDiagnostic {
  iteration: number;
  moveType: CandidateMoveType;
  fromIndex: number;
  toIndex: number;
  length: number;
  orderBefore: TaskId[];
  orderAfter: TaskId[];
  deltaTravelMin: number | null;
  deltaRoutePenaltyMin: number | null;
  deltaSubZonePenaltyMin: number | null;
  deltaSequentialShapePenaltyMin: number | null;
  deltaInRouteWaitMin: number | null;
  rejectedBecause?: RejectedShapeReason;
}

interface RejectedTravelOnlyCandidateDiagnostic {
  iteration: number;
  moveType: CandidateMoveType;
  fromIndex: number;
  toIndex: number;
  length: number;
  orderBefore: TaskId[];
  orderAfter: TaskId[];
  deltaTravelMin: number | null;
  deltaRoutePenaltyMin: number | null;
  deltaSubZonePenaltyMin: number | null;
  deltaSequentialShapePenaltyMin: number | null;
  deltaInRouteWaitMin: number | null;
  rejectedBecause: RejectedTravelOnlyReason;
}

interface RoutePolishingRouteDiagnostic {
  driverId: DriverId;
  improved: boolean;
  before: RoutePolishingMetrics;
  after: RoutePolishingMetrics;
  bucketSequenceBefore: string[];
  bucketSequenceAfter: string[];
  acceptedMoves: RoutePolishingMoveDiagnostic[];
  generatedCanonicalBucketCandidates: TaskId[][];
  generatedSequentialShapeCandidates: TaskId[][];
  acceptedShapeFirstCandidates: ShapeCandidateDiagnostic[];
  bestRejectedShapeCandidates: ShapeCandidateDiagnostic[];
  bestRejectedSequenceCandidates: RejectedSequenceCandidateDiagnostic[];
  bestRejectedTravelOnlyCandidates: RejectedTravelOnlyCandidateDiagnostic[];
  evaluatedCandidateCount: number;
  rejectedInfeasibleCount: number;
}

export interface RoutePolishingDiagnostics {
  config: typeof ROUTE_POLISHING_CONFIG;
  improvedRouteCount: number;
  routes: RoutePolishingRouteDiagnostic[];
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

function buildSubZoneLookup(input: RoutingProblemInput): Map<TaskId, SubZoneAssignment> {
  const assignment = input.metadata.dailyTerritoryAssignment;
  if (
    !assignment ||
    !assignment.routingPenaltiesEnabled ||
    assignment.territoryMode !== "historical_template_3_drivers" ||
    assignment.territories.length === 0
  ) {
    return new Map();
  }

  const territoryByIndex = new Map(
    assignment.territories.map((territory) => [territory.territoryIndex, territory])
  );
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const lookup = new Map<TaskId, SubZoneAssignment>();

  for (const entry of assignment.taskTerritoryIndex) {
    const territory = territoryByIndex.get(entry.territoryIndex);
    const task = taskById.get(entry.taskId);
    if (!territory?.territoryKey || !task) continue;

    const bucket = classifySubZone({
      territoryKey: territory.territoryKey,
      centroid: territory.historicalCentroid ?? territory.centroid,
      lat: task.location.lat,
      lng: task.location.lng,
    });

    lookup.set(entry.taskId, {
      territoryIndex: entry.territoryIndex,
      territoryKey: territory.territoryKey,
      bucketIndex: bucket.bucketIndex,
      bucketLabel: bucket.bucketLabel,
    });
  }

  return lookup;
}

function classifySubZone(args: {
  territoryKey: HistoricalTerritoryKey;
  centroid: { lat: number; lng: number };
  lat: number;
  lng: number;
}): { bucketIndex: number; bucketLabel: string } {
  const relativeLat = args.lat - args.centroid.lat;
  const relativeLng = args.lng - args.centroid.lng;

  switch (args.territoryKey) {
    case "north":
      if (relativeLng < -0.012) return { bucketIndex: 0, bucketLabel: "north_west" };
      if (relativeLng > 0.012) return { bucketIndex: 2, bucketLabel: "north_east" };
      return { bucketIndex: 1, bucketLabel: "north_central" };
    case "center_south_west":
      if (relativeLat < -0.008) return { bucketIndex: 3, bucketLabel: "south_west" };
      if (relativeLng < -0.016) return { bucketIndex: 0, bucketLabel: "far_west" };
      if (relativeLng < -0.008) return { bucketIndex: 1, bucketLabel: "north_west" };
      return { bucketIndex: 2, bucketLabel: "central_inner" };
    case "center_south_east":
      if (relativeLng < -0.01) return { bucketIndex: 0, bucketLabel: "central_east" };
      if (relativeLng > 0.018 && relativeLat >= -0.008) {
        return { bucketIndex: 2, bucketLabel: "far_east" };
      }
      if (relativeLat < -0.008 || (relativeLat < -0.004 && relativeLng > 0.018)) {
        return { bucketIndex: 4, bucketLabel: "south_east" };
      }
      if (relativeLat < -0.004) return { bucketIndex: 3, bucketLabel: "center_south" };
      return { bucketIndex: 1, bucketLabel: "east_north" };
    default:
      return { bucketIndex: 0, bucketLabel: "unknown" };
  }
}

function subZonePenalty(args: {
  fromTaskId: TaskId | null;
  toTaskId: TaskId;
  travelMin: number;
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): number {
  if (args.fromTaskId === null) return 0;

  const from = args.subZoneByTaskId.get(args.fromTaskId);
  const to = args.subZoneByTaskId.get(args.toTaskId);
  if (!from || !to || from.territoryIndex !== to.territoryIndex) return 0;

  let penalty = 0;
  if (to.bucketIndex < from.bucketIndex) {
    penalty += ROUTE_POLISHING_CONFIG.subZoneBackwardPenaltyMin * (from.bucketIndex - to.bucketIndex);
  }

  if (
    Math.abs(to.bucketIndex - from.bucketIndex) > 1 &&
    args.travelMin >= ROUTE_POLISHING_CONFIG.subZoneSkipMinTravelMin
  ) {
    penalty += ROUTE_POLISHING_CONFIG.subZoneSkipPenaltyMin;
  }

  return penalty;
}

function isFeasibleFirstStop(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  task: TaskNode;
}): boolean {
  const travel = travelMin(args.input, DEPOT_NODE_INDEX, args.task.nodeIndex);
  if (travel === null) return false;

  const arrivalMin = args.driver.workWindow.startMin + travel;
  const startMin = Math.max(arrivalMin, args.task.hardWindow.earliestStartMin);
  const endMin = startMin + args.task.serviceDurationMin;
  return (
    startMin <= args.task.hardWindow.latestStartMin &&
    endMin <= args.task.hardWindow.latestEndMin &&
    endMin <= args.driver.workWindow.endMin
  );
}

function canServeCandidateBeforeTarget(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  candidate: TaskNode;
  target: TaskNode;
}): boolean {
  const depotToCandidate = travelMin(args.input, DEPOT_NODE_INDEX, args.candidate.nodeIndex);
  const candidateToTarget = travelMin(args.input, args.candidate.nodeIndex, args.target.nodeIndex);
  if (depotToCandidate === null || candidateToTarget === null) return false;

  const candidateArrivalMin = args.driver.workWindow.startMin + depotToCandidate;
  const candidateStartMin = Math.max(
    candidateArrivalMin,
    args.candidate.hardWindow.earliestStartMin
  );
  const candidateEndMin = candidateStartMin + args.candidate.serviceDurationMin;
  if (
    candidateStartMin > args.candidate.hardWindow.latestStartMin ||
    candidateEndMin > args.candidate.hardWindow.latestEndMin ||
    candidateEndMin > args.driver.workWindow.endMin
  ) {
    return false;
  }

  const targetArrivalMin = candidateEndMin + candidateToTarget;
  const targetStartMin = Math.max(targetArrivalMin, args.target.hardWindow.earliestStartMin);
  const targetEndMin = targetStartMin + args.target.serviceDurationMin;
  return (
    targetStartMin <= args.target.hardWindow.latestStartMin &&
    targetEndMin <= args.target.hardWindow.latestEndMin &&
    targetEndMin <= args.driver.workWindow.endMin
  );
}

function startBucketPenalty(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  orderedTaskIds: TaskId[];
  taskById: Map<TaskId, TaskNode>;
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): number {
  const firstTaskId = args.orderedTaskIds[0];
  const firstTask = args.taskById.get(firstTaskId);
  const firstSubZone = args.subZoneByTaskId.get(firstTaskId);
  if (!firstTask || !firstSubZone) return 0;
  if (firstSubZone.bucketIndex !== 1) return 0;

  const hasFeasibleEdgeBucket = args.orderedTaskIds.some((taskId) => {
    if (taskId === firstTaskId) return false;
    const task = args.taskById.get(taskId);
    const subZone = args.subZoneByTaskId.get(taskId);
    if (!task || !subZone) return false;
    if (subZone.territoryIndex !== firstSubZone.territoryIndex) return false;
    if (subZone.bucketIndex === firstSubZone.bucketIndex) return false;
    if (!isFeasibleFirstStop({ input: args.input, driver: args.driver, task })) return false;
    return canServeCandidateBeforeTarget({
      input: args.input,
      driver: args.driver,
      candidate: task,
      target: firstTask,
    });
  });

  return hasFeasibleEdgeBucket ? ROUTE_POLISHING_CONFIG.bucketMiddleStartPenaltyMin : 0;
}

function bucketFragmentationPenalties(args: {
  orderedTaskIds: TaskId[];
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): { bucketRevisitPenaltyMin: number; bucketFragmentationPenaltyMin: number } {
  const compressedBuckets: string[] = [];

  for (const taskId of args.orderedTaskIds) {
    const bucket = bucketLabelForTask(taskId, args.subZoneByTaskId);
    if (bucket === "unbucketed") continue;
    if (compressedBuckets[compressedBuckets.length - 1] !== bucket) {
      compressedBuckets.push(bucket);
    }
  }

  const blockCountByBucket = new Map<string, number>();
  let revisits = 0;
  for (const bucket of compressedBuckets) {
    const previousBlocks = blockCountByBucket.get(bucket) ?? 0;
    if (previousBlocks > 0) revisits += 1;
    blockCountByBucket.set(bucket, previousBlocks + 1);
  }

  let extraBlocks = 0;
  for (const blockCount of blockCountByBucket.values()) {
    extraBlocks += Math.max(0, blockCount - 1);
  }

  return {
    bucketRevisitPenaltyMin: revisits * ROUTE_POLISHING_CONFIG.bucketRevisitPenaltyMin,
    bucketFragmentationPenaltyMin:
      extraBlocks * ROUTE_POLISHING_CONFIG.bucketFragmentationPenaltyMin,
  };
}

function compressedSubZones(
  orderedTaskIds: TaskId[],
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>
): SubZoneAssignment[] {
  const compressedBuckets: SubZoneAssignment[] = [];

  for (const taskId of orderedTaskIds) {
    const bucket = subZoneByTaskId.get(taskId);
    if (!bucket) continue;
    const previous = compressedBuckets[compressedBuckets.length - 1];
    if (
      !previous ||
      previous.territoryKey !== bucket.territoryKey ||
      previous.bucketLabel !== bucket.bucketLabel
    ) {
      compressedBuckets.push(bucket);
    }
  }

  return compressedBuckets;
}

function directionalBucketPenalty(bucketIndexes: number[], direction: 1 | -1): number {
  let penalty = 0;
  let previousStepSign = 0;

  for (let index = 1; index < bucketIndexes.length; index += 1) {
    const previous = bucketIndexes[index - 1];
    const current = bucketIndexes[index];
    const delta = current - previous;
    if (delta === 0) continue;

    const stepSign = delta > 0 ? 1 : -1;
    if (previousStepSign !== 0 && stepSign !== previousStepSign) {
      penalty += ROUTE_POLISHING_CONFIG.bucketDirectionChangePenaltyMin;
    }
    previousStepSign = stepSign;

    const movesAgainstDirection = direction === 1 ? delta < 0 : delta > 0;
    if (movesAgainstDirection) {
      penalty +=
        Math.abs(delta) * ROUTE_POLISHING_CONFIG.bucketDirectionRegressionPenaltyMin;
    }
    if (Math.abs(delta) > 1) {
      penalty += (Math.abs(delta) - 1) * ROUTE_POLISHING_CONFIG.bucketDirectionSkipPenaltyMin;
    }
  }

  return penalty;
}

function sequentialShapePenalty(args: {
  orderedTaskIds: TaskId[];
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): number {
  const compressedBuckets = compressedSubZones(args.orderedTaskIds, args.subZoneByTaskId);
  const bucketIndexesByTerritory = new Map<number, number[]>();

  for (const bucket of compressedBuckets) {
    const bucketIndexes = bucketIndexesByTerritory.get(bucket.territoryIndex) ?? [];
    bucketIndexes.push(bucket.bucketIndex);
    bucketIndexesByTerritory.set(bucket.territoryIndex, bucketIndexes);
  }

  let penalty = 0;
  for (const bucketIndexes of bucketIndexesByTerritory.values()) {
    if (bucketIndexes.length < 2) continue;
    penalty += Math.min(
      directionalBucketPenalty(bucketIndexes, 1),
      directionalBucketPenalty(bucketIndexes, -1)
    );
  }

  return penalty;
}

function bucketOrderPenalty(args: {
  orderedTaskIds: TaskId[];
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): number {
  return sequentialShapePenalty(args);
}

function bucketLabelForTask(
  taskId: TaskId,
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>
): string {
  const subZone = subZoneByTaskId.get(taskId);
  if (!subZone) return "unbucketed";
  return `${subZone.territoryKey}:${subZone.bucketLabel}`;
}

function simulateRoute(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  orderedTaskIds: TaskId[];
  taskById: Map<TaskId, TaskNode>;
  penaltyLookup: Map<string, number>;
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): SimulatedRoute | null {
  const { input, driver, orderedTaskIds, taskById, penaltyLookup, subZoneByTaskId } = args;
  const stops: RoutingStopSolution[] = [];
  let previousNodeIndex = DEPOT_NODE_INDEX;
  let previousTaskId: TaskId | null = null;
  let previousEndMin = driver.workWindow.startMin;
  let totalTravelMin = 0;
  let totalWaitMin = 0;
  let initialDepotWaitMin = 0;
  let inRouteWaitMin = 0;
  let totalServiceMin = 0;
  let routePenalty = 0;
  let totalSubZoneArcPenalty = 0;

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
    const routeSubZonePenalty = subZonePenalty({
      fromTaskId: previousTaskId,
      toTaskId: taskId,
      travelMin: travel,
      subZoneByTaskId,
    });

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
    if (index === 0) {
      initialDepotWaitMin += waitMin;
    } else {
      inRouteWaitMin += waitMin;
    }
    totalServiceMin += task.serviceDurationMin;
    routePenalty += sequencePenalty;
    totalSubZoneArcPenalty += routeSubZonePenalty;
    previousNodeIndex = task.nodeIndex;
    previousTaskId = taskId;
    previousEndMin = endMin;
  }

  if (stops.length === 0) return null;

  const startBucketPenaltyMin = startBucketPenalty({
    input,
    driver,
    orderedTaskIds,
    taskById,
    subZoneByTaskId,
  });
  const { bucketRevisitPenaltyMin, bucketFragmentationPenaltyMin } = bucketFragmentationPenalties({
    orderedTaskIds,
    subZoneByTaskId,
  });
  const sequentialShapePenaltyMin = sequentialShapePenalty({
    orderedTaskIds,
    subZoneByTaskId,
  });
  const bucketOrderPenaltyMin = sequentialShapePenaltyMin;
  const totalSubZonePenalty =
    totalSubZoneArcPenalty +
    startBucketPenaltyMin +
    bucketRevisitPenaltyMin +
    bucketFragmentationPenaltyMin +
    sequentialShapePenaltyMin;

  const weightedRoutePenaltyMin = routePenalty * ROUTE_POLISHING_CONFIG.routePenaltyWeight;
  const weightedSubZonePenaltyMin =
    totalSubZonePenalty * ROUTE_POLISHING_CONFIG.subZonePenaltyWeight;
  const sequenceScoreMin = weightedRoutePenaltyMin + weightedSubZonePenaltyMin;
  const objective =
    totalTravelMin +
    inRouteWaitMin * ROUTE_POLISHING_CONFIG.waitPenaltyWeight +
    initialDepotWaitMin * ROUTE_POLISHING_CONFIG.initialDepotWaitPenaltyWeight +
    sequenceScoreMin * ROUTE_POLISHING_CONFIG.sequencePenaltyMultiplier;
  const metrics: RoutePolishingMetrics = {
    objective,
    totalTravelMin,
    totalWaitMin,
    initialDepotWaitMin,
    inRouteWaitMin,
    totalServiceMin,
    routePenaltyMin: routePenalty,
    weightedRoutePenaltyMin,
    subZoneArcPenaltyMin: totalSubZoneArcPenalty,
    startBucketPenaltyMin,
    bucketRevisitPenaltyMin,
    bucketFragmentationPenaltyMin,
    bucketOrderPenaltyMin,
    sequentialShapePenaltyMin,
    subZonePenaltyMin: totalSubZonePenalty,
    sequenceScoreMin,
  };

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
    objective,
    metrics,
    bucketSequence: orderedTaskIds.map((taskId) => bucketLabelForTask(taskId, subZoneByTaskId)),
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

function moveBlockMoveType(length: number): CandidateMoveType {
  switch (length) {
    case 2:
      return "move-block-2";
    case 3:
      return "move-block-3";
    case 4:
      return "move-block-4";
    case 5:
      return "move-block-5";
    default:
      return "move-subzone-block";
  }
}

function contiguousBucketBlocks(
  order: TaskId[],
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>
): Array<{ startIndex: number; length: number; label: string }> {
  const blocks: Array<{ startIndex: number; length: number; label: string }> = [];

  for (let index = 0; index < order.length; index += 1) {
    const label = bucketLabelForTask(order[index], subZoneByTaskId);
    const last = blocks[blocks.length - 1];
    if (last && last.label === label) {
      last.length += 1;
      continue;
    }
    blocks.push({ startIndex: index, length: 1, label });
  }

  return blocks;
}

function travelBetweenTasks(
  input: RoutingProblemInput,
  taskById: Map<TaskId, TaskNode>,
  fromTaskId: TaskId,
  toTaskId: TaskId
): number | null {
  const fromTask = taskById.get(fromTaskId);
  const toTask = taskById.get(toTaskId);
  if (!fromTask || !toTask) return null;
  return travelMin(input, fromTask.nodeIndex, toTask.nodeIndex);
}

function routeInternalTravel(
  input: RoutingProblemInput,
  taskById: Map<TaskId, TaskNode>,
  order: TaskId[]
): number {
  let total = 0;
  for (let index = 1; index < order.length; index += 1) {
    total += travelBetweenTasks(input, taskById, order[index - 1], order[index]) ?? 0;
  }
  return total;
}

function nearestNeighborBucketOrder(
  input: RoutingProblemInput,
  taskById: Map<TaskId, TaskNode>,
  bucketTaskIds: TaskId[]
): TaskId[] {
  if (bucketTaskIds.length < 3) return bucketTaskIds;

  let bestOrder = bucketTaskIds;
  let bestTravel = routeInternalTravel(input, taskById, bucketTaskIds);

  for (const startTaskId of bucketTaskIds) {
    const remaining = new Set(bucketTaskIds);
    const candidateOrder: TaskId[] = [startTaskId];
    remaining.delete(startTaskId);

    while (remaining.size > 0) {
      const previousTaskId = candidateOrder[candidateOrder.length - 1];
      let nextTaskId: TaskId | null = null;
      let nextTravel = Number.POSITIVE_INFINITY;

      for (const taskId of remaining) {
        const travel = travelBetweenTasks(input, taskById, previousTaskId, taskId);
        if (travel !== null && travel < nextTravel) {
          nextTaskId = taskId;
          nextTravel = travel;
        }
      }

      if (nextTaskId === null) return bestOrder;
      candidateOrder.push(nextTaskId);
      remaining.delete(nextTaskId);
    }

    const candidateTravel = routeInternalTravel(input, taskById, candidateOrder);
    if (candidateTravel + EPSILON < bestTravel) {
      bestOrder = candidateOrder;
      bestTravel = candidateTravel;
    }
  }

  return bestOrder;
}

function canonicalBucketOrders(
  input: RoutingProblemInput,
  taskById: Map<TaskId, TaskNode>,
  order: TaskId[],
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>
): TaskId[][] {
  const territoryKeys = new Set<HistoricalTerritoryKey>();
  const bucketTasksByIndex = new Map<number, TaskId[]>();

  for (const taskId of order) {
    const subZone = subZoneByTaskId.get(taskId);
    if (!subZone) return [];

    territoryKeys.add(subZone.territoryKey);
    const bucketTasks = bucketTasksByIndex.get(subZone.bucketIndex) ?? [];
    bucketTasks.push(taskId);
    bucketTasksByIndex.set(subZone.bucketIndex, bucketTasks);
  }

  if (territoryKeys.size !== 1 || bucketTasksByIndex.size < 2) return [];

  const bucketIndexes = [...bucketTasksByIndex.keys()].sort((left, right) => left - right);
  const buildOrder = (orderedBucketIndexes: number[]): TaskId[] =>
    orderedBucketIndexes.flatMap((bucketIndex) =>
      nearestNeighborBucketOrder(input, taskById, bucketTasksByIndex.get(bucketIndex) ?? [])
    );

  return [buildOrder(bucketIndexes), buildOrder([...bucketIndexes].reverse())].filter(
    (candidateOrder) =>
      candidateOrder.length === order.length &&
      !candidateOrder.every((taskId, index) => taskId === order[index])
  );
}

function candidateOrders(
  input: RoutingProblemInput,
  taskById: Map<TaskId, TaskNode>,
  order: TaskId[],
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>
): { candidates: CandidateOrder[]; generatedCanonicalBucketCandidates: TaskId[][] } {
  const candidates: CandidateOrder[] = [];
  const generatedCanonicalBucketCandidates: TaskId[][] = [];
  const seen = new Set<string>([order.join(",")]);
  const n = order.length;

  const pushCandidate = (candidate: CandidateOrder): void => {
    const key = candidate.order.join(",");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  for (const canonicalOrder of canonicalBucketOrders(input, taskById, order, subZoneByTaskId)) {
    generatedCanonicalBucketCandidates.push(canonicalOrder);
    pushCandidate({
      order: canonicalOrder,
      moveType: "canonical-bucket-order",
      fromIndex: 0,
      toIndex: 0,
      length: canonicalOrder.length,
    });
  }

  for (let from = 0; from < n; from += 1) {
    for (let to = 0; to < n; to += 1) {
      if (from === to) continue;
      pushCandidate({
        order: moveItem(order, from, to),
        moveType: "move-item",
        fromIndex: from,
        toIndex: to,
        length: 1,
      });
    }
  }

  const maxBlockLength = Math.min(ROUTE_POLISHING_CONFIG.maxMoveBlockLength, n - 1);
  for (let length = 2; length <= maxBlockLength; length += 1) {
    for (let from = 0; from <= n - length; from += 1) {
      for (let to = 0; to <= n; to += 1) {
        if (to >= from && to <= from + length) continue;
        pushCandidate({
          order: moveBlock(order, from, length, to),
          moveType: moveBlockMoveType(length),
          fromIndex: from,
          toIndex: to,
          length,
        });
      }
    }
  }

  const bucketBlocks = contiguousBucketBlocks(order, subZoneByTaskId);
  const blockBoundaries = [...bucketBlocks.map((block) => block.startIndex), n];
  for (const block of bucketBlocks) {
    if (block.label === "unbucketed") continue;
    for (const to of blockBoundaries) {
      if (to >= block.startIndex && to <= block.startIndex + block.length) continue;
      pushCandidate({
        order: moveBlock(order, block.startIndex, block.length, to),
        moveType: "move-subzone-block",
        fromIndex: block.startIndex,
        toIndex: to,
        length: block.length,
      });
    }
  }

  for (let from = 0; from < n - 2; from += 1) {
    for (let to = from + 2; to < n; to += 1) {
      pushCandidate({
        order: reverseSegment(order, from, to),
        moveType: "reverse-segment",
        fromIndex: from,
        toIndex: to,
        length: to - from + 1,
      });
    }
  }

  return { candidates, generatedCanonicalBucketCandidates };
}

function moveDiagnostic(args: {
  pass: PolishPass;
  iteration: number;
  candidate: CandidateOrder;
  before: SimulatedRoute;
  after: SimulatedRoute;
}): RoutePolishingMoveDiagnostic {
  return {
    pass: args.pass,
    iteration: args.iteration,
    moveType: args.candidate.moveType,
    fromIndex: args.candidate.fromIndex,
    toIndex: args.candidate.toIndex,
    length: args.candidate.length,
    orderBefore: args.before.route.stops.map((stop) => stop.taskId),
    orderAfter: args.after.route.stops.map((stop) => stop.taskId),
    deltaObjective: args.after.metrics.objective - args.before.metrics.objective,
    deltaTravelMin: args.after.metrics.totalTravelMin - args.before.metrics.totalTravelMin,
    deltaInitialDepotWaitMin:
      args.after.metrics.initialDepotWaitMin - args.before.metrics.initialDepotWaitMin,
    deltaInRouteWaitMin: args.after.metrics.inRouteWaitMin - args.before.metrics.inRouteWaitMin,
    deltaRoutePenaltyMin: args.after.metrics.routePenaltyMin - args.before.metrics.routePenaltyMin,
    deltaSubZonePenaltyMin:
      args.after.metrics.subZonePenaltyMin - args.before.metrics.subZonePenaltyMin,
    deltaBucketRevisitPenaltyMin:
      args.after.metrics.bucketRevisitPenaltyMin - args.before.metrics.bucketRevisitPenaltyMin,
    deltaBucketFragmentationPenaltyMin:
      args.after.metrics.bucketFragmentationPenaltyMin -
      args.before.metrics.bucketFragmentationPenaltyMin,
    deltaBucketOrderPenaltyMin:
      args.after.metrics.bucketOrderPenaltyMin - args.before.metrics.bucketOrderPenaltyMin,
    deltaSequentialShapePenaltyMin:
      args.after.metrics.sequentialShapePenaltyMin - args.before.metrics.sequentialShapePenaltyMin,
    deltaSequenceScoreMin:
      args.after.metrics.sequenceScoreMin - args.before.metrics.sequenceScoreMin,
  };
}

function rejectedSequenceDiagnostic(args: {
  iteration: number;
  candidate: CandidateOrder;
  before: SimulatedRoute;
  after: SimulatedRoute | null;
  rejectedBecause: RejectedSequenceReason;
}): RejectedSequenceCandidateDiagnostic {
  return {
    iteration: args.iteration,
    moveType: args.candidate.moveType,
    fromIndex: args.candidate.fromIndex,
    toIndex: args.candidate.toIndex,
    length: args.candidate.length,
    orderBefore: args.before.route.stops.map((stop) => stop.taskId),
    orderAfter: args.candidate.order,
    deltaObjective:
      args.after === null ? null : args.after.metrics.objective - args.before.metrics.objective,
    deltaTravelMin:
      args.after === null
        ? null
        : args.after.metrics.totalTravelMin - args.before.metrics.totalTravelMin,
    deltaRoutePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.routePenaltyMin - args.before.metrics.routePenaltyMin,
    deltaSubZonePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.subZonePenaltyMin - args.before.metrics.subZonePenaltyMin,
    deltaSequentialShapePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.sequentialShapePenaltyMin -
          args.before.metrics.sequentialShapePenaltyMin,
    deltaInRouteWaitMin:
      args.after === null
        ? null
        : args.after.metrics.inRouteWaitMin - args.before.metrics.inRouteWaitMin,
    rejectedBecause: args.rejectedBecause,
  };
}

function rejectedTravelOnlyDiagnostic(args: {
  iteration: number;
  candidate: CandidateOrder;
  before: SimulatedRoute;
  after: SimulatedRoute | null;
  rejectedBecause: RejectedTravelOnlyReason;
}): RejectedTravelOnlyCandidateDiagnostic {
  return {
    iteration: args.iteration,
    moveType: args.candidate.moveType,
    fromIndex: args.candidate.fromIndex,
    toIndex: args.candidate.toIndex,
    length: args.candidate.length,
    orderBefore: args.before.route.stops.map((stop) => stop.taskId),
    orderAfter: args.candidate.order,
    deltaTravelMin:
      args.after === null
        ? null
        : args.after.metrics.totalTravelMin - args.before.metrics.totalTravelMin,
    deltaRoutePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.routePenaltyMin - args.before.metrics.routePenaltyMin,
    deltaSubZonePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.subZonePenaltyMin - args.before.metrics.subZonePenaltyMin,
    deltaSequentialShapePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.sequentialShapePenaltyMin -
          args.before.metrics.sequentialShapePenaltyMin,
    deltaInRouteWaitMin:
      args.after === null
        ? null
        : args.after.metrics.inRouteWaitMin - args.before.metrics.inRouteWaitMin,
    rejectedBecause: args.rejectedBecause,
  };
}

function shapeCandidateDiagnostic(args: {
  iteration: number;
  candidate: CandidateOrder;
  before: SimulatedRoute;
  after: SimulatedRoute | null;
  rejectedBecause?: RejectedShapeReason;
}): ShapeCandidateDiagnostic {
  return {
    iteration: args.iteration,
    moveType: args.candidate.moveType,
    fromIndex: args.candidate.fromIndex,
    toIndex: args.candidate.toIndex,
    length: args.candidate.length,
    orderBefore: args.before.route.stops.map((stop) => stop.taskId),
    orderAfter: args.candidate.order,
    deltaTravelMin:
      args.after === null
        ? null
        : args.after.metrics.totalTravelMin - args.before.metrics.totalTravelMin,
    deltaRoutePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.routePenaltyMin - args.before.metrics.routePenaltyMin,
    deltaSubZonePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.subZonePenaltyMin - args.before.metrics.subZonePenaltyMin,
    deltaSequentialShapePenaltyMin:
      args.after === null
        ? null
        : args.after.metrics.sequentialShapePenaltyMin -
          args.before.metrics.sequentialShapePenaltyMin,
    deltaInRouteWaitMin:
      args.after === null
        ? null
        : args.after.metrics.inRouteWaitMin - args.before.metrics.inRouteWaitMin,
    rejectedBecause: args.rejectedBecause,
  };
}

function isStructuralShapeCandidate(candidate: CandidateOrder): boolean {
  return (
    candidate.moveType === "canonical-bucket-order" ||
    candidate.moveType === "move-subzone-block" ||
    candidate.moveType === "move-block-3" ||
    candidate.moveType === "move-block-4" ||
    candidate.moveType === "move-block-5"
  );
}

function rejectedShapeReason(args: {
  candidate: CandidateOrder;
  before: SimulatedRoute;
  after: SimulatedRoute;
}): RejectedShapeReason | null {
  if (!isStructuralShapeCandidate(args.candidate)) return "shape_not_improved";

  const shapeImprovement =
    args.before.metrics.sequentialShapePenaltyMin - args.after.metrics.sequentialShapePenaltyMin;
  if (shapeImprovement + EPSILON < ROUTE_POLISHING_CONFIG.minShapePenaltyImprovementMin) {
    return "shape_not_improved";
  }

  const travelIncrease = args.after.metrics.totalTravelMin - args.before.metrics.totalTravelMin;
  if (travelIncrease > ROUTE_POLISHING_CONFIG.maxShapeFirstTravelIncreaseMin + EPSILON) {
    return "shape_improved_but_travel_too_high";
  }

  if (args.after.metrics.inRouteWaitMin > args.before.metrics.inRouteWaitMin + EPSILON) {
    return "shape_improved_but_wait_worse";
  }

  return null;
}

function isBetterShapeCandidate(
  candidate: { candidate: CandidateOrder; simulated: SimulatedRoute },
  current: { candidate: CandidateOrder; simulated: SimulatedRoute } | null
): boolean {
  if (!current) return true;

  const candidateShape = candidate.simulated.metrics.sequentialShapePenaltyMin;
  const currentShape = current.simulated.metrics.sequentialShapePenaltyMin;
  if (Math.abs(candidateShape - currentShape) > EPSILON) return candidateShape < currentShape;

  const candidateSubZone = candidate.simulated.metrics.subZonePenaltyMin;
  const currentSubZone = current.simulated.metrics.subZonePenaltyMin;
  if (Math.abs(candidateSubZone - currentSubZone) > EPSILON) return candidateSubZone < currentSubZone;

  return candidate.simulated.metrics.totalTravelMin < current.simulated.metrics.totalTravelMin;
}

function topRejectedSequenceCandidates(
  candidates: RejectedSequenceCandidateDiagnostic[]
): RejectedSequenceCandidateDiagnostic[] {
  return [...candidates]
    .sort((left, right) => {
      const leftObjective = left.deltaObjective ?? Number.POSITIVE_INFINITY;
      const rightObjective = right.deltaObjective ?? Number.POSITIVE_INFINITY;
      if (Math.abs(leftObjective - rightObjective) > EPSILON) {
        return leftObjective - rightObjective;
      }
      const leftSubZone = left.deltaSubZonePenaltyMin ?? Number.POSITIVE_INFINITY;
      const rightSubZone = right.deltaSubZonePenaltyMin ?? Number.POSITIVE_INFINITY;
      if (Math.abs(leftSubZone - rightSubZone) > EPSILON) return leftSubZone - rightSubZone;
      const leftTravel = left.deltaTravelMin ?? Number.POSITIVE_INFINITY;
      const rightTravel = right.deltaTravelMin ?? Number.POSITIVE_INFINITY;
      return leftTravel - rightTravel;
    })
    .slice(0, ROUTE_POLISHING_CONFIG.rejectedSequenceCandidateLimit);
}

function topRejectedShapeCandidates(candidates: ShapeCandidateDiagnostic[]): ShapeCandidateDiagnostic[] {
  return [...candidates]
    .sort((left, right) => {
      const leftShape = left.deltaSequentialShapePenaltyMin ?? Number.POSITIVE_INFINITY;
      const rightShape = right.deltaSequentialShapePenaltyMin ?? Number.POSITIVE_INFINITY;
      if (Math.abs(leftShape - rightShape) > EPSILON) return leftShape - rightShape;
      const leftTravel = left.deltaTravelMin ?? Number.POSITIVE_INFINITY;
      const rightTravel = right.deltaTravelMin ?? Number.POSITIVE_INFINITY;
      return leftTravel - rightTravel;
    })
    .slice(0, ROUTE_POLISHING_CONFIG.rejectedShapeCandidateLimit);
}

function topRejectedTravelOnlyCandidates(
  candidates: RejectedTravelOnlyCandidateDiagnostic[]
): RejectedTravelOnlyCandidateDiagnostic[] {
  return [...candidates]
    .sort((left, right) => {
      const leftTravel = left.deltaTravelMin ?? Number.POSITIVE_INFINITY;
      const rightTravel = right.deltaTravelMin ?? Number.POSITIVE_INFINITY;
      if (Math.abs(leftTravel - rightTravel) > EPSILON) return leftTravel - rightTravel;
      const leftSubZone = left.deltaSubZonePenaltyMin ?? Number.POSITIVE_INFINITY;
      const rightSubZone = right.deltaSubZonePenaltyMin ?? Number.POSITIVE_INFINITY;
      if (Math.abs(leftSubZone - rightSubZone) > EPSILON) return leftSubZone - rightSubZone;
      const leftWait = left.deltaInRouteWaitMin ?? Number.POSITIVE_INFINITY;
      const rightWait = right.deltaInRouteWaitMin ?? Number.POSITIVE_INFINITY;
      return leftWait - rightWait;
    })
    .slice(0, ROUTE_POLISHING_CONFIG.rejectedTravelOnlyCandidateLimit);
}

function polishRoute(args: {
  input: RoutingProblemInput;
  route: RoutingRouteSolution;
  driver: DriverNode;
  taskById: Map<TaskId, TaskNode>;
  penaltyLookup: Map<string, number>;
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
}): {
  route: RoutingRouteSolution;
  improved: boolean;
  beforeObjective: number;
  afterObjective: number;
  diagnostic: RoutePolishingRouteDiagnostic | null;
} {
  const initialOrder = args.route.stops.map((stop) => stop.taskId);
  const initial = simulateRoute({
    input: args.input,
    driver: args.driver,
    orderedTaskIds: initialOrder,
    taskById: args.taskById,
    penaltyLookup: args.penaltyLookup,
    subZoneByTaskId: args.subZoneByTaskId,
  });

  if (!initial) {
    return {
      route: args.route,
      improved: false,
      beforeObjective: Number.POSITIVE_INFINITY,
      afterObjective: Number.POSITIVE_INFINITY,
      diagnostic: null,
    };
  }

  let bestOrder = initialOrder;
  let best = initial;
  const beforeObjective = initial.objective;
  const acceptedMoves: RoutePolishingMoveDiagnostic[] = [];
  const rejectedSequenceCandidates: RejectedSequenceCandidateDiagnostic[] = [];
  const rejectedShapeCandidates: ShapeCandidateDiagnostic[] = [];
  const rejectedTravelOnlyCandidates: RejectedTravelOnlyCandidateDiagnostic[] = [];
  const generatedCanonicalBucketCandidates: TaskId[][] = [];
  const generatedSequentialShapeCandidates: TaskId[][] = [];
  const acceptedShapeFirstCandidates: ShapeCandidateDiagnostic[] = [];
  let evaluatedCandidateCount = 0;
  let rejectedInfeasibleCount = 0;

  for (let iteration = 0; iteration < ROUTE_POLISHING_CONFIG.maxIterationsPerRoute; iteration += 1) {
    let bestCandidate: { candidate: CandidateOrder; simulated: SimulatedRoute } | null = null;
    let bestShapeCandidate: { candidate: CandidateOrder; simulated: SimulatedRoute } | null = null;
    const generated = candidateOrders(args.input, args.taskById, bestOrder, args.subZoneByTaskId);
    generatedCanonicalBucketCandidates.push(...generated.generatedCanonicalBucketCandidates);
    generatedSequentialShapeCandidates.push(...generated.generatedCanonicalBucketCandidates);

    for (const candidate of generated.candidates) {
      evaluatedCandidateCount += 1;
      const simulated = simulateRoute({
        input: args.input,
        driver: args.driver,
        orderedTaskIds: candidate.order,
        taskById: args.taskById,
        penaltyLookup: args.penaltyLookup,
        subZoneByTaskId: args.subZoneByTaskId,
      });
      if (!simulated) {
        rejectedInfeasibleCount += 1;
        if (isStructuralShapeCandidate(candidate)) {
          rejectedShapeCandidates.push(
            shapeCandidateDiagnostic({
              iteration,
              candidate,
              before: best,
              after: null,
              rejectedBecause: "infeasible",
            })
          );
        }
        rejectedSequenceCandidates.push(
          rejectedSequenceDiagnostic({
            iteration,
            candidate,
            before: best,
            after: null,
            rejectedBecause: "infeasible",
          })
        );
        continue;
      }

      let structuralShapeRejectedReason: RejectedShapeReason | null | undefined;
      if (isStructuralShapeCandidate(candidate)) {
        structuralShapeRejectedReason = rejectedShapeReason({
          candidate,
          before: best,
          after: simulated,
        });
        if (structuralShapeRejectedReason === null) {
          const shapeCandidate = { candidate, simulated };
          if (isBetterShapeCandidate(shapeCandidate, bestShapeCandidate)) {
            if (bestShapeCandidate) {
              rejectedShapeCandidates.push(
                shapeCandidateDiagnostic({
                  iteration,
                  candidate: bestShapeCandidate.candidate,
                  before: best,
                  after: bestShapeCandidate.simulated,
                  rejectedBecause: "not_best_shape_candidate",
                })
              );
            }
            bestShapeCandidate = shapeCandidate;
          } else {
            rejectedShapeCandidates.push(
              shapeCandidateDiagnostic({
                iteration,
                candidate,
                before: best,
                after: simulated,
                rejectedBecause: "not_best_shape_candidate",
              })
            );
          }
        } else {
          rejectedShapeCandidates.push(
            shapeCandidateDiagnostic({
              iteration,
              candidate,
              before: best,
              after: simulated,
              rejectedBecause: structuralShapeRejectedReason,
            })
          );
        }
      }

      const scalarOnlyRegression =
        simulated.metrics.sequentialShapePenaltyMin >= best.metrics.sequentialShapePenaltyMin - EPSILON &&
        simulated.metrics.totalTravelMin > best.metrics.totalTravelMin + EPSILON &&
        simulated.metrics.inRouteWaitMin >= best.metrics.inRouteWaitMin - EPSILON;
      const violatesShapeGuardrail =
        structuralShapeRejectedReason === "shape_improved_but_travel_too_high" ||
        structuralShapeRejectedReason === "shape_improved_but_wait_worse";
      const improvesObjective =
        simulated.objective + EPSILON < best.objective &&
        !scalarOnlyRegression &&
        !violatesShapeGuardrail;

      if (
        improvesObjective &&
        (!bestCandidate || simulated.objective + EPSILON < bestCandidate.simulated.objective)
      ) {
        bestCandidate = { candidate, simulated };
      } else {
        rejectedSequenceCandidates.push(
          rejectedSequenceDiagnostic({
            iteration,
            candidate,
            before: best,
            after: simulated,
            rejectedBecause: improvesObjective ? "not_best_improving" : "objective_not_improving",
          })
        );
      }
    }

    const acceptedByShape = bestShapeCandidate !== null;
    if (!bestCandidate && !bestShapeCandidate) break;

    const acceptedCandidate = bestShapeCandidate ?? bestCandidate;
    if (!acceptedCandidate) break;

    if (acceptedByShape) {
      acceptedShapeFirstCandidates.push(
        shapeCandidateDiagnostic({
          iteration,
          candidate: acceptedCandidate.candidate,
          before: best,
          after: acceptedCandidate.simulated,
        })
      );
    }

    acceptedMoves.push(
      moveDiagnostic({
        pass: "sequence-objective",
        iteration,
        candidate: acceptedCandidate.candidate,
        before: best,
        after: acceptedCandidate.simulated,
      })
    );
    bestOrder = acceptedCandidate.candidate.order;
    best = acceptedCandidate.simulated;
  }

  for (
    let iteration = 0;
    iteration < ROUTE_POLISHING_CONFIG.maxTravelOnlyIterationsPerRoute;
    iteration += 1
  ) {
    let bestCandidate: { candidate: CandidateOrder; simulated: SimulatedRoute } | null = null;
    const generated = candidateOrders(args.input, args.taskById, bestOrder, args.subZoneByTaskId);
    generatedCanonicalBucketCandidates.push(...generated.generatedCanonicalBucketCandidates);
    generatedSequentialShapeCandidates.push(...generated.generatedCanonicalBucketCandidates);

    for (const candidate of generated.candidates) {
      evaluatedCandidateCount += 1;
      const simulated = simulateRoute({
        input: args.input,
        driver: args.driver,
        orderedTaskIds: candidate.order,
        taskById: args.taskById,
        penaltyLookup: args.penaltyLookup,
        subZoneByTaskId: args.subZoneByTaskId,
      });
      if (!simulated) {
        rejectedInfeasibleCount += 1;
        rejectedTravelOnlyCandidates.push(
          rejectedTravelOnlyDiagnostic({
            iteration,
            candidate,
            before: best,
            after: null,
            rejectedBecause: "infeasible",
          })
        );
        continue;
      }

      const improvesTravel = simulated.metrics.totalTravelMin + EPSILON < best.metrics.totalTravelMin;
      const preservesSubZone =
        simulated.metrics.subZonePenaltyMin <= best.metrics.subZonePenaltyMin + EPSILON;
      const preservesInRouteWait =
        simulated.metrics.inRouteWaitMin <= best.metrics.inRouteWaitMin + EPSILON;
      if (!improvesTravel || !preservesSubZone || !preservesInRouteWait) {
        const rejectedBecause: RejectedTravelOnlyReason = !improvesTravel
          ? "not_travel_improving"
          : !preservesSubZone
            ? "subZonePenalty_would_increase"
            : "inRouteWait_would_increase";
        rejectedTravelOnlyCandidates.push(
          rejectedTravelOnlyDiagnostic({
            iteration,
            candidate,
            before: best,
            after: simulated,
            rejectedBecause,
          })
        );
        continue;
      }

      if (
        !bestCandidate ||
        simulated.metrics.totalTravelMin + EPSILON < bestCandidate.simulated.metrics.totalTravelMin ||
        (Math.abs(simulated.metrics.totalTravelMin - bestCandidate.simulated.metrics.totalTravelMin) <=
          EPSILON &&
          (simulated.metrics.subZonePenaltyMin + EPSILON <
            bestCandidate.simulated.metrics.subZonePenaltyMin ||
            simulated.objective + EPSILON < bestCandidate.simulated.objective))
      ) {
        bestCandidate = { candidate, simulated };
      }
    }

    if (!bestCandidate) break;

    acceptedMoves.push(
      moveDiagnostic({
        pass: "travel-only",
        iteration,
        candidate: bestCandidate.candidate,
        before: best,
        after: bestCandidate.simulated,
      })
    );
    bestOrder = bestCandidate.candidate.order;
    best = bestCandidate.simulated;
  }

  const improved = best.objective + EPSILON < beforeObjective || acceptedMoves.length > 0;

  return {
    route: best.route,
    improved,
    beforeObjective,
    afterObjective: best.objective,
    diagnostic: {
      driverId: args.route.driverId,
      improved,
      before: initial.metrics,
      after: best.metrics,
      bucketSequenceBefore: initial.bucketSequence,
      bucketSequenceAfter: best.bucketSequence,
      acceptedMoves,
      generatedCanonicalBucketCandidates,
      generatedSequentialShapeCandidates,
      acceptedShapeFirstCandidates,
      bestRejectedShapeCandidates: topRejectedShapeCandidates(rejectedShapeCandidates),
      bestRejectedSequenceCandidates: topRejectedSequenceCandidates(rejectedSequenceCandidates),
      bestRejectedTravelOnlyCandidates: topRejectedTravelOnlyCandidates(
        rejectedTravelOnlyCandidates
      ),
      evaluatedCandidateCount,
      rejectedInfeasibleCount,
    },
  };
}

export function polishRoutingSolutionWithDiagnostics(
  input: RoutingProblemInput,
  solution: RoutingSolution
): { solution: RoutingSolution; diagnostics: RoutePolishingDiagnostics | null } {
  if (solution.routes.length === 0) return { solution, diagnostics: null };

  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));
  const arcPenaltyBuild = buildVehicleArcPenalties({ input });
  const penaltyLookup = buildArcPenaltyLookup(arcPenaltyBuild?.details ?? []);
  const subZoneByTaskId = buildSubZoneLookup(input);
  const notes = [...(solution.diagnostics?.notes ?? [])];
  const polishedRoutes: RoutingRouteSolution[] = [];
  const routeDiagnostics: RoutePolishingRouteDiagnostic[] = [];
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
      subZoneByTaskId,
    });

    polishedRoutes.push(polished.route);
    if (polished.diagnostic) {
      routeDiagnostics.push(polished.diagnostic);
    }
    if (polished.improved) {
      improvedRouteCount += 1;
      notes.push(
        `route-polishing driver=${route.driverId} objective=${polished.beforeObjective.toFixed(2)}->${polished.afterObjective.toFixed(2)}`
      );
    }
  }

  const diagnostics: RoutePolishingDiagnostics | null =
    routeDiagnostics.length > 0
      ? {
          config: ROUTE_POLISHING_CONFIG,
          improvedRouteCount,
          routes: routeDiagnostics,
        }
      : null;

  if (improvedRouteCount === 0) return { solution, diagnostics };

  const totalTravelMin = polishedRoutes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = polishedRoutes.reduce((sum, route) => sum + route.totalWaitMin, 0);

  return {
    diagnostics,
    solution: {
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
    },
  };
}

export function polishRoutingSolution(
  input: RoutingProblemInput,
  solution: RoutingSolution
): RoutingSolution {
  return polishRoutingSolutionWithDiagnostics(input, solution).solution;
}
