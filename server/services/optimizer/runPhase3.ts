import pool from '../../../shared/pg-db';
import { 
  runPhase3Algorithm, 
  TaskForScheduling,
  CleanerGroups,
  Phase3Event,
  GroupScheduleResult,
  Phase3TimelineConstraints
} from './phase3';
import { updateRunStatus, insertDecisionsBatch, OptimizerDecision, getLatestRunForDate } from './db';
import { loadPriorityStartWindows, mapPriorityType, priorityToDbFormat, PriorityWindows } from './priorityWindows';
import { TimelineContext } from './timelineContext';

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
  const ids = (result.rows[0].cleaners || [])
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n));
  // Determinismo: normalizza ordine cleaners
  ids.sort((a, b) => a - b);
  return ids;
}

async function loadCleanerStartTimes(workDate: string, cleanerIds: number[]): Promise<Map<number, string>> {
  if (cleanerIds.length === 0) return new Map();
  
  const result = await pool.query(`
    SELECT cleaner_id, name, start_time
    FROM cleaners
    WHERE work_date = $1 AND cleaner_id = ANY($2::int[])
    ORDER BY cleaner_id
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
    ORDER BY cleaner_id
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
      checkin_time,
      checkin_date::text as checkin_date,
      priority,
      straordinaria
    FROM daily_containers
    WHERE work_date = $1
      AND lat IS NOT NULL 
      AND lng IS NOT NULL
    ORDER BY task_id
  `, [workDate]);

  const map = new Map<number, TaskForScheduling>();
  for (const row of result.rows) {
    // Determinismo: evita dipendenze da timezone JS nel parsing di DATE
    const checkinDateStr: string | null = row.checkin_date || null;
    
    map.set(row.task_id, {
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      lat: parseFloat(row.lat),
      lng: parseFloat(row.lng),
      cleaningTimeMinutes: parseInt(row.cleaning_time_minutes, 10) || 60,
      checkoutTime: row.checkout_time,
      checkinTime: row.checkin_time,
      checkinDate: checkinDateStr,
      priorityType: mapPriorityType(row.priority),
      straordinaria: row.straordinaria === true
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
          run_id, cleaner_id, task_id, logistic_code, sequence, start_time, end_time, 
          travel_minutes_from_prev, reasons, priority_type, priority_penalty, priority_reasons
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        runId,
        group.cleanerId,
        row.taskId,
        row.logisticCode,
        row.sequence,
        row.startTime,
        row.endTime,
        row.travelMinutesFromPrev,
        [],
        priorityToDbFormat(row.priorityType),
        row.priorityPenalty,
        row.priorityReasons
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

export interface RunPhase3Options {
  timelineContext?: TimelineContext;
}

export async function runPhase3(
  workDate: string,
  runId?: string,
  options: RunPhase3Options = {}
): Promise<Phase3RunResult> {
  const startTime = Date.now();
  const { timelineContext } = options;
  
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
    const [selectedCleanerIds, tasksMap, phase2Assignments, priorityWindows] = await Promise.all([
      loadSelectedCleanerIds(workDate),
      loadTasksForScheduling(workDate),
      loadPhase2Assignments(resolvedRunId),
      loadPriorityStartWindows(resolvedRunId)
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
      
      const cg: CleanerGroups = {
        cleanerId,
        cleanerName: cleanerNames.get(cleanerId) || `Cleaner ${cleanerId}`,
        startTime: startTimes.get(cleanerId) || '09:00',
        groups
      };

      if (timelineContext?.lastFixedByCleaner) {
        const lastFixed = timelineContext.lastFixedByCleaner.get(cleanerId);
        if (lastFixed && lastFixed.lat !== null && lastFixed.lng !== null) {
          cg.anchorTask = {
            taskId: lastFixed.taskId,
            logisticCode: lastFixed.logisticCode,
            lat: lastFixed.lat,
            lng: lastFixed.lng,
            cleaningTimeMinutes: lastFixed.cleaningTimeMinutes ?? 60,
            checkoutTime: null,
            checkinTime: null,
            checkinDate: null,
            priorityType: null,
          };
          cg.anchorEndTimeStr = lastFixed.endTime || undefined;
        }
      }

      cleanerGroups.push(cg);
    });

    result.cleanersProcessed = cleanerGroups.length;

    let constraintsByCleaner: Map<number, Phase3TimelineConstraints> | undefined;
    if (timelineContext && timelineContext.occupiedBlocksByCleaner.size > 0) {
      constraintsByCleaner = new Map();
      for (const cleanerId of selectedCleanerIds) {
        const blocks = timelineContext.occupiedBlocksByCleaner.get(cleanerId);
        const anchors = timelineContext.anchorPointsByCleaner.get(cleanerId);
        if (blocks || anchors) {
          constraintsByCleaner.set(cleanerId, {
            occupiedBlocks: blocks ?? [],
            anchors: anchors
          });
        }
      }
      console.log(`[Phase3] Using timeline constraints for ${constraintsByCleaner.size} cleaners`);
    }

    const phase3Result = runPhase3Algorithm(workDate, cleanerGroups, tasksMap, priorityWindows, constraintsByCleaner);

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
      priority_penalty_total: phase3Result.stats.priorityPenaltyTotal,
      priority_violations_total: phase3Result.stats.priorityViolationsTotal,
      violations_by_type: phase3Result.stats.violationsByType,
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
