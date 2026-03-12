import pool from '../../../shared/pg-db';
import { 
  Phase2Params, 
  DEFAULT_PHASE2_PARAMS,
  CleanerInput,
  TaskForPhase2,
  GroupCandidate,
  Phase2Event,
  ApartmentTypes,
  DEFAULT_APARTMENT_TYPES
} from './phase2';
import { runPhase2WithOrTools } from './phase2OrTools';
import { updateRunStatus, insertDecisionsBatch, OptimizerDecision, loadLockedCleanerIds } from './db';
import { TimelineContext } from './timelineContext';

async function loadApartmentTypes(): Promise<ApartmentTypes> {
  try {
    const result = await pool.query(`
      SELECT value FROM app_settings WHERE key = 'app_settings'
    `);
    const apt = result.rows[0]?.value?.apartment_types;
    if (apt && typeof apt === 'object') {
      return {
        standard_apt: apt.standard_apt || DEFAULT_APARTMENT_TYPES.standard_apt,
        premium_apt: apt.premium_apt || DEFAULT_APARTMENT_TYPES.premium_apt,
        straordinario_apt: apt.straordinario_apt || DEFAULT_APARTMENT_TYPES.straordinario_apt,
        formatore_apt: apt.formatore_apt || DEFAULT_APARTMENT_TYPES.formatore_apt
      };
    }
    const legacy = await pool.query(`SELECT value FROM app_settings WHERE key = 'apartment_types'`);
    if (legacy.rows.length > 0 && legacy.rows[0].value) {
      const v = legacy.rows[0].value;
      return {
        standard_apt: v.standard_apt || DEFAULT_APARTMENT_TYPES.standard_apt,
        premium_apt: v.premium_apt || DEFAULT_APARTMENT_TYPES.premium_apt,
        straordinario_apt: v.straordinario_apt || DEFAULT_APARTMENT_TYPES.straordinario_apt,
        formatore_apt: v.formatore_apt || DEFAULT_APARTMENT_TYPES.formatore_apt
      };
    }
  } catch (e) {
    console.error('Failed to load apartment_types from app_settings, using defaults', e);
  }
  return DEFAULT_APARTMENT_TYPES;
}

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
  const ids = (result.rows[0].cleaners || [])
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n)) as number[];
  // Determinismo: l'ordine dell'array in DB può variare tra ambienti.
  ids.sort((a, b) => a - b);
  return ids;
}

async function loadCleanersForDate(workDate: string): Promise<CleanerInput[]> {
  const result = await pool.query(`
    SELECT 
      cleaner_id as "cleanerId",
      name,
      role,
      contract_type as "contractType",
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
    isSingle: row.payload.is_single || false,
    anchoredCleanerId: row.payload.anchored_cleaner_id ?? undefined
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

/**
 * Selects a set of non-overlapping groups that covers all tasks (partition with full coverage).
 * Uses a greedy: process hardest-to-cover tasks first, pick the best group (by score, then anchored, size, travel) for each.
 * Returns selected groups and any task IDs that could not be covered (Phase 4 will handle them).
 */
function selectPartitionCoveringAllTasks(
  groups: GroupCandidate[],
  allTaskIds: Set<number>
): { selected: GroupCandidate[]; uncoveredTaskIds: number[] } {
  const sorted = [...groups].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aAnchored = a.anchoredCleanerId !== undefined ? 1 : 0;
    const bAnchored = b.anchoredCleanerId !== undefined ? 1 : 0;
    if (aAnchored !== bAnchored) return bAnchored - aAnchored;
    if (b.taskIds.length !== a.taskIds.length) return b.taskIds.length - a.taskIds.length;
    return (a.avgTravelMin ?? 0) - (b.avgTravelMin ?? 0);
  });

  const covered = new Set<number>();
  const selected: GroupCandidate[] = [];
  const uncovered = new Set(allTaskIds);
  const uncoveredTaskIds: number[] = [];

  const isCandidate = (g: GroupCandidate, t: number): boolean =>
    g.taskIds.includes(t) && g.taskIds.every((id) => !covered.has(id));

  const getCandidatesForTask = (t: number): GroupCandidate[] =>
    sorted.filter((g) => isCandidate(g, t));

  while (uncovered.size > 0) {
    let bestT: number | null = null;
    let minCandidates = Infinity;
    for (const t of uncovered) {
      const candidates = getCandidatesForTask(t);
      if (candidates.length < minCandidates) {
        minCandidates = candidates.length;
        bestT = t;
      }
    }
    if (bestT === null) break;
    const candidates = getCandidatesForTask(bestT);
    if (candidates.length === 0) {
      uncoveredTaskIds.push(bestT);
      uncovered.delete(bestT);
      continue;
    }
    const chosen = candidates[0];
    selected.push(chosen);
    for (const id of chosen.taskIds) {
      covered.add(id);
      uncovered.delete(id);
    }
  }

  return { selected, uncoveredTaskIds };
}

function eventToDecision(runId: string, event: Phase2Event): OptimizerDecision {
  return {
    runId,
    phase: 2,
    eventType: event.eventType,
    payload: event.payload as Record<string, any>
  };
}

export interface RunPhase2Options {
  params?: Partial<Phase2Params>;
  timelineContext?: TimelineContext;
}

export async function runPhase2(
  workDate: string,
  phase1RunId?: string,
  paramsOrOptions: Partial<Phase2Params> | RunPhase2Options = {}
): Promise<Phase2RunResult> {
  const startTime = Date.now();
  const runId = phase1RunId || await getLatestPhase1RunId(workDate);
  
  const options: RunPhase2Options = 'timelineContext' in paramsOrOptions || 'params' in paramsOrOptions
    ? paramsOrOptions as RunPhase2Options
    : { params: paramsOrOptions as Partial<Phase2Params> };
  
  const params = options.params ?? {};
  const timelineContext = options.timelineContext;

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
    const apartmentTypes = await loadApartmentTypes();
    let initialLastPositionByCleaner: Map<number, { lat: number; lng: number }> | undefined;
    if (timelineContext?.anchorPointsByCleaner) {
      initialLastPositionByCleaner = new Map();
      timelineContext.anchorPointsByCleaner.forEach((anchors, cleanerId) => {
        if (anchors.lastFixed) {
          initialLastPositionByCleaner!.set(cleanerId, { lat: anchors.lastFixed.lat, lng: anchors.lastFixed.lng });
        }
      });
    }

    const fullParams: Phase2Params = { 
      ...DEFAULT_PHASE2_PARAMS, 
      ...params,
      apartmentTypes,
      initialLoadByCleanerMin: timelineContext?.initialLoadByCleanerMin,
      initialLastPositionByCleaner,
      initialFixedStatsByCleaner: timelineContext?.fixedStatsByCleaner
    };
    
    if (timelineContext && timelineContext.initialLoadByCleanerMin.size > 0) {
      const fixedCount = Array.from(timelineContext.fixedStatsByCleaner.values()).reduce((s, v) => s + v.fixedTaskCount, 0);
      console.log(`[Phase2] Using timeline context: ${timelineContext.initialLoadByCleanerMin.size} cleaners with pre-existing load, ${initialLastPositionByCleaner?.size ?? 0} with anchor positions, ${fixedCount} fixed tasks counted`);
    }

    const [selectedCleanerIds, allAvailableCleaners, lockedCleanerIds, tasksMap, allGroups] = await Promise.all([
      loadSelectedCleanerIds(workDate),
      loadCleanersForDate(workDate),
      loadLockedCleanerIds(workDate),
      loadTasksForPhase2(workDate),
      loadPhase1Groups(runId)
    ]);

    result.selectedCleanersCount = selectedCleanerIds.length;
    result.availableCleanersBeforeFilter = allAvailableCleaners.length;
    result.tasksLoaded = tasksMap.size;

    const lockedSet = new Set(lockedCleanerIds);

    const cleaners = selectedCleanerIds.length > 0
      ? allAvailableCleaners
          .filter(c => selectedCleanerIds.includes(c.cleanerId))
          .filter(c => !lockedSet.has(c.cleanerId))
      : [];

    console.log(`[Phase2] Locked cleaners excluded: ${lockedCleanerIds.length} (${lockedCleanerIds.join(",")})`);
    console.log(`[Phase2] Cleaners after lock filter: ${cleaners.length}/${selectedCleanerIds.length}`);
    
    result.cleanersLoaded = cleaners.length;

    const allTaskIds = new Set(allGroups.flatMap((g) => g.taskIds));
    const { selected: selectedGroups, uncoveredTaskIds } = selectPartitionCoveringAllTasks(allGroups, allTaskIds);
    result.groupsProcessed = selectedGroups.length;

    if (uncoveredTaskIds.length > 0) {
      console.warn(`[Phase2] Partition left ${uncoveredTaskIds.length} tasks without group (Phase 4 will try to assign them)`);
    }

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

    const phase2Result = await runPhase2WithOrTools(selectedGroups, tasksMap, cleaners, fullParams, { timeoutMs: 85000 });

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
    result.error = error?.message || 'Unknown error';
    console.error('Phase 2 OR-Tools error:', error);
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
