import type { TaskNode } from "../input-contract";
import type { NearbyClusterGroup } from "./group-contract";
import { BUSINESS_GROUP_THRESHOLDS } from "./group-weights";
import { effectiveTravelMin } from "./travel-matrix-utils";

function hasFiniteCoordinates(task: TaskNode): boolean {
  const { lat, lng } = task.location;
  return Number.isFinite(lat) && Number.isFinite(lng);
}

export function buildNearbyClusterGroups(
  tasks: TaskNode[],
  travelMatrixMin: number[][]
): NearbyClusterGroup[] {
  const maxTravelMin = BUSINESS_GROUP_THRESHOLDS.NEARBY_CLUSTER_MAX_TRAVEL_MIN;
  const eligibleTasks = tasks
    .filter(hasFiniteCoordinates)
    .sort((a, b) => a.taskId - b.taskId);
  const clustered = new Set<number>();
  const groups: NearbyClusterGroup[] = [];

  for (const seed of eligibleTasks) {
    if (clustered.has(seed.taskId)) {
      continue;
    }

    const members = [seed];
    const hubNodeIndex = seed.nodeIndex;

    for (const candidate of eligibleTasks) {
      if (candidate.taskId === seed.taskId || clustered.has(candidate.taskId)) {
        continue;
      }

      const travelFromHub = effectiveTravelMin(
        travelMatrixMin,
        hubNodeIndex,
        candidate.nodeIndex
      );
      if (travelFromHub === null || travelFromHub > maxTravelMin) {
        continue;
      }

      members.push(candidate);
    }

    if (members.length < 2) {
      continue;
    }

    for (const member of members) {
      clustered.add(member.taskId);
    }

    const taskIds = members.map((task) => task.taskId).sort((a, b) => a - b);
    groups.push({
      groupId: `nearby-cluster:${seed.taskId}`,
      type: "NEARBY_CLUSTER",
      taskIds,
      confidence: "medium",
      maxTravelMin,
      hubTaskId: seed.taskId,
      source: "travel_matrix",
    });
  }

  return groups;
}
