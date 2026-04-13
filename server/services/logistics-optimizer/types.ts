/**
 * Types for the logistics optimizer pipeline (housekeeping-window constrained).
 */

export type HousekeepingWindow = {
  taskId: number;
  cleanerId: number;
  /** Minutes from midnight UTC-aligned with PG time fields */
  startMin: number;
  endMin: number;
};

export type LogisticsTaskInput = {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  /** Service time at stop (minutes), e.g. drop-off / handover */
  serviceMinutes: number;
  locked: boolean;
};

export type DriverInput = {
  driverId: number;
  name: string;
  lastname: string;
  startTime: string;
};

export type Phase0Result =
  | { ok: true; windowsByTaskId: Map<number, HousekeepingWindow> }
  | {
      ok: false;
      reason: 'NO_HK_TIMELINE' | 'HK_WINDOW_MISSING';
      message: string;
      missingTaskIds?: number[];
    };

export type Phase1Result = {
  tasks: PreparedTask[];
  drivers: DriverInput[];
  travelMatrixMin: number[][];
  windowsByTaskId: Map<number, HousekeepingWindow>;
};

export type PreparedTask = LogisticsTaskInput & {
  hkStartMin: number;
  hkEndMin: number;
};

export type Phase2Result = {
  /** taskId -> driverId (initial seed assignment) */
  seedAssignment: Map<number, number>;
  targetMinPerDriver: number;
  targetMaxPerDriver: number;
};

export type SolverTaskPayload = {
  taskId: number;
  logisticCode: number;
  twStartMin: number;
  twEndMin: number;
  serviceMin: number;
};

export type SolverDriverPayload = {
  driverId: number;
};

export type Phase3Result =
  | {
      ok: true;
      /** Per driver: ordered task ids (only assigned tasks) */
      routesByDriverId: Map<number, number[]>;
      /** taskId -> cumulative start service minute at node (from solver) */
      arrivalMinByTaskId?: Map<number, number>;
    }
  | { ok: false; reason: 'ORTOOLS_ERROR' | 'INFEASIBLE' | 'PYTHON_MISSING'; message: string };

export type UnassignedEntry = {
  taskId: number;
  reasonCode: string;
  details?: Record<string, unknown>;
};

export type LogisticsPipelineResult = {
  runId: string;
  workDate: string;
  status: 'success' | 'partial' | 'failed';
  phase0: Phase0Result;
  phase1?: Phase1Result;
  phase2?: Phase2Result;
  phase3?: Phase3Result;
  timelinePayload?: unknown;
  unassigned: UnassignedEntry[];
  decisionsInserted: number;
  durationMs: number;
  error?: string;
};
