import type { SoftConstraintSpec, TaskNode } from "../input-contract";
import type { RoutingBusinessGroup } from "./group-contract";
import { BUSINESS_GROUP_WEIGHTS } from "./group-weights";
import { buildCleanerSequenceGroups } from "./cleaner-sequence-groups";
import { buildNearbyClusterGroups } from "./nearby-cluster-groups";
import { buildPriorityCompatibleGroups } from "./priority-compatible-groups";
import { buildSameCleanerGroups } from "./same-cleaner-groups";
import { buildSameCoordinatesBuildingGroups } from "./same-coordinates-building-groups";

export { hasCleanerAssignment } from "./task-eligibility";

export function buildBusinessGroups(
  tasks: TaskNode[],
  travelMatrixMin: number[][]
): RoutingBusinessGroup[] {
  return [
    ...buildSameCoordinatesBuildingGroups(tasks),
    ...buildSameCleanerGroups(tasks),
    ...buildCleanerSequenceGroups(tasks),
    ...buildPriorityCompatibleGroups(tasks),
    ...buildNearbyClusterGroups(tasks, travelMatrixMin),
  ];
}

export function buildBusinessGroupSoftConstraints(
  groups: RoutingBusinessGroup[]
): SoftConstraintSpec[] {
  return groups.map((group) => {
    switch (group.type) {
      case "SAME_COORDINATES_BUILDING":
        return {
          type: "KEEP_SAME_COORDINATES_BUILDING_TOGETHER",
          groupId: group.groupId,
          weight: BUSINESS_GROUP_WEIGHTS.KEEP_SAME_COORDINATES_BUILDING_TOGETHER,
          toleranceMeters: group.toleranceMeters,
        };
      case "SAME_CLEANER":
        return {
          type: "KEEP_SAME_CLEANER_TASKS_TOGETHER",
          groupId: group.groupId,
          weight: BUSINESS_GROUP_WEIGHTS.KEEP_SAME_CLEANER_TASKS_TOGETHER,
          cleanerId: group.cleanerId,
        };
      case "CLEANER_SEQUENCE":
        return {
          type: "KEEP_CLEANER_SEQUENCE",
          groupId: group.groupId,
          weight: BUSINESS_GROUP_WEIGHTS.KEEP_CLEANER_SEQUENCE,
          cleanerId: group.cleanerId,
          orderedTaskIds: group.orderedTaskIds,
        };
      case "PRIORITY_COMPATIBLE":
        return {
          type: "KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER",
          groupId: group.groupId,
          weight: BUSINESS_GROUP_WEIGHTS.KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER,
          windowOverlap: group.windowOverlap,
        };
      case "NEARBY_CLUSTER":
        return {
          type: "KEEP_NEARBY_CLUSTER_TOGETHER",
          groupId: group.groupId,
          weight: BUSINESS_GROUP_WEIGHTS.KEEP_NEARBY_CLUSTER_TOGETHER,
          maxTravelMin: group.maxTravelMin,
        };
    }
  });
}
