import fs from "fs/promises";
import path from "path";
import type { BusinessGroupType } from "./groups/group-contract";
import type { RoutingProblemInput, SoftConstraintSpec } from "./input-contract";

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
      existingLockedAssignments: input.metadata.existingLockedAssignmentsCount,
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
