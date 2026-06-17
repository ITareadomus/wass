import pool from '../../../shared/pg-db';
import * as mysql from 'mysql2/promise';
import { databaseConfig } from '../../../config/database';
import { 
  runPhase4Algorithm, 
  Phase4Params, 
  DEFAULT_PHASE4_PARAMS,
  CleanerSchedule,
  Phase4Event
} from './phase4';
import { TaskForScheduling, Phase3TimelineConstraints } from './phase3';
import { updateRunStatus, insertDecisionsBatch, OptimizerDecision, getLatestRunForDate, loadLockedCleanerIds } from './db';
import { loadPriorityStartWindows, mapPriorityType, priorityToDbFormat } from './priorityWindows';
import { ApartmentTypes, DEFAULT_APARTMENT_TYPES, calculateMinutesBasedTargets, TaskForPhase2, DEFAULT_FAIRNESS_PARAMS, FormatoreRules, TaskTypesByCleanerConfig } from './phase2';
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
        formatore_apt: apt.formatore_apt || DEFAULT_APARTMENT_TYPES.formatore_apt,
        ufficio_apt: apt.ufficio_apt || DEFAULT_APARTMENT_TYPES.ufficio_apt
      };
    }
    const legacy = await pool.query(`SELECT value FROM app_settings WHERE key = 'apartment_types'`);
    if (legacy.rows.length > 0 && legacy.rows[0].value) {
      const v = legacy.rows[0].value;
      return {
        standard_apt: v.standard_apt || DEFAULT_APARTMENT_TYPES.standard_apt,
        premium_apt: v.premium_apt || DEFAULT_APARTMENT_TYPES.premium_apt,
        straordinario_apt: v.straordinario_apt || DEFAULT_APARTMENT_TYPES.straordinario_apt,
        formatore_apt: v.formatore_apt || DEFAULT_APARTMENT_TYPES.formatore_apt,
        ufficio_apt: v.ufficio_apt || DEFAULT_APARTMENT_TYPES.ufficio_apt
      };
    }
  } catch (e) {
    console.error('Failed to load apartment_types from app_settings, using defaults', e);
  }
  return DEFAULT_APARTMENT_TYPES;
}

async function loadOfficeOperationIds(): Promise<number[]> {
  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });

    const [rows]: any = await connection.execute(
      `SELECT o.id, l.name
       FROM app_structure_operation o
       INNER JOIN app_structure_operation_langs l
         ON l.structure_operation_id = o.id AND l.id_lang = 1
       WHERE o.active = 1 AND o.enable_wass = 1
       ORDER BY o.id`
    );

    const officeNames = new Set([
      'pulizia uffici',
      'pulizia uffici/altro',
      'pulizia uffici straordinaria',
    ]);

    const ids = (Array.isArray(rows) ? rows : [])
      .filter((r: any) => officeNames.has(String(r?.name ?? '').toLowerCase().trim()))
      .map((r: any) => Number(r?.id))
      .filter((id: number) => Number.isFinite(id));

    return Array.from(new Set(ids));
  } catch (e) {
    console.warn('[Phase4] Unable to load office operation IDs, fallback to none:', e);
    return [];
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        // ignore
      }
    }
  }
}

async function loadFormatoreRules(): Promise<FormatoreRules | null> {
  try {
    const result = await pool.query(`
      SELECT value FROM app_settings WHERE key = 'app_settings'
    `);
    const value = result.rows[0]?.value;
    if (!value || typeof value !== 'object') return null;

    const pt = value.priority_types?.formatore_cleaner;
    const tt = value.task_types?.formatore_cleaner;
    const allowedPriorities: string[] = [];
    if (pt && typeof pt === 'object') {
      if (pt.early_out) allowedPriorities.push('early_out');
      if (pt.high_priority) allowedPriorities.push('high_priority');
      if (pt.low_priority) allowedPriorities.push('low_priority');
    }
    return {
      allowedPriorities: allowedPriorities.length > 0 ? allowedPriorities : ['early_out', 'high_priority', 'low_priority'],
      standardApt: tt && typeof tt === 'object' ? Boolean(tt.standard_apt) : true,
      premiumApt: tt && typeof tt === 'object' ? Boolean(tt.premium_apt) : false,
      straordinarioApt: tt && typeof tt === 'object' ? Boolean(tt.straordinario_apt) : false
    };
  } catch (e) {
    console.error('Failed to load formatore rules from app_settings:', e);
    return null;
  }
}

async function loadTaskTypesByCleaner(): Promise<TaskTypesByCleanerConfig | null> {
  try {
    const result = await pool.query(`
      SELECT value FROM app_settings WHERE key = 'app_settings'
    `);
    const value = result.rows[0]?.value;
    const taskTypes = value?.task_types;
    if (!taskTypes || typeof taskTypes !== 'object') return null;
    return taskTypes as TaskTypesByCleanerConfig;
  } catch (e) {
    console.error('Failed to load task_types from app_settings:', e);
    return null;
  }
}

/** Default restrittivo per formatori quando app_settings non ha priority_types/task_types: solo LP. */
const DEFAULT_FORMATORE_RULES: FormatoreRules = {
  allowedPriorities: ['low_priority'],
  standardApt: true,
  premiumApt: false,
  straordinarioApt: false
};

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

async function loadPhase3Schedules(runId: string, workDate: string): Promise<CleanerSchedule[]> {
  // IMPORTANTE: Carica TUTTI i cleaners selezionati, non solo quelli con task assegnati
  // Questo permette a Phase 4 di assegnare task ai cleaners vuoti
  const selectedCleanersResult = await pool.query(`
    SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1
  `, [workDate]);
  
  const allSelectedCleanerIds: number[] = (selectedCleanersResult.rows[0]?.cleaners || [])
    .map((x: any) => Number(x))
    .filter((n: number) => Number.isFinite(n))
    .sort((a: number, b: number) => a - b);
  
  if (allSelectedCleanerIds.length === 0) {
    console.warn(`[Phase4] WARNING: No selected cleaners found for ${workDate}. Phase 4 will have no cleaners to assign tasks to.`);
  } else {
    console.log(`[Phase4] Loaded ${allSelectedCleanerIds.length} selected cleaners for ${workDate}`);
  }
  
  // Join con daily_containers per ottenere cleaning_time per fairness tracking
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
    minStartTime: Date | null;
    maxEndTime: Date | null;
    totalTravel: number;
    totalPriorityPenalty: number;
  }>();
  
  // Inizializza TUTTI i cleaners selezionati (anche quelli vuoti)
  for (const cleanerId of allSelectedCleanerIds) {
    cleanerMap.set(cleanerId, {
      tasks: [],
      minStartTime: null,
      maxEndTime: null,
      totalTravel: 0,
      totalPriorityPenalty: 0
    });
  }

  // Poi aggiungi i task per i cleaners che ne hanno
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
      priorityReasons: [],
      // Per fairness tracking
      cleaningTimeMinutes: parseInt(row.cleaning_time_minutes, 10) || 60
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

  const cleanerCapabilities = await loadCleanerCapabilitiesFromAll(allSelectedCleanerIds, workDate);
  const cleanerShiftTimes = await loadCleanerShiftTimesFromAll(allSelectedCleanerIds, workDate);

  const schedules: CleanerSchedule[] = [];
  cleanerMap.forEach((data, cleanerId) => {
    const caps = cleanerCapabilities.get(cleanerId);
    const shift = cleanerShiftTimes.get(cleanerId) || { startTime: "10:00", endTime: "20:00" };
    const startTimeStr = shift.startTime;
    const [endH, endM] = shift.endTime.split(":").map((x: string) => parseInt(x, 10));
    const shiftEndMinutes = Number.isFinite(endH) && Number.isFinite(endM) ? (endH * 60 + endM) : 1200;
    const endTimeMinutes = data.maxEndTime
      ? Math.max(data.maxEndTime.getUTCHours() * 60 + data.maxEndTime.getUTCMinutes(), shiftEndMinutes)
      : shiftEndMinutes;
    
    // Calcola totalWorkMinutes dalla somma delle durate dei task già assegnati
    // (per fairness scoring)
    const totalWorkMinutes = data.tasks.reduce(
      (sum: number, t: any) => sum + (t.cleaningTimeMinutes ?? 60),
      0
    );
    
    schedules.push({
      cleanerId,
      cleanerName: caps?.name || `Cleaner ${cleanerId}`,
      startTime: startTimeStr,
      endTime: shift.endTime,
      tasks: data.tasks,
      endTimeMinutes,
      totalTravel: data.totalTravel,
      totalWait: 0,
      totalPriorityPenalty: data.totalPriorityPenalty,
      // Dati per vincoli hard
      role: caps?.role || 'Standard',
      contractType: caps?.contractType || 'C',
      // Fairness tracking
      totalWorkMinutes
    });
  });

  return schedules;
}

interface CleanerCapabilities {
  name: string;
  role: string;
  contractType: string;
}

async function loadCleanerCapabilitiesFromAll(cleanerIds: number[], workDate: string): Promise<Map<number, CleanerCapabilities>> {
  if (cleanerIds.length === 0) return new Map();

  const capsResult = await pool.query(`
    SELECT 
      cleaner_id, 
      name, 
      COALESCE(role, 'Standard') as role,
      COALESCE(contract_type, 'C') as contract_type
    FROM cleaners 
    WHERE cleaner_id = ANY($1::int[])
      AND work_date = $2
    ORDER BY cleaner_id
  `, [cleanerIds, workDate]);

  const map = new Map<number, CleanerCapabilities>();
  for (const row of capsResult.rows) {
    map.set(row.cleaner_id, {
      name: row.name || `Cleaner ${row.cleaner_id}`,
      role: row.role,
      contractType: row.contract_type,
    });
  }
  return map;
}

async function loadCleanerShiftTimesFromAll(
  cleanerIds: number[],
  workDate: string
): Promise<Map<number, { startTime: string; endTime: string }>> {
  if (cleanerIds.length === 0) return new Map();

  const timesResult = await pool.query(`
    SELECT cleaner_id, start_time, end_time
    FROM cleaners
    WHERE cleaner_id = ANY($1::int[])
      AND work_date = $2
    ORDER BY cleaner_id
  `, [cleanerIds, workDate]);

  const map = new Map<number, { startTime: string; endTime: string }>();
  for (const row of timesResult.rows) {
    map.set(row.cleaner_id, {
      startTime: row.start_time || "10:00",
      endTime: row.end_time || "20:00",
    });
  }
  return map;
}

async function loadUnassignedTasks(runId: string, workDate: string): Promise<{ taskId: number; reasonCode: string; details: Record<string, any> }[]> {
  // Calcola i task mancanti dal DIFF invece di leggere solo da optimizer_unassigned
  // Questo include anche i task che Phase 2/3 non hanno mai processato
  const result = await pool.query(`
    WITH unlocked_tasks AS (
      SELECT dc.task_id, dc.logistic_code
      FROM daily_containers dc
      WHERE dc.work_date = $1
        AND dc.task_id NOT IN (
          SELECT task_id
          FROM daily_task_locks
          WHERE work_date = $1 AND locked = true
        )
    ),
    assigned AS (
      SELECT DISTINCT task_id
      FROM optimizer.optimizer_assignment
      WHERE run_id = $2
    ),
    already_unassigned AS (
      SELECT task_id, reason_code, details
      FROM optimizer.optimizer_unassigned
      WHERE run_id = $2
    )
    SELECT 
      ut.task_id, 
      ut.logistic_code,
      au.reason_code,
      au.details
    FROM unlocked_tasks ut
    LEFT JOIN assigned a ON a.task_id = ut.task_id
    LEFT JOIN already_unassigned au ON au.task_id = ut.task_id
    WHERE a.task_id IS NULL
    ORDER BY ut.task_id
  `, [workDate, runId]);

  return result.rows.map(row => ({
    taskId: row.task_id,
    reasonCode: row.reason_code || 'PHASE4_SEED_FROM_DIFF',
    details: row.details || { source: 'diff_calculation', logistic_code: row.logistic_code }
  }));
}

async function loadTasksForScheduling(workDate: string, officeOperationIds: Set<number>): Promise<Map<number, TaskForScheduling>> {
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
      straordinaria,
      COALESCE(premium, false) as premium,
      COALESCE(type_apt, 'C') as type_apt,
      operation_id as operation_id
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
      straordinaria: row.straordinaria === true,
      premium: row.premium === true,
      typeApt: row.type_apt,
      operationId: row.operation_id != null ? Number(row.operation_id) : null,
      isOfficeTask: row.operation_id != null ? officeOperationIds.has(Number(row.operation_id)) : false
    });
  }
  return map;
}

async function getWorkDateFromRun(runId: string): Promise<string | null> {
  const result = await pool.query(`
    SELECT to_char(work_date::date, 'YYYY-MM-DD') as work_date
    FROM optimizer.optimizer_run
    WHERE run_id = $1
  `, [runId]);
  
  if (result.rows.length === 0) return null;
  
  return result.rows[0].work_date || null;
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
  const seenTaskIds = new Set<number>();
  
  for (const schedule of schedules) {
    for (const row of schedule.tasks) {
      // Safety net: in caso di duplicati nelle schedules (es. join che moltiplica righe),
      // evita violazione PK (run_id, task_id). Manteniamo la prima occorrenza.
      if (seenTaskIds.has(row.taskId)) {
        console.warn(`[Phase4.updateAssignments] Duplicate taskId detected in updatedSchedules: taskId=${row.taskId}. Skipping.`);
        continue;
      }
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

async function loadAnchorTasksFromTimeline(
  workDate: string,
  taskIds: number[]
): Promise<Map<number, TaskForScheduling>> {
  if (taskIds.length === 0) return new Map();

  const uniqueIds = Array.from(new Set(taskIds)).filter(n => Number.isFinite(n));
  if (uniqueIds.length === 0) return new Map();

  // Load from daily_assignments_current (timeline) to build previousTask anchors
  const result = await pool.query(`
    SELECT
      task_id,
      logistic_code,
      lat,
      lng,
      COALESCE(base_cleaning_time, cleaning_time, 60) as cleaning_time_minutes,
      checkout_time,
      checkin_time,
      checkin_date::text as checkin_date,
      priority,
      straordinaria,
      COALESCE(premium, false) as premium,
      COALESCE(type_apt, 'C') as type_apt
    FROM daily_assignments_current
    WHERE work_date = $1
      AND task_id = ANY($2::int[])
  `, [workDate, uniqueIds]);

  const map = new Map<number, TaskForScheduling>();
  for (const row of result.rows) {
    const checkinDateStr: string | null = row.checkin_date || null;

    // Note: anchors may have missing coords; we still store them and phase4 will use them if valid.
    map.set(row.task_id, {
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      lat: row.lat !== null ? parseFloat(row.lat) : (null as any),
      lng: row.lng !== null ? parseFloat(row.lng) : (null as any),
      cleaningTimeMinutes: parseInt(row.cleaning_time_minutes, 10) || 60,
      checkoutTime: row.checkout_time,
      checkinTime: row.checkin_time,
      checkinDate: checkinDateStr,
      priorityType: mapPriorityType(row.priority),
      straordinaria: row.straordinaria === true,
      premium: row.premium === true,
      typeApt: row.type_apt
    });
  }

  return map;
}

export interface RunPhase4Options {
  params?: Partial<Phase4Params>;
  timelineContext?: TimelineContext;
}

export async function runPhase4(
  workDate?: string,
  runId?: string,
  paramsOrOptions: Partial<Phase4Params> | RunPhase4Options = {}
): Promise<Phase4RunResult> {
  const startTime = Date.now();
  
  const options: RunPhase4Options = 'timelineContext' in paramsOrOptions || 'params' in paramsOrOptions
    ? paramsOrOptions as RunPhase4Options
    : { params: paramsOrOptions as Partial<Phase4Params> };
  
  const params = options.params ?? {};
  const timelineContext = options.timelineContext;
  
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
    const [apartmentTypes, formatoreRules, officeOperationIds, taskTypesByCleaner] = await Promise.all([
      loadApartmentTypes(),
      loadFormatoreRules(),
      loadOfficeOperationIds(),
      loadTaskTypesByCleaner(),
    ]);
    const officeOperationSet = new Set<number>(officeOperationIds);
    const fullParams: Phase4Params = { 
      ...DEFAULT_PHASE4_PARAMS, 
      ...params,
      apartmentTypes,
      officeOperationIds: params.officeOperationIds ?? officeOperationIds,
      taskTypesByCleaner: params.taskTypesByCleaner ?? taskTypesByCleaner,
      formatoreRules: formatoreRules ?? DEFAULT_FORMATORE_RULES
    };

    const [schedules, unassignedTasks, tasksMap, priorityWindows, lockedCleanerIds] = await Promise.all([
      loadPhase3Schedules(resolvedRunId, resolvedWorkDate),
      loadUnassignedTasks(resolvedRunId, resolvedWorkDate),
      loadTasksForScheduling(resolvedWorkDate, officeOperationSet),
      loadPriorityStartWindows(resolvedRunId),
      loadLockedCleanerIds(resolvedWorkDate)
    ]);

    // MERGE append-only: enrich schedules with immutable timeline anchors and fixed stats.
    // This preserves manual work and makes Phase4 compute travel/time from the last fixed task.
    if (fullParams.appendOnly === true && timelineContext) {
      const anchorTaskIds: number[] = [];
      timelineContext.lastFixedByCleaner.forEach((last) => {
        if (last?.taskId) anchorTaskIds.push(Number(last.taskId));
      });

      const anchorTasks = await loadAnchorTasksFromTimeline(resolvedWorkDate, anchorTaskIds);
      anchorTasks.forEach((t, id) => {
        if (!tasksMap.has(id)) tasksMap.set(id, t);
      });

      for (const schedule of schedules) {
        const lastFixed = timelineContext.lastFixedByCleaner.get(schedule.cleanerId);
        const fixedStats = timelineContext.fixedStatsByCleaner.get(schedule.cleanerId);

        if (fixedStats) {
          (schedule as any).fixedTaskCount = fixedStats.fixedTaskCount;
          (schedule as any).fixedWorkMinutes = fixedStats.fixedWorkMinutes;
          (schedule as any).fixedTravelMinutes = fixedStats.fixedTravelMinutes;
          (schedule as any).fixedHasAnyOT = fixedStats.fixedHasAnyOT;
          (schedule as any).fixedHasLongOT = fixedStats.fixedHasLongOT;
        }

        if (lastFixed?.endTime) {
          // Start appending after the last fixed task time (prefer endTime, fallback to startTime already handled in context)
          // If endTime is empty string, we keep the cleaner startTime.
          if (String(lastFixed.endTime).trim()) {
            schedule.startTime = String(lastFixed.endTime).slice(0, 5);
          }

          let anchor = tasksMap.get(lastFixed.taskId) || null;
          if (!anchor) {
            // Build minimal anchor from context if DB row missing
            anchor = {
              taskId: lastFixed.taskId,
              logisticCode: lastFixed.logisticCode,
              lat: lastFixed.lat as any,
              lng: lastFixed.lng as any,
              cleaningTimeMinutes: lastFixed.baseCleaningTimeMinutes ?? lastFixed.cleaningTimeMinutes ?? 60,
              checkoutTime: null,
              checkinTime: null,
              checkinDate: null,
              priorityType: null,
              straordinaria: lastFixed.straordinaria,
              premium: false,
              typeApt: 'C'
            };
          } else {
            // Ensure coords exist: if the anchor row in DB missed coords, fall back to context coords.
            if (!Number.isFinite(anchor.lat as any) && lastFixed.lat !== null) (anchor as any).lat = lastFixed.lat;
            if (!Number.isFinite(anchor.lng as any) && lastFixed.lng !== null) (anchor as any).lng = lastFixed.lng;
          }

          (schedule as any).anchorTask = anchor;
        }
      }
    }

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

    const lockedSet = new Set(lockedCleanerIds);
    const eligibleSchedulesCount = schedules.filter(s => !lockedSet.has(s.cleanerId)).length;
    console.log(`[Phase4] Locked cleaners excluded: ${lockedCleanerIds.length} (${lockedCleanerIds.join(",")})`);
    console.log(`[Phase4] Eligible cleaners for Phase4 assignment: ${eligibleSchedulesCount}/${schedules.length}`);

    // Calculate minutes-based fairness targets for Phase 4
    // Convert TaskForScheduling to TaskForPhase2 format for target calculation
    const tasksForTargets: TaskForPhase2[] = Array.from(tasksMap.values()).map(t => ({
      taskId: t.taskId,
      logisticCode: t.logisticCode,
      lat: t.lat,
      lng: t.lng,
      clientId: 0,  // Not needed for target calculation
      premium: t.premium ?? false,
      straordinaria: t.straordinaria ?? false,
      typeApt: t.typeApt ?? '',
      priority: t.priorityType ?? 'LP',  // Use priorityType from TaskForScheduling
      cleaningTime: t.cleaningTimeMinutes ?? 60,
      operationId: t.operationId ?? null,
      isOfficeTask: t.isOfficeTask === true
    }));
    const targets = calculateMinutesBasedTargets(tasksForTargets, eligibleSchedulesCount, fullParams.fairness);
    
    console.log(`[Phase4] Fairness targets: target=${Math.round(targets.targetLoadMin)}min, min=${Math.round(targets.minTarget)}min, max=${Math.round(targets.maxTarget)}min`);

    // Build constraintsByCleaner from timelineContext for collision avoidance
    const constraintsByCleaner = new Map<string, Phase3TimelineConstraints>();
    if (timelineContext) {
      // Evita iterazione Map con downlevelIteration (target ES5)
      timelineContext.occupiedBlocksByCleaner.forEach((blocks, cleanerId) => {
        const anchors = timelineContext.anchorPointsByCleaner.get(cleanerId);
        constraintsByCleaner.set(String(cleanerId), {
          occupiedBlocks: blocks,
          anchors
        });
      });
    }
    
    const phase4Result = await runPhase4Algorithm(
      resolvedWorkDate,
      schedules,
      unassignedTasks,
      tasksMap,
      priorityWindows,
      targets,
      fullParams,
      constraintsByCleaner,
      lockedCleanerIds
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
