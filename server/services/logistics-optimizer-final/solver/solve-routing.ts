import type { RoutingProblemInput } from "../input-contract";
import {
  GREEDY_SOLVER_ID,
  ORTOOLS_SOLVER_ID,
  type RoutingSolution,
} from "../solution-contract";
import { assertOrToolsAvailable } from "./ortools/ortools-availability";
import { solveGreedyRouting } from "./greedy-routing-solver";
import { solveOrToolsRouting } from "./ortools/ortools-routing-solver";
import type { RoutingSolverId, SolveRoutingOptions } from "./routing-solver-contract";

export type { RoutingSolverId, SolveRoutingOptions } from "./routing-solver-contract";
export {
  OrToolsUnavailableError,
  ORTOOLS_UNAVAILABLE_CODE,
  probeOrToolsAvailability,
  assertOrToolsAvailable,
} from "./ortools/ortools-availability";

export async function solveRouting(
  input: RoutingProblemInput,
  options: SolveRoutingOptions = {}
): Promise<RoutingSolution> {
  const solverId = options.solverId ?? ORTOOLS_SOLVER_ID;

  if (solverId === ORTOOLS_SOLVER_ID) {
    await assertOrToolsAvailable({
      pythonPath: options.ortools?.pythonPath,
      scriptPath: options.ortools?.scriptPath,
    });
    return solveOrToolsRouting(input, options);
  }

  if (solverId === GREEDY_SOLVER_ID) {
    return solveGreedyRouting(input, {
      generatedAt: options.generatedAt,
      solveDurationMs: options.solveDurationMs,
    });
  }

  throw new Error(`Unsupported routing solver: ${solverId}`);
}
