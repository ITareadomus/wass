import pool from '../../../shared/pg-db';
import { 
  runPhase4Algorithm, 
  Phase4Params, 
  DEFAULT_PHASE4_PARAMS,
  CleanerSchedule,
  Phase4Event
} from './phase4';
import { TaskForScheduling } from './phase3';
import { updateRunStatus, insertDecisionsBatch, OptimizerDecision, getLatestRunForDate } from './db';
import { loadPriorityStartWindows, mapPriorityType } from './priorityWindows';

export interface Phase4RunResult {
  runId: string;
  workDate: string;
  schedulesLoaded: number;
  unassignedLoaded: number;
  insertedCount: number;
  singleAssignedCount: number;
  remainUnassignedCount: number;
  assignmentsUpdated: number;
  unassignedUpdated: number;
  decisionsInserted: number;
  iterationsUsed: number;
  coverageImprovement: number;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
}

async function loadPhase3Schedules(runId: string): Promise<CleanerSchedule[]> {
  const result = await pool.query(`
    SELECT 
      cleaner_id,
      task_id,
      logistic_code,
      sequence,
      start_time,
      end_time,
      travel_minutes_from_prev,
      priority_type,
      priority_penalty
    FROM optimizer.optimizer_assignment
    WHERE run_id = $1
    ORDER BY cleaner_id, sequence
  `, [runId]);

  const cleanerMap = new Map<number, {
    tasks: any[];
    minStartTime: Date | null;
    maxEndTime: Date | null;
    totalTravel: number;
    totalPriorityPenalty: number;
  }>();

  for (const row of result.rows) {
    if (!cleanerMap.has(row.cleaner_id)) {
      cleanerMap.set(row.cleaner_id, {
        tasks: [],
        minStartTime: null,
        maxEndTime: null,
        totalTravel: 0,
        totalPriorityPenalty: 0
      });
    }
    
    const cleaner = cleanerMap.get(row.cleaner_id)!;
    
    cleaner.tasks.push({
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      sequence: row.sequence,
      startTime: row.start_time,
      endTime: row.end_time,
      travelMinutesFromPrev: row.travel_minutes_from_prev || 0,
      waitMinutes: 0,
      priorityType: row.priority_type,
      priorityPenalty: row.priority_penalty || 0,
      priorityReasons: []
    });
    
    cleaner.totalTravel += row.travel_minutes_from_prev || 0;
    cleaner.totalPriorityPenalty += row.priority_penalty || 0;
    
    if (row.start_time) {
      const startDate = new Date(row.start_time);
      if (!cleaner.minStartTime || startDate < cleaner.minStartTime) {
        cleaner.minStartTime = startDate;
      }
    }
    if (row.end_time) {
      const endDate = new Date(row.end_time);
      if (!cleaner.maxEndTime || endDate > cleaner.maxEndTime) {
        cleaner.maxEndTime = endDate;
      }
    }
  }

  const cleanerNames = await loadCleanerNames(runId);
  const cleanerStartTimes = await loadCleanerStartTimes(runId);

  const schedules: CleanerSchedule[] = [];
  cleanerMap.forEach((data, cleanerId) => {
    const startTimeStr = cleanerStartTimes.get(cleanerId) || '09:00';
    const endTimeMinutes = data.maxEndTime 
      ? data.maxEndTime.getHours() * 60 + data.maxEndTime.getMinutes()
      : 540;
    
    schedules.push({
      cleanerId,
      cleanerName: cleanerNames.get(cleanerId) || `Cleaner ${cleanerId}`,
      startTime: startTimeStr,
      tasks: data.tasks,
      endTimeMinutes,
      totalTravel: data.totalTravel,
      totalWait: 0,
      totalPriorityPenalty: data.totalPriorityPenalty
    });
  });

  return schedules;
}

async function loadCleanerNames(runId: string): Promise<Map<number, string>> {
  const run = await getLatestRunForDate('');
  
  const result = await pool.query(`
    SELECT DISTINCT cleaner_id FROM optimizer.optimizer_assignment WHERE run_id = $1
  `, [runId]);
  
  const cleanerIds = result.rows.map(r => r.cleaner_id);
  if (cleanerIds.length === 0) return new Map();

  const namesResult = await pool.query(`
    SELECT cleaner_id, name FROM cleaners WHERE cleaner_id = ANY($1::int[])
  `, [cleanerIds]);

  const map = new Map<number, string>();
  for (const row of namesResult.rows) {
    map.set(row.cleaner_id, row.name);
  }
  return map;
}

async function loadCleanerStartTimes(runId: string): Promise<Map<number, string>> {
  const result = await pool.query(`
    SELECT DISTINCT cleaner_id FROM optimizer.optimizer_assignment WHERE run_id = $1
  `, [runId]);
  
  const cleanerIds = result.rows.map(r => r.cleaner_id);
  if (cleanerIds.length === 0) return new Map();

  const timesResult = await pool.query(`
    SELECT cleaner_id, start_time FROM cleaners WHERE cleaner_id = ANY($1::int[])
  `, [cleanerIds]);

  const map = new Map<number, string>();
  for (const row of timesResult.rows) {
    map.set(row.cleaner_id, row.start_time || '09:00');
  }
  return map;
}

async function loadUnassignedTasks(runId: string): Promise<{ taskId: number; reasonCode: string; details: Record<string, any> }[]> {
  const result = await pool.query(`
    SELECT task_id, logistic_code, reason_code, details
    FROM optimizer.optimizer_unassigned
    WHERE run_id = $1
  `, [runId]);

  return result.rows.map(row => ({
    taskId: row.task_id,
    reasonCode: row.reason_code,
    details: row.details || {}
  }));
}

async function loadTasksForScheduling(workDate: string): Promise<Map<number, TaskForScheduling>> {
  const result = await pool.query(`
    SELECT 
      task_id,
      logistic_code,
      lat,
      lng,
      COALESCE(cleaning_time, 60) as cleaning_time_minutes,
      checkout_time,
      checkin_time,
      checkin_date,
      priority
    FROM daily_containers
    WHERE work_date = $1
      AND lat IS NOT NULL 
      AND lng IS NOT NULL
  `, [workDate]);

  const map = new Map<number, TaskForScheduling>();
  for (const row of result.rows) {
    let checkinDateStr: string | null = null;
    if (row.checkin_date) {
      const d = new Date(row.checkin_date);
      checkinDateStr = d.toISOString().slice(0, 10);
    }
    
    map.set(row.task_id, {
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      lat: parseFloat(row.lat),
      lng: parseFloat(row.lng),
      cleaningTimeMinutes: parseInt(row.cleaning_time_minutes, 10) || 60,
      checkoutTime: row.checkout_time,
      checkinTime: row.checkin_time,
      checkinDate: checkinDateStr,
      priorityType: mapPriorityType(row.priority)
    });
  }
  return map;
}

async function getWorkDateFromRun(runId: string): Promise<string | null> {
  const result = await pool.query(`
    SELECT work_date FROM optimizer.optimizer_run WHERE run_id = $1
  `, [runId]);
  
  if (result.rows.length === 0) return null;
  
  const workDate = result.rows[0].work_date;
  if (workDate instanceof Date) {
    return workDate.toISOString().slice(0, 10);
  }
  return workDate;
}

function eventToDecision(runId: string, event: Phase4Event): OptimizerDecision {
  return {
    runId,
    phase: 4,
    eventType: event.eventType,
    payload: event.payload as Record<string, any>
  };
}

async function clearPhase4Data(runId: string): Promise<void> {
  await pool.query(`
    DELETE FROM optimizer.optimizer_decision 
    WHERE run_id = $1 AND phase = 4
  `, [runId]);
}

async function updateAssignments(
  runId: string,
  schedules: CleanerSchedule[]
): Promise<number> {
  await pool.query(`
    DELETE FROM optimizer.optimizer_assignment WHERE run_id = $1
  `, [runId]);

  let inserted = 0;
  
  for (const schedule of schedules) {
    for (const row of schedule.tasks) {
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
        row.priorityType,
        row.priorityPenalty,
        row.priorityReasons || []
      ]);
      inserted++;
    }
  }
  
  return inserted;
}

async function updateUnassigned(
  runId: string,
  taskResults: { taskId: number; logisticCode: number; status: string; reason?: string }[],
  tasksMap: Map<number, TaskForScheduling>
): Promise<number> {
  await pool.query(`
    DELETE FROM optimizer.optimizer_unassigned WHERE run_id = $1
  `, [runId]);

  const remainUnassigned = taskResults.filter(r => r.status === 'remain_unassigned');
  
  for (const item of remainUnassigned) {
    const task = tasksMap.get(item.taskId);
    await pool.query(`
      INSERT INTO optimizer.optimizer_unassigned (run_id, task_id, logistic_code, reason_code, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      runId, 
      item.taskId, 
      task?.logisticCode || item.logisticCode,
      item.reason || 'PHASE4_NO_FEASIBLE_INSERTION',
      JSON.stringify({ phase: 4, original_reason: item.reason })
    ]);
  }
  
  return remainUnassigned.length;
}

export async function runPhase4(
  workDate?: string,
  runId?: string,
  params: Partial<Phase4Params> = {}
): Promise<Phase4RunResult> {
  const startTime = Date.now();
  
  let resolvedRunId = runId;
  let resolvedWorkDate = workDate;
  
  if (!resolvedRunId && resolvedWorkDate) {
    const latestRun = await getLatestRunForDate(resolvedWorkDate);
    resolvedRunId = latestRun?.runId;
  }
  
  if (resolvedRunId && !resolvedWorkDate) {
    resolvedWorkDate = await getWorkDateFromRun(resolvedRunId) || undefined;
  }
  
  const result: Phase4RunResult = {
    runId: resolvedRunId || '',
    workDate: resolvedWorkDate || '',
    schedulesLoaded: 0,
    unassignedLoaded: 0,
    insertedCount: 0,
    singleAssignedCount: 0,
    remainUnassignedCount: 0,
    assignmentsUpdated: 0,
    unassignedUpdated: 0,
    decisionsInserted: 0,
    iterationsUsed: 0,
    coverageImprovement: 0,
    durationMs: 0,
    status: 'partial'
  };

  if (!resolvedRunId || !resolvedWorkDate) {
    result.status = 'failed';
    result.error = 'No optimizer run found for this date. Run Phase 1-3 first.';
    result.durationMs = Date.now() - startTime;
    return result;
  }

  try {
    const fullParams: Phase4Params = { ...DEFAULT_PHASE4_PARAMS, ...params };

    const [schedules, unassignedTasks, tasksMap, priorityWindows] = await Promise.all([
      loadPhase3Schedules(resolvedRunId),
      loadUnassignedTasks(resolvedRunId),
      loadTasksForScheduling(resolvedWorkDate),
      loadPriorityStartWindows(resolvedRunId)
    ]);

    result.schedulesLoaded = schedules.length;
    result.unassignedLoaded = unassignedTasks.length;

    if (unassignedTasks.length === 0) {
      const noWorkEvents: Phase4Event[] = [{
        eventType: 'PHASE4_NO_UNASSIGNED_TASKS',
        payload: {
          work_date: resolvedWorkDate,
          schedules_count: schedules.length
        }
      }];

      const decisions = noWorkEvents.map(e => eventToDecision(resolvedRunId!, e));
      result.decisionsInserted = await insertDecisionsBatch(decisions);
      result.status = 'success';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await clearPhase4Data(resolvedRunId);

    const phase4Result = runPhase4Algorithm(
      resolvedWorkDate,
      schedules,
      unassignedTasks,
      tasksMap,
      priorityWindows,
      fullParams
    );

    result.insertedCount = phase4Result.stats.insertedCount;
    result.singleAssignedCount = phase4Result.stats.singleAssignedCount;
    result.remainUnassignedCount = phase4Result.stats.remainUnassignedCount;
    result.iterationsUsed = phase4Result.stats.iterationsUsed;
    result.coverageImprovement = phase4Result.stats.coverageImprovement;

    result.assignmentsUpdated = await updateAssignments(resolvedRunId, phase4Result.updatedSchedules);
    result.unassignedUpdated = await updateUnassigned(resolvedRunId, phase4Result.taskResults, tasksMap);

    const decisions = phase4Result.events.map(e => eventToDecision(resolvedRunId!, e));
    result.decisionsInserted = await insertDecisionsBatch(decisions);

    const summary = {
      phase: 4,
      schedules_loaded: result.schedulesLoaded,
      unassigned_loaded: result.unassignedLoaded,
      inserted_count: result.insertedCount,
      single_assigned_count: result.singleAssignedCount,
      remain_unassigned_count: result.remainUnassignedCount,
      assignments_updated: result.assignmentsUpdated,
      unassigned_updated: result.unassignedUpdated,
      decisions_inserted: result.decisionsInserted,
      iterations_used: result.iterationsUsed,
      coverage_improvement: result.coverageImprovement,
      duration_ms: Date.now() - startTime
    };

    await updateRunStatus(resolvedRunId, 'success', summary);
    result.status = 'success';

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message || 'Unknown error';
    console.error('Phase 4 error:', error);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
