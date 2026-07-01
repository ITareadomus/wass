import { applyLogisticsRoutingSolution, type ApplyRoutingSolutionResult } from "./apply-routing-solution";
import { buildLogisticsRoutingInput, type BuildLogisticsRoutingInputOptions } from "./build-routing-input";
import {
  isLogisticsOptimizerFinalDebugEnabled,
  writeRoutingDryRunDebug,
} from "./debug-writer";
import type { RoutingProblemInput } from "./input-contract";
import { evaluateSolutionApplyGate, type SolutionApplyGateResult } from "./solution-apply-gate";
import { GREEDY_SOLVER_ID, ORTOOLS_SOLVER_ID, type RoutingSolution } from "./solution-contract";
import {
  assertRoutingSolutionValid,
  RoutingSolutionValidationError,
  validateRoutingSolution,
} from "./solution-validation";
import type { RoutingSolutionValidationResult } from "./solution-validation-contract";
import { buildOrToolsPayload } from "./solver/ortools/ortools-adapter";
import { solveRouting, type RoutingSolverId } from "./solver/solve-routing";
import { diagnoseDroppedTasks, type DroppedTaskDiagnostic } from "./unassigned-diagnostics";
import { RoutingInputValidationError } from "./run-routing-dry";
import { validateRoutingProblemInput } from "./validation";
import type { RoutingProblemValidationResult } from "./validation-contract";
import { computeTerritoryDiagnostics } from "./groups/territory-diagnostics";
import {
  buildVehicleArcPenalties,
  computeRouteSequenceDiagnostics,
} from "./groups/route-sequence-penalties";
import { polishRoutingSolution } from "./route-polishing";

export interface RunLogisticsRoutingOptions extends BuildLogisticsRoutingInputOptions {
  solver?: RoutingSolverId;
  apply?: boolean;
  allowPartial?: boolean;
  debug?: boolean;
  /** Allows greedy-v1 with apply for explicit debug only. */
  allowDebugSolverApply?: boolean;
}

export class GreedySolverNotAllowedForApplyError extends Error {
  readonly code = "GREEDY_SOLVER_NOT_ALLOWED_FOR_APPLY";

  constructor() {
    super(
      'Use solver="ortools-v1" for apply. greedy-v1 is allowed only for dry-run/debug without apply.'
    );
    this.name = "GreedySolverNotAllowedForApplyError";
  }
}

export interface RunLogisticsRoutingResult {
  workDate: string;
  debugDir: string | null;
  inputValidation: RoutingProblemValidationResult;
  solutionValidation: RoutingSolutionValidationResult;
  applyGate: SolutionApplyGateResult;
  solution: RoutingSolution;
  droppedDiagnostics: DroppedTaskDiagnostic[];
  applyResult: ApplyRoutingSolutionResult | null;
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
}

export async function runLogisticsRouting(
  workDate: string,
  options: RunLogisticsRoutingOptions = {}
): Promise<RunLogisticsRoutingResult> {
  const input = await buildLogisticsRoutingInput(workDate, {
    performedBy: options.performedBy,
    skipAutoConvoke: options.skipAutoConvoke,
    saveSelectedDrivers: options.saveSelectedDrivers,
  });

  const inputValidation = validateRoutingProblemInput(input, { mode: "solver" });
  if (!inputValidation.valid) {
    throw new RoutingInputValidationError(inputValidation);
  }

  const solverId = options.solver ?? ORTOOLS_SOLVER_ID;

  if (options.apply === true && solverId === GREEDY_SOLVER_ID && !options.allowDebugSolverApply) {
    throw new GreedySolverNotAllowedForApplyError();
  }

  const solverSolution = await solveRouting(input, { solverId });
  const solution = polishRoutingSolution(input, solverSolution);
  const solutionValidation = validateRoutingSolution(input, solution);
  const applyGate = evaluateSolutionApplyGate(solution, {
    allowPartial: options.allowPartial,
  });
  const droppedDiagnostics =
    solution.droppedTasks.length > 0 ? diagnoseDroppedTasks(input, solution) : [];
  const territoryDiagnostics = computeTerritoryDiagnostics(input, solution);
  const arcPenaltyBuild = buildVehicleArcPenalties({ input });
  const routeSequenceDiagnostics = arcPenaltyBuild
    ? computeRouteSequenceDiagnostics({
        input,
        solution,
        arcPenaltyDetails: arcPenaltyBuild.details,
      })
    : null;

  const debugEnabled = isLogisticsOptimizerFinalDebugEnabled(options.debug);
  let debugDir: string | null = null;

  if (debugEnabled) {
    debugDir = await writeRoutingDryRunDebug({
      input,
      solution,
      inputValidation,
      solutionValidation,
      ortoolsPayload:
        solverId === ORTOOLS_SOLVER_ID ? buildOrToolsPayload(input).payload : undefined,
      extra: {
        applyGate,
        droppedDiagnostics,
        ...(territoryDiagnostics ? { territoryDiagnostics } : {}),
        ...(routeSequenceDiagnostics ? { routeSequenceDiagnostics } : {}),
      },
    });
  }

  let applyResult: ApplyRoutingSolutionResult | null = null;
  if (options.apply === true) {
    assertRoutingSolutionValid(input, solution);
    applyResult = await applyLogisticsRoutingSolution({
      workDate,
      input,
      solution,
      performedBy: options.performedBy,
      allowPartial: options.allowPartial,
      debugDir: debugDir ?? undefined,
    });
  }

  const assignedTaskCount = solution.routes.reduce((sum, route) => sum + route.stops.length, 0);

  return {
    workDate,
    debugDir,
    inputValidation,
    solutionValidation,
    applyGate,
    solution,
    droppedDiagnostics,
    applyResult,
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
  };
}

export type { RoutingProblemInput };
