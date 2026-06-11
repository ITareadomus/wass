import fs from "fs/promises";
import path from "path";
import type { BusinessGroupType } from "./groups/group-contract";
import type { RoutingProblemInput, SoftConstraintSpec } from "./input-contract";
import type { OrToolsRoutingPayload } from "./solver/ortools/ortools-adapter";
import type { RoutingSolution } from "./solution-contract";
import type { RoutingSolutionValidationResult } from "./solution-validation-contract";
import type { RoutingProblemValidationResult } from "./validation-contract";

export function isLogisticsOptimizerFinalDebugEnabled(explicit?: boolean): boolean {
  if (explicit === true) return true;
  if (explicit === false) return false;
  const raw = String(process.env.LOGISTICS_OPTIMIZER_FINAL_DEBUG ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return process.env.NODE_ENV !== "production";
}

function debugRootDir(): string {
  return path.join(process.cwd(), "server", "debug", "logistics-optimizer-final");
}

export function createLogisticsOptimizerFinalRunId(startedAt = new Date()): string {
  return startedAt.toISOString().replace(/[:.]/g, "-");
}

function countBusinessGroupsByType(
  groups: RoutingProblemInput["businessGroups"]
): Record<BusinessGroupType, number> {
  const counts: Record<BusinessGroupType, number> = {
    SAME_COORDINATES_BUILDING: 0,
    SAME_CLEANER: 0,
    CLEANER_SEQUENCE: 0,
    PRIORITY_COMPATIBLE: 0,
    NEARBY_CLUSTER: 0,
  };

  for (const group of groups) {
    counts[group.type] += 1;
  }

  return counts;
}

function extractBusinessSoftConstraints(
  softConstraints: SoftConstraintSpec[]
): SoftConstraintSpec[] {
  return softConstraints.filter((constraint) =>
    constraint.type.startsWith("KEEP_")
  );
}

export async function writeRoutingProblemInputDebug(
  input: RoutingProblemInput,
  options?: { runId?: string; startedAt?: string }
): Promise<string> {
  const startedAt = options?.startedAt ?? new Date().toISOString();
  const runId = options?.runId ?? createLogisticsOptimizerFinalRunId(new Date(startedAt));
  const dir = path.join(debugRootDir(), input.workDate, runId);
  await fs.mkdir(dir, { recursive: true });

  const manifest = {
    workDate: input.workDate,
    runId,
    startedAt,
    milestone: "routing-input-only",
    validation: {
      valid: input.metadata.validation.valid,
      errorCount: input.metadata.validation.errors.length,
      warningCount: input.metadata.validation.warnings.length,
    },
    counts: {
      drivers: input.drivers.length,
      tasks: input.tasks.length,
      hardConstraints: input.hardConstraints.length,
      softConstraints: input.softConstraints.length,
      businessGroups: input.businessGroups.length,
      businessSoftConstraints: extractBusinessSoftConstraints(input.softConstraints).length,
      timelineAssignmentHints: input.metadata.timelineAssignmentHintsCount,
      preAssignedRequiredCount: input.metadata.preAssignedRequiredCount,
      requiredDriverTaskConstraints: input.hardConstraints.filter(
        (constraint) => constraint.type === "REQUIRED_DRIVER_TASK"
      ).length,
      excludedTasks: input.metadata.excludedTasks.length,
    },
    businessGroupsByType: countBusinessGroupsByType(input.businessGroups),
    businessSoftConstraints: extractBusinessSoftConstraints(input.softConstraints),
    files: ["01-routing-input.json"],
  };

  await Promise.all([
    fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8"),
    fs.writeFile(
      path.join(dir, "01-routing-input.json"),
      JSON.stringify(input, null, 2),
      "utf8"
    ),
  ]);

  return dir;
}

export interface WriteRoutingDryRunDebugArgs {
  input: RoutingProblemInput;
  solution: RoutingSolution;
  inputValidation: RoutingProblemValidationResult;
  solutionValidation: RoutingSolutionValidationResult;
  ortoolsPayload?: OrToolsRoutingPayload;
  runId?: string;
  startedAt?: string;
}

export async function writeRoutingDryRunDebug(
  args: WriteRoutingDryRunDebugArgs
): Promise<string> {
  const { input, solution, inputValidation, solutionValidation, ortoolsPayload } = args;
  const startedAt = args.startedAt ?? new Date().toISOString();
  const runId = args.runId ?? createLogisticsOptimizerFinalRunId(new Date(startedAt));
  const dir = path.join(debugRootDir(), input.workDate, runId);
  await fs.mkdir(dir, { recursive: true });

  const assignedTasks = solution.routes.reduce((sum, route) => sum + route.stops.length, 0);

  const manifest = {
    workDate: input.workDate,
    runId,
    startedAt,
    milestone: "routing-dry-run",
    solverId: solution.solverId,
    inputValidation: {
      valid: inputValidation.valid,
      errorCount: inputValidation.errors.length,
      warningCount: inputValidation.warnings.length,
    },
    solutionValidation: {
      valid: solutionValidation.valid,
      errorCount: solutionValidation.errors.length,
      warningCount: solutionValidation.warnings.length,
    },
    counts: {
      drivers: input.drivers.length,
      tasks: input.tasks.length,
      routes: solution.routes.length,
      assignedTasks,
      droppedTasks: solution.droppedTasks.length,
      hardConstraints: input.hardConstraints.length,
      softConstraints: input.softConstraints.length,
      businessGroups: input.businessGroups.length,
      businessSoftConstraints: extractBusinessSoftConstraints(input.softConstraints).length,
      timelineAssignmentHints: input.metadata.timelineAssignmentHintsCount,
      preAssignedRequiredCount: input.metadata.preAssignedRequiredCount,
      requiredDriverTaskConstraints: input.hardConstraints.filter(
        (constraint) => constraint.type === "REQUIRED_DRIVER_TASK"
      ).length,
      excludedTasks: input.metadata.excludedTasks.length,
    },
    solutionStatus: solution.status,
    businessGroupsByType: countBusinessGroupsByType(input.businessGroups),
    businessSoftConstraints: extractBusinessSoftConstraints(input.softConstraints),
    files: ortoolsPayload
      ? ["01-routing-input.json", "02-routing-solution.json", "03-ortools-payload.json"]
      : ["01-routing-input.json", "02-routing-solution.json"],
  };

  const writes: Promise<void>[] = [
    fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8"),
    fs.writeFile(
      path.join(dir, "01-routing-input.json"),
      JSON.stringify(input, null, 2),
      "utf8"
    ),
    fs.writeFile(
      path.join(dir, "02-routing-solution.json"),
      JSON.stringify(solution, null, 2),
      "utf8"
    ),
  ];

  if (ortoolsPayload) {
    writes.push(
      fs.writeFile(
        path.join(dir, "03-ortools-payload.json"),
        JSON.stringify(ortoolsPayload, null, 2),
        "utf8"
      )
    );
  }

  await Promise.all(writes);

  return dir;
}
