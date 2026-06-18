import type { TaskNode } from "../input-contract";
import type { SameCoordinatesBuildingGroup } from "./group-contract";
import { BUSINESS_GROUP_THRESHOLDS } from "./group-weights";
import { calculateCentroid, haversineMeters, unionFindGroups } from "./geo-utils";

function hasFiniteCoordinates(task: TaskNode): boolean {
  const { lat, lng } = task.location;
  return Number.isFinite(lat) && Number.isFinite(lng);
}

/**
 * Transitive closure over coordinates within 100 meters.
 */
export function buildSameCoordinatesBuildingGroups(tasks: TaskNode[]): SameCoordinatesBuildingGroup[] {
  const toleranceMeters = BUSINESS_GROUP_THRESHOLDS.SAME_COORDINATES_BUILDING_TOLERANCE_METERS;
  const eligibleTasks = tasks.filter(hasFiniteCoordinates);
  const components = unionFindGroups(eligibleTasks, (left, right) => {
    const distance = haversineMeters(
      left.location.lat,
      left.location.lng,
      right.location.lat,
      right.location.lng
    );
    return distance <= toleranceMeters;
  });

  return components
    .filter((component) => component.length >= 2)
    .map((component) => {
      const taskIds = component.map((task) => task.taskId).sort((a, b) => a - b);
      const centroid = calculateCentroid(component.map((task) => task.location));
      return {
        groupId: `same-coordinates:${taskIds.join(",")}`,
        type: "SAME_COORDINATES_BUILDING" as const,
        taskIds,
        confidence: "high" as const,
        toleranceMeters,
        centroid,
        source: "coordinates" as const,
      };
    });
}
