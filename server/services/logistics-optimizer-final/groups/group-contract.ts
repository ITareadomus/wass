import type { Minutes, TaskId } from "../input-contract";

export type BusinessGroupType =
  | "SAME_COORDINATES_BUILDING"
  | "SAME_CLEANER"
  | "CLEANER_SEQUENCE"
  | "PRIORITY_COMPATIBLE"
  | "NEARBY_CLUSTER";

export type BusinessGroupConfidence = "high" | "medium" | "low";

export interface BaseBusinessGroup {
  groupId: string;
  type: BusinessGroupType;
  taskIds: TaskId[];
  confidence: BusinessGroupConfidence;
}

export interface SameCoordinatesBuildingGroup extends BaseBusinessGroup {
  type: "SAME_COORDINATES_BUILDING";
  toleranceMeters: number;
  centroid: { lat: number; lng: number };
  source: "coordinates";
}

export interface SameCleanerGroup extends BaseBusinessGroup {
  type: "SAME_CLEANER";
  cleanerId: number;
  source: "cleaner_id";
}

export interface CleanerSequenceGroup extends BaseBusinessGroup {
  type: "CLEANER_SEQUENCE";
  cleanerId: number;
  orderedTaskIds: TaskId[];
  source: "cleaner_task_start_time";
}

export interface PriorityCompatibleGroup extends BaseBusinessGroup {
  type: "PRIORITY_COMPATIBLE";
  windowOverlap: {
    startMin: Minutes;
    endMin: Minutes;
  };
  source: "priority_window";
}

export interface NearbyClusterGroup extends BaseBusinessGroup {
  type: "NEARBY_CLUSTER";
  maxTravelMin: number;
  hubTaskId: TaskId;
  source: "travel_matrix";
}

export type RoutingBusinessGroup =
  | SameCoordinatesBuildingGroup
  | SameCleanerGroup
  | CleanerSequenceGroup
  | PriorityCompatibleGroup
  | NearbyClusterGroup;
