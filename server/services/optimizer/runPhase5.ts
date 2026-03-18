import pool from '../../../shared/pg-db';
import {
  runPhase5Algorithm,
  Phase5Params,
  DEFAULT_PHASE5_PARAMS,
  Phase5Event
} from './phase5';
import { TaskForScheduling, Phase3TimelineConstraints } from './phase3';
import { CleanerSchedule } from './phase4';
import { updateRunStatus, insertDecisionsBatch, OptimizerDecision, getLatestRunForDate, loadLockedCleanerIds } from './db';
import { loadPriorityStartWindows, mapPriorityType, priorityToDbFormat } from './priorityWindows';
import { TimelineContext } from './timelineContext';

export interface Phase5RunResult {
  runId: string;
  workDate: string;
  schedulesLoaded: number;
  relocationsExecuted: number;
  swapsExecuted: number;
  fairnessRelocations: number;
  travelBefore: number;
  travelAfter: number;
  travelReduced: number;
  loadSpreadBefore: number;
  loadSpreadAfter: number;
  assignmentsUpdated: number;
  decisionsInserted: number;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
}

async function loadSchedulesFromAssignments(runId: string, workDate: string): Promise<CleanerSchedule[]> {
  const selectedCleanersResult = await pool.query(`
    SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1
  `, [workDate]);

  const allCleanerIds: number[] = (selectedCleanersResult.rows[0]?.cleaners || [])
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n))
    .sort((a: number, b: number) => a - b);

  const result = await pool.query(`
    SELECT 
      oa.cleaner_id,
      oa.task_id,
      oa.logistic_code,
      oa.sequence,
      oa.start_time,
      oa.end_time,
      oa.travel_minutes_from_prev,
      oa.priority_type,
      oa.priority_penalty,
      COALESCE(dc.cleaning_time, 60) as cleaning_time_minutes
    FROM optimizer.optimizer_assignment oa
    LEFT JOIN daily_containers dc ON dc.task_id = oa.task_id AND dc.work_date = $2
    WHERE oa.run_id = $1
    ORDER BY oa.cleaner_id, oa.sequence
  `, [runId, workDate]);

  const cleanerMap = new Map<number, {
    tasks: any[];
    maxEndTime: Date | null;
    totalTravel: number;
    totalPriorityPenalty: number;
  }>();

  for (const cleanerId of allCleanerIds) {
    cleanerMap.set(cleanerId, { tasks: [], maxEndTime: null, totalTravel: 0, totalPriorityPenalty: 0 });
  }

  for (const row of result.rows) {
    if (!cleanerMap.has(row.cleaner_id)) {
      cleanerMap.set(row.cleaner_id, { tasks: [], maxEndTime: null, totalTravel: 0, totalPriorityPenalty: 0 });
    }
    const c = cleanerMap.get(row.cleaner_id)!;
    c.tasks.push({
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      sequence: row.sequence,
      startTime: row.start_time,
      endTime: row.end_time,
      travelMinutesFromPrev: row.travel_minutes_from_prev || 0,
      waitMinutes: 0,
      priorityType: row.priority_type,
      priorityPenalty: row.priority_penalty || 0,
      priorityReasons: [],
      cleaningTimeMinutes: parseInt(row.cleaning_time_minutes, 10) || 60
    });
    c.totalTravel += row.travel_minutes_from_prev || 0;
    c.totalPriorityPenalty += row.priority_penalty || 0;
    if (row.end_time) {
      const d = new Date(row.end_time);
      if (!c.maxEndTime || d > c.maxEndTime) c.maxEndTime = d;
    }
  }

  const capsResult = await pool.query(`
    SELECT cleaner_id, name, COALESCE(role, 'Standard') as role,
           COALESCE(contract_type, 'C') as contract_type,
           COALESCE(start_time, '09:00') as start_time
    FROM cleaners
    WHERE cleaner_id = ANY($1::int[]) AND work_date = $2
    ORDER BY cleaner_id
  `, [allCleanerIds, workDate]);

  const caps = new Map<number, { name: string; role: string; contractType: string; startTime: string }>();
  for (const row of capsResult.rows) {
    caps.set(row.cleaner_id, {
      name: row.name || `Cleaner ${row.cleaner_id}`,
      role: row.role,
      contractType: row.contract_type,
      startTime: row.start_time
    });
  }

  const schedules: CleanerSchedule[] = [];
  cleanerMap.forEach((data, cleanerId) => {
    const cap = caps.get(cleanerId);
    const endMin = data.maxEndTime
      ? data.maxEndTime.getUTCHours() * 60 + data.maxEndTime.getUTCMinutes()
      : 540;

    const totalWorkMinutes = data.tasks.reduce(
      (sum: number, t: any) => sum + (t.cleaningTimeMinutes ?? 60), 0
    );

    schedules.push({
      cleanerId,
      cleanerName: cap?.name || `Cleaner ${cleanerId}`,
      startTime: cap?.startTime || '09:00',
      tasks: data.tasks,
      endTimeMinutes: endMin,
      totalTravel: data.totalTravel,
      totalWait: 0,
      totalPriorityPenalty: data.totalPriorityPenalty,
      role: cap?.role || 'Standard',
      contractType: cap?.contractType || 'C',
      totalWorkMinutes
    });
  });

  return schedules;
}

async function loadTasksForScheduling(workDate: string): Promise<Map<number, TaskForScheduling>> {
  const result = await pool.query(`
    SELECT 
      task_id, logistic_code, lat, lng,
      COALESCE(cleaning_time, 60) as cleaning_time_minutes,
      checkout_time, checkin_time, checkin_date::text as checkin_date,
      priority, straordinaria,
      COALESCE(premium, false) as premium,
      COALESCE(type_apt, 'C') as type_apt
    FROM daily_containers
    WHERE work_date = $1 AND lat IS NOT NULL AND lng IS NOT NULL
    ORDER BY task_id
  `, [workDate]);

  const map = new Map<number, TaskForScheduling>();
  for (const row of result.rows) {
    map.set(row.task_id, {
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      lat: parseFloat(row.lat),
      lng: parseFloat(row.lng),
      cleaningTimeMinutes: parseInt(row.cleaning_time_minutes, 10) || 60,
      checkoutTime: row.checkout_time,
      checkinTime: row.checkin_time,
      checkinDate: row.checkin_date || null,
      priorityType: mapPriorityType(row.priority),
      straordinaria: row.straordinaria === true,
      premium: row.premium === true,
      typeApt: row.type_apt
    });
  }
  return map;
}

async function updateAssignments(runId: string, schedules: CleanerSchedule[]): Promise<number> {
  await pool.query(`DELETE FROM optimizer.optimizer_assignment WHERE run_id = $1`, [runId]);

  let inserted = 0;
  const seenTaskIds = new Set<number>();

  for (const schedule of schedules) {
    for (const row of schedule.tasks) {
      if (seenTaskIds.has(row.taskId)) continue;
      seenTaskIds.add(row.taskId);

      await pool.query(`
        INSERT INTO optimizer.optimizer_assignment (
          run_id, cleaner_id, task_id, logistic_code, sequence, start_time, end_time,
          travel_minutes_from_prev, reasons, priority_type, priority_penalty, priority_reasons
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        runId,
        schedule.cleanerId,
        row.taskId,
        row.logisticCode,
        row.sequence,
        row.startTime,
        row.endTime,
        row.travelMinutesFromPrev,
        [],
        priorityToDbFormat(row.priorityType),
        row.priorityPenalty,
        row.priorityReasons || []
      ]);
      inserted++;
    }
  }

  return inserted;
}

function eventToDecision(runId: string, event: Phase5Event): OptimizerDecision {
  return {
    runId,
    phase: 5,
    eventType: event.eventType,
    payload: event.payload as Record<string, any>
  };
}

export interface RunPhase5Options {
  params?: Partial<Phase5Params>;
  timelineContext?: TimelineContext;
}

export async function runPhase5(
  workDate?: string,
  runId?: string,
  options: RunPhase5Options = {}
): Promise<Phase5RunResult> {
  const startTime = Date.now();
  const params = options.params ?? {};
  const timelineContext = options.timelineContext;

  let resolvedRunId = runId;
  let resolvedWorkDate = workDate;

  if (!resolvedRunId && resolvedWorkDate) {
    const latestRun = await getLatestRunForDate(resolvedWorkDate);
    resolvedRunId = latestRun?.runId;
  }

  const result: Phase5RunResult = {
    runId: resolvedRunId || '',
    workDate: resolvedWorkDate || '',
    schedulesLoaded: 0,
    relocationsExecuted: 0,
    swapsExecuted: 0,
    fairnessRelocations: 0,
    travelBefore: 0,
    travelAfter: 0,
    travelReduced: 0,
    loadSpreadBefore: 0,
    loadSpreadAfter: 0,
    assignmentsUpdated: 0,
    decisionsInserted: 0,
    durationMs: 0,
    status: 'partial'
  };

  if (!resolvedRunId || !resolvedWorkDate) {
    result.status = 'failed';
    result.error = 'No optimizer run found for this date.';
    result.durationMs = Date.now() - startTime;
    return result;
  }

  try {
    const fullParams: Phase5Params = { ...DEFAULT_PHASE5_PARAMS, ...params };

    const [schedules, tasksMap, priorityWindows, lockedCleanerIds] = await Promise.all([
      loadSchedulesFromAssignments(resolvedRunId, resolvedWorkDate),
      loadTasksForScheduling(resolvedWorkDate),
      loadPriorityStartWindows(resolvedRunId),
      loadLockedCleanerIds(resolvedWorkDate)
    ]);

    result.schedulesLoaded = schedules.length;

    const totalTasks = schedules.reduce((sum, s) => sum + s.tasks.length, 0);
    if (totalTasks <= 1) {
      result.status = 'success';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Enrich schedules with pre-existing load from timeline so fairness
    // correctly accounts for manually assigned tasks.
    if (timelineContext) {
      for (const schedule of schedules) {
        const fixedStats = timelineContext.fixedStatsByCleaner.get(schedule.cleanerId);
        if (fixedStats) {
          schedule.fixedTaskCount = fixedStats.fixedTaskCount;
          schedule.fixedWorkMinutes = fixedStats.fixedWorkMinutes;
          schedule.fixedTravelMinutes = fixedStats.fixedTravelMinutes;
          schedule.fixedHasAnyOT = fixedStats.fixedHasAnyOT;
          schedule.fixedHasLongOT = fixedStats.fixedHasLongOT;
        }
      }
    }

    const constraintsByCleaner = new Map<string, Phase3TimelineConstraints>();
    if (timelineContext) {
      timelineContext.occupiedBlocksByCleaner.forEach((blocks, cleanerId) => {
        const anchors = timelineContext.anchorPointsByCleaner.get(cleanerId);
        constraintsByCleaner.set(String(cleanerId), {
          occupiedBlocks: blocks,
          anchors
        });
      });
    }

    const phase5Result = await runPhase5Algorithm(
      resolvedWorkDate,
      schedules,
      tasksMap,
      priorityWindows,
      fullParams,
      constraintsByCleaner,
      lockedCleanerIds
    );

    result.relocationsExecuted = phase5Result.stats.relocationsExecuted;
    result.swapsExecuted = phase5Result.stats.swapsExecuted;
    result.fairnessRelocations = phase5Result.stats.fairnessRelocations;
    result.travelBefore = phase5Result.stats.travelBefore;
    result.travelAfter = phase5Result.stats.travelAfter;
    result.travelReduced = phase5Result.stats.travelReduced;
    result.loadSpreadBefore = phase5Result.stats.loadSpreadBefore;
    result.loadSpreadAfter = phase5Result.stats.loadSpreadAfter;

    const totalMoves = phase5Result.stats.relocationsExecuted + phase5Result.stats.swapsExecuted + phase5Result.stats.fairnessRelocations;
    if (totalMoves > 0) {
      result.assignmentsUpdated = await updateAssignments(resolvedRunId, phase5Result.updatedSchedules);
    }

    const decisions = phase5Result.events.map(e => eventToDecision(resolvedRunId!, e));
    result.decisionsInserted = await insertDecisionsBatch(decisions);

    result.status = 'success';
  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message || 'Unknown error';
    console.error('Phase 5 error:', error);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
