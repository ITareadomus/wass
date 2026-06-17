import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ORTOOLS_UNAVAILABLE_CODE = "ORTOOLS_UNAVAILABLE" as const;

export interface OrToolsAvailabilityResult {
  available: boolean;
  reason?: string;
  pythonPath?: string;
  scriptPath?: string;
}

export class OrToolsUnavailableError extends Error {
  readonly code = ORTOOLS_UNAVAILABLE_CODE;

  constructor(message: string, readonly reason?: string) {
    super(message);
    this.name = "OrToolsUnavailableError";
  }
}

export function defaultOrToolsScriptPath(): string {
  const localPath = join(__dirname, "logistics_routing_ortools.py");
  if (existsSync(localPath)) return localPath;
  return join(process.cwd(), "dist", "logistics_routing_ortools.py");
}

export function defaultPythonPath(): string {
  return process.platform === "win32" ? "python" : "python3";
}

function runPythonImportCheck(pythonPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(pythonPath, ["-c", "import ortools"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, timeoutMs);

    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && stderr) {
        resolve(false);
        return;
      }
      resolve(code === 0);
    });
  });
}

export interface ProbeOrToolsAvailabilityOptions {
  pythonPath?: string;
  scriptPath?: string;
  timeoutMs?: number;
}

export async function probeOrToolsAvailability(
  options: ProbeOrToolsAvailabilityOptions = {}
): Promise<OrToolsAvailabilityResult> {
  const pythonPath = options.pythonPath ?? defaultPythonPath();
  const scriptPath = options.scriptPath ?? defaultOrToolsScriptPath();
  const timeoutMs = options.timeoutMs ?? 8000;

  if (!existsSync(scriptPath)) {
    return {
      available: false,
      reason: `OR-Tools routing script not found: ${scriptPath}`,
      pythonPath,
      scriptPath,
    };
  }

  const importOk = await runPythonImportCheck(pythonPath, timeoutMs);
  if (!importOk) {
    return {
      available: false,
      reason: `Python OR-Tools import failed (python=${pythonPath}). Install with: pip install ortools`,
      pythonPath,
      scriptPath,
    };
  }

  return { available: true, pythonPath, scriptPath };
}

export async function assertOrToolsAvailable(
  options: ProbeOrToolsAvailabilityOptions = {}
): Promise<OrToolsAvailabilityResult> {
  const probe = await probeOrToolsAvailability(options);
  if (!probe.available) {
    throw new OrToolsUnavailableError(
      probe.reason ??
        "OR-Tools solver is required for production routing. Pass solver=greedy-v1 only for debug.",
      probe.reason
    );
  }
  return probe;
}
