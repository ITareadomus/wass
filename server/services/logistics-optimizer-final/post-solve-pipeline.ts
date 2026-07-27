import type { RoutingProblemInput } from "./input-contract";
import { ORTOOLS_SOLVER_ID, type RoutingSolution } from "./solution-contract";
import {
  polishRoutingSolutionWithDiagnostics,
  type RoutePolishingDiagnostics,
} from "./route-polishing";
import {
  compareSolutionShape,
  computeSolutionShapeMetrics,
  type SolutionShapeMetrics,
} from "./solution-shape-metrics";
import {
  repairTerritoryAssignments,
  type TerritoryRepairDiagnostics,
} from "./territory-repair";
import {
  isSequenceRefinementEnabled,
  refineSolutionSequence,
  type SequenceRefinementDiagnostics,
  type SequenceRefinementOptions,
} from "./solver/ortools/sequence-refinement";

export interface PostSolveDiagnostics {
  routePolishingDiagnostics: RoutePolishingDiagnostics | null;
  territoryRepairDiagnostics: TerritoryRepairDiagnostics | null;
  sequenceRefinementDiagnostics: SequenceRefinementDiagnostics | null;
  shapeMetricsBefore: SolutionShapeMetrics;
  shapeMetricsAfter: SolutionShapeMetrics;
}

export interface PostSolvePipelineOptions {
  solverId?: string;
  sequenceRefinement?: boolean;
  sequenceRefinementOptions?: SequenceRefinementOptions;
}

/**
 * Post-solve phases, each one accepted only when the whole plan improves
 * lexicographically (coverage first). Order matters: reassigning a task changes which
 * sequences are reachable, so territory repair runs before sequence refinement.
 */
export async function runPostSolvePipeline(args: {
  input: RoutingProblemInput;
  solution: RoutingSolution;
  options?: PostSolvePipelineOptions;
}): Promise<{ solution: RoutingSolution; diagnostics: PostSolveDiagnostics }> {
  const { input } = args;
  const shapeMetricsBefore = computeSolutionShapeMetrics(input, args.solution);

  const polished = polishRoutingSolutionWithDiagnostics(input, args.solution);
  const repaired = repairTerritoryAssignments(input, polished.solution);

  const useRefinement =
    (args.options?.solverId ?? ORTOOLS_SOLVER_ID) === ORTOOLS_SOLVER_ID &&
    isSequenceRefinementEnabled(args.options?.sequenceRefinement);

  const refined = useRefinement
    ? await refineSolutionSequence({
        input,
        solution: repaired.solution,
        options: args.options?.sequenceRefinementOptions,
      })
    : null;

  // Refinement is accepted on coverage, so it can hand back a plan that serves more
  // tasks while having drifted on territory and distance. Cleaning up afterwards keeps
  // the extra tasks without paying for the drift.
  let solution = refined?.solution ?? repaired.solution;
  let finalRepair = repaired;
  if (refined) {
    const cleanup = repairTerritoryAssignments(input, solution);
    const repolished = polishRoutingSolutionWithDiagnostics(input, cleanup.solution);
    if (
      compareSolutionShape(
        computeSolutionShapeMetrics(input, repolished.solution),
        computeSolutionShapeMetrics(input, solution)
      ) < 0
    ) {
      solution = repolished.solution;
      finalRepair = cleanup;
    }
  }

  return {
    solution,
    diagnostics: {
      routePolishingDiagnostics: polished.diagnostics,
      territoryRepairDiagnostics: finalRepair.diagnostics,
      sequenceRefinementDiagnostics: refined?.diagnostics ?? null,
      shapeMetricsBefore,
      shapeMetricsAfter: computeSolutionShapeMetrics(input, solution),
    },
  };
}
