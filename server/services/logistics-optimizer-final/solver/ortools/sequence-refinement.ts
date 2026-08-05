import type { RoutingProblemInput } from "../../input-contract";
import type { RoutingSolution } from "../../solution-contract";
import { buildVehicleArcPenalties } from "../../groups/route-sequence-penalties";
import { polishRoutingSolutionWithDiagnostics } from "../../route-polishing";
import {
  compareSolutionShape,
  computeSolutionShapeMetrics,
  degradesRobustness,
  type SolutionShapeMetrics,
} from "../../solution-shape-metrics";
import { buildSequenceRefinementPayload, decodeOrToolsSolution } from "./ortools-adapter";
import { runOrToolsPayload } from "./ortools-routing-solver";

export const DEFAULT_SEQUENCE_REFINEMENT_TIME_LIMIT_SEC = 10;

export type SequenceRefinementOutcome =
  | "accepted"
  | "rejected_not_better"
  | "rejected_lost_tasks"
  | "rejected_fragile"
  | "skipped_no_arc_penalties"
  | "skipped_no_routes"
  | "solver_infeasible"
  | "solver_error";

export interface SequenceRefinementDiagnostics {
  outcome: SequenceRefinementOutcome;
  timeLimitSec: number;
  initialAssignmentUsed: boolean | null;
  solveDurationMs: number | null;
  message?: string;
  before: SolutionShapeMetrics | null;
  after: SolutionShapeMetrics | null;
}

export interface SequenceRefinementOptions {
  timeLimitSec?: number;
  pythonPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

export function isSequenceRefinementEnabled(explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  const raw = String(process.env.LOGISTICS_SEQUENCE_REFINEMENT ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return true;
}

/**
 * Re-solves the plan with driver assignment frozen and route-sequence arc penalties
 * enabled, then keeps the result only if it wins the lexicographic comparison. Coverage
 * can never regress: the incumbent is returned unchanged whenever anything goes wrong.
 */
export async function refineSolutionSequence(args: {
  input: RoutingProblemInput;
  solution: RoutingSolution;
  options?: SequenceRefinementOptions;
}): Promise<{ solution: RoutingSolution; diagnostics: SequenceRefinementDiagnostics }> {
  const { input, solution } = args;
  const timeLimitSec =
    args.options?.timeLimitSec ?? DEFAULT_SEQUENCE_REFINEMENT_TIME_LIMIT_SEC;
  const before = computeSolutionShapeMetrics(input, solution);

  const baseDiagnostics: SequenceRefinementDiagnostics = {
    outcome: "skipped_no_routes",
    timeLimitSec,
    initialAssignmentUsed: null,
    solveDurationMs: null,
    before,
    after: null,
  };

  if (solution.routes.length === 0) {
    return { solution, diagnostics: baseDiagnostics };
  }

  const arcPenaltyBuild = buildVehicleArcPenalties({ input });
  if (!arcPenaltyBuild) {
    return {
      solution,
      diagnostics: { ...baseDiagnostics, outcome: "skipped_no_arc_penalties" },
    };
  }

  const built = buildSequenceRefinementPayload({
    input,
    routes: solution.routes.map((route) => ({
      driverId: route.driverId,
      orderedTaskIds: route.stops.map((stop) => stop.taskId),
    })),
    vehicleArcPenalties: arcPenaltyBuild.penalties,
    timeLimitSec,
  });

  if (!built) {
    return { solution, diagnostics: baseDiagnostics };
  }

  let raw;
  try {
    raw = await runOrToolsPayload(built.payload, {
      pythonPath: args.options?.pythonPath,
      scriptPath: args.options?.scriptPath,
      timeoutMs: args.options?.timeoutMs,
    });
  } catch (error) {
    return {
      solution,
      diagnostics: {
        ...baseDiagnostics,
        outcome: "solver_error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  if (raw.status !== "ok") {
    return {
      solution,
      diagnostics: {
        ...baseDiagnostics,
        outcome: raw.status === "infeasible" ? "solver_infeasible" : "solver_error",
        message: raw.message,
        solveDurationMs: raw.solveDurationMs ?? null,
      },
    };
  }

  const decoded = decodeOrToolsSolution({
    input,
    payload: built.payload,
    raw,
    maps: built.maps,
    generatedAt: solution.generatedAt,
  });
  const refined = polishRoutingSolutionWithDiagnostics(input, decoded).solution;
  const after = computeSolutionShapeMetrics(input, refined);

  const diagnostics: SequenceRefinementDiagnostics = {
    ...baseDiagnostics,
    outcome: "rejected_not_better",
    initialAssignmentUsed: raw.initialAssignmentUsed ?? null,
    solveDurationMs: raw.solveDurationMs ?? null,
    after,
  };

  const assignedBefore = solution.routes.reduce((sum, route) => sum + route.stops.length, 0);
  const assignedAfter = refined.routes.reduce((sum, route) => sum + route.stops.length, 0);
  if (assignedAfter < assignedBefore) {
    return { solution, diagnostics: { ...diagnostics, outcome: "rejected_lost_tasks" } };
  }

  if (degradesRobustness(before, after)) {
    return { solution, diagnostics: { ...diagnostics, outcome: "rejected_fragile" } };
  }

  if (compareSolutionShape(after, before) >= 0) {
    return { solution, diagnostics };
  }

  return {
    solution: {
      ...refined,
      diagnostics: {
        warnings: refined.diagnostics?.warnings ?? [],
        notes: [
          ...(refined.diagnostics?.notes ?? []),
          `sequence-refinement accepted travel=${before.totalTravelMin}->${after.totalTravelMin} revisits=${before.subZoneRevisitCount}->${after.subZoneRevisitCount} crossTerritory=${before.crossTerritoryTransitionCount}->${after.crossTerritoryTransitionCount}`,
        ],
        solveDurationMs: solution.diagnostics?.solveDurationMs,
      },
    },
    diagnostics: { ...diagnostics, outcome: "accepted" },
  };
}
