import { buildLogisticsRoutingInput } from "./build-routing-input";
import { isLogisticsOptimizerFinalDebugEnabled, writeRoutingProblemInputDebug } from "./debug-writer";
import type { BusinessGroupType } from "./groups/group-contract";
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
  businessGroupCount: number;
  businessGroupsByType: Record<BusinessGroupType, number>;
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

  const businessGroupsByType: Record<BusinessGroupType, number> = {
    SAME_COORDINATES_BUILDING: 0,
    SAME_CLEANER: 0,
    CLEANER_SEQUENCE: 0,
    PRIORITY_COMPATIBLE: 0,
    NEARBY_CLUSTER: 0,
  };
  for (const group of input.businessGroups) {
    businessGroupsByType[group.type] += 1;
  }

  return {
    workDate,
    debugDir,
    validation: input.metadata.validation,
    taskCount: input.tasks.length,
    driverCount: input.drivers.length,
    businessGroupCount: input.businessGroups.length,
    businessGroupsByType,
    errorCount: input.metadata.validation.errors.length,
    warningCount: input.metadata.validation.warnings.length,
  };
}
