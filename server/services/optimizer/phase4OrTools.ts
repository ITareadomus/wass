/**
 * Phase 4 OR-Tools repair batch: spawns Python CP-SAT script with pre-built allowed (task, cleaner) pairs,
 * parses assignments. Used as local repair solver at each relax level; feasibility is computed in Node.
 * On timeout/error/infeasible returns empty assignments (fallback to greedy).
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Phase4RepairAllowedPair {
  taskId: number;
  cleanerId: number;
  deltaTravel: number;
}

export interface Phase4RepairTask {
  taskId: number;
  cleaningTimeMinutes: number;
}

export interface Phase4RepairCleaner {
  cleanerId: number;
  currentLoadMin: number;
  currentTaskCount: number;
  maxLoad: number;
  maxTasks: number;
}

export interface Phase4RepairBatchResult {
  assignments: { taskId: number; cleanerId: number }[];
  unassigned: number[];
}

export interface RunPhase4RepairBatchOptions {
  timeoutMs?: number;
  pythonPath?: string;
  scriptPath?: string;
}

function buildPayload(
  allowed: Phase4RepairAllowedPair[],
  tasks: Phase4RepairTask[],
  cleaners: Phase4RepairCleaner[],
  wT: number
): string {
  const taskIds = tasks.map((t) => t.taskId);
  const cleanerIds = cleaners.map((c) => c.cleanerId);
  const payload = {
    taskIds,
    tasks: tasks.map((t) => ({ taskId: t.taskId, cleaningTimeMinutes: t.cleaningTimeMinutes })),
    cleanerIds,
    cleaners: cleaners.map((c) => ({
      cleanerId: c.cleanerId,
      currentLoadMin: c.currentLoadMin,
      currentTaskCount: c.currentTaskCount,
      maxLoad: c.maxLoad,
      maxTasks: c.maxTasks
    })),
    allowed: allowed.map((a) => ({ taskId: a.taskId, cleanerId: a.cleanerId, deltaTravel: a.deltaTravel })),
    wT
  };
  return JSON.stringify(payload);
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
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Phase 4 OR-Tools timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Phase 4 OR-Tools spawn error: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Phase 4 OR-Tools exit ${code}${signal ? ` (${signal})` : ''}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
          )
        );
        return;
      }
      resolve(stdout);
    });

    proc.stdin?.write(stdinJson, 'utf8', () => {
      proc.stdin?.end();
    });
  });
}

function parseOutput(stdout: string, taskIds: number[]): Phase4RepairBatchResult {
  let data: { status: string; assignments?: { taskId: number; cleanerId: number }[] };
  try {
    data = JSON.parse(stdout);
  } catch {
    return { assignments: [], unassigned: [...taskIds] };
  }
  if (data.status !== 'ok' || !Array.isArray(data.assignments)) {
    return { assignments: [], unassigned: [...taskIds] };
  }
  const assignedSet = new Set(data.assignments.map((a) => a.taskId));
  const unassigned = taskIds.filter((id) => !assignedSet.has(id));
  return { assignments: data.assignments, unassigned };
}

/**
 * Run Phase 4 repair batch via Python CP-SAT. Returns assignments and list of task IDs that were not assigned.
 * On timeout, spawn error, or infeasible, returns empty assignments and all taskIds as unassigned (greedy fallback).
 */
export async function runPhase4RepairBatch(
  allowed: Phase4RepairAllowedPair[],
  tasks: Phase4RepairTask[],
  cleaners: Phase4RepairCleaner[],
  wT: number,
  options: RunPhase4RepairBatchOptions = {}
): Promise<Phase4RepairBatchResult> {
  const timeoutMs = options.timeoutMs ?? 60000;
  const pythonPath = options.pythonPath ?? 'python3';
  const scriptPath = options.scriptPath ?? join(__dirname, 'phase4_ortools.py');

  const taskIds = tasks.map((t) => t.taskId);
  if (taskIds.length === 0 || cleaners.length === 0 || allowed.length === 0) {
    return { assignments: [], unassigned: taskIds };
  }

  try {
    const stdinJson = buildPayload(allowed, tasks, cleaners, wT);
    const stdout = await runPythonScript(scriptPath, stdinJson, { timeoutMs, pythonPath });
    return parseOutput(stdout, taskIds);
  } catch (err) {
    console.warn('[Phase4] OR-Tools repair batch failed (fallback to greedy):', (err as Error)?.message);
    return { assignments: [], unassigned: taskIds };
  }
}
