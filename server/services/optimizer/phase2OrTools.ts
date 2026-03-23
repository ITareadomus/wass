/**
 * Phase 2 OR-Tools bridge: serializes input to JSON, spawns Python CP-SAT script,
 * parses output into Phase2Result. No fallback to legacy; on timeout/error/infeasible throws.
 *
 * Business rules mapped to solver (see plan):
 * - Task-cleaner compatibility → (g,c) allowed only if compatible
 * - Load cap → sum(workMin + wT*travelMin) + initialLoad_c <= maxTarget
 * - Max tasks per cleaner → dynamicMaxTasks+1 or 4
 * - Straordinaria: reserve, existing OT, long OT empty cleaner, short OT + 1 extra <=2h
 * - Anchored group → only that cleaner (or unassigned)
 * - Each group at most one cleaner → sum_c x[g,c] <= 1
 */

import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  GroupCandidate,
  TaskForPhase2,
  CleanerInput,
  Phase2Params,
  Phase2Result,
  Phase2Event,
  AssignmentResult,
  calculateMinutesBasedTargets,
  ApartmentTypes,
  DEFAULT_APARTMENT_TYPES,
  FormatoreRules
} from './phase2';
import { estimateTravelMinutes } from './phase1';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STRAORDINARIA_LONG_THRESHOLD_MIN = 360;
const STRAORDINARIA_EXTRA_TASK_MAX_MIN = 120;

export interface RunPhase2WithOrToolsOptions {
  timeoutMs?: number;
  pythonPath?: string;
  scriptPath?: string;
}

function mapToObject<K extends string | number, V>(m: Map<K, V> | undefined): Record<string, V> {
  if (!m || m.size === 0) return {};
  const o: Record<string, V> = {};
  m.forEach((v, k) => { o[String(k)] = v; });
  return o;
}

function deriveHasStraordinaria(group: GroupCandidate, tasksMap: Map<number, TaskForPhase2>): { hasStraordinaria: boolean; isLongStraordinaria: boolean } {
  if (group.hasStraordinaria !== undefined && group.isLongStraordinaria !== undefined) {
    return { hasStraordinaria: group.hasStraordinaria, isLongStraordinaria: group.isLongStraordinaria };
  }
  const tasks = group.taskIds.map(id => tasksMap.get(id)).filter((t): t is TaskForPhase2 => t != null);
  const hasOT = tasks.some(t => t.straordinaria);
  if (!hasOT) return { hasStraordinaria: false, isLongStraordinaria: false };
  const otDuration = tasks.filter(t => t.straordinaria).reduce((s, t) => s + (t.cleaningTime || 60), 0);
  return { hasStraordinaria: true, isLongStraordinaria: otDuration >= STRAORDINARIA_LONG_THRESHOLD_MIN };
}

/** Serialize Phase 2 input to JSON for Python. All numbers; Maps as key-value objects. */
function buildPayload(
  groups: GroupCandidate[],
  tasksMap: Map<number, TaskForPhase2>,
  cleaners: CleanerInput[],
  params: Phase2Params
): string {
  const allTasks = Array.from(tasksMap.values());
  const preExistingTotalLoadMin = Array.from(params.initialLoadByCleanerMin?.values() ?? []).reduce((s, v) => s + v, 0);
  const targets = calculateMinutesBasedTargets(allTasks, cleaners.length, params.fairness, preExistingTotalLoadMin);

  const groupsPayload = groups.map((g, idx) => {
    const { hasStraordinaria, isLongStraordinaria } = deriveHasStraordinaria(g, tasksMap);
    return {
      index: idx,
      taskIds: g.taskIds,
      logisticCodes: g.logisticCodes,
      zone: g.zone,
      score: g.score,
      avgTravelMin: g.avgTravelMin ?? 0,
      maxTravelMin: g.maxTravelMin ?? 0,
      hasStraordinaria,
      isLongStraordinaria,
      anchoredCleanerId: g.anchoredCleanerId ?? null
    };
  });

  const tasksPayload = allTasks.map(t => ({
    taskId: t.taskId,
    logisticCode: t.logisticCode,
    lat: t.lat,
    lng: t.lng,
    clientId: t.clientId,
    premium: t.premium,
    straordinaria: t.straordinaria,
    operationId: t.operationId ?? null,
    isOfficeTask: t.isOfficeTask === true,
    typeApt: t.typeApt,
    priority: t.priority,
    cleaningTime: t.cleaningTime
  }));

  const cleanersPayload = cleaners.map(c => ({
    cleanerId: c.cleanerId,
    name: c.name,
    role: c.role,
    contractType: c.contractType,
    preferredCustomers: c.preferredCustomers,
    counterHours: c.counterHours
  }));

  const maxTasksPerCleaner = params.dynamicMaxTasks != null ? params.dynamicMaxTasks + 1 : 4;

  const travelToFirstTaskMin: number[][] = [];
  for (let g = 0; g < groups.length; g++) {
    const firstTaskId = groups[g].taskIds?.[0];
    const firstTask = firstTaskId != null ? tasksMap.get(firstTaskId) : null;
    const row: number[] = [];
    for (let c = 0; c < cleaners.length; c++) {
      const cleaner = cleaners[c];
      const fromPos = params.initialLastPositionByCleaner?.get(cleaner.cleanerId) ??
        (cleaner.lat != null && cleaner.lng != null ? { lat: cleaner.lat, lng: cleaner.lng } : null);
      if (fromPos && firstTask) {
        row.push(estimateTravelMinutes(
          { taskId: 0, logisticCode: 0, lat: fromPos.lat, lng: fromPos.lng },
          firstTask
        ));
      } else {
        row.push(0);
      }
    }
    travelToFirstTaskMin.push(row);
  }

  const formatoreRules: FormatoreRules | null = params.formatoreRules ?? null;

  const payload = {
    groups: groupsPayload,
    tasks: tasksPayload,
    cleaners: cleanersPayload,
    apartmentTypes: params.apartmentTypes ?? DEFAULT_APARTMENT_TYPES,
    officeOperationIds: params.officeOperationIds ?? [],
    taskTypesByCleaner: params.taskTypesByCleaner ?? null,
    formatoreRules: formatoreRules ? {
      allowedPriorities: formatoreRules.allowedPriorities,
      standardApt: formatoreRules.standardApt,
      premiumApt: formatoreRules.premiumApt,
      straordinarioApt: formatoreRules.straordinarioApt
    } : null,
    fairness: params.fairness,
    wT: params.fairness.wT,
    targets: {
      targetLoadMin: Math.round(targets.targetLoadMin),
      minTarget: Math.round(targets.minTarget),
      maxTarget: Math.round(targets.maxTarget),
      totalWorkMin: Math.round(targets.totalWorkMin),
      numCleaners: targets.numCleaners
    },
    initialLoadByCleanerMin: mapToObject(params.initialLoadByCleanerMin),
    initialFixedStatsByCleaner: mapToObject(params.initialFixedStatsByCleaner),
    maxTasksPerCleaner,
    straordinariaLongThresholdMin: STRAORDINARIA_LONG_THRESHOLD_MIN,
    straordinariaExtraTaskMaxMin: STRAORDINARIA_EXTRA_TASK_MAX_MIN,
    travelToFirstTaskMin,
    travelWeight: params.travelWeight ?? 2
  };

  return JSON.stringify(payload);
}

/** Run Python script with JSON on stdin; return stdout as string. Throws on timeout or non-zero exit. */
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
    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Phase 2 OR-Tools timeout after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Phase 2 OR-Tools spawn error: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error('[Phase2 OR-Tools] Process exited with code', code, signal || '');
        if (stderr) console.error('[Phase2 OR-Tools] stderr:', stderr.slice(0, 2000));
        if (stdout) console.error('[Phase2 OR-Tools] stdout (last 1500 chars):', stdout.slice(-1500));
        // Python may still print JSON to stdout before exit(1) (e.g. status "error" or "infeasible")
        try {
          const data = JSON.parse(stdout) as { status?: string; message?: string };
          if (data.status === 'infeasible') {
            reject(new Error(`Phase 2 OR-Tools infeasible${data.message ? `: ${data.message}` : ''}`));
            return;
          }
          if (data.status === 'error' && data.message) {
            reject(new Error(`Phase 2 OR-Tools error: ${data.message}`));
            return;
          }
        } catch {
          // stdout was not valid JSON, use exit code and stderr
        }
        reject(new Error(`Phase 2 OR-Tools exit ${code}${signal ? ` (${signal})` : ''}${stderr ? `: ${stderr.slice(0, 500)}` : ''}`));
        return;
      }
      resolve(stdout);
    });

    proc.stdin?.write(stdinJson, 'utf8', () => {
      proc.stdin?.end();
    });
  });
}

/** Parse Python stdout JSON into Phase2Result. Throws if status is not 'ok'. */
function parseOutput(
  stdout: string,
  groups: GroupCandidate[],
  cleaners: CleanerInput[]
): Phase2Result {
  let data: {
    status: string;
    message?: string;
    assignments?: { groupIndex: number; cleanerId: number | null }[];
    stats?: { groupsAssigned?: number; groupsUnassigned?: number; tasksDropped?: number };
    fairnessTargets?: Record<string, number>;
    fairnessFinal?: Record<string, unknown>;
  };

  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error('Phase 2 OR-Tools invalid JSON output');
  }

  if (data.status === 'infeasible') {
    throw new Error(`Phase 2 OR-Tools infeasible${data.message ? `: ${data.message}` : ''}`);
  }
  if (data.status === 'error') {
    throw new Error(`Phase 2 OR-Tools error${data.message ? `: ${data.message}` : ''}`);
  }
  if (data.status !== 'ok' || !Array.isArray(data.assignments)) {
    throw new Error(`Phase 2 OR-Tools unexpected status or missing assignments: ${data.status}`);
  }

  const assignments: AssignmentResult[] = [];
  const events: Phase2Event[] = [];

  if (data.fairnessTargets) {
    events.push({
      eventType: 'PHASE2_FAIRNESS_TARGETS',
      payload: data.fairnessTargets
    });
  }

  const cleanerIdToName = new Map(cleaners.map(c => [c.cleanerId, c.name]));
  let groupsAssigned = 0;
  let groupsUnassigned = 0;

  data.assignments.forEach((a: { groupIndex: number; cleanerId: number | null }, idx: number) => {
    const group = groups[a.groupIndex] ?? groups[idx];
    if (!group) return;

    const assigned = a.cleanerId != null;
    if (assigned) groupsAssigned++; else groupsUnassigned++;

    assignments.push({
      groupTaskIds: group.taskIds,
      groupLogisticCodes: group.logisticCodes,
      cleanerId: a.cleanerId,
      cleanerName: a.cleanerId != null ? (cleanerIdToName.get(a.cleanerId) ?? null) : null,
      assigned,
      droppedTasks: [],
      retryCount: 0
    });

    if (assigned) {
      events.push({
        eventType: 'PHASE2_GROUP_ASSIGNED',
        payload: {
          cleaner_id: a.cleanerId,
          group_tasks: group.taskIds,
          group_logistic_codes: group.logisticCodes,
          task_ids: group.taskIds,
          score: group.score ?? 0
        }
      });
    } else {
      events.push({
        eventType: 'PHASE2_GROUP_UNASSIGNED_CANDIDATE',
        payload: {
          group_tasks: group.taskIds,
          group_logistic_codes: group.logisticCodes,
          reason: 'OR_TOOLS_UNASSIGNED'
        }
      });
    }
  });

  if (data.fairnessFinal) {
    events.push({
      eventType: 'PHASE2_FAIRNESS_FINAL_METRICS',
      payload: data.fairnessFinal
    });
  }

  const stats = data.stats ?? {};
  return {
    assignments,
    events,
    stats: {
      groupsProcessed: groups.length,
      groupsAssigned: stats.groupsAssigned ?? groupsAssigned,
      groupsUnassigned: stats.groupsUnassigned ?? groupsUnassigned,
      tasksDropped: stats.tasksDropped ?? 0
    }
  };
}

/**
 * Run Phase 2 using OR-Tools CP-SAT via Python subprocess.
 * Throws on timeout, solver error, or infeasible (no legacy fallback).
 */
export async function runPhase2WithOrTools(
  groups: GroupCandidate[],
  tasksMap: Map<number, TaskForPhase2>,
  cleaners: CleanerInput[],
  params: Phase2Params,
  options: RunPhase2WithOrToolsOptions = {}
): Promise<Phase2Result> {
  const timeoutMs = options.timeoutMs ?? 90000;
  const pythonPath = options.pythonPath ?? 'python3';
  const scriptPath = options.scriptPath ?? join(__dirname, 'phase2_ortools.py');

  const stdinJson = buildPayload(groups, tasksMap, cleaners, params);
  const stdout = await runPythonScript(scriptPath, stdinJson, { timeoutMs, pythonPath });
  return parseOutput(stdout, groups, cleaners);
}
