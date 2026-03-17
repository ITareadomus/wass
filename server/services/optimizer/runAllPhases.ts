import { v4 as uuidv4 } from 'uuid';
import pool from '../../../shared/pg-db';
import { runPhase0, Phase0RunResult } from './runPhase0';
import { runPhase1, Phase1RunResult } from './runPhase1';
import { runPhase2, Phase2RunResult } from './runPhase2';
import { runPhase3, Phase3RunResult } from './runPhase3';
import { runPhase4, Phase4RunResult } from './runPhase4';
import { runPhase5, Phase5RunResult } from './runPhase5';
import {
  createRun,
  updateRunStatus,
  OptimizerRun,
  getPlanRunIdForDate,
  setPlanRunIdForDate
} from './db';
import { DEFAULT_PHASE1_PARAMS, TaskInput } from './phase1';
import { calculateDynamicLimits } from './phase2';
import { DEFAULT_TRAVEL_POLICY } from './travelPolicy';
import path from 'path';
import { TimelineContext } from './timelineContext';

export type WavePriority = 'early_out' | 'high_priority' | 'low_priority';

export interface UnassignedBreakdown {
  taskId: number;
  logisticCode: number;
  isStraordinaria: boolean;
  reason: string;
  compatibleCleanersCount: number;
}

type PythonRecalcTask = {
  task_id: number;
  logistic_code: number;
  sequence: number;
  cleaning_time: number;
  address: string | null;
  lat: number | string | null;
  lng: number | string | null;
  start_time: string | null;
  end_time: string | null;
  travel_time: number | null;
  checkout_time?: string | null;
  checkin_time?: string | null;
  checkin_date?: string | null;
  priority?: string | null;
};

async function recalculateCleanerTimesViaPython(cleanerData: any): Promise<any> {
  const { spawn } = await import('child_process');

  return await new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), 'client/public/scripts/recalculate_times.py');
    const cleanerDataJson = JSON.stringify(cleanerData);

    const pythonProcess = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (!result.success) {
          reject(new Error(result.error || 'Unknown error from Python script'));
          return;
        }
        resolve(result.cleaner_data);
      } catch (parseError: any) {
        reject(new Error(`Failed to parse Python output: ${parseError.message}`));
      }
    });

    pythonProcess.on('error', (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });

    try {
      pythonProcess.stdin.write(cleanerDataJson);
      pythonProcess.stdin.end();
    } catch (writeError: any) {
      reject(new Error(`Failed to write to Python process: ${writeError.message}`));
    }
  });
}

async function recalculateAffectedCleaners(
  client: any,
  workDate: string,
  runId: string,
  cleanerIds: number[]
): Promise<CheckinViolation[]> {
  const violations: CheckinViolation[] = [];

  for (const cleanerId of cleanerIds) {
    const tasksResult = await client.query(
      `SELECT dac.task_id, dac.logistic_code, dac.cleaner_id,
              dac.sequence, dac.cleaning_time, dac.address, dac.lat, dac.lng,
              dac.start_time, dac.end_time, dac.travel_time,
              dac.checkout_time, dac.checkin_time, dac.checkin_date, dac.priority
       FROM daily_assignments_current dac
       LEFT JOIN optimizer.optimizer_assignment oa
         ON oa.task_id = dac.task_id
         AND oa.run_id = $3
         AND oa.cleaner_id = dac.cleaner_id
       WHERE dac.work_date = $1 AND dac.cleaner_id = $2
       ORDER BY COALESCE(oa.start_time::time, dac.start_time::time, '23:59'::time) ASC, dac.task_id ASC`,
      [workDate, cleanerId, runId]
    );

    if (tasksResult.rows.length === 0) continue;

    const startTimeResult = await client.query(
      `SELECT COALESCE(start_time, '10:00') as start_time
       FROM cleaners
       WHERE work_date = $1 AND cleaner_id = $2
       LIMIT 1`,
      [workDate, cleanerId]
    );
    const cleanerStartTime = startTimeResult.rows[0]?.start_time || '10:00';

    const cleanerData = {
      cleaner: { id: cleanerId, start_time: cleanerStartTime },
      work_date: workDate,
      tasks: tasksResult.rows.map((r: any): PythonRecalcTask => ({
        task_id: Number(r.task_id),
        logistic_code: Number(r.logistic_code),
        sequence: Number(r.sequence),
        cleaning_time: Number(r.cleaning_time) || 0,
        address: r.address ?? null,
        lat: r.lat ?? null,
        lng: r.lng ?? null,
        start_time: r.start_time ?? null,
        end_time: r.end_time ?? null,
        travel_time: r.travel_time ?? null,
        checkout_time: r.checkout_time ?? null,
        checkin_time: r.checkin_time ?? null,
        checkin_date: r.checkin_date ?? null,
        priority: r.priority ?? null,
      })),
    };

    const updatedCleanerData = await recalculateCleanerTimesViaPython(cleanerData);
    const recalculatedTasks = Array.isArray(updatedCleanerData?.tasks) ? updatedCleanerData.tasks : [];

    for (const t of recalculatedTasks) {
      if (t._checkin_violated) {
        violations.push({
          taskId: Number(t.task_id),
          logisticCode: Number(t.logistic_code),
          cleanerId,
          endTime: String(t.end_time ?? ''),
          checkinTime: String(t.checkin_time ?? ''),
        });
      }
    }

    const toMinutes = (t?: string | null): number => {
      if (!t) return Number.POSITIVE_INFINITY;
      const parts = String(t).split(':');
      if (parts.length < 2) return Number.POSITIVE_INFINITY;
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.POSITIVE_INFINITY;
      return h * 60 + m;
    };

    const orderedTasks = [...recalculatedTasks].sort((a: any, b: any) => {
      const ma = toMinutes(a.start_time);
      const mb = toMinutes(b.start_time);
      if (ma !== mb) return ma - mb;
      const sa = Number(a.sequence);
      const sb = Number(b.sequence);
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
      return Number(a.task_id) - Number(b.task_id);
    });

    for (let i = 0; i < orderedTasks.length; i++) {
      const task = orderedTasks[i];
      const newSeq = i + 1;
      const followup = newSeq > 1;
      await client.query(
        `UPDATE daily_assignments_current
         SET start_time = $1, end_time = $2, travel_time = $3, sequence = $4, followup = $5
         WHERE work_date = $6 AND cleaner_id = $7 AND task_id = $8`,
        [task.start_time, task.end_time, task.travel_time, newSeq, followup, workDate, cleanerId, task.task_id]
      );
    }
  }

  return violations;
}

export interface AllPhasesRunResult {
  runId: string;
  workDate: string;
  totalDurationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
  phase0: Phase0RunResult | null;
  phase1: Phase1RunResult | null;
  phase2: Phase2RunResult | null;
  phase3: Phase3RunResult | null;
  phase4: Phase4RunResult | null;
  phase5: Phase5RunResult | null;
  summary: {
    totalTasksProcessed: number;
    tasksAssigned: number;
    tasksUnassigned: number;
    cleanersUsed: number;
  };
  metrics: {
    totalTasks: number;
    assignedTasks: number;
    unassignedTasks: number;
    otTotal: number;
    otAssigned: number;
    otUnassigned: number;
    unassignedByReason: Record<string, number>;
    unassignedDetails: UnassignedBreakdown[];
  };
}

export interface RunAllPhasesOptions {
  skipPhase4?: boolean;
  applyToProduction?: boolean;
  forceFullPipeline?: boolean;
  anchorTaskIds?: number[];
}

interface TimelineAnchorBuildResult {
  timelineSeeds?: Map<number, number>;
  timelineSeedTasks?: TaskInput[];
  remainingSlotsPerCleaner?: Map<number, number>;
}

function filterMapByCleaner<T>(source: Map<number, T>, cleanerIds: Set<number>): Map<number, T> {
  const filtered = new Map<number, T>();
  source.forEach((value, key) => {
    if (cleanerIds.has(key)) filtered.set(key, value);
  });
  return filtered;
}

function buildPhase2TimelineContextForAnchors(
  fullContext: TimelineContext,
  anchorCleanerIds: Set<number>
): TimelineContext | undefined {
  if (anchorCleanerIds.size === 0) return undefined;

  return {
    alreadyOnTimelineTaskIds: new Set<string>(),
    occupiedBlocksByCleaner: filterMapByCleaner(fullContext.occupiedBlocksByCleaner, anchorCleanerIds),
    initialLoadByCleanerMin: filterMapByCleaner(fullContext.initialLoadByCleanerMin, anchorCleanerIds),
    anchorPointsByCleaner: filterMapByCleaner(fullContext.anchorPointsByCleaner, anchorCleanerIds),
    collaborationIndex: new Map<string, number[]>(),
    lastFixedByCleaner: filterMapByCleaner(fullContext.lastFixedByCleaner, anchorCleanerIds),
    fixedStatsByCleaner: filterMapByCleaner(fullContext.fixedStatsByCleaner, anchorCleanerIds),
  };
}

async function buildTimelineAnchorsForPhase1(
  workDate: string,
  timelineContext: TimelineContext,
  unlockedTaskData: TaskInput[],
  unlockedTasksCount: number,
  numCleaners: number,
  anchorTaskIds: number[]
): Promise<TimelineAnchorBuildResult> {
  const timelineSeeds = new Map<number, number>();
  const timelineSeedTasks: TaskInput[] = [];
  const remainingSlotsPerCleaner = new Map<number, number>();

  const newTasksTotalMin = unlockedTaskData.reduce((sum, t) => sum + (t.cleaningTimeMinutes || 60), 0);
  const avgNewTaskMin = unlockedTasksCount > 0 ? newTasksTotalMin / unlockedTasksCount : 60;
  const preExistingTotalMin = Array.from(timelineContext.initialLoadByCleanerMin.values()).reduce((s, v) => s + v, 0);
  const targetMinPerCleaner = (newTasksTotalMin + preExistingTotalMin) / Math.max(1, numCleaners);

  if (anchorTaskIds.length === 0) {
    timelineContext.lastFixedByCleaner.forEach((lastFixed, cleanerId) => {
      if (lastFixed.lat === null || lastFixed.lng === null) return;
      timelineSeeds.set(lastFixed.taskId, cleanerId);
      timelineSeedTasks.push({
        taskId: lastFixed.taskId,
        logisticCode: lastFixed.logisticCode,
        lat: lastFixed.lat,
        lng: lastFixed.lng,
        straordinaria: lastFixed.straordinaria,
        cleaningTimeMinutes: lastFixed.baseCleaningTimeMinutes ?? lastFixed.cleaningTimeMinutes ?? 60
      });

      const fixedStats = timelineContext.fixedStatsByCleaner.get(cleanerId);
      const fixedMinutes = fixedStats?.fixedWorkMinutes ?? 0;
      const remainingMinutes = Math.max(0, targetMinPerCleaner - fixedMinutes);
      const remainingSlots = Math.max(0, Math.round(remainingMinutes / avgNewTaskMin));
      remainingSlotsPerCleaner.set(cleanerId, remainingSlots);
    });
  } else {
    const anchorsResult = await pool.query<{
      task_id: number;
      logistic_code: number | null;
      cleaner_id: number;
      sequence: number | null;
      start_time: string | null;
      end_time: string | null;
      lat: number | null;
      lng: number | null;
      straordinaria: boolean | null;
      cleaning_time: number | null;
      base_cleaning_time: number | null;
    }>(`
      SELECT
        task_id,
        logistic_code,
        cleaner_id,
        sequence,
        start_time,
        end_time,
        lat,
        lng,
        straordinaria,
        cleaning_time,
        base_cleaning_time
      FROM daily_assignments_current
      WHERE work_date = $1
        AND task_id = ANY($2::int[])
    `, [workDate, anchorTaskIds]);

    const ranked = new Map<number, (typeof anchorsResult.rows)[number]>();
    const rank = (row: (typeof anchorsResult.rows)[number]) => {
      const hasEnd = !!row.end_time ? 3 : 0;
      const hasStart = !hasEnd && !!row.start_time ? 2 : 0;
      const time = row.end_time || row.start_time || '';
      const seq = row.sequence ?? -1;
      return { kind: Math.max(hasEnd, hasStart, 1), time, seq };
    };

    for (const row of anchorsResult.rows) {
      if (row.lat === null || row.lng === null) continue;
      const current = ranked.get(row.cleaner_id);
      if (!current) {
        ranked.set(row.cleaner_id, row);
        continue;
      }
      const a = rank(row);
      const b = rank(current);
      const shouldReplace =
        a.kind > b.kind ||
        (a.kind === b.kind && (a.time > b.time || (a.time === b.time && a.seq > b.seq)));
      if (shouldReplace) ranked.set(row.cleaner_id, row);
    }

    ranked.forEach((row, cleanerId) => {
      timelineSeeds.set(row.task_id, cleanerId);
      timelineSeedTasks.push({
        taskId: row.task_id,
        logisticCode: Number(row.logistic_code ?? 0),
        lat: row.lat as number,
        lng: row.lng as number,
        straordinaria: row.straordinaria === true,
        cleaningTimeMinutes: row.base_cleaning_time ?? row.cleaning_time ?? 60
      });

      const fixedStats = timelineContext.fixedStatsByCleaner.get(cleanerId);
      const fixedMinutes = fixedStats?.fixedWorkMinutes ?? 0;
      const remainingMinutes = Math.max(0, targetMinPerCleaner - fixedMinutes);
      const remainingSlots = Math.max(0, Math.round(remainingMinutes / avgNewTaskMin));
      remainingSlotsPerCleaner.set(cleanerId, remainingSlots);
    });
  }

  if (timelineSeeds.size === 0) {
    return {};
  }

  const totalRemaining = Array.from(remainingSlotsPerCleaner.values()).reduce((s, v) => s + v, 0);
  console.log(
    `[runAllPhases] Existing timeline: ${timelineSeeds.size} seed tasks, target=${Math.round(targetMinPerCleaner)}min/cleaner, avgTask=${Math.round(avgNewTaskMin)}min, total remaining slots: ${totalRemaining}`
  );

  return {
    timelineSeeds,
    timelineSeedTasks,
    remainingSlotsPerCleaner
  };
}

export async function runAllPhases(
  workDate: string,
  options: RunAllPhasesOptions = {}
): Promise<AllPhasesRunResult> {
  const startTime = Date.now();
  const runId = uuidv4();
  const {
    skipPhase4 = false,
    applyToProduction = false,
    forceFullPipeline = false,
    anchorTaskIds = []
  } = options;

  const result: AllPhasesRunResult = {
    runId,
    workDate,
    totalDurationMs: 0,
    status: 'partial',
    phase0: null,
    phase1: null,
    phase2: null,
    phase3: null,
    phase4: null,
    phase5: null,
    summary: {
      totalTasksProcessed: 0,
      tasksAssigned: 0,
      tasksUnassigned: 0,
      cleanersUsed: 0
    },
    metrics: {
      totalTasks: 0,
      assignedTasks: 0,
      unassignedTasks: 0,
      otTotal: 0,
      otAssigned: 0,
      otUnassigned: 0,
      unassignedByReason: {},
      unassignedDetails: []
    }
  };

  try {
    console.log(`[runAllPhases] Starting complete optimization for ${workDate}, runId=${runId}`);

    const run: OptimizerRun = {
      runId,
      workDate,
      algorithmVersion: 'v2.0-full',
      params: DEFAULT_PHASE1_PARAMS,
      status: 'partial'
    };
    await createRun(run);

    console.log(`[runAllPhases] === PHASE 0: Locked Task Filter ===`);
    result.phase0 = await runPhase0(workDate, runId);
    if (result.phase0.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 0 failed: ${result.phase0.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 0 complete: ${result.phase0.unlockedTasks} unlocked tasks`);

    const cleanersRes = await pool.query<{ cleaners: number[] }>(
      `SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1`,
      [workDate]
    );
    const numCleaners = cleanersRes.rows[0]?.cleaners?.length || 1;
    const timelineTasksCount = result.phase0?.alreadyOnTimelineTasks ?? 0;
    const unlockedTasksCount = result.phase0?.unlockedTasks ?? 0;
    // Use day-total workload (already on timeline + still to assign) for dynamic limits.
    // In wave runs this avoids over-tight caps based only on residual slice (e.g. LP only).
    const totalTasksForDynamicLimits = timelineTasksCount + unlockedTasksCount;
    const dynamicLimits = calculateDynamicLimits(totalTasksForDynamicLimits, numCleaners);

    const hasExistingTimeline = (result.phase0?.timelineContext?.alreadyOnTimelineTaskIds?.size ?? 0) > 0;

    const phase1MaxGroupSize = dynamicLimits.baseMax + 1;
    
    console.log(
      `[runAllPhases] Dynamic limits: total=${totalTasksForDynamicLimits} (timeline=${timelineTasksCount}, unlocked=${unlockedTasksCount}) / ${numCleaners} cleaners = baseMax=${dynamicLimits.baseMax}, phase1MaxGroup=${phase1MaxGroupSize}`
    );

    // When timeline has existing tasks, use them as seeds so Phase 1 creates groups anchored to cleaners
    let timelineSeeds: Map<number, number> | undefined;
    let timelineSeedTasks: TaskInput[] | undefined;
    let remainingSlotsPerCleaner: Map<number, number> | undefined;

    if (hasExistingTimeline && result.phase0?.timelineContext?.lastFixedByCleaner) {
      const anchorResult = await buildTimelineAnchorsForPhase1(
        workDate,
        result.phase0.timelineContext,
        result.phase0.unlockedTaskData,
        result.phase0.unlockedTasks,
        numCleaners,
        anchorTaskIds
      );
      timelineSeeds = anchorResult.timelineSeeds;
      timelineSeedTasks = anchorResult.timelineSeedTasks;
      remainingSlotsPerCleaner = anchorResult.remainingSlotsPerCleaner;
    }

    let phase2TimelineContext: TimelineContext | undefined = result.phase0?.timelineContext;
    if (anchorTaskIds.length > 0) {
      const anchorCleanerIds = new Set<number>(Array.from(timelineSeeds?.values() ?? []));
      phase2TimelineContext = buildPhase2TimelineContextForAnchors(
        result.phase0.timelineContext,
        anchorCleanerIds
      );
      if (phase2TimelineContext) {
        const fixedCount = Array.from(phase2TimelineContext.fixedStatsByCleaner.values())
          .reduce((s, v) => s + v.fixedTaskCount, 0);
        console.log(
          `[runAllPhases] Phase2 anchor context: ${phase2TimelineContext.fixedStatsByCleaner.size} cleaners, ${fixedCount} fixed tasks`
        );
      } else {
        console.log(`[runAllPhases] Phase2 anchor context empty: no anchored cleaners found`);
      }
    }

    console.log(`[runAllPhases] === PHASE 1: Candidate Group Generation ===`);
    result.phase1 = await runPhase1(workDate, {
      existingRunId: runId,
      preFilteredTasks: result.phase0.unlockedTaskData,
      params: {
        minGroupSize: dynamicLimits.minTasks,
        maxGroupSize: phase1MaxGroupSize,
        remainingSlotsPerCleaner
      },
      timelineSeeds,
      timelineSeedTasks
    });
    if (result.phase1.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 1 failed: ${result.phase1.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 1 complete: ${result.phase1.groupsGenerated} groups generated`);

    console.log(`[runAllPhases] === PHASE 2: Cleaner Assignment ===`);
    // Passa baseMax - il bonus travel (+1) viene applicato per-cleaner basato su avgTravel ≤ 10min
    // Passa timelineContext per fairness scoring (pre-existing load)
    result.phase2 = await runPhase2(workDate, runId, { 
      params: { dynamicMaxTasks: dynamicLimits.baseMax },
      timelineContext: phase2TimelineContext
    });
    if (result.phase2.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 2 failed: ${result.phase2.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 2 complete: ${result.phase2.groupsAssigned} groups assigned`);

    console.log(`[runAllPhases] === PHASE 3: Scheduling ===`);
    // Passa timelineContext per collision avoidance (occupiedBlocks)
    result.phase3 = await runPhase3(workDate, runId, { 
      timelineContext: result.phase0?.timelineContext 
    });
    if (result.phase3.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 3 failed: ${result.phase3.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 3 complete: ${result.phase3.tasksScheduled} tasks scheduled`);

    if (!skipPhase4) {
      console.log(`[runAllPhases] === PHASE 4: Recovery ===`);
      result.phase4 = await runPhase4(workDate, runId, { 
        params: {
          dynamicMaxTasks: dynamicLimits.baseMax,
          ...(hasExistingTimeline ? { appendOnly: true, travelPolicy: DEFAULT_TRAVEL_POLICY } : {})
        },
        timelineContext: result.phase0?.timelineContext
      });
      if (result.phase4.status === 'failed') {
        console.warn(`[runAllPhases] Phase 4 failed (non-critical): ${result.phase4.error}`);
      } else {
        console.log(`[runAllPhases] Phase 4 complete: ${result.phase4.singleAssignedCount} tasks recovered`);
      }
    }

    // Phase 5: Inter-Cleaner Travel Optimization (relocations + swaps)
    console.log(`[runAllPhases] === PHASE 5: Inter-Cleaner Travel Optimization ===`);
    result.phase5 = await runPhase5(workDate, runId, {
      params: { dynamicMaxTasks: dynamicLimits.baseMax },
      timelineContext: result.phase0?.timelineContext
    });
    if (result.phase5.status === 'failed') {
      console.warn(`[runAllPhases] Phase 5 failed (non-critical): ${result.phase5.error}`);
    } else {
      console.log(`[runAllPhases] Phase 5 complete: ${result.phase5.relocationsExecuted} relocations, ${result.phase5.swapsExecuted} swaps, ${result.phase5.fairnessRelocations} fairness moves, travel reduced by ${result.phase5.travelReduced} min, load spread ${result.phase5.loadSpreadBefore} -> ${result.phase5.loadSpreadAfter} min`);
    }

    const assignmentCount = await pool.query(`
      SELECT COUNT(DISTINCT task_id) as count FROM optimizer.optimizer_assignment WHERE run_id = $1
    `, [runId]);
    const unassignedCount = await pool.query(`
      SELECT COUNT(*) as count FROM optimizer.optimizer_unassigned WHERE run_id = $1
    `, [runId]);
    const cleanerCount = await pool.query(`
      SELECT COUNT(DISTINCT cleaner_id) as count FROM optimizer.optimizer_assignment WHERE run_id = $1
    `, [runId]);

    result.summary = {
      totalTasksProcessed: result.phase0?.unlockedTasks || 0,  // Use unlockedTasks (excludes locked)
      tasksAssigned: parseInt(assignmentCount.rows[0]?.count || '0'),
      tasksUnassigned: parseInt(unassignedCount.rows[0]?.count || '0'),
      cleanersUsed: parseInt(cleanerCount.rows[0]?.count || '0')
    };

    // === METRICHE DETTAGLIATE ===
    await collectDetailedMetrics(runId, workDate, result);

    if (applyToProduction) {
      console.log(`[runAllPhases] === APPLYING TO PRODUCTION ===`);
      const applyResult = await applyOptimizerToProduction(runId, workDate);
      console.log(`[runAllPhases] Applied ${applyResult.insertedCount} assignments to production`);
    }

    result.status = 'success';
    await updateRunStatus(runId, 'success', result.summary);

    // Persist plan only for full runs without pre-existing timeline.
    // This is the "single solve" baseline used by wave applies.
    if (!hasExistingTimeline) {
      await setPlanRunIdForDate(workDate, runId);
      console.log(`[runAllPhases] Plan run updated for ${workDate}: ${runId}`);
    }

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message;
    console.error(`[runAllPhases] Error:`, error);
    await updateRunStatus(runId, 'failed', { error: result.error });
  }

  result.totalDurationMs = Date.now() - startTime;
  console.log(`[runAllPhases] Complete in ${result.totalDurationMs}ms - Status: ${result.status}`);
  
  return result;
}

async function collectDetailedMetrics(
  runId: string,
  workDate: string,
  result: AllPhasesRunResult
): Promise<void> {
  try {
    // Query per contare OT totali, assegnate e non assegnate
    const otStats = await pool.query(`
      WITH all_tasks AS (
        SELECT DISTINCT task_id, 
          COALESCE(dc.straordinaria, false) as is_ot
        FROM daily_containers dc
        WHERE dc.work_date = $1
      ),
      assigned_tasks AS (
        SELECT task_id FROM optimizer.optimizer_assignment WHERE run_id = $2
      ),
      unassigned_tasks AS (
        SELECT task_id, reason_code FROM optimizer.optimizer_unassigned WHERE run_id = $2
      )
      SELECT 
        COUNT(*) FILTER (WHERE at.is_ot = true) as ot_total,
        COUNT(*) FILTER (WHERE at.is_ot = true AND ast.task_id IS NOT NULL) as ot_assigned,
        COUNT(*) FILTER (WHERE at.is_ot = true AND ust.task_id IS NOT NULL) as ot_unassigned
      FROM all_tasks at
      LEFT JOIN assigned_tasks ast ON at.task_id = ast.task_id
      LEFT JOIN unassigned_tasks ust ON at.task_id = ust.task_id
    `, [workDate, runId]);

    // Query per breakdown dei non assegnati per reason
    const unassignedByReason = await pool.query(`
      SELECT reason_code, COUNT(*) as count
      FROM optimizer.optimizer_unassigned
      WHERE run_id = $1
      GROUP BY reason_code
      ORDER BY count DESC
    `, [runId]);

    // Query per dettagli dei non assegnati (incluso OT)
    // Calcola i cleaners compatibili basandosi sui selected_cleaners e le regole di compatibilità
    // NOTA: La compatibilità si basa su role (Premium/Standard/Straordinario)
    // Le settings apartment_types sono caricate in Phase2/Phase4 per la logica completa
    // Qui usiamo una versione semplificata che considera:
    // - Premium task → richiede cleaner Premium
    // - Straordinaria → richiede cleaner con role = 'Straordinario'
    // - typeApt: tutti i ruoli possono fare tutti i tipi di appartamento (secondo current settings)
    const unassignedDetails = await pool.query(`
      WITH selected_cleaners AS (
        SELECT UNNEST(cleaners) as cleaner_id FROM daily_selected_cleaners WHERE work_date = $2
      ),
      cleaner_details AS (
        SELECT 
          c.cleaner_id,
          COALESCE(c.role, 'Standard') as role
        FROM cleaners c
        WHERE c.work_date = $2 AND c.cleaner_id IN (SELECT cleaner_id FROM selected_cleaners)
      ),
      unassigned_with_compat AS (
        SELECT 
          ou.task_id,
          ou.logistic_code,
          COALESCE(dc.straordinaria, false) as is_straordinaria,
          ou.reason_code,
          dc.premium,
          COALESCE(dc.type_apt, 'C') as type_apt,
          (
            SELECT COUNT(*)
            FROM cleaner_details cd
            WHERE 
              (NOT COALESCE(dc.premium, false) OR cd.role = 'Premium')
              AND (NOT COALESCE(dc.straordinaria, false) OR cd.role = 'Straordinario')
          ) as compatible_cleaners_count
        FROM optimizer.optimizer_unassigned ou
        LEFT JOIN daily_containers dc ON dc.task_id = ou.task_id AND dc.work_date = $2
        WHERE ou.run_id = $1
      )
      SELECT * FROM unassigned_with_compat
      ORDER BY is_straordinaria DESC, compatible_cleaners_count ASC
    `, [runId, workDate]);

    result.metrics = {
      totalTasks: result.phase0?.unlockedTasks || 0,  // Use unlockedTasks to exclude locked tasks from count
      assignedTasks: result.summary.tasksAssigned,
      unassignedTasks: result.summary.tasksUnassigned,
      otTotal: parseInt(otStats.rows[0]?.ot_total || '0'),
      otAssigned: parseInt(otStats.rows[0]?.ot_assigned || '0'),
      otUnassigned: parseInt(otStats.rows[0]?.ot_unassigned || '0'),
      unassignedByReason: {},
      unassignedDetails: []
    };

    // Popola unassignedByReason
    for (const row of unassignedByReason.rows) {
      result.metrics.unassignedByReason[row.reason_code || 'UNKNOWN'] = parseInt(row.count);
    }

    // Popola unassignedDetails
    result.metrics.unassignedDetails = unassignedDetails.rows.map((row: any) => ({
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      isStraordinaria: row.is_straordinaria,
      reason: row.reason_code || 'UNKNOWN',
      compatibleCleanersCount: row.compatible_cleaners_count
    }));

    // Log delle metriche
    console.log(`[runAllPhases] === METRICHE FINALI ===`);
    console.log(`   Totale task: ${result.metrics.totalTasks}`);
    console.log(`   Assegnati: ${result.metrics.assignedTasks}`);
    console.log(`   Non assegnati: ${result.metrics.unassignedTasks}`);
    console.log(`   OT totali: ${result.metrics.otTotal}, assegnate: ${result.metrics.otAssigned}, non assegnate: ${result.metrics.otUnassigned}`);

    // Check di coerenza: assigned + unassigned deve essere uguale a total
    const expectedTotal = result.metrics.assignedTasks + result.metrics.unassignedTasks;
    if (expectedTotal !== result.metrics.totalTasks) {
      const missing = result.metrics.totalTasks - expectedTotal;
      console.warn(`   ⚠️ WARNING: Conteggio incoerente! assigned(${result.metrics.assignedTasks}) + unassigned(${result.metrics.unassignedTasks}) = ${expectedTotal}, ma total = ${result.metrics.totalTasks}`);
      console.warn(`   ⚠️ ${missing} task mancanti dal sistema di conteggio!`);
      
      // Query per trovare i task_id mancanti
      try {
        const missingTasksQuery = await pool.query(`
          WITH all_unlocked AS (
            SELECT task_id FROM daily_containers 
            WHERE work_date = $1
              AND task_id NOT IN (SELECT task_id FROM daily_task_locks WHERE work_date = $1 AND locked = true)
          ),
          accounted AS (
            SELECT task_id FROM optimizer.optimizer_assignment WHERE run_id = $2
            UNION
            SELECT task_id FROM optimizer.optimizer_unassigned WHERE run_id = $2
          )
          SELECT task_id FROM all_unlocked WHERE task_id NOT IN (SELECT task_id FROM accounted)
        `, [workDate, runId]);
        
        if (missingTasksQuery.rows.length > 0) {
          const missingIds = missingTasksQuery.rows.map(r => r.task_id);
          console.warn(`   ⚠️ Task IDs mancanti: ${missingIds.join(', ')}`);
        }
      } catch (e: any) {
        console.warn(`   ⚠️ Impossibile recuperare task mancanti: ${e.message}`);
      }
    }
    
    if (Object.keys(result.metrics.unassignedByReason).length > 0) {
      console.log(`   Non assegnati per reason:`);
      for (const [reason, count] of Object.entries(result.metrics.unassignedByReason)) {
        console.log(`      - ${reason}: ${count}`);
      }
    }

    // Log dettagliato per OT non assegnate
    const unassignedOTs = result.metrics.unassignedDetails.filter(d => d.isStraordinaria);
    if (unassignedOTs.length > 0) {
      console.log(`   ⚠️ STRAORDINARIE NON ASSEGNATE (${unassignedOTs.length}):`);
      for (const ot of unassignedOTs) {
        console.log(`      - Task ${ot.taskId} (LC: ${ot.logisticCode}): ${ot.reason}, cleaners compatibili: ${ot.compatibleCleanersCount}`);
      }
    }

  } catch (error: any) {
    console.warn(`[runAllPhases] Warning: failed to collect detailed metrics: ${error.message}`);
  }
}

export interface ApplyToProductionResult {
  runId: string;
  workDate: string;
  insertedCount: number;
  deletedCount: number;
  success: boolean;
  error?: string;
}

export async function applyOptimizerToProduction(
  runId: string,
  workDate: string
): Promise<ApplyToProductionResult> {
  const result: ApplyToProductionResult = {
    runId,
    workDate,
    insertedCount: 0,
    deletedCount: 0,
    success: false
  };

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Ensure PK sequence is aligned. If the table was bulk-loaded with explicit IDs
    // (or restored), the underlying sequence can lag behind and generate duplicates.
    // This would break MERGE MODE inserts with "duplicate key ... daily_assignments_current_pkey".
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('daily_assignments_current', 'id'),
        (SELECT COALESCE(MAX(id), 0) FROM daily_assignments_current),
        true
      )
    `);

    result.deletedCount = 0;

    const insertQuery = `
      INSERT INTO daily_assignments_current (
        work_date, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time,
        cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time,
        customer_reference, base_cleaning_time
      )
      SELECT 
        $2 as work_date,
        oa.cleaner_id,
        oa.task_id,
        oa.logistic_code,
        dc.client_id,
        dc.premium,
        dc.address,
        dc.lat::numeric,
        dc.lng::numeric,
        dc.cleaning_time::integer,
        dc.checkin_date::date,
        dc.checkout_date::date,
        dc.checkin_time::time,
        dc.checkout_time::time,
        dc.pax_in::integer,
        dc.pax_out::integer,
        dc.small_equipment,
        dc.operation_id,
        dc.confirmed_operation,
        dc.straordinaria,
        dc.type_apt,
        dc.alias,
        dc.customer_name,
        oa.reasons,
        oa.priority_type as priority,
        oa.start_time::time as start_time,
        oa.end_time::time as end_time,
        CASE WHEN (bs.base_seq + oa.sequence) > 1 THEN true ELSE false END as followup,
        (bs.base_seq + oa.sequence) as sequence,
        COALESCE(oa.travel_minutes_from_prev, 0) as travel_time,
        c.name as cleaner_name,
        c.lastname as cleaner_lastname,
        c.role as cleaner_role,
        false as cleaner_premium,
        COALESCE(c.start_time, '10:00') as cleaner_start_time,
        dc.customer_reference,
        dc.cleaning_time as base_cleaning_time
      FROM optimizer.optimizer_assignment oa
      JOIN daily_containers dc ON dc.task_id = oa.task_id AND dc.work_date = $2
      LEFT JOIN cleaners c ON c.cleaner_id = oa.cleaner_id AND c.work_date = $2
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(sequence), 0) as base_seq
        FROM daily_assignments_current dac
        WHERE dac.work_date = $2 AND dac.cleaner_id = oa.cleaner_id
      ) bs ON true
      WHERE oa.run_id = $1
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_task_locks 
          WHERE work_date = $2 AND locked = true
        )
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_assignments_current
          WHERE work_date = $2
        )
    `;

    const insertResult = await client.query(insertQuery, [runId, workDate]);
    result.insertedCount = insertResult.rowCount || 0;
    console.log(`[applyToProduction] MERGE MODE: Inserted ${result.insertedCount} new assignments (existing preserved)`);

    if (result.insertedCount > 0) {
      try {
        const affectedCleanersResult = await client.query(
          `SELECT DISTINCT oa.cleaner_id
           FROM optimizer.optimizer_assignment oa
           JOIN daily_assignments_current dac ON dac.task_id = oa.task_id AND dac.work_date = $2
           WHERE oa.run_id = $1`,
          [runId, workDate]
        );
        const cleanerIds: number[] = affectedCleanersResult.rows
          .map((r: any) => Number(r.cleaner_id))
          .filter((n: number) => Number.isFinite(n));

        const violations = await recalculateAffectedCleaners(client, workDate, runId, cleanerIds);
        console.log(`[applyToProduction] Recalculated travel/start/end times for ${cleanerIds.length} cleaners`);
        if (violations.length > 0) {
          console.warn(`[applyToProduction] ${violations.length} checkin violations detected after recalc`);
        }
      } catch (recalcError: any) {
        console.warn(`[applyToProduction] Warning: failed to recalculate travel times: ${recalcError.message}`);
      }
    }

    // Get next revision number for history table
    const historyRevisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_history WHERE work_date = $1`,
      [workDate]
    );
    const historyNextRevision = historyRevisionResult.rows[0].next_revision;
    
    // Get next revision number for revisions table (separate sequence)
    const revisionsRevisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_revisions WHERE work_date = $1`,
      [workDate]
    );
    const revisionsNextRevision = revisionsRevisionResult.rows[0].next_revision;
    
    await client.query(`
      INSERT INTO daily_assignments_history (
        work_date, revision, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons, manually_moved,
        priority, start_time, end_time, followup, sequence, travel_time,
        created_by
      )
      SELECT 
        work_date, $3, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons, COALESCE(manually_moved, false),
        priority, start_time, end_time, followup, sequence, travel_time,
        'optimizer-' || $1
      FROM daily_assignments_current
      WHERE work_date = $2
    `, [runId, workDate, historyNextRevision]);

    await client.query(`
      INSERT INTO daily_assignments_revisions (work_date, revision, task_count, created_by, modification_type)
      VALUES ($1, $2, $3, $4, 'optimizer_auto_assign')
    `, [workDate, revisionsNextRevision, result.insertedCount, 'optimizer-' + runId]);

    await client.query('COMMIT');
    result.success = true;

  } catch (error: any) {
    await client.query('ROLLBACK');
    result.success = false;
    result.error = error.message;
    console.error(`[applyToProduction] Error:`, error);
  } finally {
    client.release();
  }

  return result;
}

// ============================================================
// WAVE-BASED OPTIMIZER
// ============================================================

export interface WaveRunResult {
  runId: string;
  workDate: string;
  priority: WavePriority;
  skipped: boolean;
  inputTasks: number;
  assignedTasks: number;
  unassignedTasks: number;
  cleanersUsed: number;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
  warnings?: string[];
}

const WAVE_PRIORITY_ALIASES: Record<string, WavePriority> = {
  early_out: 'early_out',
  high_priority: 'high_priority',
  high: 'high_priority',
  low_priority: 'low_priority',
  low: 'low_priority',
  'early-out': 'early_out'
};

function matchesWavePriority(taskPriority: string | null | undefined, wavePriority: WavePriority): boolean {
  if (!taskPriority) return false;
  const normalized = WAVE_PRIORITY_ALIASES[String(taskPriority).toLowerCase()];
  return normalized === wavePriority;
}

type TimelinePriorityState = {
  hasEoOnTimeline: boolean;
  hasHpOnTimeline: boolean;
  hasLpOnTimeline: boolean;
};

async function getManuallyMovedTaskIds(workDate: string): Promise<number[]> {
  const rows = await pool.query<{ task_id: number }>(`
    SELECT task_id
    FROM daily_assignments_current
    WHERE work_date = $1 AND manually_moved = true
  `, [workDate]);
  return rows.rows
    .map((row) => Number(row.task_id))
    .filter((id) => Number.isFinite(id));
}

function normalizePriorityValue(priority: string | null | undefined): WavePriority | null {
  if (!priority) return null;
  return WAVE_PRIORITY_ALIASES[String(priority).toLowerCase()] ?? null;
}

async function getTimelinePriorityState(workDate: string): Promise<TimelinePriorityState> {
  const rows = await pool.query<{ priority: string | null }>(`
    SELECT priority
    FROM daily_assignments_current
    WHERE work_date = $1
  `, [workDate]);

  let hasEoOnTimeline = false;
  let hasHpOnTimeline = false;
  let hasLpOnTimeline = false;

  for (const row of rows.rows) {
    const normalized = normalizePriorityValue(row.priority);
    if (normalized === 'early_out') hasEoOnTimeline = true;
    if (normalized === 'high_priority') hasHpOnTimeline = true;
    if (normalized === 'low_priority') hasLpOnTimeline = true;
  }

  return { hasEoOnTimeline, hasHpOnTimeline, hasLpOnTimeline };
}

async function getTimelineTaskIdsByPriority(workDate: string, priority: WavePriority): Promise<number[]> {
  const rows = await pool.query<{ task_id: number; priority: string | null }>(`
    SELECT task_id, priority
    FROM daily_assignments_current
    WHERE work_date = $1
  `, [workDate]);

  return rows.rows
    .filter((row) => matchesWavePriority(row.priority, priority))
    .map((row) => Number(row.task_id))
    .filter((id) => Number.isFinite(id));
}

async function getValidPlanRunIdForDate(workDate: string): Promise<string | null> {
  const planRunId = await getPlanRunIdForDate(workDate);
  if (!planRunId) return null;

  const runCheck = await pool.query<{ count: string }>(`
    SELECT COUNT(*) as count
    FROM optimizer.optimizer_run
    WHERE run_id = $1
      AND work_date = $2
      AND status = 'success'
  `, [planRunId, workDate]);

  if (parseInt(runCheck.rows[0]?.count || '0', 10) === 0) return null;

  const assignmentCheck = await pool.query<{ count: string }>(`
    SELECT COUNT(*) as count
    FROM optimizer.optimizer_assignment
    WHERE run_id = $1
  `, [planRunId]);

  if (parseInt(assignmentCheck.rows[0]?.count || '0', 10) === 0) return null;

  return planRunId;
}

function appliedSliceForWave(wavePriority: WavePriority): WavePriority[] {
  if (wavePriority === 'early_out') return ['early_out'];
  if (wavePriority === 'high_priority') return ['early_out', 'high_priority'];
  return ['early_out', 'high_priority', 'low_priority'];
}

function futureSliceForWave(wavePriority: WavePriority): WavePriority[] {
  if (wavePriority === 'early_out') return ['high_priority', 'low_priority'];
  if (wavePriority === 'high_priority') return ['low_priority'];
  return [];
}

async function synchronizeTimelineWithRunAfterRerun(
  workDate: string,
  runId: string,
  wavePriority: WavePriority
): Promise<{ success: boolean; checkinViolations: CheckinViolation[]; error?: string }> {
  const inScopePriorities = appliedSliceForWave(wavePriority);
  const futurePriorities = futureSliceForWave(wavePriority);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Enforce wave stage: drop future-priority rows that should not remain in timeline yet.
    if (futurePriorities.length > 0) {
      await client.query(
        `
          DELETE FROM daily_assignments_current
          WHERE work_date = $1
            AND priority = ANY($2::text[])
        `,
        [workDate, futurePriorities]
      );
    }

    // Align already-applied priorities (EO / EO+HP / EO+HP+LP) to the same run used as plan.
    await client.query(
      `
        UPDATE daily_assignments_current dac
        SET
          cleaner_id = oa.cleaner_id,
          reasons = oa.reasons,
          priority = oa.priority_type,
          start_time = oa.start_time::time,
          end_time = oa.end_time::time,
          followup = CASE WHEN oa.sequence > 1 THEN true ELSE false END,
          sequence = oa.sequence,
          travel_time = COALESCE(oa.travel_minutes_from_prev, 0),
          cleaner_name = c.name,
          cleaner_lastname = c.lastname,
          cleaner_role = c.role,
          cleaner_start_time = COALESCE(c.start_time, '10:00')
        FROM optimizer.optimizer_assignment oa
        LEFT JOIN cleaners c
          ON c.cleaner_id = oa.cleaner_id
         AND c.work_date = $1
        WHERE dac.work_date = $1
          AND dac.priority = ANY($3::text[])
          AND oa.run_id = $2
          AND oa.task_id = dac.task_id
          AND oa.priority_type = ANY($3::text[])
      `,
      [workDate, runId, inScopePriorities]
    );

    const affectedCleanersResult = await client.query(
      `
        SELECT DISTINCT cleaner_id
        FROM daily_assignments_current
        WHERE work_date = $1
          AND priority = ANY($2::text[])
      `,
      [workDate, inScopePriorities]
    );
    const cleanerIds: number[] = affectedCleanersResult.rows
      .map((r: any) => Number(r.cleaner_id))
      .filter((n: number) => Number.isFinite(n));

    const checkinViolations = await recalculateAffectedCleaners(client, workDate, runId, cleanerIds);
    await client.query('COMMIT');

    return { success: true, checkinViolations };
  } catch (error: any) {
    await client.query('ROLLBACK');
    return { success: false, checkinViolations: [], error: error.message };
  } finally {
    client.release();
  }
}

export async function runSingleWave(
  workDate: string,
  wavePriority: WavePriority
): Promise<WaveRunResult> {
  const startTime = Date.now();

  const result: WaveRunResult = {
    runId: '',
    workDate,
    priority: wavePriority,
    skipped: false,
    inputTasks: 0,
    assignedTasks: 0,
    unassignedTasks: 0,
    cleanersUsed: 0,
    durationMs: 0,
    status: 'partial',
  };

  try {
    console.log(`[runSingleWave] === WAVE ${wavePriority} === workDate=${workDate}`);

    const timelineCheck = await pool.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM daily_assignments_current WHERE work_date = $1`,
      [workDate]
    );
    const hasTimeline = parseInt(timelineCheck.rows[0]?.count || '0', 10) > 0;

    let runId = '';
    let usedRerun = false;
    const currentPlanRunId = await getValidPlanRunIdForDate(workDate);

    if (wavePriority === 'early_out') {
      if (!hasTimeline) {
        if (currentPlanRunId) {
          runId = currentPlanRunId;
          console.log(`[runSingleWave] Wave EO: using existing plan run ${runId}`);
        } else {
          console.log(`[runSingleWave] Wave EO: creating plan run for ${workDate}`);
          const allPhasesResult = await runAllPhases(workDate, { forceFullPipeline: true });
          if (allPhasesResult.status === 'failed') {
            result.status = 'failed';
            result.error = allPhasesResult.error;
            result.runId = allPhasesResult.runId;
            result.durationMs = Date.now() - startTime;
            return result;
          }
          runId = allPhasesResult.runId;
          await setPlanRunIdForDate(workDate, runId);
          console.log(`[runSingleWave] Wave EO: saved new plan run ${runId}`);
        }
      } else {
        const anchorTaskIds = await getManuallyMovedTaskIds(workDate);
        if (anchorTaskIds.length === 0) {
          if (currentPlanRunId) {
            runId = currentPlanRunId;
            console.log(`[runSingleWave] Wave EO: no manually moved tasks, apply from plan ${runId}`);
          } else {
            console.log(`[runSingleWave] Wave EO: timeline present but no plan, creating plan run for ${workDate}`);
            const allPhasesResult = await runAllPhases(workDate, { forceFullPipeline: true });
            if (allPhasesResult.status === 'failed') {
              result.status = 'failed';
              result.error = allPhasesResult.error;
              result.runId = allPhasesResult.runId;
              result.durationMs = Date.now() - startTime;
              return result;
            }
            runId = allPhasesResult.runId;
            await setPlanRunIdForDate(workDate, runId);
            console.log(`[runSingleWave] Wave EO: saved new plan run ${runId}`);
          }
        } else {
          console.log(`[runSingleWave] Wave EO: timeline present (${anchorTaskIds.length} manually moved), rerun with anchors`);
          const allPhasesResult = await runAllPhases(workDate, {
            forceFullPipeline: true,
            anchorTaskIds
          });
          usedRerun = true;
          if (allPhasesResult.status === 'failed') {
            result.status = 'failed';
            result.error = allPhasesResult.error;
            result.runId = allPhasesResult.runId;
            result.durationMs = Date.now() - startTime;
            return result;
          }
          runId = allPhasesResult.runId;
          await setPlanRunIdForDate(workDate, runId);
          console.log(`[runSingleWave] Wave EO: rerun complete and plan updated to ${runId}`);
        }
      }
    } else {
      const planRunId = currentPlanRunId;
      if (!planRunId) {
        result.status = 'failed';
        result.error = 'Plan run non disponibile per la data. Esegui prima la wave Early Out.';
        result.durationMs = Date.now() - startTime;
        return result;
      }

      const anchorTaskIds = await getManuallyMovedTaskIds(workDate);
      if (anchorTaskIds.length === 0) {
        runId = planRunId;
        console.log(`[runSingleWave] Wave ${wavePriority}: no manually moved tasks, apply from plan ${planRunId}`);
      } else {
        console.log(`[runSingleWave] Wave ${wavePriority}: ${anchorTaskIds.length} manually moved, rerun with anchors`);
        const allPhasesResult = await runAllPhases(workDate, {
          forceFullPipeline: true,
          anchorTaskIds
        });
        usedRerun = true;
        if (allPhasesResult.status === 'failed') {
          result.status = 'failed';
          result.error = allPhasesResult.error;
          result.runId = allPhasesResult.runId;
          result.durationMs = Date.now() - startTime;
          return result;
        }
        runId = allPhasesResult.runId;
        await setPlanRunIdForDate(workDate, runId);
        console.log(`[runSingleWave] Wave ${wavePriority}: rerun complete, plan updated to ${runId}`);
      }
    }

    result.runId = runId;

    // Count how many tasks of this priority were assigned by the optimizer
    const waveAssignmentCount = await pool.query(`
      SELECT COUNT(DISTINCT oa.task_id) as count
      FROM optimizer.optimizer_assignment oa
      JOIN daily_containers dc ON dc.task_id = oa.task_id AND dc.work_date = $2
      WHERE oa.run_id = $1
        AND dc.priority = $3
    `, [runId, workDate, wavePriority]);
    const waveAssigned = parseInt(waveAssignmentCount.rows[0]?.count || '0');

    if (waveAssigned === 0) {
      console.log(`[runSingleWave] No ${wavePriority} tasks in optimizer result, skipping apply`);
      result.skipped = true;
      result.status = 'success';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    result.inputTasks = waveAssigned;

    // Apply only the wave's priority assignments to production
    const applyResult = await applyWaveToProduction(workDate, runId, wavePriority);
    result.assignedTasks = applyResult.insertedCount;
    result.cleanersUsed = applyResult.affectedCleaners;

    if (!applyResult.success) {
      result.status = 'failed';
      result.error = applyResult.error;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    if (applyResult.checkinViolations.length > 0) {
      result.warnings = applyResult.checkinViolations.map(v =>
        `Task ${v.logisticCode}: finisce alle ${v.endTime} ma checkin alle ${v.checkinTime}`
      );
      console.warn(`[runSingleWave] ${applyResult.checkinViolations.length} checkin violations detected`);
    }

    if (usedRerun) {
      const syncResult = await synchronizeTimelineWithRunAfterRerun(workDate, runId, wavePriority);
      if (!syncResult.success) {
        result.status = 'failed';
        result.error = `Timeline sync failed after rerun: ${syncResult.error || 'unknown error'}`;
        result.durationMs = Date.now() - startTime;
        return result;
      }

      if (syncResult.checkinViolations.length > 0) {
        const extraWarnings = syncResult.checkinViolations.map(v =>
          `Task ${v.logisticCode}: finisce alle ${v.endTime} ma checkin alle ${v.checkinTime}`
        );
        result.warnings = [...(result.warnings || []), ...extraWarnings];
        console.warn(`[runSingleWave] ${syncResult.checkinViolations.length} checkin violations detected after rerun sync`);
      }
    }

    result.status = 'success';
    console.log(`[runSingleWave] Wave ${wavePriority} complete: ${result.assignedTasks} applied to timeline`);

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message;
    console.error(`[runSingleWave] Error in wave ${wavePriority}:`, error);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

export interface CheckinViolation {
  taskId: number;
  logisticCode: number;
  cleanerId: number;
  endTime: string;
  checkinTime: string;
}

export interface ApplyWaveResult {
  runId: string;
  workDate: string;
  priority: WavePriority;
  insertedCount: number;
  deletedFromContainers: number;
  affectedCleaners: number;
  checkinViolations: CheckinViolation[];
  success: boolean;
  error?: string;
}

export async function applyWaveToProduction(
  workDate: string,
  runId: string,
  wavePriority: WavePriority
): Promise<ApplyWaveResult> {
  const result: ApplyWaveResult = {
    runId,
    workDate,
    priority: wavePriority,
    insertedCount: 0,
    deletedFromContainers: 0,
    affectedCleaners: 0,
    checkinViolations: [],
    success: false,
  };

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('daily_assignments_current', 'id'),
        (SELECT COALESCE(MAX(id), 0) FROM daily_assignments_current),
        true
      )
    `);

    // Insert only assignments matching the requested priority
    const insertQuery = `
      INSERT INTO daily_assignments_current (
        work_date, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time,
        cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time,
        customer_reference, base_cleaning_time
      )
      SELECT
        $2 as work_date,
        oa.cleaner_id,
        oa.task_id,
        oa.logistic_code,
        dc.client_id,
        dc.premium,
        dc.address,
        dc.lat::numeric,
        dc.lng::numeric,
        dc.cleaning_time::integer,
        dc.checkin_date::date,
        dc.checkout_date::date,
        dc.checkin_time::time,
        dc.checkout_time::time,
        dc.pax_in::integer,
        dc.pax_out::integer,
        dc.small_equipment,
        dc.operation_id,
        dc.confirmed_operation,
        dc.straordinaria,
        dc.type_apt,
        dc.alias,
        dc.customer_name,
        oa.reasons,
        oa.priority_type as priority,
        oa.start_time::time as start_time,
        oa.end_time::time as end_time,
        CASE WHEN (bs.base_seq + oa.sequence) > 1 THEN true ELSE false END as followup,
        (bs.base_seq + oa.sequence) as sequence,
        COALESCE(oa.travel_minutes_from_prev, 0) as travel_time,
        c.name as cleaner_name,
        c.lastname as cleaner_lastname,
        c.role as cleaner_role,
        false as cleaner_premium,
        COALESCE(c.start_time, '10:00') as cleaner_start_time,
        dc.customer_reference,
        dc.cleaning_time as base_cleaning_time
      FROM optimizer.optimizer_assignment oa
      JOIN daily_containers dc ON dc.task_id = oa.task_id AND dc.work_date = $2
      LEFT JOIN cleaners c ON c.cleaner_id = oa.cleaner_id AND c.work_date = $2
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(sequence), 0) as base_seq
        FROM daily_assignments_current dac
        WHERE dac.work_date = $2 AND dac.cleaner_id = oa.cleaner_id
      ) bs ON true
      WHERE oa.run_id = $1
        AND dc.priority = $3
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_task_locks
          WHERE work_date = $2 AND locked = true
        )
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_assignments_current
          WHERE work_date = $2
        )
    `;

    const insertResult = await client.query(insertQuery, [runId, workDate, wavePriority]);
    result.insertedCount = insertResult.rowCount || 0;
    console.log(`[applyWave] Inserted ${result.insertedCount} ${wavePriority} assignments`);

    // Remove applied tasks from daily_containers
    if (result.insertedCount > 0) {
      const deleteContainersResult = await client.query(`
        DELETE FROM daily_containers
        WHERE work_date = $1
          AND task_id IN (
            SELECT task_id FROM daily_assignments_current
            WHERE work_date = $1
          )
          AND priority = $2
      `, [workDate, wavePriority]);
      result.deletedFromContainers = deleteContainersResult.rowCount || 0;
      console.log(`[applyWave] Removed ${result.deletedFromContainers} tasks from daily_containers`);
    }

    // Recalculate times for cleaners that received new tasks from this wave
    try {
      const affectedCleanersResult = await client.query(`
        SELECT DISTINCT dac.cleaner_id
        FROM daily_assignments_current dac
        WHERE dac.work_date = $1 AND dac.priority = $2
      `, [workDate, wavePriority]);
      const cleanerIds: number[] = affectedCleanersResult.rows
        .map((r: any) => Number(r.cleaner_id))
        .filter((n: number) => Number.isFinite(n));
      result.affectedCleaners = cleanerIds.length;

      const violations = await recalculateAffectedCleaners(client, workDate, runId, cleanerIds);
      result.checkinViolations = violations;
      console.log(`[applyWave] Recalculated times for ${cleanerIds.length} cleaners`);
    } catch (recalcError: any) {
      console.warn(`[applyWave] Warning: recalculation failed: ${recalcError.message}`);
    }

    // History + revision
    const historyRevisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_history WHERE work_date = $1`,
      [workDate]
    );
    const historyNextRevision = historyRevisionResult.rows[0].next_revision;

    const revisionsRevisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_revisions WHERE work_date = $1`,
      [workDate]
    );
    const revisionsNextRevision = revisionsRevisionResult.rows[0].next_revision;

    await client.query(`
      INSERT INTO daily_assignments_history (
        work_date, revision, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons, manually_moved,
        priority, start_time, end_time, followup, sequence, travel_time,
        created_by
      )
      SELECT
        work_date, $3, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons, COALESCE(manually_moved, false),
        priority, start_time, end_time, followup, sequence, travel_time,
        'wave-' || $1
      FROM daily_assignments_current
      WHERE work_date = $2
    `, [runId, workDate, historyNextRevision]);

    await client.query(`
      INSERT INTO daily_assignments_revisions (work_date, revision, task_count, created_by, modification_type)
      VALUES ($1, $2, $3, $4, 'optimizer_wave_assign')
    `, [workDate, revisionsNextRevision, result.insertedCount, 'wave-' + wavePriority + '-' + runId]);

    await client.query('COMMIT');
    result.success = true;
    console.log(`[applyWave] Wave ${wavePriority} applied successfully`);

  } catch (error: any) {
    await client.query('ROLLBACK');
    result.success = false;
    result.error = error.message;
    console.error(`[applyWave] Error applying wave ${wavePriority}:`, error);
  } finally {
    client.release();
  }

  return result;
}
