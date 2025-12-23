import pool from '../../../shared/pg-db';
import { 
  runPhase3Algorithm, 
  TaskForScheduling,
  CleanerGroups,
  Phase3Event,
  GroupScheduleResult
} from './phase3';
import { updateRunStatus, insertDecisionsBatch, OptimizerDecision, getLatestRunForDate } from './db';

export interface Phase3RunResult {
  runId: string;
  workDate: string;
  selectedCleanersCount: number;
  cleanersProcessed: number;
  tasksLoaded: number;
  tasksScheduled: number;
  tasksUnassigned: number;
  assignmentsInserted: number;
  unassignedInserted: number;
  decisionsInserted: number;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
}

async function loadSelectedCleanerIds(workDate: string): Promise<number[]> {
  const result = await pool.query(`
    SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1
  `, [workDate]);
  
  if (result.rows.length === 0 || !result.rows[0].cleaners) {
    return [];
  }
  return (result.rows[0].cleaners || [])
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n));
}

async function loadCleanerStartTimes(workDate: string, cleanerIds: number[]): Promise<Map<number, string>> {
  if (cleanerIds.length === 0) return new Map();
  
  const result = await pool.query(`
    SELECT cleaner_id, name, start_time
    FROM cleaners
    WHERE work_date = $1 AND cleaner_id = ANY($2::int[])
  `, [workDate, cleanerIds]);
  
  const map = new Map<number, string>();
  for (const row of result.rows) {
    map.set(row.cleaner_id, row.start_time || '09:00');
  }
  return map;
}

async function loadCleanerNames(workDate: string, cleanerIds: number[]): Promise<Map<number, string>> {
  if (cleanerIds.length === 0) return new Map();
  
  const result = await pool.query(`
    SELECT cleaner_id, name
    FROM cleaners
    WHERE work_date = $1 AND cleaner_id = ANY($2::int[])
  `, [workDate, cleanerIds]);
  
  const map = new Map<number, string>();
  for (const row of result.rows) {
    map.set(row.cleaner_id, row.name);
  }
  return map;
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
      checkin_time
    FROM daily_containers
    WHERE work_date = $1
      AND lat IS NOT NULL 
      AND lng IS NOT NULL
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
      checkinTime: row.checkin_time
    });
  }
  return map;
}

async function loadPhase2Assignments(runId: string): Promise<Map<number, { taskIds: number[]; score: number }[]>> {
  const result = await pool.query(`
    SELECT payload
    FROM optimizer.optimizer_decision
    WHERE run_id = $1 AND phase = 2 AND event_type = 'PHASE2_GROUP_ASSIGNED'
    ORDER BY id
  `, [runId]);

  const cleanerGroups = new Map<number, { taskIds: number[]; score: number }[]>();
  
  for (const row of result.rows) {
    const payload = row.payload;
    const cleanerId = payload.cleaner_id || payload.cleanerId;
    const taskIds = payload.task_ids || payload.taskIds || payload.group_tasks || [];
    const score = payload.score || 0;

    if (!cleanerId || taskIds.length === 0) continue;

    if (!cleanerGroups.has(cleanerId)) {
      cleanerGroups.set(cleanerId, []);
    }
    cleanerGroups.get(cleanerId)!.push({ taskIds, score });
  }

  return cleanerGroups;
}

function eventToDecision(runId: string, event: Phase3Event): OptimizerDecision {
  return {
    runId,
    phase: 3,
    eventType: event.eventType,
    payload: event.payload as Record<string, any>
  };
}

async function insertAssignments(
  runId: string,
  scheduledGroups: GroupScheduleResult[]
): Promise<number> {
  let inserted = 0;
  
  for (const group of scheduledGroups) {
    for (const row of group.scheduleRows) {
      await pool.query(`
        INSERT INTO optimizer.optimizer_assignment (
          run_id, cleaner_id, task_id, logistic_code, sequence, start_time, end_time, travel_minutes_from_prev, reasons
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        runId,
        group.cleanerId,
        row.taskId,
        row.logisticCode,
        row.sequence,
        row.startTime,
        row.endTime,
        row.travelMinutesFromPrev,
        []
      ]);
      inserted++;
    }
  }
  
  return inserted;
}

async function insertUnassigned(
  runId: string,
  unassigned: { taskId: number; reasonCode: string; details: Record<string, any> }[]
): Promise<number> {
  if (unassigned.length === 0) return 0;
  
  for (const item of unassigned) {
    const logisticCode = item.details.logistic_code || null;
    await pool.query(`
      INSERT INTO optimizer.optimizer_unassigned (run_id, task_id, logistic_code, reason_code, details)
      VALUES ($1, $2, $3, $4, $5)
    `, [runId, item.taskId, logisticCode, item.reasonCode, JSON.stringify(item.details)]);
  }
  
  return unassigned.length;
}

export async function runPhase3(
  workDate: string,
  runId?: string
): Promise<Phase3RunResult> {
  const startTime = Date.now();
  
  const resolvedRunId = runId || (await getLatestRunForDate(workDate))?.runId;
  
  const result: Phase3RunResult = {
    runId: resolvedRunId || '',
    workDate,
    selectedCleanersCount: 0,
    cleanersProcessed: 0,
    tasksLoaded: 0,
    tasksScheduled: 0,
    tasksUnassigned: 0,
    assignmentsInserted: 0,
    unassignedInserted: 0,
    decisionsInserted: 0,
    durationMs: 0,
    status: 'partial'
  };

  if (!resolvedRunId) {
    result.status = 'failed';
    result.error = 'No optimizer run found for this date. Run Phase 1 and Phase 2 first.';
    result.durationMs = Date.now() - startTime;
    return result;
  }

  try {
    const [selectedCleanerIds, tasksMap, phase2Assignments] = await Promise.all([
      loadSelectedCleanerIds(workDate),
      loadTasksForScheduling(workDate),
      loadPhase2Assignments(resolvedRunId)
    ]);

    result.selectedCleanersCount = selectedCleanerIds.length;
    result.tasksLoaded = tasksMap.size;

    if (selectedCleanerIds.length === 0) {
      const noCleanerEvents: Phase3Event[] = [{
        eventType: 'PHASE3_NO_SELECTED_CLEANERS',
        payload: {
          work_date: workDate,
          reason: 'NO_SELECTED_CLEANERS',
          tasks_count: tasksMap.size
        }
      }];

      const decisions = noCleanerEvents.map(e => eventToDecision(resolvedRunId, e));
      result.decisionsInserted = await insertDecisionsBatch(decisions);
      result.status = 'success';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    if (phase2Assignments.size === 0) {
      const noAssignmentsEvents: Phase3Event[] = [{
        eventType: 'PHASE3_NO_PHASE2_ASSIGNMENTS',
        payload: {
          work_date: workDate,
          reason: 'NO_PHASE2_GROUP_ASSIGNMENTS',
          selected_cleaners_count: selectedCleanerIds.length
        }
      }];

      const decisions = noAssignmentsEvents.map(e => eventToDecision(resolvedRunId, e));
      result.decisionsInserted = await insertDecisionsBatch(decisions);
      result.status = 'success';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const cleanerIdsWithAssignments = Array.from(phase2Assignments.keys());
    const [startTimes, cleanerNames] = await Promise.all([
      loadCleanerStartTimes(workDate, cleanerIdsWithAssignments),
      loadCleanerNames(workDate, cleanerIdsWithAssignments)
    ]);

    const cleanerGroups: CleanerGroups[] = [];
    phase2Assignments.forEach((groups, cleanerId) => {
      if (!selectedCleanerIds.includes(cleanerId)) return;
      
      cleanerGroups.push({
        cleanerId,
        cleanerName: cleanerNames.get(cleanerId) || `Cleaner ${cleanerId}`,
        startTime: startTimes.get(cleanerId) || '09:00',
        groups
      });
    });

    result.cleanersProcessed = cleanerGroups.length;

    const phase3Result = runPhase3Algorithm(workDate, cleanerGroups, tasksMap);

    result.tasksScheduled = phase3Result.stats.tasksScheduled;
    result.tasksUnassigned = phase3Result.stats.tasksUnassigned;

    result.assignmentsInserted = await insertAssignments(resolvedRunId, phase3Result.scheduledGroups);
    result.unassignedInserted = await insertUnassigned(resolvedRunId, phase3Result.unassignedTasks);

    const decisions = phase3Result.events.map(e => eventToDecision(resolvedRunId, e));
    result.decisionsInserted = await insertDecisionsBatch(decisions);

    const summary = {
      phase: 3,
      selected_cleaners_count: result.selectedCleanersCount,
      cleaners_processed: result.cleanersProcessed,
      tasks_loaded: result.tasksLoaded,
      tasks_scheduled: result.tasksScheduled,
      tasks_unassigned: result.tasksUnassigned,
      assignments_inserted: result.assignmentsInserted,
      unassigned_inserted: result.unassignedInserted,
      decisions_inserted: result.decisionsInserted,
      duration_ms: Date.now() - startTime
    };

    await updateRunStatus(resolvedRunId, 'success', summary);
    result.status = 'success';

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message || 'Unknown error';
    console.error('Phase 3 error:', error);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}
