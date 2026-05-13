import { runLogisticsPhase0, LogisticsPhase0Result } from "./phase0";
import { runLogisticsPhase1, LogisticsPhase1Result } from "./phase1";
import { LogisticsPhase2Result, runLogisticsPhase2 } from "./phase2";

export interface LogisticsOptimizerRunResult extends LogisticsPhase0Result {
  phase1: LogisticsPhase1Result;
  phase2: LogisticsPhase2Result;
}

export async function runLogisticsOptimizer(workDate: string): Promise<LogisticsOptimizerRunResult> {
  const phase0 = await runLogisticsPhase0(workDate);
  const phase1 = await runLogisticsPhase1(workDate, phase0.unlockedTaskData);
  const phase2 = await runLogisticsPhase2(workDate, phase0.unlockedTaskData, phase1);

  return {
    ...phase0,
    canRun: phase0.canRun && phase1.canRun && phase2.canRun,
    phase1,
    phase2,
  };
}
