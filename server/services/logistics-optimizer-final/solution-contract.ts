import type { DriverId, Minutes, TaskId } from "./input-contract";

export const ROUTING_SOLUTION_SCHEMA_VERSION = "logistics-routing-solution/v1" as const;
export const GREEDY_SOLVER_ID = "greedy-v1" as const;
export const ORTOOLS_SOLVER_ID = "ortools-v1" as const;

export const KNOWN_ROUTING_SOLVER_IDS = [GREEDY_SOLVER_ID, ORTOOLS_SOLVER_ID] as const;

export type RoutingSolutionStatus =
  | "OPTIMAL"
  | "FEASIBLE"
  | "PARTIAL"
  | "INFEASIBLE"
  | "INVALID";

export type RoutingDroppedTaskReason =
  | "NO_FEASIBLE_DRIVER"
  | "REQUIRED_DRIVER_INFEASIBLE"
  | "OUTSIDE_TIME_WINDOWS"
  | "MISSING_TRAVEL_MATRIX"
  | "VALIDATION_FAILED"
  | "UNKNOWN";

export interface RoutingStopSolution {
  sequence: number;
  taskId: TaskId;
  arrivalMin: Minutes;
  startMin: Minutes;
  endMin: Minutes;
  serviceDurationMin: Minutes;
  travelFromPreviousMin: Minutes;
  waitMin: Minutes;
  previousTaskId?: TaskId | null;
}

export interface RoutingRouteSolution {
  driverId: DriverId;
  startMin: Minutes;
  endMin: Minutes;
  totalServiceMin: Minutes;
  totalTravelMin: Minutes;
  totalWaitMin: Minutes;
  stops: RoutingStopSolution[];
}

export interface RoutingDroppedTask {
  taskId: TaskId;
  reason: RoutingDroppedTaskReason;
  details?: string;
}

export interface RoutingObjectiveBreakdown {
  assignedTasks: number;
  droppedTasks: number;
  totalTravelMin: Minutes;
  totalWaitMin: Minutes;
  softConstraintScore?: number;
  penalties?: Record<string, number>;
}

export interface RoutingSolutionDiagnostics {
  warnings: string[];
  notes?: string[];
  solveDurationMs?: number;
}

export interface RoutingSolution {
  schemaVersion: typeof ROUTING_SOLUTION_SCHEMA_VERSION;
  solverId: string;
  workDate: string;
  status: RoutingSolutionStatus;
  generatedAt: string;
  routes: RoutingRouteSolution[];
  droppedTasks: RoutingDroppedTask[];
  objectiveBreakdown?: RoutingObjectiveBreakdown;
  diagnostics?: RoutingSolutionDiagnostics;
}
