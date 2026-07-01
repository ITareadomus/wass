export const ROUTE_SEQUENCE_CONFIG = {
  reverseSweepPenaltyMin: 25,
  largeLateralJumpPenaltyMin: 20,
  veryLargeLateralJumpPenaltyMin: 40,
  lateralJumpTravelMin: 12,
  veryLargeLateralJumpTravelMin: 18,
  firstStopMismatchPenaltyMin: 20,
  sweepBackwardTolerance: 0.00025,
  frontierPercentile: 0.75,
  urgentTaskDiscount: 0.5,
  tightLatestStartMin: 14 * 60,
} as const;

export type RouteSequencePenaltyReason =
  | "REVERSE_SWEEP"
  | "LARGE_LATERAL_JUMP"
  | "VERY_LARGE_LATERAL_JUMP"
  | "FIRST_STOP_MISMATCH";
