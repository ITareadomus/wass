import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { DriverInput, Phase1Result, Phase2Result, Phase3Result, PreparedTask } from './types';

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultPython(): string {
  if (process.env.PYTHON) return process.env.PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function runPythonScript(
  scriptPath: string,
  stdinJson: string,
  options: { timeoutMs: number; pythonPath: string }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(options.pythonPath, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Logistics OR-Tools timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try {
          const data = JSON.parse(stdout) as { status?: string; message?: string };
          if (data.status === 'infeasible') {
            resolve(stdout);
            return;
          }
          if (data.status === 'error' && data.message) {
            reject(new Error(data.message));
            return;
          }
        } catch {
          /* ignore */
        }
        reject(
          new Error(
            `Logistics OR-Tools exit ${code}${stderr ? `: ${stderr.slice(0, 600)}` : ''}`
          )
        );
        return;
      }
      resolve(stdout);
    });
    proc.stdin?.write(stdinJson, 'utf8', () => proc.stdin?.end());
  });
}

function buildPayload(
  tasks: PreparedTask[],
  drivers: DriverInput[],
  timeMatrix: number[][],
  phase2: Phase2Result
): string {
  const serviceTimes = [0, ...tasks.map((t) => Math.max(1, Math.round(t.serviceMinutes)))];
  const timeWindows: [number, number][] = [[0, 24 * 60 - 1]];
  for (const t of tasks) {
    const start = t.hkStartMin;
    let end = t.hkEndMin - Math.max(1, Math.round(t.serviceMinutes));
    if (end < start) end = start;
    timeWindows.push([start, end]);
  }
  const seedAssignment: Record<string, number> = {};
  for (const t of tasks) {
    const did = phase2.seedAssignment.get(t.taskId);
    if (did != null) seedAssignment[String(t.taskId)] = did;
  }
  return JSON.stringify({
    taskIds: tasks.map((t) => t.taskId),
    driverIds: drivers.map((d) => d.driverId),
    timeMatrix,
    serviceTimes,
    timeWindows,
    numVehicles: drivers.length,
    vehicleCapacity: phase2.targetMaxPerDriver + 1,
    targetMinPerDriver: phase2.targetMinPerDriver,
    targetMaxPerDriver: phase2.targetMaxPerDriver + 1,
    balancePenalty: 1000,
    seedAssignment,
    timeLimitSeconds: 45.0
  });
}

/**
 * OR-Tools routing (Python). Task order in matrix: same as sorted taskId.
 */
export async function runLgPhase3(
  phase1: Phase1Result,
  phase2: Phase2Result,
  options: { timeoutMs?: number; pythonPath?: string; scriptPath?: string } = {}
): Promise<Phase3Result> {
  const { tasks, drivers, travelMatrixMin } = phase1;
  if (tasks.length === 0 || drivers.length === 0) {
    return { ok: true, routesByDriverId: new Map() };
  }
  if (!travelMatrixMin.length || travelMatrixMin.length !== tasks.length + 1) {
    return {
      ok: false,
      reason: 'ORTOOLS_ERROR',
      message: 'travelMatrix missing or wrong size'
    };
  }

  const sorted = [...tasks].sort((a, b) => a.taskId - b.taskId);
  const payload = buildPayload(sorted, drivers, travelMatrixMin, phase2);
  const scriptPath = options.scriptPath ?? join(__dirname, 'lg_phase3_ortools.py');
  const pythonPath = options.pythonPath ?? defaultPython();
  const timeoutMs = options.timeoutMs ?? 120000;

  let stdout: string;
  try {
    stdout = await runPythonScript(scriptPath, payload, { timeoutMs, pythonPath });
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('ortools not installed')) {
      return { ok: false, reason: 'PYTHON_MISSING', message: msg };
    }
    return { ok: false, reason: 'ORTOOLS_ERROR', message: msg };
  }

  let data: {
    status?: string;
    message?: string;
    routes?: { vehicleIndex: number; taskIds: number[] }[];
    arrivalsMinByTaskId?: Record<string, number>;
  };
  try {
    data = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: 'ORTOOLS_ERROR', message: 'Invalid JSON from logistics OR-Tools' };
  }

  if (data.status === 'infeasible') {
    return {
      ok: false,
      reason: 'INFEASIBLE',
      message: data.message || 'Solver infeasible'
    };
  }
  if (data.status === 'error') {
    if (String(data.message || '').includes('ortools not installed')) {
      return { ok: false, reason: 'PYTHON_MISSING', message: data.message || 'ortools missing' };
    }
    return { ok: false, reason: 'ORTOOLS_ERROR', message: data.message || 'error' };
  }
  if (data.status !== 'ok' || !Array.isArray(data.routes)) {
    return { ok: false, reason: 'ORTOOLS_ERROR', message: 'Unexpected solver output' };
  }

  const routesByDriverId = new Map<number, number[]>();
  for (let v = 0; v < drivers.length; v++) {
    const dr = data.routes.find((r) => r.vehicleIndex === v);
    const ids = dr?.taskIds ?? [];
    routesByDriverId.set(drivers[v].driverId, ids);
  }

  const arrivalMinByTaskId = new Map<number, number>();
  if (data.arrivalsMinByTaskId) {
    for (const [k, val] of Object.entries(data.arrivalsMinByTaskId)) {
      arrivalMinByTaskId.set(Number(k), val);
    }
  }

  return { ok: true, routesByDriverId, arrivalMinByTaskId };
}
