/** Soft routing priority: geo > priority windows. Cleaner sequence/clustering disabled (weight 0). */
export const BUSINESS_GROUP_WEIGHTS = {
  KEEP_SAME_COORDINATES_BUILDING_TOGETHER: 100,
  KEEP_NEARBY_CLUSTER_TOGETHER: 45,
  KEEP_CLEANER_SEQUENCE: 0,
  KEEP_SAME_CLEANER_TASKS_TOGETHER: 0,
  KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER: 20,
} as const;

export const BUSINESS_GROUP_THRESHOLDS = {
  SAME_COORDINATES_BUILDING_TOLERANCE_METERS: 100,
  NEARBY_CLUSTER_MAX_TRAVEL_MIN: 10,
  /** Cost bonus applies only on legs at or below this travel time (within a cluster). */
  NEARBY_CLUSTER_BONUS_MAX_TRAVEL_MIN: 5,
  PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN: 45,
} as const;
