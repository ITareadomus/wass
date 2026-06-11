import type { RoutingProblemInput } from "../input-contract";
import type { RoutingSolution } from "../solution-contract";

export type RoutingSolverId = "greedy-v1" | "ortools-v1";

export interface SolveRoutingOptions {
  solverId?: RoutingSolverId;
  generatedAt?: string;
  solveDurationMs?: number;
  ortools?: {
    timeoutMs?: number;
    pythonPath?: string;
    scriptPath?: string;
    timeLimitSec?: number;
  };
}

export interface RoutingSolver {
  readonly solverId: RoutingSolverId;
  solve(input: RoutingProblemInput, options?: SolveRoutingOptions): Promise<RoutingSolution>;
}
