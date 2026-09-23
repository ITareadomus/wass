import type {
  DriverId,
  DriverNode,
  RoutingProblemInput,
  TaskId,
  TaskNode,
} from "./input-contract";
import {
  ORTOOLS_SOLVER_ID,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingDroppedTask,
  type RoutingRouteSolution,
  type RoutingSolution,
} from "./solution-contract";
import { calculateCentroid, haversineMeters, unionFindGroups } from "./groups/geo-utils";
import { BUSINESS_GROUP_THRESHOLDS } from "./groups/group-weights";
import { matchTerritoriesToDrivers } from "./groups/territory-driver-matching";
import { solveRouting, type RoutingSolverId } from "./solver/solve-routing";

const ZONE_COLORS = ["#d73027", "#1a9850", "#4575b4", "#fdae61", "#984ea3", "#00a6d6"];
/** Complete-linkage diameter: same palazzo / isolato stays on one driver, streets do not chain. */
const EXCLUSIVE_ZONE_COHESION_METERS = Math.max(
  250,
  BUSINESS_GROUP_THRESHOLDS.SAME_COORDINATES_BUILDING_TOLERANCE_METERS * 2
);

interface CohesiveTaskCluster {
  tasks: TaskNode[];
  centroid: { lat: number; lng: number };
}

export interface ExclusiveWorkZoneSpec {
  zoneIndex: number;
  zoneId: string;
  label: string;
  driverId: DriverId;
  taskIds: TaskId[];
  centroid: { lat: number; lng: number };
  color: string;
}

export interface ExclusiveWorkZonePartition {
  zones: ExclusiveWorkZoneSpec[];
  taskZoneIndex: Array<{ taskId: TaskId; zoneIndex: number }>;
}

function hasFiniteCoordinates(task: TaskNode): boolean {
  return Number.isFinite(Number(task.location.lat)) && Number.isFinite(Number(task.location.lng));
}

function geographicDistance(left: { lat: number; lng: number }, right: { lat: number; lng: number }): number {
  return haversineMeters(Number(left.lat), Number(left.lng), Number(right.lat), Number(right.lng));
}

export function geographicZoneLabels(count: number): string[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => `Zona ${index + 1}`);
}

function buildingCoordKey(lat: number, lng: number): string {
  return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
}

function areSameBuilding(left: TaskNode, right: TaskNode): boolean {
  const leftAddress = left.location.addressGroupId ?? left.groupingHints.addressGroupId;
  const rightAddress = right.location.addressGroupId ?? right.groupingHints.addressGroupId;
  if (leftAddress != null && rightAddress != null && leftAddress === rightAddress) return true;
  if (buildingCoordKey(left.location.lat, left.location.lng) === buildingCoordKey(right.location.lat, right.location.lng)) {
    return true;
  }
  return (
    geographicDistance(left.location, right.location) <=
    BUSINESS_GROUP_THRESHOLDS.SAME_COORDINATES_BUILDING_TOLERANCE_METERS
  );
}

export function targetExclusiveZoneSizes(taskCount: number, zoneCount: number): number[] {
  if (zoneCount <= 0) return [];
  const base = Math.floor(taskCount / zoneCount);
  const extra = taskCount % zoneCount;
  return Array.from({ length: zoneCount }, (_, index) => base + (index < extra ? 1 : 0));
}

function chooseGeographicSeeds(tasks: TaskNode[], zoneCount: number): TaskNode[] {
  const sorted = [...tasks].sort((left, right) => left.taskId - right.taskId);
  if (sorted.length === 0) return [];

  const globalCentroid = calculateCentroid(sorted.map((task) => task.location));
  const first = sorted.reduce((best, candidate) => {
    const candidateDistance = geographicDistance(candidate.location, globalCentroid);
    const bestDistance = geographicDistance(best.location, globalCentroid);
    if (candidateDistance > bestDistance) return candidate;
    if (candidateDistance === bestDistance && candidate.taskId < best.taskId) return candidate;
    return best;
  }, sorted[0]);

  const seeds = [first];
  while (seeds.length < zoneCount) {
    const nextSeed = sorted
      .filter((task) => !seeds.some((seed) => seed.taskId === task.taskId))
      .reduce((best: TaskNode | null, candidate) => {
        const candidateMin = Math.min(
          ...seeds.map((seed) => geographicDistance(candidate.location, seed.location))
        );
        if (!best) return candidate;
        const bestMin = Math.min(
          ...seeds.map((seed) => geographicDistance(best.location, seed.location))
        );
        if (candidateMin > bestMin) return candidate;
        if (candidateMin === bestMin && candidate.taskId < best.taskId) return candidate;
        return best;
      }, null);
    if (!nextSeed) break;
    seeds.push(nextSeed);
  }
  return seeds;
}

function clusterDiameterMeters(tasks: TaskNode[]): number {
  let max = 0;
  for (let i = 0; i < tasks.length; i += 1) {
    for (let j = i + 1; j < tasks.length; j += 1) {
      const distance = geographicDistance(tasks[i].location, tasks[j].location);
      if (distance > max) max = distance;
    }
  }
  return max;
}

function mergeDiameterMeters(left: TaskNode[], right: TaskNode[]): number {
  let max = Math.max(clusterDiameterMeters(left), clusterDiameterMeters(right));
  for (const leftTask of left) {
    for (const rightTask of right) {
      const distance = geographicDistance(leftTask.location, rightTask.location);
      if (distance > max) max = distance;
    }
  }
  return max;
}

function nearestPairDistanceMeters(left: TaskNode[], right: TaskNode[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const leftTask of left) {
    for (const rightTask of right) {
      const distance = geographicDistance(leftTask.location, rightTask.location);
      if (distance < min) min = distance;
    }
  }
  return min;
}

function clusterAnchorTaskId(cluster: CohesiveTaskCluster | TaskNode[]): number {
  const tasks = Array.isArray(cluster) ? cluster : cluster.tasks;
  return Math.min(...tasks.map((task) => task.taskId));
}

function toCohesiveCluster(tasks: TaskNode[]): CohesiveTaskCluster {
  return {
    tasks: [...tasks].sort((left, right) => left.taskId - right.taskId),
    centroid: calculateCentroid(tasks.map((task) => task.location)),
  };
}

function buildCohesiveTaskClusters(tasks: TaskNode[]): CohesiveTaskCluster[] {
  const clusters = unionFindGroups(
    [...tasks].sort((left, right) => left.taskId - right.taskId),
    areSameBuilding
  );

  while (clusters.length > 1) {
    let bestLeft = -1;
    let bestRight = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        if (mergeDiameterMeters(clusters[i], clusters[j]) > EXCLUSIVE_ZONE_COHESION_METERS) {
          continue;
        }
        const distance = nearestPairDistanceMeters(clusters[i], clusters[j]);
        if (distance > bestDistance) continue;
        const leftAnchor = clusterAnchorTaskId(clusters[i]);
        const rightAnchor = clusterAnchorTaskId(clusters[j]);
        const bestLeftAnchor = bestLeft >= 0 ? clusterAnchorTaskId(clusters[bestLeft]) : Number.POSITIVE_INFINITY;
        const bestRightAnchor = bestRight >= 0 ? clusterAnchorTaskId(clusters[bestRight]) : Number.POSITIVE_INFINITY;
        if (
          distance < bestDistance ||
          leftAnchor < bestLeftAnchor ||
          (leftAnchor === bestLeftAnchor && rightAnchor < bestRightAnchor)
        ) {
          bestDistance = distance;
          bestLeft = i;
          bestRight = j;
        }
      }
    }
    if (bestLeft < 0) break;
    clusters[bestLeft] = [...clusters[bestLeft], ...clusters[bestRight]];
    clusters.splice(bestRight, 1);
  }

  return clusters.map((group) => toCohesiveCluster(group));
}

function assignClustersToNearestCentroid(
  clusters: CohesiveTaskCluster[],
  centroids: Array<{ lat: number; lng: number }>
): CohesiveTaskCluster[][] {
  const buckets = centroids.map(() => [] as CohesiveTaskCluster[]);
  for (const cluster of clusters) {
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < centroids.length; index += 1) {
      const distance = geographicDistance(cluster.centroid, centroids[index]);
      if (distance < bestDistance || (distance === bestDistance && index < bestIndex)) {
        bestIndex = index;
        bestDistance = distance;
      }
    }
    buckets[bestIndex].push(cluster);
  }
  return buckets;
}

function flattenClusterBuckets(buckets: CohesiveTaskCluster[][]): TaskNode[][] {
  return buckets.map((zoneClusters) => zoneClusters.flatMap((cluster) => cluster.tasks));
}

function zoneTaskCount(zoneClusters: CohesiveTaskCluster[]): number {
  return zoneClusters.reduce((sum, cluster) => sum + cluster.tasks.length, 0);
}

function zoneRadiusMeters(tasks: TaskNode[], centroid: { lat: number; lng: number }): number {
  if (tasks.length === 0) return 0;
  return Math.max(...tasks.map((task) => geographicDistance(task.location, centroid)));
}

function rebalanceExclusiveZoneLoads(
  buckets: CohesiveTaskCluster[][],
  centroids: Array<{ lat: number; lng: number }>
): { buckets: CohesiveTaskCluster[][]; centroids: Array<{ lat: number; lng: number }> } {
  const nextBuckets = buckets.map((zoneClusters) => [...zoneClusters]);
  const total = nextBuckets.reduce((sum, zoneClusters) => sum + zoneTaskCount(zoneClusters), 0);
  const targets = targetExclusiveZoneSizes(total, nextBuckets.length);

  const maxMoves = total;
  for (let move = 0; move < maxMoves; move += 1) {
    let oversizedIndex = -1;
    let undersizedIndex = -1;
    let overAmount = 0;
    let underAmount = 0;
    for (let index = 0; index < nextBuckets.length; index += 1) {
      const over = zoneTaskCount(nextBuckets[index]) - targets[index];
      const under = targets[index] - zoneTaskCount(nextBuckets[index]);
      if (over > overAmount) {
        overAmount = over;
        oversizedIndex = index;
      }
      if (under > underAmount) {
        underAmount = under;
        undersizedIndex = index;
      }
    }
    if (oversizedIndex < 0 || undersizedIndex < 0 || overAmount <= 0 || underAmount <= 0) break;

    const originTasks = flattenClusterBuckets([nextBuckets[oversizedIndex]])[0];
    const destTasks = flattenClusterBuckets([nextBuckets[undersizedIndex]])[0];
    const originCentroid =
      originTasks.length > 0
        ? calculateCentroid(originTasks.map((task) => task.location))
        : centroids[oversizedIndex];
    const destCentroid =
      destTasks.length > 0
        ? calculateCentroid(destTasks.map((task) => task.location))
        : centroids[undersizedIndex];
    const destRadius = Math.max(1200, zoneRadiusMeters(destTasks, destCentroid));

    const transferable = nextBuckets[oversizedIndex]
      .map((cluster) => ({
        cluster,
        size: cluster.tasks.length,
        toDest: geographicDistance(cluster.centroid, destCentroid),
        toOrigin: geographicDistance(cluster.centroid, originCentroid),
      }))
      .filter((entry) => entry.size <= overAmount && entry.size <= underAmount)
      .filter(
        (entry) =>
          entry.toDest <= destRadius * 1.8 || entry.toDest <= entry.toOrigin + 1800
      )
      .sort((left, right) => {
        if (left.toDest !== right.toDest) return left.toDest - right.toDest;
        if (left.size !== right.size) return left.size - right.size;
        return clusterAnchorTaskId(left.cluster) - clusterAnchorTaskId(right.cluster);
      });

    const chosen = transferable[0];
    if (!chosen) break;

    nextBuckets[oversizedIndex] = nextBuckets[oversizedIndex].filter(
      (cluster) => cluster !== chosen.cluster
    );
    nextBuckets[undersizedIndex].push(chosen.cluster);
  }

  const flattened = flattenClusterBuckets(nextBuckets);
  const nextCentroids = flattened.map((zoneTasks, index) =>
    zoneTasks.length > 0
      ? calculateCentroid(zoneTasks.map((task) => task.location))
      : centroids[index]
  );
  return { buckets: nextBuckets, centroids: nextCentroids };
}

function reseedEmptyBuckets(
  buckets: CohesiveTaskCluster[][],
  centroids: Array<{ lat: number; lng: number }>
): { buckets: CohesiveTaskCluster[][]; centroids: Array<{ lat: number; lng: number }> } {
  const nextBuckets = buckets.map((zoneClusters) => [...zoneClusters]);
  const nextCentroids = centroids.map((centroid) => ({ ...centroid }));

  for (let index = 0; index < nextBuckets.length; index += 1) {
    if (nextBuckets[index].length > 0) continue;
    const donorIndex = nextBuckets.reduce(
      (best, zoneClusters, zoneIndex) =>
        zoneTaskCount(zoneClusters) > zoneTaskCount(nextBuckets[best]) ? zoneIndex : best,
      0
    );
    if (nextBuckets[donorIndex].length < 2) continue;
    const donorCentroid = nextCentroids[donorIndex];
    const farthest = nextBuckets[donorIndex].reduce((best, candidate) => {
      const candidateDistance = geographicDistance(candidate.centroid, donorCentroid);
      const bestDistance = geographicDistance(best.centroid, donorCentroid);
      if (candidateDistance > bestDistance) return candidate;
      if (candidateDistance === bestDistance && clusterAnchorTaskId(candidate) < clusterAnchorTaskId(best)) {
        return candidate;
      }
      return best;
    }, nextBuckets[donorIndex][0]);
    nextBuckets[donorIndex] = nextBuckets[donorIndex].filter((cluster) => cluster !== farthest);
    nextBuckets[index] = [farthest];
    nextCentroids[index] = { ...farthest.centroid };
  }

  return { buckets: nextBuckets, centroids: nextCentroids };
}

function clustersShareBuilding(left: CohesiveTaskCluster, right: CohesiveTaskCluster): boolean {
  return left.tasks.some((leftTask) =>
    right.tasks.some((rightTask) => areSameBuilding(leftTask, rightTask))
  );
}

function repairSplitBuildings(buckets: CohesiveTaskCluster[][]): CohesiveTaskCluster[][] {
  const nextBuckets = buckets.map((zoneClusters) => [...zoneClusters]);
  let moved = true;
  while (moved) {
    moved = false;
    outer: for (let leftIndex = 0; leftIndex < nextBuckets.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nextBuckets.length; rightIndex += 1) {
        for (const leftCluster of nextBuckets[leftIndex]) {
          for (const rightCluster of nextBuckets[rightIndex]) {
            if (!clustersShareBuilding(leftCluster, rightCluster)) continue;
            const destIndex =
              zoneTaskCount(nextBuckets[leftIndex]) >= zoneTaskCount(nextBuckets[rightIndex])
                ? leftIndex
                : rightIndex;
            const sourceIndex = destIndex === leftIndex ? rightIndex : leftIndex;
            const moving = destIndex === leftIndex ? rightCluster : leftCluster;
            nextBuckets[sourceIndex] = nextBuckets[sourceIndex].filter((cluster) => cluster !== moving);
            nextBuckets[destIndex].push(moving);
            moved = true;
            break outer;
          }
        }
      }
    }
  }
  return nextBuckets;
}

function findHub(tasks: TaskNode[], centroid: { lat: number; lng: number }): TaskNode {
  return tasks.reduce((best, candidate) => {
    const candidateDistance = haversineMeters(
      candidate.location.lat,
      candidate.location.lng,
      centroid.lat,
      centroid.lng
    );
    const bestDistance = haversineMeters(
      best.location.lat,
      best.location.lng,
      centroid.lat,
      centroid.lng
    );
    if (candidateDistance < bestDistance) return candidate;
    if (candidateDistance === bestDistance && candidate.taskId < best.taskId) return candidate;
    return best;
  }, tasks[0]);
}

export function resolveExclusiveZoneCount(taskCount: number, driverCount: number): number {
  if (driverCount <= 0 || taskCount <= 0) return 0;
  return Math.min(driverCount, taskCount);
}

function clusterExclusiveZones(args: {
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
}): ExclusiveWorkZoneSpec[] {
  const { tasks, drivers, travelMatrixMin } = args;
  const located = tasks.filter(hasFiniteCoordinates);
  const unlocated = tasks.filter((task) => !hasFiniteCoordinates(task));
  const zoneCount = resolveExclusiveZoneCount(located.length || tasks.length, drivers.length);
  if (zoneCount === 0) return [];

  if (located.length === 0) {
    const driver = drivers[0];
    return [
      {
        zoneIndex: 0,
        zoneId: "exclusive-zone:0",
        label: "Zona 1",
        driverId: driver.id,
        taskIds: unlocated.map((task) => task.taskId).sort((left, right) => left - right),
        centroid: { lat: 0, lng: 0 },
        color: ZONE_COLORS[0],
      },
    ];
  }

  const cohesiveClusters = buildCohesiveTaskClusters(located);
  const seeds = chooseGeographicSeeds(located, zoneCount);
  let centroids = seeds.map((seed) => ({ lat: seed.location.lat, lng: seed.location.lng }));
  let clusterBuckets: CohesiveTaskCluster[][] = [];
  let previous = "";

  for (let iteration = 0; iteration < 20; iteration += 1) {
    clusterBuckets = assignClustersToNearestCentroid(cohesiveClusters, centroids);
    const reseeded = reseedEmptyBuckets(clusterBuckets, centroids);
    clusterBuckets = reseeded.buckets;
    centroids = reseeded.centroids;
    const signature = clusterBuckets
      .map((zoneClusters) =>
        zoneClusters
          .flatMap((cluster) => cluster.tasks.map((task) => task.taskId))
          .sort((left, right) => left - right)
          .join(",")
      )
      .join("|");
    if (signature === previous) break;
    previous = signature;
    const flattened = flattenClusterBuckets(clusterBuckets);
    centroids = flattened.map((zoneTasks, index) => {
      if (zoneTasks.length === 0) return centroids[index];
      return calculateCentroid(zoneTasks.map((task) => task.location));
    });
  }

  const balanced = rebalanceExclusiveZoneLoads(clusterBuckets, centroids);
  clusterBuckets = repairSplitBuildings(balanced.buckets);
  centroids = flattenClusterBuckets(clusterBuckets).map((zoneTasks, index) =>
    zoneTasks.length > 0
      ? calculateCentroid(zoneTasks.map((task) => task.location))
      : balanced.centroids[index]
  );
  const buckets = flattenClusterBuckets(clusterBuckets);

  const nonEmpty = buckets
    .map((zoneTasks, index) => ({ zoneTasks, centroid: centroids[index], index }))
    .filter((entry) => entry.zoneTasks.length > 0);

  if (unlocated.length > 0 && nonEmpty.length > 0) {
    for (const task of unlocated) {
      const smallest = nonEmpty.reduce((best, entry) =>
        entry.zoneTasks.length < best.zoneTasks.length ? entry : best
      );
      smallest.zoneTasks.push(task);
    }
  }

  const driverAssignments = matchTerritoriesToDrivers({
    territories: nonEmpty.map((entry, zoneIndex) => {
      const locatedInZone = entry.zoneTasks.filter(hasFiniteCoordinates);
      const hubTask =
        locatedInZone.length > 0
          ? findHub(locatedInZone, entry.centroid)
          : located[0];
      return {
        territoryIndex: zoneIndex,
        taskIds: entry.zoneTasks.map((task) => task.taskId),
        hubNodeIndex: hubTask.nodeIndex,
      };
    }),
    drivers,
    travelMatrixMin,
    requiredDriverByTaskId: new Map(),
  });
  const driverByZone = new Map(
    driverAssignments.map((assignment) => [assignment.territoryIndex, assignment.assignedDriverId])
  );

  const labels = geographicZoneLabels(nonEmpty.length);

  return nonEmpty.map((entry, zoneIndex) => {
    const locatedInZone = entry.zoneTasks.filter(hasFiniteCoordinates);
    const centroid =
      locatedInZone.length > 0
        ? calculateCentroid(locatedInZone.map((task) => task.location))
        : entry.centroid;
    return {
      zoneIndex,
      zoneId: `exclusive-zone:${zoneIndex}`,
      label: labels[zoneIndex] ?? `Zona ${zoneIndex + 1}`,
      driverId: driverByZone.get(zoneIndex) ?? drivers[zoneIndex % drivers.length].id,
      taskIds: entry.zoneTasks.map((task) => task.taskId).sort((left, right) => left - right),
      centroid,
      color: ZONE_COLORS[zoneIndex % ZONE_COLORS.length],
    };
  });
}

export function computeExclusiveWorkZones(args: {
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  territoryAssignment?: RoutingProblemInput["metadata"]["dailyTerritoryAssignment"];
}): ExclusiveWorkZonePartition | null {
  if (args.tasks.length === 0 || args.drivers.length === 0) return null;

  const zones = clusterExclusiveZones({
    tasks: args.tasks,
    drivers: args.drivers,
    travelMatrixMin: args.travelMatrixMin,
  });

  if (zones.length === 0) return null;

  return {
    zones,
    taskZoneIndex: zones.flatMap((zone) =>
      zone.taskIds.map((taskId) => ({ taskId, zoneIndex: zone.zoneIndex }))
    ),
  };
}

export function partitionExclusiveWorkZones(input: RoutingProblemInput): ExclusiveWorkZoneSpec[] {
  return (
    computeExclusiveWorkZones({
      tasks: input.tasks,
      drivers: input.drivers,
      travelMatrixMin: input.travelMatrixMin,
      territoryAssignment: input.metadata.dailyTerritoryAssignment,
    })?.zones ?? []
  );
}

export function shouldSolveAsExclusiveWorkZones(input: RoutingProblemInput): boolean {
  return input.drivers.length >= 2 && input.tasks.length >= 2;
}

export function sliceRoutingInputToZone(
  input: RoutingProblemInput,
  zone: ExclusiveWorkZoneSpec
): RoutingProblemInput {
  const taskIds = new Set(zone.taskIds);
  const tasks = input.tasks.filter((task) => taskIds.has(task.taskId));
  const drivers = input.drivers.filter((driver) => driver.id === zone.driverId);
  const driverIds = new Set(drivers.map((driver) => driver.id));

  return {
    ...input,
    drivers,
    tasks,
    hardConstraints: input.hardConstraints.filter((constraint) => {
      if ("taskId" in constraint && constraint.taskId !== undefined) {
        return taskIds.has(constraint.taskId);
      }
      if (constraint.type === "DRIVER_WORK_WINDOW") {
        return driverIds.has(constraint.driverId);
      }
      return true;
    }),
    softConstraints: input.softConstraints.filter((constraint) => {
      if ("taskId" in constraint && constraint.taskId !== undefined) {
        return taskIds.has(constraint.taskId);
      }
      if ("groupId" in constraint) {
        const group = input.businessGroups.find((entry) => entry.groupId === constraint.groupId);
        return group ? group.taskIds.every((taskId) => taskIds.has(taskId)) : false;
      }
      return true;
    }),
    businessGroups: input.businessGroups.filter((group) =>
      group.taskIds.every((taskId) => taskIds.has(taskId))
    ),
  };
}

export function mergeExclusiveZoneSolutions(args: {
  input: RoutingProblemInput;
  zoneSolutions: Array<{ zone: ExclusiveWorkZoneSpec; solution: RoutingSolution }>;
  solverId?: string;
  generatedAt?: string;
}): RoutingSolution {
  const assigned = new Set<TaskId>();
  const routes: RoutingRouteSolution[] = [];
  const droppedTasks: RoutingDroppedTask[] = [];
  const warnings: string[] = [];
  const notes: string[] = [
    `exclusive-work-zones:${args.zoneSolutions.length}`,
  ];
  let solveDurationMs = 0;

  for (const { zone, solution } of args.zoneSolutions) {
    notes.push(`exclusive-work-zone:${zone.zoneIndex}:${zone.label}:driver=${zone.driverId}`);
    for (const route of solution.routes) {
      routes.push(route);
      for (const stop of route.stops) assigned.add(stop.taskId);
    }
    droppedTasks.push(...solution.droppedTasks);
    warnings.push(...(solution.diagnostics?.warnings ?? []));
    solveDurationMs += solution.diagnostics?.solveDurationMs ?? 0;
  }

  const droppedIds = new Set(droppedTasks.map((dropped) => dropped.taskId));
  for (const task of args.input.tasks) {
    if (!assigned.has(task.taskId) && !droppedIds.has(task.taskId)) {
      droppedTasks.push({ taskId: task.taskId, reason: "NO_FEASIBLE_DRIVER" });
      droppedIds.add(task.taskId);
    }
  }

  const assignedTaskCount = routes.reduce((sum, route) => sum + route.stops.length, 0);
  const totalTravelMin = routes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWaitMin = routes.reduce((sum, route) => sum + route.totalWaitMin, 0);
  const status =
    assignedTaskCount === 0
      ? "INFEASIBLE"
      : droppedTasks.length > 0
        ? "PARTIAL"
        : "FEASIBLE";

  return {
    schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
    solverId: args.solverId ?? ORTOOLS_SOLVER_ID,
    workDate: args.input.workDate,
    status,
    generatedAt: args.generatedAt ?? new Date().toISOString(),
    routes: routes.sort((left, right) => left.driverId - right.driverId),
    droppedTasks,
    objectiveBreakdown: {
      assignedTasks: assignedTaskCount,
      droppedTasks: droppedTasks.length,
      totalTravelMin,
      totalWaitMin,
    },
    diagnostics: {
      warnings,
      notes,
      solveDurationMs,
    },
  };
}

export async function solveExclusiveWorkZoneRouting(
  input: RoutingProblemInput,
  options: { solverId?: RoutingSolverId } = {}
): Promise<RoutingSolution> {
  const zones = partitionExclusiveWorkZones(input);
  if (zones.length === 0) {
    return solveRouting(input, { solverId: options.solverId });
  }

  const zoneSolutions = await Promise.all(
    zones.map(async (zone) => {
      const sliced = sliceRoutingInputToZone(input, zone);
      if (sliced.tasks.length === 0 || sliced.drivers.length === 0) {
        return {
          zone,
          solution: {
            schemaVersion: ROUTING_SOLUTION_SCHEMA_VERSION,
            solverId: options.solverId ?? ORTOOLS_SOLVER_ID,
            workDate: input.workDate,
            status: "FEASIBLE" as const,
            generatedAt: new Date().toISOString(),
            routes: [],
            droppedTasks: sliced.tasks.map((task) => ({
              taskId: task.taskId,
              reason: "NO_FEASIBLE_DRIVER" as const,
            })),
          },
        };
      }
      const solution = await solveRouting(sliced, { solverId: options.solverId });
      return { zone, solution };
    })
  );

  return mergeExclusiveZoneSolutions({
    input,
    zoneSolutions,
    solverId: options.solverId,
  });
}
