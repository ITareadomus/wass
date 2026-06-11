import { buildLogisticsRoutingInput } from "./build-routing-input";
import {
  isLogisticsOptimizerFinalDebugEnabled,
  writeRoutingDryRunDebug,
} from "./debug-writer";
import { solveGreedyRouting } from "./solver/greedy-routing-solver";
import type { RoutingSolution } from "./solution-contract";
import { validateRoutingSolution } from "./solution-validation";
import { validateRoutingProblemInput } from "./validation";
import type { RoutingProblemValidationResult } from "./validation-contract";
import type { RoutingSolutionValidationResult } from "./solution-validation-contract";

export interface RunLogisticsRoutingDryOptions {
  debug?: boolean;
}

export interface RunLogisticsRoutingDryResult {
  workDate: string;
  debugDir: string | null;
  inputValidation: RoutingProblemValidationResult;
  solutionValidation: RoutingSolutionValidationResult;
  solution: RoutingSolution;
  inputSummary: {
    taskCount: number;
    driverCount: number;
  };
  solutionSummary: {
    status: RoutingSolution["status"];
    routeCount: number;
    assignedTaskCount: number;
    droppedTaskCount: number;
    totalTravelMin: number;
    totalWaitMin: number;
  };
  inputErrorCount: number;
  inputWarningCount: number;
  solutionErrorCount: number;
  solutionWarningCount: number;
}

export class RoutingInputValidationError extends Error {
  readonly inputValidation: RoutingProblemValidationResult;

  constructor(inputValidation: RoutingProblemValidationResult) {
    const summary = inputValidation.errors
      .map((issue) => `${issue.code}: ${issue.message}`)
      .join("\n");
    super(`Invalid RoutingProblemInput:\n${summary}`);
    this.name = "RoutingInputValidationError";
    this.inputValidation = inputValidation;
  }
}

/**
 * Dry-run routing solver: builds RoutingProblemInput, runs greedy solver,
 * validates solution, and optionally persists debug JSON artifacts.
 * Does not apply assignments to timeline or DB.
 */
export async function runLogisticsRoutingDry(
  workDate: string,
  options: RunLogisticsRoutingDryOptions = {}
): Promise<RunLogisticsRoutingDryResult> {
  const input = await buildLogisticsRoutingInput(workDate);
  const inputValidation = validateRoutingProblemInput(input);

  if (!inputValidation.valid) {
    throw new RoutingInputValidationError(inputValidation);
  }

  const solution = solveGreedyRouting(input);
  const solutionValidation = validateRoutingSolution(input, solution);

  const debugEnabled = isLogisticsOptimizerFinalDebugEnabled(options.debug);
  let debugDir: string | null = null;

  if (debugEnabled) {
    debugDir = await writeRoutingDryRunDebug({
      input,
      solution,
      inputValidation,
      solutionValidation,
    });
    console.log(`📋 Logistics optimizer final dry-run scritto in: ${debugDir}`);
  }

  const assignedTaskCount = solution.routes.reduce((sum, route) => sum + route.stops.length, 0);

  return {
    workDate,
    debugDir,
    inputValidation,
    solutionValidation,
    solution,
    inputSummary: {
      taskCount: input.tasks.length,
      driverCount: input.drivers.length,
    },
    solutionSummary: {
      status: solution.status,
      routeCount: solution.routes.length,
      assignedTaskCount,
      droppedTaskCount: solution.droppedTasks.length,
      totalTravelMin: solution.objectiveBreakdown?.totalTravelMin ?? 0,
      totalWaitMin: solution.objectiveBreakdown?.totalWaitMin ?? 0,
    },
    inputErrorCount: inputValidation.errors.length,
    inputWarningCount: inputValidation.warnings.length,
    solutionErrorCount: solutionValidation.errors.length,
    solutionWarningCount: solutionValidation.warnings.length,
  };
}
