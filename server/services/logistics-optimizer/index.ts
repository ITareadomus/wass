import { runLogisticsPhase0, LogisticsPhase0Result } from "./phase0";

export interface LogisticsOptimizerRunResult extends LogisticsPhase0Result {}

export async function runLogisticsOptimizer(workDate: string): Promise<LogisticsOptimizerRunResult> {
  // Initial implementation: only Phase 0 constraints.
  return runLogisticsPhase0(workDate);
}
