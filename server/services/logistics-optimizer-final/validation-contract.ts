export type ValidationSeverity = "error" | "warning";

/** debug = permissive warnings; solver/apply = blocking production rules */
export type ValidationMode = "debug" | "solver" | "apply";

export interface ValidateRoutingProblemInputOptions {
  mode?: ValidationMode;
}

export type ValidationIssueCode =
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "NO_SELECTED_DRIVERS"
  | "PRIORITY_WINDOWS_UNAVAILABLE"
  | "DUPLICATE_REQUIRED_DRIVER_TASK"
  | "MULTIPLE_REQUIRED_DRIVERS_FOR_TASK"
  | "REQUIRED_DRIVER_TASK_SKIPPED"
  | "INVALID_DEPOT_NODE"
  | "DUPLICATE_DRIVER_ID"
  | "INVALID_DRIVER_WORK_WINDOW"
  | "MISSING_DRIVER_WORK_WINDOW_CONSTRAINT"
  | "DUPLICATE_TASK_ID"
  | "DUPLICATE_NODE_INDEX"
  | "INVALID_NODE_INDEX"
  | "TASK_INCLUDED_BUT_UNSCHEDULABLE"
  | "INVALID_TASK_COORDINATES"
  | "INVALID_TASK_HARD_WINDOW"
  | "TASK_SERVICE_EXCEEDS_WINDOW"
  | "INVALID_TASK_SERVICE_DURATION"
  | "MISSING_TASK_TIME_WINDOW_CONSTRAINT"
  | "MISSING_TASK_REQUIRED_CONSTRAINT"
  | "UNKNOWN_TASK_IN_CONSTRAINT"
  | "UNKNOWN_DRIVER_IN_CONSTRAINT"
  | "INVALID_HARD_CONSTRAINT"
  | "DUPLICATE_HARD_CONSTRAINT"
  | "INVALID_SOFT_CONSTRAINT"
  | "INVALID_TRAVEL_MATRIX_SIZE"
  | "INVALID_TRAVEL_MATRIX_VALUE"
  | "INVALID_EXCLUDED_TASK_REASON"
  | "EXCLUDED_TASK_COUNT_MISMATCH"
  | "METADATA_CONSISTENCY_MISMATCH"
  | "INVALID_BUSINESS_GROUP"
  | "UNKNOWN_TASK_IN_BUSINESS_GROUP"
  | "DUPLICATE_BUSINESS_GROUP_ID"
  | "UNKNOWN_BUSINESS_GROUP_IN_CONSTRAINT"
  | "SAME_BUILDING_GROUP_NOT_LOCKED";

export interface ValidationIssue {
  code: ValidationIssueCode;
  severity: ValidationSeverity;
  message: string;
  path?: string;
  taskId?: number;
  /** Codice ADAM (`logistic_code`) per messaggi utente. */
  logisticCode?: number;
  driverId?: number;
  nodeIndex?: number;
  expected?: unknown;
  actual?: unknown;
}

export interface RoutingProblemValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}
