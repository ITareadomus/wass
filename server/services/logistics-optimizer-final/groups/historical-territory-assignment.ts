import type { DriverId, DriverNode, TaskId, TaskNode } from "../input-contract";
import type { DailyTerritoryGroup } from "./group-contract";
import { calculateCentroid, haversineMeters } from "./geo-utils";
import {
  HISTORICAL_TEMPLATE_PENALTY_CONFIG,
  resolveTerritoryCapacity,
  TERRITORY_ALGO_CONFIG,
} from "./territory-config";
import {
  matchTerritoriesToDrivers,
  type TerritoryForDriverMatching,
} from "./territory-driver-matching";
import type { HistoricalTerritoryProfile } from "./historical-territory-profiles";
import type { DailyTerritoryAssignment } from "./daily-territory-groups";

export type TaskAssignmentSource = "historical_score" | "border_rebalance";

const BORDER_AMBIGUITY_METERS = 400;

interface RankedTask {
  task: TaskNode;
  bestTerritoryIndex: number;
  secondTerritoryIndex: number;
  bestDistanceMeters: number;
  secondDistanceMeters: number;
  ambiguityMeters: number;
}

interface TerritoryCluster {
  profile: HistoricalTerritoryProfile;
  tasks: TaskNode[];
  hubTaskId: TaskId;
  hubNodeIndex: number;
}

function distanceToProfile(task: TaskNode, profile: HistoricalTerritoryProfile): number {
  return haversineMeters(
    task.location.lat,
    task.location.lng,
    profile.centroid.lat,
    profile.centroid.lng
  );
}

function scoreTaskToProfile(task: TaskNode, profile: HistoricalTerritoryProfile): number {
  const distanceMeters = distanceToProfile(task, profile);
  if (distanceMeters <= profile.penaltyRadiusMeters) {
    return distanceMeters;
  }
  return distanceMeters + (distanceMeters - profile.penaltyRadiusMeters) * 0.5;
}

function rankTasks(tasks: TaskNode[], profiles: HistoricalTerritoryProfile[]): RankedTask[] {
  return tasks
    .map((task) => {
      const distances = profiles
        .map((profile) => ({
          territoryIndex: profile.territoryIndex,
          distanceMeters: distanceToProfile(task, profile),
          score: scoreTaskToProfile(task, profile),
        }))
        .sort(
          (left, right) =>
            left.score - right.score ||
            left.distanceMeters - right.distanceMeters ||
            left.territoryIndex - right.territoryIndex
        );

      const best = distances[0];
      const second = distances[1] ?? best;
      return {
        task,
        bestTerritoryIndex: best.territoryIndex,
        secondTerritoryIndex: second.territoryIndex,
        bestDistanceMeters: best.distanceMeters,
        secondDistanceMeters: second.distanceMeters,
        ambiguityMeters: second.distanceMeters - best.distanceMeters,
      };
    })
    .sort(
      (left, right) =>
        left.ambiguityMeters - right.ambiguityMeters || left.task.taskId - right.task.taskId
    );
}

function isBorderTask(
  ranked: RankedTask,
  profileByIndex: Map<number, HistoricalTerritoryProfile>
): boolean {
  const profile = profileByIndex.get(ranked.bestTerritoryIndex);
  if (!profile) return false;

  const coreRadiusMeters = profile.penaltyRadiusMeters * TERRITORY_ALGO_CONFIG.coreRadiusRatio;
  return (
    ranked.ambiguityMeters <= BORDER_AMBIGUITY_METERS ||
    ranked.bestDistanceMeters > coreRadiusMeters
  );
}

function isNonCoreTask(
  ranked: RankedTask,
  territoryIndex: number,
  profileByIndex: Map<number, HistoricalTerritoryProfile>
): boolean {
  const profile = profileByIndex.get(territoryIndex);
  if (!profile) return false;
  const distanceMeters = distanceToProfile(ranked.task, profile);
  return distanceMeters > profile.penaltyRadiusMeters * TERRITORY_ALGO_CONFIG.coreRadiusRatio;
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

function assignInitialTasks(args: {
  rankedTasks: RankedTask[];
  profiles: HistoricalTerritoryProfile[];
  maxTasksPerTerritory: number;
}): {
  assignments: TaskNode[][];
  assignmentSourceByTaskId: Map<TaskId, TaskAssignmentSource>;
} {
  const assignments = args.profiles.map(() => [] as TaskNode[]);
  const assignmentSourceByTaskId = new Map<TaskId, TaskAssignmentSource>();

  for (const ranked of args.rankedTasks) {
    const preferredIndex = [ranked.bestTerritoryIndex, ranked.secondTerritoryIndex].find(
      (territoryIndex) => assignments[territoryIndex].length < args.maxTasksPerTerritory
    );
    const fallbackIndex = assignments
      .map((tasks, territoryIndex) => ({ territoryIndex, count: tasks.length }))
      .sort((left, right) => left.count - right.count || left.territoryIndex - right.territoryIndex)[0]
      .territoryIndex;
    const territoryIndex = preferredIndex ?? fallbackIndex;
    assignments[territoryIndex].push(ranked.task);
    assignmentSourceByTaskId.set(ranked.task.taskId, "historical_score");
  }

  return { assignments, assignmentSourceByTaskId };
}

function rebalanceBorderTasks(args: {
  assignments: TaskNode[][];
  rankedByTaskId: Map<TaskId, RankedTask>;
  profileByIndex: Map<number, HistoricalTerritoryProfile>;
  minTasksPerTerritory: number;
  assignmentSourceByTaskId: Map<TaskId, TaskAssignmentSource>;
  allowNonCoreMoves: boolean;
}): TaskNode[][] {
  const balanced = args.assignments.map((tasks) => [...tasks]);

  for (let guard = 0; guard < 100; guard += 1) {
    const counts = balanced.map((tasks) => tasks.length);
    const underfullIndex = counts.findIndex((count) => count < args.minTasksPerTerritory);
    if (underfullIndex === -1) break;

    const donorIndex = counts
      .map((count, territoryIndex) => ({ territoryIndex, count }))
      .filter((entry) => entry.count > args.minTasksPerTerritory)
      .sort((left, right) => right.count - left.count || left.territoryIndex - right.territoryIndex)[0]
      ?.territoryIndex;

    if (donorIndex === undefined) break;

    const movableTasks = balanced[donorIndex]
      .map((task) => ({
        task,
        ranked: args.rankedByTaskId.get(task.taskId),
      }))
      .filter((entry): entry is { task: TaskNode; ranked: RankedTask } => entry.ranked !== undefined)
      .filter((entry) => {
        if (args.allowNonCoreMoves) {
          return isNonCoreTask(entry.ranked, donorIndex, args.profileByIndex);
        }
        return (
          isBorderTask(entry.ranked, args.profileByIndex) &&
          entry.ranked.secondTerritoryIndex === underfullIndex
        );
      })
      .sort((left, right) => {
        const leftDistance = distanceToProfile(left.task, args.profileByIndex.get(underfullIndex)!);
        const rightDistance = distanceToProfile(right.task, args.profileByIndex.get(underfullIndex)!);
        return leftDistance - rightDistance || left.task.taskId - right.task.taskId;
      });

    const taskToMove = movableTasks[0]?.task;
    if (!taskToMove) break;

    balanced[donorIndex] = balanced[donorIndex].filter((task) => task.taskId !== taskToMove.taskId);
    balanced[underfullIndex].push(taskToMove);
    args.assignmentSourceByTaskId.set(taskToMove.taskId, "border_rebalance");
  }

  return balanced;
}

function buildClusters(
  assignments: TaskNode[][],
  profiles: HistoricalTerritoryProfile[]
): TerritoryCluster[] {
  return profiles
    .map((profile, index) => {
      const tasks = [...assignments[index]].sort((left, right) => left.taskId - right.taskId);
      if (tasks.length === 0) return null;
      const hubTask = findHubTask(tasks, profile.centroid);
      return {
        profile,
        tasks,
        hubTaskId: hubTask.taskId,
        hubNodeIndex: hubTask.nodeIndex,
      };
    })
    .filter((cluster): cluster is TerritoryCluster => cluster !== null);
}

function countCoreAndBorderTasks(
  cluster: TerritoryCluster,
  assignmentSourceByTaskId: Map<TaskId, TaskAssignmentSource>
): { coreTasks: number; borderTasks: number } {
  let coreTasks = 0;
  let borderTasks = 0;
  for (const task of cluster.tasks) {
    const distanceMeters = distanceToProfile(task, cluster.profile);
    const isCore =
      distanceMeters <= cluster.profile.penaltyRadiusMeters * TERRITORY_ALGO_CONFIG.coreRadiusRatio;
    if (isCore && assignmentSourceByTaskId.get(task.taskId) === "historical_score") {
      coreTasks += 1;
    } else {
      borderTasks += 1;
    }
  }
  return { coreTasks, borderTasks };
}

export function buildHistoricalTerritoryAssignment(args: {
  tasks: TaskNode[];
  drivers: DriverNode[];
  travelMatrixMin: number[][];
  requiredDriverByTaskId: Map<TaskId, DriverId>;
  profiles: HistoricalTerritoryProfile[];
  debugTerritoriesEnabled: boolean;
  routingPenaltiesEnabled: boolean;
}): {
  groups: DailyTerritoryGroup[];
  assignment: DailyTerritoryAssignment;
} {
  const profiles = [...args.profiles].sort((left, right) => left.territoryIndex - right.territoryIndex);
  const profileByIndex = new Map(profiles.map((profile) => [profile.territoryIndex, profile]));
  const capacity = resolveTerritoryCapacity(args.tasks.length, profiles.length);
  const rankedTasks = rankTasks(args.tasks, profiles);
  const rankedByTaskId = new Map(rankedTasks.map((ranked) => [ranked.task.taskId, ranked]));

  const initial = assignInitialTasks({
    rankedTasks,
    profiles,
    maxTasksPerTerritory: capacity.max,
  });

  let assignments = rebalanceBorderTasks({
    assignments: initial.assignments,
    rankedByTaskId,
    profileByIndex,
    minTasksPerTerritory: capacity.min,
    assignmentSourceByTaskId: initial.assignmentSourceByTaskId,
    allowNonCoreMoves: false,
  });

  const countsAfterBorder = assignments.map((tasks) => tasks.length);
  const imbalance = Math.max(...countsAfterBorder) - Math.min(...countsAfterBorder);
  if (imbalance > TERRITORY_ALGO_CONFIG.balanceToleranceTasks * 2) {
    assignments = rebalanceBorderTasks({
      assignments,
      rankedByTaskId,
      profileByIndex,
      minTasksPerTerritory: capacity.min,
      assignmentSourceByTaskId: initial.assignmentSourceByTaskId,
      allowNonCoreMoves: true,
    });
  }

  const clusters = buildClusters(assignments, profiles);
  const territoriesForMatching: TerritoryForDriverMatching[] = clusters.map((cluster) => ({
    territoryIndex: cluster.profile.territoryIndex,
    taskIds: cluster.tasks.map((task) => task.taskId),
    hubNodeIndex: cluster.hubNodeIndex,
    territoryKey: cluster.profile.territoryKey,
    preferredHistoricalDriverCode: cluster.profile.preferredHistoricalDriverCode,
  }));

  const driverAssignments = matchTerritoriesToDrivers({
    territories: territoriesForMatching,
    drivers: args.drivers,
    travelMatrixMin: args.travelMatrixMin,
    requiredDriverByTaskId: args.requiredDriverByTaskId,
    useHistoricalDriverBias: true,
  });
  const driverByTerritory = new Map(
    driverAssignments.map((assignment) => [assignment.territoryIndex, assignment.assignedDriverId])
  );

  const groups: DailyTerritoryGroup[] = clusters.map((cluster) => {
    const assignedDriverId =
      driverByTerritory.get(cluster.profile.territoryIndex) ?? args.drivers[0]?.id ?? 0;
    return {
      groupId: `daily-territory:${cluster.profile.territoryKey}`,
      type: "DAILY_TERRITORY",
      taskIds: cluster.tasks.map((task) => task.taskId),
      confidence: "high",
      territoryIndex: cluster.profile.territoryIndex,
      territoryKey: cluster.profile.territoryKey,
      centroid: cluster.profile.centroid,
      radiusMeters: cluster.profile.visualRadiusMeters,
      penaltyRadiusMeters: cluster.profile.penaltyRadiusMeters,
      softBoundaryMeters: cluster.profile.penaltyRadiusMeters,
      assignedDriverId,
      source: "historical_territory_template",
    };
  });

  const assignment: DailyTerritoryAssignment = {
    debugTerritoriesEnabled: args.debugTerritoriesEnabled,
    routingPenaltiesEnabled: args.routingPenaltiesEnabled,
    territoryMode: "historical_template_3_drivers",
    penaltyConfig: HISTORICAL_TEMPLATE_PENALTY_CONFIG,
    territories: groups.map((group) => {
      const cluster = clusters.find((item) => item.profile.territoryIndex === group.territoryIndex)!;
      const { coreTasks, borderTasks } = countCoreAndBorderTasks(
        cluster,
        initial.assignmentSourceByTaskId
      );
      return {
        territoryId: group.groupId,
        territoryIndex: group.territoryIndex,
        territoryKey: group.territoryKey,
        label: cluster.profile.label,
        taskIds: group.taskIds,
        centroid: group.centroid,
        radiusMeters: group.radiusMeters,
        penaltyRadiusMeters: group.penaltyRadiusMeters,
        historicalCentroid: cluster.profile.centroid,
        historicalPenaltyRadiusMeters: cluster.profile.penaltyRadiusMeters,
        assignedDriverId: group.assignedDriverId,
        suggestedColor: cluster.profile.suggestedColor,
        coreTasks,
        borderTasks,
      };
    }),
    profiles: groups.map((group) => {
      const cluster = clusters.find((item) => item.profile.territoryIndex === group.territoryIndex)!;
      const { coreTasks, borderTasks } = countCoreAndBorderTasks(
        cluster,
        initial.assignmentSourceByTaskId
      );
      return {
        territoryKey: group.territoryKey!,
        label: cluster.profile.label,
        assignedDriverId: group.assignedDriverId,
        taskCount: group.taskIds.length,
        coreTasks,
        borderTasks,
      };
    }),
    taskTerritoryIndex: groups.flatMap((group) =>
      group.taskIds.map((taskId) => ({ taskId, territoryIndex: group.territoryIndex }))
    ),
    taskPreferredDriverId: groups.flatMap((group) =>
      group.taskIds.map((taskId) => ({ taskId, driverId: group.assignedDriverId }))
    ),
    taskAssignmentDetails: groups.flatMap((group) =>
      group.taskIds.map((taskId) => ({
        taskId,
        territoryIndex: group.territoryIndex,
        assignmentSource: initial.assignmentSourceByTaskId.get(taskId) ?? "historical_score",
      }))
    ),
  };

  return { groups, assignment };
}

export function classifyTaskTerritoryZone(
  task: TaskNode,
  profile: HistoricalTerritoryProfile
): "core" | "normal" | "border" {
  const distanceMeters = distanceToProfile(task, profile);
  const ratio = distanceMeters / Math.max(profile.penaltyRadiusMeters, 1);
  if (ratio <= TERRITORY_ALGO_CONFIG.coreRadiusRatio) return "core";
  if (ratio <= TERRITORY_ALGO_CONFIG.borderRadiusRatio) return "normal";
  return "border";
}

export function dayCentroidForTasks(tasks: TaskNode[]): { lat: number; lng: number } {
  return calculateCentroid(tasks.map((task) => task.location));
}
