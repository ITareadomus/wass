import fs from "fs/promises";
import path from "path";
import type { RoutingProblemInput } from "./input-contract";

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
