export type SolutionValidationSeverity = "error" | "warning";

export type SolutionValidationIssueCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "UNEXPECTED_SOLVER_ID"
  | "UNKNOWN_TASK_IN_SOLUTION"
  | "DUPLICATE_ASSIGNED_TASK"
  | "DUPLICATE_DROPPED_TASK"
  | "TASK_PARTITION_MISMATCH"
  | "UNKNOWN_DRIVER_IN_ROUTE"
  | "EMPTY_ROUTE_IN_SOLUTION"
  | "INVALID_ROUTE_SEQUENCE"
  | "INVALID_SERVICE_DURATION"
  | "TASK_HARD_WINDOW_VIOLATION"
  | "DRIVER_WINDOW_VIOLATION"
  | "NON_MONOTONIC_ROUTE_TIMES"
  | "TRAVEL_MATRIX_MISMATCH"
  | "PREVIOUS_TASK_MISMATCH"
  | "ROUTE_TOTALS_MISMATCH"
  | "ARRIVAL_WAIT_INCONSISTENT"
  | "INVALID_SOLUTION_STATUS"
  | "REQUIRED_DRIVER_VIOLATION"
  | "REQUIRED_DRIVER_DROPPED"
  | "OBJECTIVE_BREAKDOWN_MISMATCH";

export interface SolutionValidationIssue {
  code: SolutionValidationIssueCode;
  severity: SolutionValidationSeverity;
  message: string;
  path?: string;
  taskId?: number;
  /** Codice ADAM (`logistic_code`) per messaggi utente. */
  logisticCode?: number;
  driverId?: number;
  expected?: unknown;
  actual?: unknown;
}

export interface RoutingSolutionValidationResult {
  valid: boolean;
  errors: SolutionValidationIssue[];
  warnings: SolutionValidationIssue[];
}
