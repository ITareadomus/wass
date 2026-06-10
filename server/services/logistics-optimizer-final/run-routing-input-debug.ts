import { buildLogisticsRoutingInput } from "./build-routing-input";
import { isLogisticsOptimizerFinalDebugEnabled, writeRoutingProblemInputDebug } from "./debug-writer";
import type { RoutingProblemInput } from "./input-contract";

export interface RunLogisticsRoutingInputDebugOptions {
  debug?: boolean;
}

export interface RunLogisticsRoutingInputDebugResult {
  workDate: string;
  debugDir: string | null;
  validation: RoutingProblemInput["metadata"]["validation"];
  taskCount: number;
  driverCount: number;
  errorCount: number;
  warningCount: number;
}

/**
 * Pre-solver debug runner: builds RoutingProblemInput, validates it,
 * and optionally persists debug JSON.
 * Does not run solver or apply assignments.
 */
export async function runLogisticsRoutingInputDebug(
  workDate: string,
  options: RunLogisticsRoutingInputDebugOptions = {}
): Promise<RunLogisticsRoutingInputDebugResult> {
  const input = await buildLogisticsRoutingInput(workDate);
  const debugEnabled = isLogisticsOptimizerFinalDebugEnabled(options.debug);
  let debugDir: string | null = null;

  if (debugEnabled) {
    debugDir = await writeRoutingProblemInputDebug(input);
    console.log(`📋 Logistics optimizer final debug scritto in: ${debugDir}`);
  }

  return {
    workDate,
    debugDir,
    validation: input.metadata.validation,
    taskCount: input.tasks.length,
    driverCount: input.drivers.length,
    errorCount: input.metadata.validation.errors.length,
    warningCount: input.metadata.validation.warnings.length,
  };
}
