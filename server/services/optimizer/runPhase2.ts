import pool from '../../../shared/pg-db';
import { 
  runPhase2Algorithm, 
  Phase2Params, 
  DEFAULT_PHASE2_PARAMS,
  CleanerInput,
  TaskForPhase2,
  GroupCandidate,
  Phase2Event,
  Phase2InitialState
} from './phase2';
import { updateRunStatus, insertDecisionsBatch, OptimizerDecision } from './db';

export interface Phase2RunResult {
  runId: string;
  workDate: string;
  phase1RunId: string;
  selectedCleanersCount: number;
  availableCleanersBeforeFilter: number;
  cleanersLoaded: number;
  tasksLoaded: number;
  groupsProcessed: number;
  groupsAssigned: number;
  groupsUnassigned: number;
  tasksDropped: number;
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

async function loadCleanersForDate(workDate: string): Promise<CleanerInput[]> {
  const result = await pool.query(`
    SELECT 
      cleaner_id as "cleanerId",
      name,
      role,
      contract_type as "contractType",
      can_do_straordinaria as "canDoStraordinaria",
      preferred_customers as "preferredCustomers",
      counter_hours as "counterHours"
    FROM cleaners
    WHERE work_date = $1
      AND available = true
      AND active = true
    ORDER BY cleaner_id
  `, [workDate]);

  return result.rows.map(row => ({
    cleanerId: row.cleanerId,
    name: row.name,
    role: row.role || 'Standard',
    contractType: row.contractType || 'C',
    canDoStraordinaria: row.canDoStraordinaria || false,
    preferredCustomers: row.preferredCustomers || [],
    counterHours: parseFloat(row.counterHours) || 0
  }));
}

async function loadTasksForPhase2(workDate: string): Promise<Map<number, TaskForPhase2>> {
  const result = await pool.query(`
    SELECT 
      task_id as "taskId",
      logistic_code as "logisticCode",
      lat,
      lng,
      client_id as "clientId",
      premium,
      straordinaria,
      type_apt as "typeApt",
      priority,
      cleaning_time as "cleaningTime"
    FROM daily_containers
    WHERE work_date = $1
      AND lat IS NOT NULL
      AND lng IS NOT NULL
    ORDER BY task_id
  `, [workDate]);

  const map = new Map<number, TaskForPhase2>();
  for (const row of result.rows) {
    map.set(row.taskId, {
      taskId: row.taskId,
      logisticCode: row.logisticCode,
      lat: parseFloat(row.lat),
      lng: parseFloat(row.lng),
      clientId: row.clientId,
      premium: row.premium || false,
      straordinaria: row.straordinaria || false,
      typeApt: row.typeApt || 'C',
      priority: row.priority || 'low',
      cleaningTime: row.cleaningTime || 60
    });
  }
  return map;
}

// Load existing cleaner assignments from timeline (daily_assignments_current)
// This returns: cleanerLoad, cleanerStraordinariaState, cleanerTotalCleaningTime
export interface ExistingCleanerState {
  cleanerLoad: Map<number, number>;                    // cleanerId -> number of assigned tasks
  cleanerHasStraordinaria: Map<number, boolean>;       // cleanerId -> has straordinaria assigned
  cleanerStraordinariaMinutes: Map<number, number>;    // cleanerId -> straordinaria duration (if any)
  cleanerTotalCleaningTime: Map<number, number>;       // cleanerId -> total cleaning time in minutes
  cleanerLastPosition: Map<number, { lat: number; lng: number }>;
}

async function loadExistingCleanerState(workDate: string): Promise<ExistingCleanerState> {
  const result = await pool.query(`
    SELECT 
      dac.cleaner_id as "cleanerId",
      dac.task_id as "taskId",
      dc.straordinaria,
      dc.cleaning_time as "cleaningTime",
      dc.lat,
      dc.lng
    FROM daily_assignments_current dac
    JOIN daily_containers dc ON dac.task_id = dc.task_id AND dac.work_date = dc.work_date
    WHERE dac.work_date = $1
      AND dac.cleaner_id IS NOT NULL
    ORDER BY dac.cleaner_id, dac.position
  `, [workDate]);

  const cleanerLoad = new Map<number, number>();
  const cleanerHasStraordinaria = new Map<number, boolean>();
  const cleanerStraordinariaMinutes = new Map<number, number>();
  const cleanerTotalCleaningTime = new Map<number, number>();
  const cleanerLastPosition = new Map<number, { lat: number; lng: number }>();

  for (const row of result.rows) {
    const cleanerId = row.cleanerId;
    const cleaningTime = row.cleaningTime || 60;
    const isStraordinaria = row.straordinaria || false;

    // Update load count
    cleanerLoad.set(cleanerId, (cleanerLoad.get(cleanerId) || 0) + 1);

    // Update total cleaning time
    cleanerTotalCleaningTime.set(cleanerId, (cleanerTotalCleaningTime.get(cleanerId) || 0) + cleaningTime);

    // Track straordinaria
    if (isStraordinaria) {
      cleanerHasStraordinaria.set(cleanerId, true);
      cleanerStraordinariaMinutes.set(cleanerId, cleaningTime);
    }

    // Track last position (will be overwritten by later tasks in order)
    if (row.lat && row.lng) {
      cleanerLastPosition.set(cleanerId, { lat: parseFloat(row.lat), lng: parseFloat(row.lng) });
    }
  }

  console.log(`[Phase2] Loaded existing state: ${cleanerLoad.size} cleaners with assignments`);
  
  return {
    cleanerLoad,
    cleanerHasStraordinaria,
    cleanerStraordinariaMinutes,
    cleanerTotalCleaningTime,
    cleanerLastPosition
  };
}

async function loadPhase1Groups(runId: string): Promise<GroupCandidate[]> {
  const result = await pool.query(`
    SELECT payload
    FROM optimizer.optimizer_decision
    WHERE run_id = $1 
      AND phase = 1
      AND event_type IN ('PHASE1_GROUP_CANDIDATE', 'PHASE1_GROUP_SINGLE_CREATED')
    ORDER BY (payload->>'score')::numeric DESC
  `, [runId]);

  return result.rows.map(row => ({
    taskIds: row.payload.tasks,
    logisticCodes: row.payload.logistic_codes,
    zone: row.payload.zone,
    score: row.payload.score,
    avgTravelMin: row.payload.avg_travel_min,
    maxTravelMin: row.payload.max_travel_min,
    isSingle: row.payload.is_single || false
  }));
}

async function getLatestPhase1RunId(workDate: string): Promise<string | null> {
  const result = await pool.query(`
    SELECT run_id 
    FROM optimizer.optimizer_run
    WHERE work_date = $1 AND status = 'success'
    ORDER BY created_at DESC
    LIMIT 1
  `, [workDate]);

  return result.rows.length > 0 ? result.rows[0].run_id : null;
}

function selectNonOverlappingGroups(groups: GroupCandidate[]): GroupCandidate[] {
  const usedTasks = new Set<number>();
  const selected: GroupCandidate[] = [];

  for (const group of groups) {
    const hasOverlap = group.taskIds.some(t => usedTasks.has(t));
    if (!hasOverlap) {
      selected.push(group);
      group.taskIds.forEach(t => usedTasks.add(t));
    }
  }

  return selected;
}

function eventToDecision(runId: string, event: Phase2Event): OptimizerDecision {
  return {
    runId,
    phase: 2,
    eventType: event.eventType,
    payload: event.payload as Record<string, any>
  };
}

export async function runPhase2(
  workDate: string,
  phase1RunId?: string,
  params: Partial<Phase2Params> = {}
): Promise<Phase2RunResult> {
  const startTime = Date.now();
  const runId = phase1RunId || await getLatestPhase1RunId(workDate);

  const result: Phase2RunResult = {
    runId: runId || '',
    workDate,
    phase1RunId: runId || '',
    selectedCleanersCount: 0,
    availableCleanersBeforeFilter: 0,
    cleanersLoaded: 0,
    tasksLoaded: 0,
    groupsProcessed: 0,
    groupsAssigned: 0,
    groupsUnassigned: 0,
    tasksDropped: 0,
    decisionsInserted: 0,
    durationMs: 0,
    status: 'partial'
  };

  if (!runId) {
    result.status = 'failed';
    result.error = 'No Phase 1 run found for this date';
    result.durationMs = Date.now() - startTime;
    return result;
  }

  try {
    const fullParams: Phase2Params = { ...DEFAULT_PHASE2_PARAMS, ...params };

    const [selectedCleanerIds, allAvailableCleaners, tasksMap, allGroups, existingState] = await Promise.all([
      loadSelectedCleanerIds(workDate),
      loadCleanersForDate(workDate),
      loadTasksForPhase2(workDate),
      loadPhase1Groups(runId),
      loadExistingCleanerState(workDate) // Load existing assignments from timeline
    ]);

    result.selectedCleanersCount = selectedCleanerIds.length;
    result.availableCleanersBeforeFilter = allAvailableCleaners.length;
    result.tasksLoaded = tasksMap.size;

    const cleaners = selectedCleanerIds.length > 0
      ? allAvailableCleaners.filter(c => selectedCleanerIds.includes(c.cleanerId))
      : [];
    
    result.cleanersLoaded = cleaners.length;

    const selectedGroups = selectNonOverlappingGroups(allGroups);
    result.groupsProcessed = selectedGroups.length;
    
    // Convert existing state to Phase2InitialState format
    const initialState: Phase2InitialState = {
      cleanerLoad: existingState.cleanerLoad,
      cleanerHasStraordinaria: existingState.cleanerHasStraordinaria,
      cleanerStraordinariaMinutes: existingState.cleanerStraordinariaMinutes,
      cleanerTotalCleaningTime: existingState.cleanerTotalCleaningTime,
      cleanerLastPosition: existingState.cleanerLastPosition
    };

    if (cleaners.length === 0) {
      const noCleanerEvents: Phase2Event[] = selectedGroups.map(g => ({
        eventType: 'PHASE2_GROUP_UNASSIGNED_CANDIDATE',
        payload: {
          group_tasks: g.taskIds,
          group_logistic_codes: g.logisticCodes,
          reason: selectedCleanerIds.length === 0 ? 'NO_SELECTED_CLEANERS' : 'NO_AVAILABLE_CLEANERS_IN_SELECTION',
          selected_cleaners_count: selectedCleanerIds.length,
          available_cleaners_before_filter: allAvailableCleaners.length
        }
      }));

      const decisions = noCleanerEvents.map(e => eventToDecision(runId, e));
      result.decisionsInserted = await insertDecisionsBatch(decisions);
      result.groupsUnassigned = selectedGroups.length;

      const summary = {
        phase: 2,
        selected_cleaners_count: result.selectedCleanersCount,
        available_cleaners_before_filter: result.availableCleanersBeforeFilter,
        cleaners_loaded: result.cleanersLoaded,
        tasks_loaded: result.tasksLoaded,
        groups_processed: result.groupsProcessed,
        groups_assigned: 0,
        groups_unassigned: result.groupsUnassigned,
        tasks_dropped: 0,
        decisions_inserted: result.decisionsInserted,
        duration_ms: Date.now() - startTime
      };

      await updateRunStatus(runId, 'success', summary);
      result.status = 'success';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const phase2Result = runPhase2Algorithm(selectedGroups, tasksMap, cleaners, fullParams, initialState);

    result.groupsAssigned = phase2Result.stats.groupsAssigned;
    result.groupsUnassigned = phase2Result.stats.groupsUnassigned;
    result.tasksDropped = phase2Result.stats.tasksDropped;

    const decisions = phase2Result.events.map(e => eventToDecision(runId, e));
    result.decisionsInserted = await insertDecisionsBatch(decisions);

    const summary = {
      phase: 2,
      selected_cleaners_count: result.selectedCleanersCount,
      available_cleaners_before_filter: result.availableCleanersBeforeFilter,
      cleaners_loaded: result.cleanersLoaded,
      tasks_loaded: result.tasksLoaded,
      groups_processed: result.groupsProcessed,
      groups_assigned: result.groupsAssigned,
      groups_unassigned: result.groupsUnassigned,
      tasks_dropped: result.tasksDropped,
      decisions_inserted: result.decisionsInserted,
      duration_ms: Date.now() - startTime
    };

    await updateRunStatus(runId, 'success', summary);
    result.status = 'success';

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message || 'Unknown error';
    console.error('Phase 2 error:', error);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

export async function getPhase2Stats(runId: string): Promise<{
  hasRun: boolean;
  stats?: {
    groupsAssigned: number;
    groupsUnassigned: number;
    tasksDropped: number;
  };
}> {
  const result = await pool.query(`
    SELECT COUNT(*) as count
    FROM optimizer.optimizer_decision
    WHERE run_id = $1 AND phase = 2
  `, [runId]);

  const count = parseInt(result.rows[0].count);
  if (count === 0) {
    return { hasRun: false };
  }

  const assigned = await pool.query(`
    SELECT COUNT(*) as count
    FROM optimizer.optimizer_decision
    WHERE run_id = $1 AND phase = 2 AND event_type = 'PHASE2_GROUP_ASSIGNED'
  `, [runId]);

  const unassigned = await pool.query(`
    SELECT COUNT(*) as count
    FROM optimizer.optimizer_decision
    WHERE run_id = $1 AND phase = 2 AND event_type = 'PHASE2_GROUP_UNASSIGNED_CANDIDATE'
  `, [runId]);

  const dropped = await pool.query(`
    SELECT COUNT(*) as count
    FROM optimizer.optimizer_decision
    WHERE run_id = $1 AND phase = 2 AND event_type = 'PHASE2_TASK_DROPPED'
  `, [runId]);

  return {
    hasRun: true,
    stats: {
      groupsAssigned: parseInt(assigned.rows[0].count),
      groupsUnassigned: parseInt(unassigned.rows[0].count),
      tasksDropped: parseInt(dropped.rows[0].count)
    }
  };
}
