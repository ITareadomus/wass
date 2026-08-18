import type { RoutingSolution } from "./solution-contract";
import { formatSolutionApplyGateForUser } from "./user-facing-errors";

export type SolutionApplyGateReason =
  | "OK"
  | "INVALID_SOLUTION"
  | "INFEASIBLE_SOLUTION"
  | "PARTIAL_REQUIRES_ALLOW_PARTIAL";

export interface SolutionApplyGateResult {
  canApply: boolean;
  reason: SolutionApplyGateReason;
  droppedTaskCount: number;
}

export class SolutionCannotBeAppliedError extends Error {
  readonly gate: SolutionApplyGateResult;

  constructor(gate: SolutionApplyGateResult) {
    super(formatSolutionApplyGateForUser(gate));
    this.name = "SolutionCannotBeAppliedError";
    this.gate = gate;
  }
}

export function evaluateSolutionApplyGate(
  solution: RoutingSolution,
  options: { allowPartial?: boolean } = {}
): SolutionApplyGateResult {
  const droppedTaskCount = solution.droppedTasks.length;
  const allowPartial = options.allowPartial === true;

  if (solution.status === "INVALID") {
    return { canApply: false, reason: "INVALID_SOLUTION", droppedTaskCount };
  }

  if (solution.status === "INFEASIBLE") {
    return { canApply: false, reason: "INFEASIBLE_SOLUTION", droppedTaskCount };
  }

  if (solution.status === "PARTIAL" && !allowPartial) {
    return {
      canApply: false,
      reason: "PARTIAL_REQUIRES_ALLOW_PARTIAL",
      droppedTaskCount,
    };
  }

  if (solution.status === "FEASIBLE" || solution.status === "PARTIAL") {
    return { canApply: true, reason: "OK", droppedTaskCount };
  }

  return { canApply: false, reason: "INVALID_SOLUTION", droppedTaskCount };
}

export function assertSolutionCanBeApplied(
  solution: RoutingSolution,
  options: { allowPartial?: boolean } = {}
): void {
  const gate = evaluateSolutionApplyGate(solution, options);
  if (!gate.canApply) {
    throw new SolutionCannotBeAppliedError(gate);
  }
}
