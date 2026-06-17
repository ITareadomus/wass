import type { Priority, PriorityWindows } from "../optimizer/priorityWindows";
import type { RuleTrace } from "./business-rules";
import type { RoutingBusinessGroup } from "./groups/group-contract";
import type { RoutingProblemValidationResult } from "./validation-contract";

export type Minutes = number;
export type TaskId = number;
export type DriverId = number;

export type BagHandling =
  | "NO_CLEANER_CONTEXT"
  | "DRIVER_BRINGS_BAG"
  | "CLEANER_HAS_BAG";

/** Task grezzo da DB, indipendente da `logistics-optimizer/phase0`. */
export interface RawLogisticsTaskInput {
  taskId: number;
  logisticCode: number;
  priority: string | null;
  cleaningTime: number | null;
  lat: number | null;
  lng: number | null;
  checkinDate: string | null;
  checkoutDate: string | null;
  checkinTime: string | null;
  checkoutTime: string | null;
  cleanerId: number | null;
  cleanerStartTime: string | null;
  cleanerTaskStartTime: string | null;
  cleanerSequence: number | null;
  premium: boolean;
  paxIn: number | null;
  locked: boolean;
  lockedReason: string | null;
}

/** Pre-assigned: assignment attivo su logistics timeline driver (classe di dominio §22). */
export interface TimelineAssignmentHint {
  taskId: TaskId;
  driverId: DriverId;
  source: "timeline";
  sequence: number | null;
  manuallyMoved: boolean;
}

/** @deprecated Usare `TimelineAssignmentHint`. Mantenuto per retrocompatibilità export. */
export interface ExistingLockedAssignment {
  driverId: number;
  taskId: number;
  sequence: number | null;
  locked: boolean;
  manuallyMoved: boolean;
}

export interface LocationNode {
  nodeId: string;
  nodeIndex: number;
  kind: "DEPOT" | "TASK";
  lat: number;
  lng: number;
  taskId?: TaskId;
}

export interface DriverNode {
  id: DriverId;
  startLocationNodeId: string;
  endLocationNodeId?: string;
  workWindow: {
    startMin: Minutes;
    endMin: Minutes;
    startSource: "driver_row" | "default";
    endSource: "driver_row" | "default";
  };
  selected: true;
}

export interface TaskHardWindow {
  earliestStartMin: Minutes;
  latestStartMin: Minutes;
  latestEndMin: Minutes;
  /**
   * Legacy debug bridge kept during pre-OR-Tools migration.
   * New diagnostics should use task.debug.ruleTrace.
   * TODO: remove when solver-contract.ts is introduced.
   */
  reasons: string[];
}

export interface TaskSoftWindow {
  type: "preferred_start" | "preferred_end" | "slack_buffer";
  startMin?: Minutes;
  endMin?: Minutes;
  penaltyPerMin?: number;
  maxPenalty?: number;
  reason: string;
}

export interface RoutingTaskDebug {
  ruleTrace: RuleTrace[];
  sourceTimes?: {
    customerCheckoutMin: Minutes | null;
    cleanerTaskStartMin: Minutes | null;
    customerCheckinMin: Minutes | null;
  };
}

export interface TaskNode {
  taskId: TaskId;
  logisticCode: number;
  nodeIndex: number;
  location: {
    lat: number;
    lng: number;
    address?: string | null;
    addressGroupId?: number | null;
  };
  priority: Priority | null;
  bagHandling: BagHandling;
  serviceDurationMin: Minutes;
  rawTimes: {
    checkoutDate: string | null;
    checkoutTime: string | null;
    checkinDate: string | null;
    checkinTime: string | null;
    cleanerStartTime: string | null;
    cleanerTaskStartTime: string | null;
    cleanerTaskEndTime?: string | null;
  };
  hardWindow: TaskHardWindow;
  softWindows: TaskSoftWindow[];
  debug?: RoutingTaskDebug;
  groupingHints: {
    cleanerId: number | null;
    cleanerSequence: number | null;
    addressGroupId: number | null;
    sameLogisticCodeGroup: number | null;
    nearbyGroupCandidates?: TaskId[];
  };
  eligibility: {
    schedulable: boolean;
    exclusionReasons: string[];
  };
}

export type HardConstraintSpec =
  | {
      type: "TASK_TIME_WINDOW";
      taskId: TaskId;
      earliestStartMin: Minutes;
      latestStartMin: Minutes;
      latestEndMin: Minutes;
      /**
       * Legacy solver/debug bridge.
       * New diagnostics should use task.debug.ruleTrace.
       * TODO: remove from solver-facing constraints when solver-contract.ts is introduced.
       */
      sourceRules?: string[];
    }
  | {
      type: "DRIVER_WORK_WINDOW";
      driverId: DriverId;
      startMin: Minutes;
      endMin: Minutes;
    }
  | {
      type: "TASK_REQUIRED";
      taskId: TaskId;
      penaltyIfDropped?: number;
    }
  | {
      type: "REQUIRED_DRIVER_TASK";
      taskId: TaskId;
      driverId: DriverId;
      source: "timeline_pre_assigned";
      manuallyMoved?: boolean;
    };

export type SoftConstraintSpec =
  | {
      type: "MINIMIZE_TOTAL_TRAVEL";
      weight: number;
    }
  | {
      type: "BALANCE_DRIVER_LOAD";
      weight: number;
    }
  | {
      type: "PREFERRED_PRIORITY_WINDOW";
      taskId: TaskId;
      startMin: Minutes;
      endMin?: Minutes;
      penaltyPerMinOutside: number;
    }
  | {
      type: "KEEP_SAME_COORDINATES_BUILDING_TOGETHER";
      groupId: string;
      weight: number;
      toleranceMeters: number;
    }
  | {
      type: "KEEP_CLEANER_SEQUENCE";
      groupId: string;
      weight: number;
      cleanerId: number;
      orderedTaskIds: TaskId[];
    }
  | {
      type: "KEEP_SAME_CLEANER_TASKS_TOGETHER";
      groupId: string;
      weight: number;
      cleanerId: number;
    }
  | {
      type: "KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER";
      groupId: string;
      weight: number;
      windowOverlap: {
        startMin: Minutes;
        endMin: Minutes;
      };
    }
  | {
      type: "KEEP_NEARBY_CLUSTER_TOGETHER";
      groupId: string;
      weight: number;
      maxTravelMin: number;
    };

export interface LogisticsWindowConfig {
  source: "app_settings" | "unavailable";
  workDate: string;
  priorityWindows: PriorityWindows | null;
  fallbackUsed: boolean;
  error?: string;
}

export interface RoutingProblemMetadata {
  generatedAt: string;
  totalLogisticsTasks: number;
  lockedTasksExcluded: number;
  tasksExcludedNoCoordinatesCount: number;
  tasksExcludedNoCoordinatesIds: TaskId[];
  noSelectedDrivers: boolean;
  excludedTasks: Array<{
    taskId: TaskId;
    reason: "LOCKED" | "NO_COORDINATES";
    detail?: string | null;
  }>;
  /** @deprecated Non popolato dal builder 4b+. Usare `timelineAssignmentHints`. */
  existingLockedAssignments?: ExistingLockedAssignment[];
  existingLockedAssignmentsCount?: number;
  timelineAssignmentHints: TimelineAssignmentHint[];
  timelineAssignmentHintsCount: number;
  preAssignedRequiredCount: number;
  skippedTimelineAssignmentHintsCount: number;
  autoConvokedDriverIds: number[];
  autoConvokedDriversCount: number;
  autoConvokeMissingInDbDriverIds: number[];
  autoConvokeMissingInDbDriversCount: number;
  lockedAssignmentsSolverIntegration: "integrated_v4b" | "pending";
  validation: RoutingProblemValidationResult;
}

export interface RoutingProblemInput {
  schemaVersion: "logistics-routing-input/v1";
  workDate: string;
  windowConfig: LogisticsWindowConfig;
  depot: LocationNode;
  drivers: DriverNode[];
  tasks: TaskNode[];
  travelMatrixMin: number[][];
  serviceDurationMin: Minutes;
  hardConstraints: HardConstraintSpec[];
  softConstraints: SoftConstraintSpec[];
  businessGroups: RoutingBusinessGroup[];
  metadata: RoutingProblemMetadata;
}
