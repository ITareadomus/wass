import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { RoutingProblemInput } from "../../input-contract";
import type { RoutingSolution } from "../../solution-contract";
import type { SolveRoutingOptions } from "../routing-solver-contract";
import {
  buildOrToolsPayload,
  decodeOrToolsSolution,
  type OrToolsRawSolution,
} from "./ortools-adapter";
import {
  buildRequiredDriverNotSelectedSolution,
  buildRequiredInfeasibleSolution,
  findTasksWithMissingRequiredVehicle,
} from "./required-infeasible";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RunOrToolsRoutingOptions extends SolveRoutingOptions {
  ortools?: SolveRoutingOptions["ortools"] & {
    timeLimitSec?: number;
  };
}

function runPythonScript(
  scriptPath: string,
  stdinJson: string,
  options: { timeoutMs: number; pythonPath: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(options.pythonPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`OR-Tools routing timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`OR-Tools routing spawn error: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try {
          const data = JSON.parse(stdout) as OrToolsRawSolution;
          if (data.status === "infeasible") {
            resolve(stdout);
            return;
          }
          if (data.status === "error" && data.message) {
            reject(new Error(`OR-Tools routing error: ${data.message}`));
            return;
          }
        } catch {
          // fall through
        }
        reject(
          new Error(
            `OR-Tools routing exit ${code}${stderr ? `: ${stderr.slice(0, 500)}` : ""}`
          )
        );
        return;
      }
      resolve(stdout);
    });

    proc.stdin?.write(stdinJson, "utf8", () => {
      proc.stdin?.end();
    });
  });
}

function parseRawSolution(stdout: string): OrToolsRawSolution {
  try {
    return JSON.parse(stdout) as OrToolsRawSolution;
  } catch {
    throw new Error("OR-Tools routing invalid JSON output");
  }
}

function defaultScriptPath(): string {
  const localPath = join(__dirname, "logistics_routing_ortools.py");
  if (existsSync(localPath)) return localPath;
  return join(process.cwd(), "dist", "logistics_routing_ortools.py");
}

export async function solveOrToolsRouting(
  input: RoutingProblemInput,
  options: RunOrToolsRoutingOptions = {}
): Promise<RoutingSolution> {
  const startedAt = Date.now();
  const timeLimitSec = options.ortools?.timeLimitSec ?? 30;
  const timeoutMs = options.ortools?.timeoutMs ?? (timeLimitSec + 10) * 1000;
  const pythonPath =
    options.ortools?.pythonPath ?? (process.platform === "win32" ? "python" : "python3");
  const scriptPath = options.ortools?.scriptPath ?? defaultScriptPath();

  const missingRequiredVehicles = findTasksWithMissingRequiredVehicle(input);
  if (missingRequiredVehicles.length > 0) {
    return buildRequiredDriverNotSelectedSolution(input, missingRequiredVehicles, {
      generatedAt: options.generatedAt,
      solveDurationMs: 0,
    });
  }

  const { payload, maps } = buildOrToolsPayload(input, { timeLimitSec });
  const stdinJson = JSON.stringify(payload);
  const stdout = await runPythonScript(scriptPath, stdinJson, { timeoutMs, pythonPath });
  const raw = parseRawSolution(stdout);

  if (raw.status === "error") {
    throw new Error(raw.message ?? "OR-Tools routing solver error");
  }

  if (raw.status === "infeasible") {
    return buildRequiredInfeasibleSolution(input, {
      generatedAt: options.generatedAt,
      solveDurationMs: options.solveDurationMs ?? raw.solveDurationMs ?? Date.now() - startedAt,
      note: raw.message ?? "ortools_infeasible_fallback",
    });
  }

  return decodeOrToolsSolution({
    input,
    payload,
    raw,
    maps,
    generatedAt: options.generatedAt,
  });
}
