import type { DriverId, DriverNode, TaskId, TaskNode } from "../input-contract";
import type { DailyTerritoryGroup } from "./group-contract";
import { calculateCentroid, haversineMeters } from "./geo-utils";
import { effectiveTravelMin } from "./travel-matrix-utils";
import {
  resolveTerritoryCapacity,
  resolveTerritoryFlags,
  TERRITORY_ALGO_CONFIG,
} from "./territory-config";
import { matchTerritoriesToDrivers } from "./territory-driver-matching";
import { THREE_DRIVER_TERRITORY_PROFILES } from "./historical-territory-profiles";
import { buildHistoricalTerritoryAssignment } from "./historical-territory-assignment";
import type { HistoricalTerritoryKey } from "./historical-territory-profiles";
import type { TaskAssignmentSource } from "./historical-territory-assignment";
import type { TerritoryPenaltyConfig, TerritoryMode } from "./territory-config";

const TERRITORY_COLORS = ["#d73027", "#1a9850", "#4575b4", "#fdae61", "#984ea3", "#00a6d6", "#4daf4a"];

interface TerritoryCluster {
  territoryIndex: number;
  seedTaskId: TaskId;
  hubTaskId: TaskId;
  hubNodeIndex: number;
  tasks: TaskNode[];
  centroid: { lat: number; lng: number };
  radiusMeters: number;
  penaltyRadiusMeters: number;
}

export interface DailyTerritoryAssignment {
  debugTerritoriesEnabled: boolean;
  routingPenaltiesEnabled: boolean;
  territoryMode: TerritoryMode;
  penaltyConfig?: TerritoryPenaltyConfig;
  territories: Array<{
    territoryId: string;
    territoryIndex: number;
    territoryKey?: HistoricalTerritoryKey;
    label?: string;
    taskIds: TaskId[];
    centroid: { lat: number; lng: number };
    radiusMeters: number;
    penaltyRadiusMeters: number;
    historicalCentroid?: { lat: number; lng: number };
    historicalPenaltyRadiusMeters?: number;
    assignedDriverId: DriverId;
    suggestedColor: string;
    coreTasks?: number;
    borderTasks?: number;
  }>;
  profiles?: Array<{
    territoryKey: HistoricalTerritoryKey;
    label: string;
    assignedDriverId: DriverId;
    taskCount: number;
    coreTasks: number;
    borderTasks: number;
  }>;
  taskTerritoryIndex: Array<{ taskId: TaskId; territoryIndex: number }>;
  taskPreferredDriverId: Array<{ taskId: TaskId; driverId: DriverId }>;
  taskAssignmentDetails?: Array<{
    taskId: TaskId;
    territoryIndex: number;
    assignmentSource: TaskAssignmentSource;
  }>;
}

export interface DailyTerritoryBuildResult {
  groups: DailyTerritoryGroup[];
  assignment?: DailyTerritoryAssignment;
}

function hasFiniteCoordinates(task: TaskNode): boolean {
  return Number.isFinite(task.location.lat) && Number.isFinite(task.location.lng);
}

function taskDistance(
  left: TaskNode,
  right: TaskNode,
  travelMatrixMin: number[][]
): number {
  return (
    effectiveTravelMin(travelMatrixMin, left.nodeIndex, right.nodeIndex) ??
    haversineMeters(left.location.lat, left.location.lng, right.location.lat, right.location.lng)
  );
}

function taskDistanceToHub(
  task: TaskNode,
  hub: TaskNode,
  travelMatrixMin: number[][]
): number {
  return taskDistance(task, hub, travelMatrixMin);
}

function chooseInitialSeeds(
  tasks: TaskNode[],
  territoryCount: number,
  travelMatrixMin: number[][]
): TaskNode[] {
  const sortedTasks = [...tasks].sort((left, right) => left.taskId - right.taskId);
  const centralSeed = sortedTasks.reduce((best, candidate) => {
    const candidateSum = sortedTasks.reduce(
      (sum, other) => sum + (candidate.taskId === other.taskId ? 0 : taskDistance(candidate, other, travelMatrixMin)),
      0
    );
    const bestSum = sortedTasks.reduce(
      (sum, other) => sum + (best.taskId === other.taskId ? 0 : taskDistance(best, other, travelMatrixMin)),
      0
    );
    if (candidateSum < bestSum) return candidate;
    if (candidateSum === bestSum && candidate.taskId < best.taskId) return candidate;
    return best;
  }, sortedTasks[0]);

  const seeds = [centralSeed];
  while (seeds.length < territoryCount) {
    const nextSeed = sortedTasks
      .filter((task) => !seeds.some((seed) => seed.taskId === task.taskId))
      .reduce((best: TaskNode | null, candidate) => {
        const candidateMinDistance = Math.min(
          ...seeds.map((seed) => taskDistance(candidate, seed, travelMatrixMin))
        );
        if (!best) return candidate;
        const bestMinDistance = Math.min(...seeds.map((seed) => taskDistance(best, seed, travelMatrixMin)));
        if (candidateMinDistance > bestMinDistance) return candidate;
        if (candidateMinDistance === bestMinDistance && candidate.taskId < best.taskId) return candidate;
        return best;
      }, null);

    if (!nextSeed) break;
    seeds.push(nextSeed);
  }

  return seeds;
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

function findHubTask(tasks: TaskNode[], centroid: { lat: number; lng: number }): TaskNode {
  return tasks.reduce((best, candidate) => {
    const candidateDistance = haversineMeters(
      candidate.location.lat,
      candidate.location.lng,
      centroid.lat,
      centroid.lng
    );
    const bestDistance = haversineMeters(best.location.lat, best.location.lng, centroid.lat, centroid.lng);
    if (candidateDistance < bestDistance) return candidate;
    if (candidateDistance === bestDistance && candidate.taskId < best.taskId) return candidate;
    return best;
  }, tasks[0]);
}

function buildCluster(
  territoryIndex: number,
  seedTaskId: TaskId,
  tasks: TaskNode[]
): TerritoryCluster {
  const centroid = calculateCentroid(tasks.map((task) => task.location));
  const distances = tasks.map((task) =>
    haversineMeters(task.location.lat, task.location.lng, centroid.lat, centroid.lng)
  );
  const hubTask = findHubTask(tasks, centroid);
  const radiusMeters = Math.max(...distances, 1);
  const penaltyRadiusMeters = Math.max(
    percentile(distances, TERRITORY_ALGO_CONFIG.penaltyRadiusPercentile),
    1
  );

  return {
    territoryIndex,
    seedTaskId,
    hubTaskId: hubTask.taskId,
    hubNodeIndex: hubTask.nodeIndex,
    tasks,
    centroid,
    radiusMeters,
    penaltyRadiusMeters,
  };
}

function assignTasksToSeeds(args: {
  tasks: TaskNode[];
  seeds: TaskNode[];
  travelMatrixMin: number[][];
  maxTasksPerTerritory: number;
}): TaskNode[][] {
  const { tasks, seeds, travelMatrixMin, maxTasksPerTerritory } = args;
  const assignments = seeds.map(() => [] as TaskNode[]);
  const rankedTasks = [...tasks]
    .map((task) => {
      const distances = seeds
        .map((seed, territoryIndex) => ({
          territoryIndex,
          distance: taskDistanceToHub(task, seed, travelMatrixMin),
        }))
        .sort((left, right) => left.distance - right.distance || left.territoryIndex - right.territoryIndex);
      const best = distances[0];
      const second = distances[1] ?? best;
      return {
        task,
        candidates: distances,
        margin: second.distance - best.distance,
      };
    })
    .sort((left, right) => right.margin - left.margin || left.task.taskId - right.task.taskId);

  for (const ranked of rankedTasks) {
    const preferred = ranked.candidates.find(
      (candidate) => assignments[candidate.territoryIndex].length < maxTasksPerTerritory
    );
    const fallback = assignments
      .map((territoryTasks, territoryIndex) => ({ territoryIndex, count: territoryTasks.length }))
      .sort((left, right) => left.count - right.count || left.territoryIndex - right.territoryIndex)[0];
    const territoryIndex = preferred?.territoryIndex ?? fallback.territoryIndex;
    assignments[territoryIndex].push(ranked.task);
  }

  return assignments;
}

function rebalanceMinimums(args: {
  assignments: TaskNode[][];
  seeds: TaskNode[];
  travelMatrixMin: number[][];
  minTasksPerTerritory: number;
}): TaskNode[][] {
  const { assignments, seeds, travelMatrixMin, minTasksPerTerritory } = args;
  const balanced = assignments.map((tasks) => [...tasks]);

  for (let guard = 0; guard < 100; guard += 1) {
    const underfullIndex = balanced.findIndex((tasks) => tasks.length < minTasksPerTerritory);
    if (underfullIndex === -1) break;

    const donorIndex = balanced
      .map((tasks, territoryIndex) => ({ territoryIndex, count: tasks.length }))
      .filter((entry) => entry.count > minTasksPerTerritory)
      .sort((left, right) => right.count - left.count || left.territoryIndex - right.territoryIndex)[0]
      ?.territoryIndex;

    if (donorIndex === undefined) break;

    const donorTasks = balanced[donorIndex];
    const taskToMove = donorTasks.reduce((best, candidate) => {
      const candidateDistance = taskDistanceToHub(candidate, seeds[underfullIndex], travelMatrixMin);
      const bestDistance = taskDistanceToHub(best, seeds[underfullIndex], travelMatrixMin);
      if (candidateDistance < bestDistance) return candidate;
      if (candidateDistance === bestDistance && candidate.taskId < best.taskId) return candidate;
      return best;
    }, donorTasks[0]);

    balanced[donorIndex] = donorTasks.filter((task) => task.taskId !== taskToMove.taskId);
    balanced[underfullIndex].push(taskToMove);
  }

  return balanced;
}

export function buildDailyTerritoryAssignment(args: {
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  requiredDriverByTaskId: Map<TaskId, DriverId>;
}): DailyTerritoryBuildResult {
  const flags = resolveTerritoryFlags();
  if (!flags.debugTerritoriesEnabled) {
    return { groups: [] };
  }

  const eligibleTasks = args.tasks.filter(hasFiniteCoordinates).sort((left, right) => left.taskId - right.taskId);
  if (eligibleTasks.length < TERRITORY_ALGO_CONFIG.minTasksPerTerritory || args.drivers.length === 0) {
    return { groups: [] };
  }

  if (
    args.drivers.length === THREE_DRIVER_TERRITORY_PROFILES.length &&
    eligibleTasks.length >= TERRITORY_ALGO_CONFIG.minTasksPerTerritory * THREE_DRIVER_TERRITORY_PROFILES.length
  ) {
    return buildHistoricalTerritoryAssignment({
      tasks: eligibleTasks,
      drivers: args.drivers,
      travelMatrixMin: args.travelMatrixMin,
      requiredDriverByTaskId: args.requiredDriverByTaskId,
      profiles: THREE_DRIVER_TERRITORY_PROFILES,
      debugTerritoriesEnabled: flags.debugTerritoriesEnabled,
      routingPenaltiesEnabled: flags.routingPenaltiesEnabled,
    });
  }

  const territoryCount = Math.min(
    args.drivers.length,
    Math.max(1, Math.floor(eligibleTasks.length / TERRITORY_ALGO_CONFIG.minTasksPerTerritory))
  );
  const capacity = resolveTerritoryCapacity(eligibleTasks.length, territoryCount);
  let seeds = chooseInitialSeeds(eligibleTasks, territoryCount, args.travelMatrixMin);
  let assignments: TaskNode[][] = [];
  let previousSignature = "";

  for (let iteration = 0; iteration < TERRITORY_ALGO_CONFIG.maxIterations; iteration += 1) {
    assignments = assignTasksToSeeds({
      tasks: eligibleTasks,
      seeds,
      travelMatrixMin: args.travelMatrixMin,
      maxTasksPerTerritory: capacity.max,
    });
    assignments = rebalanceMinimums({
      assignments,
      seeds,
      travelMatrixMin: args.travelMatrixMin,
      minTasksPerTerritory: capacity.min,
    });

    const signature = assignments
      .map((tasks) => tasks.map((task) => task.taskId).sort((left, right) => left - right).join(","))
      .join("|");
    if (signature === previousSignature) break;
    previousSignature = signature;

    seeds = assignments.map((tasks, index) => {
      if (tasks.length === 0) return seeds[index];
      const centroid = calculateCentroid(tasks.map((task) => task.location));
      return findHubTask(tasks, centroid);
    });
  }

  const clusters = assignments
    .map((tasks, territoryIndex) => buildCluster(territoryIndex, seeds[territoryIndex].taskId, tasks))
    .filter((cluster) => cluster.tasks.length > 0);

  const driverAssignments = matchTerritoriesToDrivers({
    territories: clusters.map((cluster) => ({
      territoryIndex: cluster.territoryIndex,
      taskIds: cluster.tasks.map((task) => task.taskId),
      hubNodeIndex: cluster.hubNodeIndex,
    })),
    drivers: args.drivers,
    travelMatrixMin: args.travelMatrixMin,
    requiredDriverByTaskId: args.requiredDriverByTaskId,
  });
  const driverByTerritory = new Map(
    driverAssignments.map((assignment) => [assignment.territoryIndex, assignment.assignedDriverId])
  );

  const groups: DailyTerritoryGroup[] = clusters.map((cluster) => {
    const territoryId = `daily-territory:${cluster.territoryIndex}`;
    const assignedDriverId = driverByTerritory.get(cluster.territoryIndex) ?? args.drivers[0].id;
    return {
      groupId: territoryId,
      type: "DAILY_TERRITORY",
      taskIds: cluster.tasks.map((task) => task.taskId).sort((left, right) => left - right),
      confidence: "medium",
      territoryIndex: cluster.territoryIndex,
      centroid: cluster.centroid,
      radiusMeters: cluster.radiusMeters,
      penaltyRadiusMeters: cluster.penaltyRadiusMeters,
      softBoundaryMeters: cluster.penaltyRadiusMeters,
      assignedDriverId,
      source: "balanced_geo_cluster",
    };
  });

  const assignment: DailyTerritoryAssignment = {
    debugTerritoriesEnabled: flags.debugTerritoriesEnabled,
    routingPenaltiesEnabled: flags.routingPenaltiesEnabled,
    territoryMode: "dynamic_clustering",
    territories: groups.map((group) => ({
      territoryId: group.groupId,
      territoryIndex: group.territoryIndex,
      taskIds: group.taskIds,
      centroid: group.centroid,
      radiusMeters: group.radiusMeters,
      penaltyRadiusMeters: group.penaltyRadiusMeters,
      assignedDriverId: group.assignedDriverId,
      suggestedColor: TERRITORY_COLORS[group.territoryIndex % TERRITORY_COLORS.length],
    })),
    taskTerritoryIndex: groups.flatMap((group) =>
      group.taskIds.map((taskId) => ({ taskId, territoryIndex: group.territoryIndex }))
    ),
    taskPreferredDriverId: groups.flatMap((group) =>
      group.taskIds.map((taskId) => ({ taskId, driverId: group.assignedDriverId }))
    ),
  };

  return { groups, assignment };
}
