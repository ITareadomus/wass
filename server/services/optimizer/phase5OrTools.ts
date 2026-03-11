/**
 * Phase 5 OR-Tools neighborhood batch: spawns Python CP-SAT script with candidate relocations and swaps,
 * parses which move indices to apply. Used as optional neighborhood optimization on small subsets.
 * On timeout/error/infeasible returns empty lists (fallback to single best move).
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Phase5CandidateRelocation {
  taskId: number;
  fromCleanerId: number;
  toCleanerId: number;
  toPosition: number;
  improvement: number;
}

export interface Phase5CandidateSwap {
  taskAId: number;
  taskBId: number;
  cleanerAId: number;
  cleanerBId: number;
  improvement: number;
}

export interface Phase5NeighborhoodCleaner {
  cleanerId: number;
  currentTaskCount: number;
  maxTasks: number;
}

export interface Phase5NeighborhoodBatchResult {
  applyRelocationIndices: number[];
  applySwapIndices: number[];
}

export interface RunPhase5NeighborhoodBatchOptions {
  timeoutMs?: number;
  pythonPath?: string;
  scriptPath?: string;
}

function buildPayload(
  relocations: Phase5CandidateRelocation[],
  swaps: Phase5CandidateSwap[],
  cleaners: Phase5NeighborhoodCleaner[]
): string {
  const payload = {
    relocations: relocations.map((r) => ({
      taskId: r.taskId,
      fromCleanerId: r.fromCleanerId,
      toCleanerId: r.toCleanerId,
      toPosition: r.toPosition,
      improvement: r.improvement
    })),
    swaps: swaps.map((s) => ({
      taskAId: s.taskAId,
      taskBId: s.taskBId,
      cleanerAId: s.cleanerAId,
      cleanerBId: s.cleanerBId,
      improvement: s.improvement
    })),
    cleaners: cleaners.map((c) => ({
      cleanerId: c.cleanerId,
      currentTaskCount: c.currentTaskCount,
      maxTasks: c.maxTasks
    }))
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
      reject(new Error(`Phase 5 OR-Tools timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Phase 5 OR-Tools spawn error: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Phase 5 OR-Tools exit ${code}${signal ? ` (${signal})` : ''}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`
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

function parseOutput(stdout: string): Phase5NeighborhoodBatchResult {
  const empty: Phase5NeighborhoodBatchResult = { applyRelocationIndices: [], applySwapIndices: [] };
  let data: { status: string; applyRelocationIndices?: number[]; applySwapIndices?: number[] };
  try {
    data = JSON.parse(stdout);
  } catch {
    return empty;
  }
  if (data.status !== 'ok') {
    return empty;
  }
  return {
    applyRelocationIndices: Array.isArray(data.applyRelocationIndices) ? data.applyRelocationIndices : [],
    applySwapIndices: Array.isArray(data.applySwapIndices) ? data.applySwapIndices : []
  };
}

/**
 * Run Phase 5 neighborhood batch via Python CP-SAT. Returns indices of relocations and swaps to apply.
 * On timeout, spawn error, or infeasible, returns empty lists (fallback to single best move).
 */
export async function runPhase5NeighborhoodBatch(
  relocations: Phase5CandidateRelocation[],
  swaps: Phase5CandidateSwap[],
  cleaners: Phase5NeighborhoodCleaner[],
  options: RunPhase5NeighborhoodBatchOptions = {}
): Promise<Phase5NeighborhoodBatchResult> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const pythonPath = options.pythonPath ?? 'python3';
  const scriptPath = options.scriptPath ?? join(__dirname, 'phase5_ortools.py');

  if (relocations.length === 0 && swaps.length === 0) {
    return { applyRelocationIndices: [], applySwapIndices: [] };
  }

  try {
    const stdinJson = buildPayload(relocations, swaps, cleaners);
    const stdout = await runPythonScript(scriptPath, stdinJson, { timeoutMs, pythonPath });
    return parseOutput(stdout);
  } catch (err) {
    console.warn('[Phase5] OR-Tools neighborhood batch failed (fallback to single move):', (err as Error)?.message);
    return { applyRelocationIndices: [], applySwapIndices: [] };
  }
}
