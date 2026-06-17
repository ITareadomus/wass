import { estimateTravelMinutes, TaskInput } from './phase1';
import { 
  TaskForScheduling, 
  simulateSequence, 
  ScheduleRow,
  PriorityViolation,
  Phase3TimelineConstraints
} from './phase3';
import { PriorityWindows, priorityPenalty, Priority } from './priorityWindows';
import { ApartmentTypes, DEFAULT_APARTMENT_TYPES, FairnessParams, DEFAULT_FAIRNESS_PARAMS, MinutesBasedTargets, FormatoreRules, TaskTypesByCleanerConfig } from './phase2';
import { TravelPolicy, getWaveLevelConstraints } from './travelPolicy';
import { runPhase4RepairBatch } from './phase4OrTools';
import { isTaskEquivalentToStraordinaria } from '../../utils/straordinaria-utils';

export interface Phase4Params {
  maxInsertionAttempts: number;
  underfilledBonus: number;
  singleAssignmentPenalty: number;
  // MERGE append-only: only allow insert at end (never between tasks)
  appendOnly?: boolean;
  // Penalità per task non assegnati (sistema progressivo)
  baseUnassignedPenalty: number;       // Penalità base per ogni task normale non assegnato
  straordinariaExtraPenalty: number;   // Penalità extra per straordinarie non assegnate
  progressiveMultiplier: number;       // Incremento penalità per ogni task successivo non assegnato
  // Coverage-first: relaxation levels
  maxRelaxLevel: number;               // Livello massimo di rilassamento (0-4)
  baseRelaxPenalty: number;            // Penalità base per ogni livello di relax
  relaxMultiplier: number;             // Moltiplicatore esponenziale per livello
  maxCleanersToTryPerTask: number;     // Max cleaners da provare per task (performance cap)
  // Compatibilità appartamento (role-based)
  apartmentTypes: ApartmentTypes;
  officeOperationIds?: number[];
  taskTypesByCleaner?: TaskTypesByCleanerConfig | null;
  /** Regole formatori da app_settings (priorità + tipi task ammessi). Se assente, nessuna restrizione extra. */
  formatoreRules?: FormatoreRules | null;
  // Dynamic max tasks per cleaner (calcolato da totalTasks/numCleaners)
  dynamicMaxTasks?: number;
  // Minutes-based fairness parameters
  fairness: FairnessParams;
  // Wave-only: per-leg travel policy (mirrors Phase 1 thresholds).
  // When set, replaces the legacy deltaTravel check with per-leg maxNewLeg validation.
  travelPolicy?: TravelPolicy;
}

// LIMITE HARD DINAMICO - basato su dynamicMaxTasks + bonus travel per-cleaner
// Bonus +1 se avgTravel ≤ 10min per cleaner

export const DEFAULT_PHASE4_PARAMS: Phase4Params = {
  maxInsertionAttempts: 1000,
  underfilledBonus: 5,
  singleAssignmentPenalty: 20,
  appendOnly: false,
  // Penalità per task non assegnati
  baseUnassignedPenalty: 1500,         // Ogni task non assegnato costa 1500
  straordinariaExtraPenalty: 2500,     // Extra per OT → totale 4000
  progressiveMultiplier: 0.5,          // 1° = 1500, 2° = 2250, 3° = 3000...
  // Coverage-first: relaxation levels
  maxRelaxLevel: 3,                    // L0=strict, L1=lateness, L2=maxLoad, L3=travel
  baseRelaxPenalty: 200,               // Penalità base per relax
  relaxMultiplier: 3,                  // Esponenziale: L1=200, L2=600, L3=1800
  maxCleanersToTryPerTask: 20,         // Cap performance
  // Compatibilità appartamento
  apartmentTypes: DEFAULT_APARTMENT_TYPES,
  // Dynamic max tasks - base da totalTasks/numCleaners, bonus +1 se avgTravel ≤ 10min
  dynamicMaxTasks: undefined,
  // Minutes-based fairness
  fairness: DEFAULT_FAIRNESS_PARAMS
};

export interface CleanerSchedule {
  cleanerId: number;
  cleanerName: string;
  startTime: string;
  endTime: string;
  tasks: ScheduleRow[];
  endTimeMinutes: number;
  totalTravel: number;
  totalWait: number;
  totalPriorityPenalty: number;
  // MERGE append-only: fixed (manual) workload that must remain immutable.
  // These minutes are included only for fairness / constraints, NOT for deltaTravel computations.
  fixedTaskCount?: number;
  fixedWorkMinutes?: number;
  fixedTravelMinutes?: number;
  fixedHasAnyOT?: boolean;
  fixedHasLongOT?: boolean;
  // Anchor task (last fixed task) used to compute travel to first appended task.
  anchorTask?: TaskForScheduling | null;
  // Dati per vincoli hard (opzionali per retrocompatibilità)
  role?: string;
  contractType?: string;
  // Fairness tracking: ore totali lavorate (in minuti)
  totalWorkMinutes?: number;
}

export interface InsertionCandidate {
  cleanerId: number;
  position: number;
  deltaTravel: number;
  deltaWait: number;
  deltaLateness: number;
  priorityPenalty: number;
  underfilledBonus: number;
  totalScore: number;
  feasible: boolean;
  reason?: string;
}

export interface Phase4Event {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface Phase4TaskResult {
  taskId: number;
  logisticCode: number;
  status: 'inserted' | 'single_assigned' | 'remain_unassigned';
  cleanerId?: number;
  position?: number;
  reason?: string;
  score?: number;
}

export interface Phase4Result {
  taskResults: Phase4TaskResult[];
  updatedSchedules: CleanerSchedule[];
  events: Phase4Event[];
  stats: {
    unassignedInput: number;
    insertedCount: number;
    singleAssignedCount: number;
    remainUnassignedCount: number;
    iterationsUsed: number;
    coverageImprovement: number;
    unassignedPenalty: number;
    normalUnassignedCount: number;
    straordinariaUnassignedCount: number;
  };
}

function parseTimeToMinutes(timeStr: string | null): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const hours = parseInt(parts[0], 10);
  const minutes = parseInt(parts[1], 10);
  if (isNaN(hours) || isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function minutesToTimeStr(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function dateToMinutes(d: Date): number {
  // Determinismo: le Date in scheduling sono in UTC (vedi phase3.ts)
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ============================================================================
// VINCOLI HARD: Verifiche di compatibilità cleaner-task
// Questi vincoli NON possono essere rilassati
// ============================================================================

function normalizeCleanerRole(role: string): string {
  if (!role) return 'standard_cleaner';
  const normalized = role.toLowerCase().trim();
  if (normalized.includes('standard')) return 'standard_cleaner';
  if (normalized.includes('premium')) return 'premium_cleaner';
  if (normalized.includes('ufficio')) return 'ufficio_cleaner';
  if (normalized.includes('straord')) return 'straordinario_cleaner';
  if (normalized.includes('formatore')) return 'formatore_cleaner';
  return 'standard_cleaner';
}

function resolveOperationId(task: TaskForScheduling): number | null {
  if (typeof task.operationId === 'number' && Number.isFinite(task.operationId)) {
    return task.operationId;
  }
  return null;
}

function isOfficeTask(task: TaskForScheduling, officeOperationIds: Set<number>): boolean {
  if (task.isOfficeTask === true) return true;
  const operationId = resolveOperationId(task);
  return operationId != null && officeOperationIds.has(operationId);
}

function isRealStraordinariaTask(task: TaskForScheduling, officeOperationIds: Set<number>): boolean {
  return isTaskEquivalentToStraordinaria(task) && !isOfficeTask(task, officeOperationIds);
}

function canCleanerHandleApartment(
  cleanerRole: string,
  typeApt: string | undefined,
  apartmentTypes: ApartmentTypes
): boolean {
  if (!typeApt) return true;
  
  const roleKey = normalizeCleanerRole(cleanerRole);
  const normalizedApt = typeApt.toUpperCase().trim();
  
  let allowedApts: string[];
  switch (roleKey) {
    case 'standard_cleaner':
      allowedApts = apartmentTypes.standard_apt || [];
      break;
    case 'premium_cleaner':
      allowedApts = apartmentTypes.premium_apt || [];
      break;
    case 'straordinario_cleaner':
      allowedApts = apartmentTypes.straordinario_apt || [];
      break;
    case 'formatore_cleaner':
      allowedApts = apartmentTypes.formatore_apt || [];
      break;
    case 'ufficio_cleaner':
      allowedApts = apartmentTypes.ufficio_apt || [];
      break;
    default:
      return true;
  }
  
  return allowedApts.map(a => a.toUpperCase()).includes(normalizedApt);
}

interface HardConstraintResult {
  compatible: boolean;
  reason?: string;
}

function priorityTypeToKey(priorityType: Priority | null | undefined): string | null {
  if (!priorityType) return null;
  if (priorityType === 'EO') return 'early_out';
  if (priorityType === 'HP') return 'high_priority';
  if (priorityType === 'LP') return 'low_priority';
  return null;
}

function checkHardConstraints(
  schedule: CleanerSchedule,
  task: TaskForScheduling,
  tasksMap: Map<number, TaskForScheduling>,
  apartmentTypes: ApartmentTypes = DEFAULT_APARTMENT_TYPES,
  officeOperationIds: Set<number> = new Set<number>(),
  taskTypesByCleaner: TaskTypesByCleanerConfig | null = null,
  formatoreRules?: FormatoreRules | null
): HardConstraintResult {
  const cleanerRole = schedule.role || 'Standard';
  const normalizedRole = normalizeCleanerRole(cleanerRole);
  const officeTask = isOfficeTask(task, officeOperationIds);
  const taskIsStraordinaria = isRealStraordinariaTask(task, officeOperationIds);
  void taskTypesByCleaner;
  const fixedCount = schedule.fixedTaskCount ?? 0;
  const totalExistingCount = fixedCount + (schedule.tasks?.length ?? 0);
  const fixedHasAnyOT = schedule.fixedHasAnyOT === true;
  const fixedHasLongOT = schedule.fixedHasLongOT === true;

  if (officeTask) {
    return normalizedRole === 'ufficio_cleaner'
      ? { compatible: true }
      : { compatible: false, reason: 'OFFICE_TASK_REQUIRES_UFFICIO_CLEANER' };
  }

  // Cleaner ufficio non prende task non-ufficio.
  if (normalizedRole === 'ufficio_cleaner') {
    return { compatible: false, reason: 'UFFICIO_CLEANER_NON_OFFICE_TASK' };
  }
  
  // 0. Verifica premium: task premium richiede cleaner Premium
  if (task.premium && normalizedRole !== 'premium_cleaner') {
    return { compatible: false, reason: 'ROLE_MISMATCH_PREMIUM_REQUIRED' };
  }
  
  // 0b. Verifica compatibilità typeApt con role del cleaner
  if (!canCleanerHandleApartment(cleanerRole, task.typeApt, apartmentTypes)) {
    return { compatible: false, reason: `ROLE_APT_MISMATCH_${cleanerRole}_vs_${task.typeApt}` };
  }
  
  // 1. Verifica straordinaria: solo cleaner con role "Straordinario"
  if (taskIsStraordinaria && normalizedRole !== 'straordinario_cleaner') {
    return { compatible: false, reason: 'CANNOT_DO_STRAORDINARIA' };
  }

  // 1b. Formatori: vincoli da app_settings (priorità + tipo task ammessi)
  if (normalizedRole === 'formatore_cleaner' && formatoreRules) {
    const taskPriorityKey = priorityTypeToKey(task.priorityType ?? null);
    if (formatoreRules.allowedPriorities.length > 0) {
      if (taskPriorityKey == null) {
        return { compatible: false, reason: 'FORMATORE_TASK_PRIORITY_MISSING' };
      }
      const allowedSet = new Set(formatoreRules.allowedPriorities.map(p => p.toLowerCase().replace(/-/g, '_')));
      if (!allowedSet.has(taskPriorityKey)) {
        return { compatible: false, reason: `FORMATORE_PRIORITY_NOT_ALLOWED_${taskPriorityKey}` };
      }
    }
    if (task.premium && !formatoreRules.premiumApt) {
      return { compatible: false, reason: 'FORMATORE_TASK_TYPE_PREMIUM_NOT_ALLOWED' };
    }
    if (taskIsStraordinaria && !formatoreRules.straordinarioApt) {
      return { compatible: false, reason: 'FORMATORE_TASK_TYPE_OT_NOT_ALLOWED' };
    }
    if (!task.premium && !taskIsStraordinaria && !formatoreRules.standardApt) {
      return { compatible: false, reason: 'FORMATORE_TASK_TYPE_STANDARD_NOT_ALLOWED' };
    }
  }
  
  // 2. Regole OT per il nuovo task da inserire
  if (taskIsStraordinaria) {
    const taskDurationMin = task.cleaningTimeMinutes || 60;
    
    // OT lunga (≥6h = 360min) deve essere sola
    if (taskDurationMin >= 360 && totalExistingCount > 0) {
      return { compatible: false, reason: 'LONG_OT_MUST_BE_ALONE' };
    }
    
    // OT corta: cleaner può avere max 1 altro task (che non sia OT e ≤2h)
    if (taskDurationMin < 360 && totalExistingCount > 0) {
      // Se esiste già una OT fissa in timeline, non possiamo aggiungere un'altra OT
      if (fixedHasAnyOT) {
        return { compatible: false, reason: 'ALREADY_HAS_OT' };
      }
      // Conta quanti task non-OT ha già il cleaner
      const existingTasks = schedule.tasks.map(t => tasksMap.get(t.taskId)).filter(Boolean);
      const existingOTs = existingTasks.filter((t): t is TaskForScheduling => !!t && isRealStraordinariaTask(t, officeOperationIds));
      const existingNonOTs = existingTasks.filter((t): t is TaskForScheduling => !!t && !isRealStraordinariaTask(t, officeOperationIds));
      
      // Se c'è già una OT, non può prenderne un'altra
      if (existingOTs.length > 0) {
        return { compatible: false, reason: 'ALREADY_HAS_OT' };
      }
      
      // Con OT corta, max 1 task extra e deve essere ≤2h
      if (existingNonOTs.length > 1) {
        return { compatible: false, reason: 'OT_SHORT_MAX_1_EXTRA' };
      }
      
      // Se c'è già 1 task extra, verifica che sia ≤2h (120 min) e ≤25 min di travel
      if (existingNonOTs.length === 1) {
        const extraTask = existingNonOTs[0]!;
        const extraDur = extraTask.cleaningTimeMinutes ?? 60;
        if (extraDur > 120) {
          return { compatible: false, reason: 'EXTRA_TASK_EXCEEDS_2H' };
        }
        
        // Check distanza tra OT corta (nuovo task) e task extra esistente
        const travelToExtra = estimateTravelMinutes(
          task as TaskInput,
          extraTask as TaskInput
        );
        if (travelToExtra > 25) {
          return { compatible: false, reason: 'OT_SHORT_EXTRA_TOO_FAR' };
        }
      }
    }
  }
  
  // 3. Se il cleaner ha già una OT, non può prendere altri task
  const existingTasks = schedule.tasks.map(t => tasksMap.get(t.taskId)).filter(Boolean);
  const existingOTs = existingTasks.filter((t): t is TaskForScheduling => !!t && isRealStraordinariaTask(t, officeOperationIds));
  
  // Se in timeline esiste una OT lunga fissa, non aggiungere nulla (append-only non deve violare)
  if (fixedHasLongOT) {
    return { compatible: false, reason: 'CLEANER_HAS_LONG_OT' };
  }

  // Se c'è una OT fissa (short) in timeline, applichiamo una regola conservativa:
  // - non aggiungere altre OT
  // - aggiungere un extra SOLO se l'ancora è proprio la OT (così possiamo stimare distanza)
  if (fixedHasAnyOT && existingOTs.length === 0) {
    if (taskIsStraordinaria) {
      return { compatible: false, reason: 'CANNOT_ADD_OT_TO_OT_CLEANER' };
    }
    // Se il cleaner ha già >=2 task fisse, significa che ha già extra oltre alla OT → non aggiungere altro
    if (fixedCount >= 2) {
      return { compatible: false, reason: 'CLEANER_HAS_OT_MAX_REACHED' };
    }
    const newTaskDuration = task.cleaningTimeMinutes || 60;
    if (newTaskDuration > 120) {
      return { compatible: false, reason: 'EXTRA_TASK_EXCEEDS_2H' };
    }
    // Possiamo stimare travel solo se l'anchor è la OT con coordinate
    const otAnchor = schedule.anchorTask;
    if (!otAnchor || !isTaskEquivalentToStraordinaria(otAnchor)) {
      return { compatible: false, reason: 'CLEANER_HAS_OT_ANCHOR_UNKNOWN' };
    }
    if (typeof otAnchor.lat !== 'number' || typeof otAnchor.lng !== 'number') {
      return { compatible: false, reason: 'CLEANER_HAS_OT_MISSING_COORDS' };
    }
    const travelToOT = estimateTravelMinutes(task as TaskInput, otAnchor as any as TaskInput);
    if (travelToOT > 25) {
      return { compatible: false, reason: 'OT_SHORT_EXTRA_TOO_FAR' };
    }
    return { compatible: true };
  }

  if (existingOTs.length > 0) {
    const otTask = existingOTs[0]!;
    const otDuration = otTask.cleaningTimeMinutes || 60;
    
    // OT lunga: nessun altro task
    if (otDuration >= 360) {
      return { compatible: false, reason: 'CLEANER_HAS_LONG_OT' };
    }
    
    // OT corta: max 1 task extra ≤2h
    if (existingTasks.length >= 2) {
      return { compatible: false, reason: 'CLEANER_HAS_OT_MAX_REACHED' };
    }
    
    // Il nuovo task deve essere ≤2h e non OT
    if (taskIsStraordinaria) {
      return { compatible: false, reason: 'CANNOT_ADD_OT_TO_OT_CLEANER' };
    }
    
    const newTaskDuration = task.cleaningTimeMinutes || 60;
    if (newTaskDuration > 120) {
      return { compatible: false, reason: 'EXTRA_TASK_EXCEEDS_2H' };
    }
    
    // Check distanza tra OT corta esistente e nuovo task extra
    const travelToOT = estimateTravelMinutes(
      task as TaskInput,
      otTask as TaskInput
    );
    if (travelToOT > 25) {
      return { compatible: false, reason: 'OT_SHORT_EXTRA_TOO_FAR' };
    }
  }
  
  return { compatible: true };
}

// ============================================================================
// COVERAGE-FIRST: Relaxation Levels
// L0 = strict (come oggi)
// L1 = consenti lateness/priority window violation
// L2 = consenti superare max load
// L3 = consenti travel alto
// ============================================================================

export enum RelaxLevel {
  STRICT = 0,
  ALLOW_LATENESS = 1,
  ALLOW_OVERLOAD = 2,
  ALLOW_HIGH_TRAVEL = 3
}

function relaxPenalty(level: number, params: Phase4Params): number {
  if (level === 0) return 0;
  return params.baseRelaxPenalty * Math.pow(params.relaxMultiplier, level);
}

interface RelaxConstraints {
  allowLateness: boolean;
  allowHighTravel: boolean;
  maxTravelMinutes: number;
  // Nota: maxLoad è un vincolo HARD basato su dynamicMaxTasks + bonus travel
  // Non è un soft limit che può essere relaxed
}

function getRelaxConstraints(level: number): RelaxConstraints {
  // maxLoad è un vincolo HARD (dynamicMaxTasks + bonus) - non può essere rilassato
  // I relaxation levels gestiscono solo lateness e travel alto
  return {
    allowLateness: level >= RelaxLevel.ALLOW_LATENESS,
    allowHighTravel: level >= RelaxLevel.ALLOW_HIGH_TRAVEL,
    maxTravelMinutes: level >= RelaxLevel.ALLOW_HIGH_TRAVEL ? 90 : 45
  };
}

function scheduleRowToTaskForScheduling(
  row: ScheduleRow,
  tasksMap: Map<number, TaskForScheduling>
): TaskForScheduling | null {
  return tasksMap.get(row.taskId) || null;
}

function tryInsertTask(
  schedule: CleanerSchedule,
  task: TaskForScheduling,
  position: number,
  workDate: string,
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null,
  params: Phase4Params,
  targets: MinutesBasedTargets,
  relaxLevel: number = 0,
  timelineConstraints: Phase3TimelineConstraints | null = null,
  previousTask: TaskForScheduling | null = null
): InsertionCandidate {
  const constraints = getRelaxConstraints(relaxLevel);
  const fixedCount = schedule.fixedTaskCount ?? 0;
  const newTaskCount = fixedCount + schedule.tasks.length + 1;
  
  // =====================================================
  // VINCOLI HARD: compatibilità cleaner-task, regole OT
  // Questi vincoli NON possono essere rilassati
  // =====================================================
  const hardCheck = checkHardConstraints(
    schedule,
    task,
    tasksMap,
    params.apartmentTypes,
    new Set<number>(params.officeOperationIds ?? []),
    params.taskTypesByCleaner ?? null,
    params.formatoreRules
  );
  if (!hardCheck.compatible) {
    return {
      cleanerId: schedule.cleanerId,
      position,
      deltaTravel: 0,
      deltaWait: 0,
      deltaLateness: 0,
      priorityPenalty: 0,
      underfilledBonus: 0,
      totalScore: Infinity,
      feasible: false,
      reason: hardCheck.reason
    };
  }
  
  const tasksBefore = schedule.tasks.slice(0, position);
  const tasksAfter = schedule.tasks.slice(position);
  
  const allTasksForSim: TaskForScheduling[] = [];
  
  for (const row of tasksBefore) {
    const t = tasksMap.get(row.taskId);
    if (t) allTasksForSim.push(t);
  }
  
  allTasksForSim.push(task);
  
  for (const row of tasksAfter) {
    const t = tasksMap.get(row.taskId);
    if (t) allTasksForSim.push(t);
  }
  
  const simResult = simulateSequence(
    workDate,
    allTasksForSim,
    schedule.startTime,
    tasksMap,
    previousTask,
    priorityWindows,
    timelineConstraints
  );
  
  if (!simResult.ok) {
    return {
      cleanerId: schedule.cleanerId,
      position,
      deltaTravel: 0,
      deltaWait: 0,
      deltaLateness: 0,
      priorityPenalty: 0,
      underfilledBonus: 0,
      totalScore: Infinity,
      feasible: false,
      reason: simResult.failReason || 'SIMULATION_FAILED'
    };
  }
  
  const deltaTravel = simResult.totalTravel - schedule.totalTravel;
  const deltaWait = simResult.totalWait - schedule.totalWait;
  const deltaPriorityPenalty = simResult.totalPriorityPenalty - schedule.totalPriorityPenalty;
  
  // =====================================================
  // VINCOLO HARD DINAMICO: max load con bonus travel individuale per cleaner
  // Usa travel DOPO l'inserimento (simResult) per calcolare avgTravel
  // Bonus +1 se avgTravel ≤ 10min (cleaner con percorsi compatti)
  // Se cleaner avrà 0 task (impossibile qui), avgTravel = Infinity
  // =====================================================
  let dynamicMaxLoad: number;
  if (params.dynamicMaxTasks !== undefined) {
    const avgTravelAfterInsert = newTaskCount > 0 ? simResult.totalTravel / newTaskCount : Infinity;
    const travelBonus = avgTravelAfterInsert <= 10 ? 1 : 0;
    dynamicMaxLoad = params.dynamicMaxTasks + travelBonus;
  } else {
    // Fallback se dynamicMaxTasks non è definito (usa baseMax = 3)
    dynamicMaxLoad = 3;
  }
  if (newTaskCount > dynamicMaxLoad) {
    return {
      cleanerId: schedule.cleanerId,
      position,
      deltaTravel,
      deltaWait,
      deltaLateness: deltaPriorityPenalty,
      priorityPenalty: simResult.totalPriorityPenalty,
      underfilledBonus: 0,
      totalScore: Infinity,
      feasible: false,
      reason: 'DYNAMIC_MAX_LOAD_EXCEEDED'
    };
  }
  
  if (params.travelPolicy) {
    // Wave path: check per-leg travel of the newly inserted task
    const waveConstraints = getWaveLevelConstraints(relaxLevel, params.travelPolicy);
    const newTaskIdx = simResult.scheduleRows.findIndex(r => r.taskId === task.taskId);
    const legToNew = newTaskIdx >= 0 ? simResult.scheduleRows[newTaskIdx].travelMinutesFromPrev : 0;
    const legFromNew = (newTaskIdx >= 0 && newTaskIdx + 1 < simResult.scheduleRows.length)
      ? simResult.scheduleRows[newTaskIdx + 1].travelMinutesFromPrev : 0;
    const maxNewLeg = Math.max(legToNew, legFromNew);

    if (maxNewLeg > waveConstraints.maxNewLegLimit) {
      return {
        cleanerId: schedule.cleanerId,
        position,
        deltaTravel,
        deltaWait,
        deltaLateness: deltaPriorityPenalty,
        priorityPenalty: simResult.totalPriorityPenalty,
        underfilledBonus: 0,
        totalScore: Infinity,
        feasible: false,
        reason: `WAVE_LEG_${Math.round(maxNewLeg)}_EXCEEDS_${waveConstraints.maxNewLegLimit}`
      };
    }

    if (deltaPriorityPenalty > 50 && !waveConstraints.allowLateness) {
      return {
        cleanerId: schedule.cleanerId,
        position,
        deltaTravel,
        deltaWait,
        deltaLateness: deltaPriorityPenalty,
        priorityPenalty: simResult.totalPriorityPenalty,
        underfilledBonus: 0,
        totalScore: Infinity,
        feasible: false,
        reason: 'PRIORITY_VIOLATION_REJECTED'
      };
    }
  } else {
    // Normal optimizer: legacy deltaTravel check
    if (deltaTravel > constraints.maxTravelMinutes) {
      if (!constraints.allowHighTravel) {
        return {
          cleanerId: schedule.cleanerId,
          position,
          deltaTravel,
          deltaWait,
          deltaLateness: deltaPriorityPenalty,
          priorityPenalty: simResult.totalPriorityPenalty,
          underfilledBonus: 0,
          totalScore: Infinity,
          feasible: false,
          reason: 'HIGH_TRAVEL_REJECTED'
        };
      }
    }

    if (deltaPriorityPenalty > 50 && !constraints.allowLateness) {
      return {
        cleanerId: schedule.cleanerId,
        position,
        deltaTravel,
        deltaWait,
        deltaLateness: deltaPriorityPenalty,
        priorityPenalty: simResult.totalPriorityPenalty,
        underfilledBonus: 0,
        totalScore: Infinity,
        feasible: false,
        reason: 'PRIORITY_VIOLATION_REJECTED'
      };
    }
  }
  
  let underfilledBonus = 0;
  if (fixedCount + schedule.tasks.length === 0) {
    underfilledBonus = params.underfilledBonus;
  }
  
  // FAIRNESS SCORING (minutes-based, consistent with Phase 2)
  const { fairness } = params;
  const currentWorkMinutes = (schedule.fixedWorkMinutes ?? 0) + (schedule.totalWorkMinutes ?? 0);
  const currentTravelMinutes = (schedule.fixedTravelMinutes ?? 0) + (schedule.totalTravel ?? 0);
  const currentLoadMin = currentWorkMinutes + fairness.wT * currentTravelMinutes;
  
  const newTaskDuration = task.cleaningTimeMinutes ?? 60;
  const deltaWorkMin = newTaskDuration;
  const deltaTravelMin = deltaTravel;
  const deltaLoadMin = deltaWorkMin + fairness.wT * deltaTravelMin;
  const newLoadMin = currentLoadMin + deltaLoadMin;
  
  // Bonus for underfilled cleaners (linear, consistent with Phase 2)
  // Use newLoadMin (post-insertion) to see if cleaner would still be under target
  const underGap = Math.max(0, targets.minTarget - newLoadMin);
  const minutesUnderBonus = underGap * fairness.k_under;
  
  // Penalty for overloaded cleaners (quadratic, consistent with Phase 2)
  const overGap = Math.max(0, newLoadMin - targets.maxTarget);
  const overloadPenalty = Math.pow(overGap, 2) * fairness.k_over;
  
  // Continuous balance penalty (consistent with Phase 2)
  const aboveAvg = Math.max(0, newLoadMin - targets.targetLoadMin);
  const balancePenalty = aboveAvg * fairness.k_balance;
  
  // Bonus for empty cleaners
  const zeroBonus = currentLoadMin === 0 ? fairness.zeroBonus : 0;
  
  // Include relaxPenalty nel totalScore - così soluzioni a livello più basso vincono sempre
  const relaxPenaltyValue = relaxPenalty(relaxLevel, params);
  const totalScore = deltaTravel + (deltaWait * 0.5) + (deltaPriorityPenalty * 2) 
    - underfilledBonus - minutesUnderBonus - zeroBonus + overloadPenalty + balancePenalty + relaxPenaltyValue;
  
  return {
    cleanerId: schedule.cleanerId,
    position,
    deltaTravel,
    deltaWait,
    deltaLateness: deltaPriorityPenalty,
    priorityPenalty: simResult.totalPriorityPenalty,
    underfilledBonus,
    totalScore,
    feasible: true
  };
}

function applyInsertion(
  schedule: CleanerSchedule,
  task: TaskForScheduling,
  position: number,
  workDate: string,
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null,
  previousTask: TaskForScheduling | null = null,
  timelineConstraints: Phase3TimelineConstraints | null = null
): CleanerSchedule {
  const allTasksForSim: TaskForScheduling[] = [];
  
  for (let i = 0; i < position; i++) {
    const t = tasksMap.get(schedule.tasks[i].taskId);
    if (t) allTasksForSim.push(t);
  }
  
  allTasksForSim.push(task);
  
  for (let i = position; i < schedule.tasks.length; i++) {
    const t = tasksMap.get(schedule.tasks[i].taskId);
    if (t) allTasksForSim.push(t);
  }
  
  const simResult = simulateSequence(
    workDate,
    allTasksForSim,
    schedule.startTime,
    tasksMap,
    previousTask,
    priorityWindows,
    timelineConstraints
  );

  // This should not happen if tryInsertTask was feasible with the same parameters.
  // If it does, fail fast to avoid silently dropping tasks from schedules.
  if (!simResult.ok) {
    throw new Error(simResult.failReason || 'APPLY_INSERTION_SIMULATION_FAILED');
  }
  
  // Calcola totalWorkMinutes dalla somma delle durate dei task
  const totalWorkMinutes = allTasksForSim.reduce(
    (sum, t) => sum + (t.cleaningTimeMinutes ?? 60),
    0
  );
  
  return {
    cleanerId: schedule.cleanerId,
    cleanerName: schedule.cleanerName,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    tasks: simResult.scheduleRows,
    endTimeMinutes: simResult.endTime ? dateToMinutes(simResult.endTime) : schedule.endTimeMinutes,
    totalTravel: simResult.totalTravel,
    totalWait: simResult.totalWait,
    totalPriorityPenalty: simResult.totalPriorityPenalty,
    fixedTaskCount: schedule.fixedTaskCount,
    fixedWorkMinutes: schedule.fixedWorkMinutes,
    fixedTravelMinutes: schedule.fixedTravelMinutes,
    fixedHasAnyOT: schedule.fixedHasAnyOT,
    fixedHasLongOT: schedule.fixedHasLongOT,
    anchorTask: schedule.anchorTask,
    // Preserva i dati per vincoli hard
    role: schedule.role,
    contractType: schedule.contractType,
    // Fairness tracking
    totalWorkMinutes
  };
}

interface SwapCandidate {
  cleanerId: number;
  removedTaskId: number;
  removedTaskLogisticCode: number;
  removedTaskScore: number; // Valore perso rimuovendo questo task
  newSchedule: CleanerSchedule;
  netGain: number; // Guadagno netto: penalty_avoided - loss_score
}

function trySwapForTask(
  task: TaskForScheduling,
  schedules: CleanerSchedule[],
  workDate: string,
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null,
  params: Phase4Params,
  unassignedPenaltyValue: number,
  relaxLevel: number = 0
): SwapCandidate | null {
  let bestSwap: SwapCandidate | null = null;
  const constraints = getRelaxConstraints(relaxLevel);
  const relaxPenaltyValue = relaxPenalty(relaxLevel, params);
  
  for (const schedule of schedules) {
    // Prova a rimuovere ciascun task (non OT) e inserire il nuovo task
    for (let i = 0; i < schedule.tasks.length; i++) {
      const taskToRemove = schedule.tasks[i];
      const removedTask = tasksMap.get(taskToRemove.taskId);
      
      // Non rimuovere straordinarie per fare spazio ad altri task
      if (removedTask && isTaskEquivalentToStraordinaria(removedTask)) continue;
      
      // Calcola il "valore" del task rimosso (approssimativo)
      // Un task normale vale circa la baseUnassignedPenalty
      const removedTaskScore = params.baseUnassignedPenalty;
      
      // Crea schedule senza questo task
      const tasksWithoutRemoved = schedule.tasks.filter((_, idx) => idx !== i);
      const tasksForSim: TaskForScheduling[] = tasksWithoutRemoved
        .map(r => tasksMap.get(r.taskId))
        .filter((t): t is TaskForScheduling => t !== undefined);
      
      // =====================================================
      // VINCOLI HARD: verifico con schedule temporaneo
      // =====================================================
      const tempSchedule: CleanerSchedule = {
        ...schedule,
        tasks: tasksWithoutRemoved
      };
      const hardCheck = checkHardConstraints(
        tempSchedule,
        task,
        tasksMap,
        params.apartmentTypes,
        new Set<number>(params.officeOperationIds ?? []),
        params.taskTypesByCleaner ?? null,
        params.formatoreRules
      );
      if (!hardCheck.compatible) {
        continue;
      }
      
      // Aggiungi il nuovo task alla fine
      tasksForSim.push(task);
      
      const simResult = simulateSequence(
        workDate,
        tasksForSim,
        schedule.startTime,
        tasksMap,
        schedule.anchorTask ?? null,
        priorityWindows
      );
      
      if (!simResult.ok) continue;
      
      // =====================================================
      // VINCOLO HARD DINAMICO: max load con bonus travel individuale per cleaner
      // Usa travel DOPO lo swap (simResult) per calcolare avgTravel
      // Bonus +1 se avgTravel ≤ 10min (cleaner con percorsi compatti)
      // Se cleaner avrà 0 task, avgTravel = Infinity
      // =====================================================
      const newTaskCount = tasksForSim.length;
      let dynamicMaxLoad: number;
      if (params.dynamicMaxTasks !== undefined) {
        const fixedCount = schedule.fixedTaskCount ?? 0;
        const totalCountAfterSwap = fixedCount + newTaskCount;
        const avgTravelAfterSwap = totalCountAfterSwap > 0 ? simResult.totalTravel / totalCountAfterSwap : Infinity;
        const travelBonus = avgTravelAfterSwap <= 10 ? 1 : 0;
        dynamicMaxLoad = params.dynamicMaxTasks + travelBonus;
      } else {
        // Fallback se dynamicMaxTasks non è definito (usa baseMax = 3)
        dynamicMaxLoad = 3;
      }
      if (newTaskCount > dynamicMaxLoad) {
        continue;
      }
      
      if (params.travelPolicy) {
        // Wave path: check the new task's leg travel
        const waveConstraints = getWaveLevelConstraints(relaxLevel, params.travelPolicy);
        const newTaskRow = simResult.scheduleRows.find(r => r.taskId === task.taskId);
        const maxNewLeg = newTaskRow?.travelMinutesFromPrev ?? 0;
        if (maxNewLeg > waveConstraints.maxNewLegLimit) continue;

        const priorityDelta = simResult.totalPriorityPenalty - schedule.totalPriorityPenalty;
        if (priorityDelta > 50 && !waveConstraints.allowLateness) continue;
      } else {
        // Normal optimizer: legacy deltaTravel check
        const travelDelta = simResult.totalTravel - schedule.totalTravel;
        if (travelDelta > constraints.maxTravelMinutes && !constraints.allowHighTravel) continue;

        const priorityDelta = simResult.totalPriorityPenalty - schedule.totalPriorityPenalty;
        if (priorityDelta > 50 && !constraints.allowLateness) continue;
      }
      
      // Calcola guadagno netto (include relaxPenalty nel costo)
      // Guadagno: evito penalità del nuovo task
      // Perdita: devo poi riassegnare il task rimosso + relaxPenalty
      const netGain = unassignedPenaltyValue - removedTaskScore - relaxPenaltyValue;
      
      // Accetta solo se il guadagno è positivo (vale la pena fare lo swap)
      if (netGain > 0) {
        if (!bestSwap || netGain > bestSwap.netGain) {
          // Calcola totalWorkMinutes per il nuovo schedule
          const newTotalWorkMinutes = tasksForSim.reduce(
            (sum, t) => sum + (t.cleaningTimeMinutes ?? 60),
            0
          );
          
          bestSwap = {
            cleanerId: schedule.cleanerId,
            removedTaskId: taskToRemove.taskId,
            removedTaskLogisticCode: taskToRemove.logisticCode,
            removedTaskScore,
            newSchedule: {
              cleanerId: schedule.cleanerId,
              cleanerName: schedule.cleanerName,
              startTime: schedule.startTime,
              endTime: schedule.endTime,
              tasks: simResult.scheduleRows,
              endTimeMinutes: simResult.endTime ? dateToMinutes(simResult.endTime) : schedule.endTimeMinutes,
              totalTravel: simResult.totalTravel,
              totalWait: simResult.totalWait,
              totalPriorityPenalty: simResult.totalPriorityPenalty,
              fixedTaskCount: schedule.fixedTaskCount,
              fixedWorkMinutes: schedule.fixedWorkMinutes,
              fixedTravelMinutes: schedule.fixedTravelMinutes,
              fixedHasAnyOT: schedule.fixedHasAnyOT,
              fixedHasLongOT: schedule.fixedHasLongOT,
              anchorTask: schedule.anchorTask,
              // Preserva i dati per vincoli hard
              role: schedule.role,
              contractType: schedule.contractType,
              // Fairness tracking
              totalWorkMinutes: newTotalWorkMinutes
            },
            netGain
          };
        }
      }
    }
  }
  
  return bestSwap;
}

function trySingleAssignment(
  task: TaskForScheduling,
  schedules: CleanerSchedule[],
  workDate: string,
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null,
  params: Phase4Params,
  targets: MinutesBasedTargets,
  relaxLevel: number = 0,
  constraintsByCleaner: Map<string, Phase3TimelineConstraints> = new Map()
): { success: boolean; cleanerId?: number; updatedSchedule?: CleanerSchedule; score?: number } {
  let bestOption: { cleanerId: number; schedule: CleanerSchedule; score: number } | null = null;
  
  for (const schedule of schedules) {
    const position = schedule.tasks.length;
    const cleanerConstraints = constraintsByCleaner.get(String(schedule.cleanerId)) || null;
    
    const candidate = tryInsertTask(
      schedule,
      task,
      position,
      workDate,
      tasksMap,
      priorityWindows,
      params,
      targets,
      relaxLevel,
      cleanerConstraints,
      schedule.anchorTask ?? null
    );
    
    if (candidate.feasible) {
      const score = candidate.totalScore + params.singleAssignmentPenalty;
      
      if (!bestOption || score < bestOption.score) {
        const updatedSchedule = applyInsertion(
          schedule,
          task,
          position,
          workDate,
          tasksMap,
          priorityWindows,
          schedule.anchorTask ?? null,
          cleanerConstraints
        );
        
        bestOption = {
          cleanerId: schedule.cleanerId,
          schedule: updatedSchedule,
          score
        };
      }
    }
  }
  
  if (bestOption) {
    return {
      success: true,
      cleanerId: bestOption.cleanerId,
      updatedSchedule: bestOption.schedule,
      score: bestOption.score
    };
  }
  
  return { success: false };
}

interface UnassignedPenaltyResult {
  totalPenalty: number;
  normalCount: number;
  straordinariaCount: number;
  normalPenalty: number;
  straordinariaPenalty: number;
}

function calculateUnassignedPenalty(
  taskResults: Phase4TaskResult[],
  tasksMap: Map<number, TaskForScheduling>,
  params: Phase4Params
): UnassignedPenaltyResult {
  const unassignedTasks = taskResults.filter(r => r.status === 'remain_unassigned');
  
  let normalCount = 0;
  let straordinariaCount = 0;
  
  for (const result of unassignedTasks) {
    const task = tasksMap.get(result.taskId);
    if (task && isTaskEquivalentToStraordinaria(task)) {
      straordinariaCount++;
    } else {
      normalCount++;
    }
  }
  
  // Penalità progressiva: ogni task successivo costa di più
  // Formula: base * (1 + multiplier * (k-1)) per il k-esimo task
  // Es: 1500, 2250, 3000, 3750... con multiplier=0.5
  let normalPenalty = 0;
  for (let k = 1; k <= normalCount; k++) {
    normalPenalty += params.baseUnassignedPenalty * (1 + params.progressiveMultiplier * (k - 1));
  }
  
  // Straordinarie: base + extra, con progressione
  let straordinariaPenalty = 0;
  const straordinariaBase = params.baseUnassignedPenalty + params.straordinariaExtraPenalty;
  for (let k = 1; k <= straordinariaCount; k++) {
    straordinariaPenalty += straordinariaBase * (1 + params.progressiveMultiplier * (k - 1));
  }
  
  return {
    totalPenalty: normalPenalty + straordinariaPenalty,
    normalCount,
    straordinariaCount,
    normalPenalty,
    straordinariaPenalty
  };
}

export async function runPhase4Algorithm(
  workDate: string,
  initialSchedules: CleanerSchedule[],
  unassignedTasks: { taskId: number; reasonCode: string; details: Record<string, any> }[],
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null,
  targets: MinutesBasedTargets,
  params: Phase4Params = DEFAULT_PHASE4_PARAMS,
  constraintsByCleaner: Map<string, Phase3TimelineConstraints> = new Map(),
  lockedCleanerIds: number[] = []
): Promise<Phase4Result> {
  const events: Phase4Event[] = [];
  const taskResults: Phase4TaskResult[] = [];
  let schedules = [...initialSchedules];
  const lockedSet = new Set(lockedCleanerIds);
  const getAssignableSchedules = () => schedules.filter(s => !lockedSet.has(s.cleanerId));
  
  let insertedCount = 0;
  let singleAssignedCount = 0;
  let remainUnassignedCount = 0;
  let iterationsUsed = 0;
  
  events.push({
    eventType: 'PHASE4_RETRY_STARTED',
    payload: {
      unassigned_count: unassignedTasks.length,
      schedules_count: schedules.length,
      locked_cleaners_excluded: lockedCleanerIds.length,
      params
    }
  });
  
  // Calcola scarcity per ogni task (quanti cleaners compatibili)
  const taskScarcity = new Map<number, number>();
  for (const unassigned of unassignedTasks) {
    const task = tasksMap.get(unassigned.taskId);
    if (!task) continue;
    
    let compatibleCount = 0;
    for (const schedule of getAssignableSchedules()) {
      // Conta solo se almeno 1 posizione potrebbe funzionare (approssimativo)
      const cleanerConstraints = constraintsByCleaner.get(String(schedule.cleanerId)) || null;
      const candidate = tryInsertTask(
        schedule,
        task,
        schedule.tasks.length,
        workDate,
        tasksMap,
        priorityWindows,
        params,
        targets,
        0,
        cleanerConstraints,
        schedule.anchorTask ?? null
      );
      if (candidate.feasible) compatibleCount++;
    }
    taskScarcity.set(unassigned.taskId, compatibleCount);
  }
  
  // Sort unassigned tasks: straordinarie first, then by scarcity (più rari prima), then by priority
  const sortedUnassigned = [...unassignedTasks].sort((a, b) => {
    const taskA = tasksMap.get(a.taskId);
    const taskB = tasksMap.get(b.taskId);
    
    // Straordinarie get highest priority (0 = straordinaria, 1 = normal)
    const straordA = taskA && isTaskEquivalentToStraordinaria(taskA) ? 0 : 1;
    const straordB = taskB && isTaskEquivalentToStraordinaria(taskB) ? 0 : 1;
    if (straordA !== straordB) return straordA - straordB;
    
    // Then by scarcity (più rari prima - meno compatibili = priorità più alta)
    const scarcityA = taskScarcity.get(a.taskId) ?? schedules.length;
    const scarcityB = taskScarcity.get(b.taskId) ?? schedules.length;
    if (scarcityA !== scarcityB) return scarcityA - scarcityB;
    
    // Then by priority type
    const priorityOrder: Record<string, number> = { 'EO': 0, 'HP': 1, 'LP': 2 };
    const priorityA = priorityOrder[taskA?.priorityType || ''] ?? 3;
    const priorityB = priorityOrder[taskB?.priorityType || ''] ?? 3;
    
    return priorityA - priorityB;
  });
  
  events.push({
    eventType: 'PHASE4_SCARCITY_CALCULATED',
    payload: {
      task_scarcity: Object.fromEntries(taskScarcity)
    }
  });
  
  // ============================================================================
  // LEVEL-WIDE PASSES: processa tutti i task con L0, poi tutti i rimanenti con L1, ecc.
  // Questo preserva l'ordinamento scarcity/priority per ogni livello
  // ============================================================================
  
  const finalizedTaskIds = new Set<number>(); // Task già assegnati (evita duplicati)
  const maxRequeueAttempts = 2; // Massimo tentativi per task re-enqueuati via swap
  const requeueAttempts = new Map<number, number>(); // Conta solo i tentativi dopo swap
  
  // Inizializza remaining con tutti i task non assegnati
  let remainingTasks = [...sortedUnassigned];
  
  // Level-wide pass: processa tutti i task a ogni livello di relax
  for (let currentRelaxLevel = 0; currentRelaxLevel <= params.maxRelaxLevel; currentRelaxLevel++) {
    if (remainingTasks.length === 0) break;
    
    const tasksForThisLevel = [...remainingTasks];
    const stillUnassigned: typeof remainingTasks = [];
    
    // Coda per swap re-enqueue dentro questo livello
    const levelQueue: { 
      taskId: number; 
      reasonCode: string; 
      details: Record<string, any>; 
      wasSwappedOut?: boolean 
    }[] = [...tasksForThisLevel];
    
    events.push({
      eventType: 'PHASE4_LEVEL_PASS_STARTED',
      payload: {
        relax_level: currentRelaxLevel,
        tasks_to_process: levelQueue.length
      }
    });

    // OR-Tools batch repair: assign as many tasks as possible (append-only) in one CP-SAT solve
    const assignableSchedules = getAssignableSchedules();
    const queueForBatch = levelQueue.filter((u) => !finalizedTaskIds.has(u.taskId));
    if (queueForBatch.length > 0 && assignableSchedules.length > 0) {
      const allowed: { taskId: number; cleanerId: number; deltaTravel: number }[] = [];
      const repairTasks: { taskId: number; cleaningTimeMinutes: number }[] = [];
      const seenTaskIds = new Set<number>();
      for (const u of queueForBatch) {
        const task = tasksMap.get(u.taskId);
        if (!task) continue;
        if (!seenTaskIds.has(task.taskId)) {
          seenTaskIds.add(task.taskId);
          repairTasks.push({
            taskId: task.taskId,
            cleaningTimeMinutes: task.cleaningTimeMinutes ?? 60
          });
        }
        for (const schedule of assignableSchedules) {
          const cleanerConstraints = constraintsByCleaner.get(String(schedule.cleanerId)) ?? null;
          const candidate = tryInsertTask(
            schedule,
            task,
            schedule.tasks.length,
            workDate,
            tasksMap,
            priorityWindows,
            params,
            targets,
            currentRelaxLevel,
            cleanerConstraints,
            schedule.anchorTask ?? null
          );
          if (candidate.feasible) {
            allowed.push({
              taskId: task.taskId,
              cleanerId: schedule.cleanerId,
              deltaTravel: candidate.deltaTravel
            });
          }
        }
      }
      const repairCleaners: {
        cleanerId: number;
        currentLoadMin: number;
        currentTaskCount: number;
        maxLoad: number;
        maxTasks: number;
      }[] = [];
      for (const schedule of assignableSchedules) {
        const currentWorkMinutes = (schedule.fixedWorkMinutes ?? 0) + (schedule.totalWorkMinutes ?? 0);
        const currentTravelMinutes = (schedule.fixedTravelMinutes ?? 0) + (schedule.totalTravel ?? 0);
        const currentLoadMin = currentWorkMinutes + params.fairness.wT * currentTravelMinutes;
        const currentTaskCount = (schedule.fixedTaskCount ?? 0) + schedule.tasks.length;
        const avgTravel = schedule.tasks.length > 0 ? schedule.totalTravel / schedule.tasks.length : 0;
        const travelBonus = avgTravel <= 10 ? 1 : 0;
        const maxTasks =
          (params.dynamicMaxTasks !== undefined ? params.dynamicMaxTasks : 3) + travelBonus;
        repairCleaners.push({
          cleanerId: schedule.cleanerId,
          currentLoadMin,
          currentTaskCount,
          maxLoad: targets.maxTarget,
          maxTasks
        });
      }
      try {
        const batchResult = await runPhase4RepairBatch(
          allowed,
          repairTasks,
          repairCleaners,
          params.fairness.wT,
          { timeoutMs: 60000 }
        );
        const sortedAssignments = [...batchResult.assignments].sort(
          (a, b) => a.cleanerId - b.cleanerId || a.taskId - b.taskId
        );
        const appliedTaskIds = new Set<number>();
        for (const { taskId, cleanerId } of sortedAssignments) {
          const scheduleIdx = schedules.findIndex((s) => s.cleanerId === cleanerId);
          if (scheduleIdx < 0) continue;
          const schedule = schedules[scheduleIdx];
          const task = tasksMap.get(taskId);
          if (!task) continue;
          const cleanerConstraints = constraintsByCleaner.get(String(cleanerId)) ?? null;
          const candidate = tryInsertTask(
            schedule,
            task,
            schedule.tasks.length,
            workDate,
            tasksMap,
            priorityWindows,
            params,
            targets,
            currentRelaxLevel,
            cleanerConstraints,
            schedule.anchorTask ?? null
          );
          if (!candidate.feasible) continue;
          const updatedSchedule = applyInsertion(
            schedule,
            task,
            schedule.tasks.length,
            workDate,
            tasksMap,
            priorityWindows,
            schedule.anchorTask ?? null,
            cleanerConstraints
          );
          schedules[scheduleIdx] = updatedSchedule;
          taskResults.push({
            taskId: task.taskId,
            logisticCode: task.logisticCode,
            status: 'inserted',
            cleanerId: candidate.cleanerId,
            position: schedule.tasks.length,
            score: candidate.totalScore
          });
          finalizedTaskIds.add(task.taskId);
          appliedTaskIds.add(task.taskId);
          insertedCount++;
          events.push({
            eventType: 'PHASE4_TASK_REASSIGNED_INSERTION',
            payload: {
              task_id: task.taskId,
              logistic_code: task.logisticCode,
              cleaner_id: candidate.cleanerId,
              position: schedule.tasks.length,
              delta_travel: candidate.deltaTravel,
              delta_wait: candidate.deltaWait,
              priority_penalty: candidate.priorityPenalty,
              underfilled_bonus: candidate.underfilledBonus,
              total_score: candidate.totalScore,
              ortools_batch: true
            }
          });
        }
        for (let i = levelQueue.length - 1; i >= 0; i--) {
          if (appliedTaskIds.has(levelQueue[i].taskId)) levelQueue.splice(i, 1);
        }
      } catch (_err) {
        // Fallback to greedy only for this level
      }
    }

    while (levelQueue.length > 0) {
      const unassigned = levelQueue.shift()!;
      
      // Skip se già finalizzato
      if (finalizedTaskIds.has(unassigned.taskId)) {
        continue;
      }
      
      // Conta tentativi solo per task re-enqueuati via swap
      const isSwappedOut = (unassigned as any).wasSwappedOut === true;
      if (isSwappedOut) {
        const attempts = requeueAttempts.get(unassigned.taskId) || 0;
        if (attempts >= maxRequeueAttempts) {
          taskResults.push({
            taskId: unassigned.taskId,
            logisticCode: tasksMap.get(unassigned.taskId)?.logisticCode || 0,
            status: 'remain_unassigned',
            reason: 'MAX_REQUEUE_ATTEMPTS_EXCEEDED'
          });
          remainUnassignedCount++;
          finalizedTaskIds.add(unassigned.taskId);
          continue;
        }
        requeueAttempts.set(unassigned.taskId, attempts + 1);
      }
      
      const task = tasksMap.get(unassigned.taskId);
      if (!task) {
        taskResults.push({
          taskId: unassigned.taskId,
          logisticCode: 0,
          status: 'remain_unassigned',
          reason: 'TASK_NOT_FOUND'
        });
        finalizedTaskIds.add(unassigned.taskId);
        remainUnassignedCount++;
        continue;
      }
      
      let bestCandidate: InsertionCandidate | null = null;
      let bestScheduleIdx = -1;
      let bestPosition = -1;
      let usedRelaxLevel = currentRelaxLevel;
      
      // Ordina cleaners per workload più basso (euristica: più disponibili prima)
      // poi applica il cap per performance
      const sortedScheduleIndices = schedules
        .map((s, idx) => ({ idx, load: s.tasks.length, endTime: s.endTimeMinutes, isLocked: lockedSet.has(s.cleanerId) }))
        .filter(s => !s.isLocked)
        .sort((a, b) => {
          // Prima per carico minore
          if (a.load !== b.load) return a.load - b.load;
          // Poi per end time più basso (finiscono prima)
          return a.endTime - b.endTime;
        })
        .slice(0, params.maxCleanersToTryPerTask)
        .map(s => s.idx);
      
      for (const sIdx of sortedScheduleIndices) {
        const schedule = schedules[sIdx];

        const startPos = params.appendOnly ? schedule.tasks.length : 0;
        const endPos = params.appendOnly ? schedule.tasks.length : schedule.tasks.length;

        for (let pos = startPos; pos <= endPos; pos++) {
          iterationsUsed++;
          
          if (iterationsUsed > params.maxInsertionAttempts) {
            events.push({
              eventType: 'PHASE4_ITERATION_LIMIT_REACHED',
              payload: {
                limit: params.maxInsertionAttempts,
                remaining_unassigned: sortedUnassigned.length - taskResults.length
              }
            });
            break;
          }
          
          const cleanerConstraints = constraintsByCleaner.get(String(schedule.cleanerId)) || null;
          const candidate = tryInsertTask(
            schedule,
            task,
            pos,
            workDate,
            tasksMap,
            priorityWindows,
            params,
            targets,
            currentRelaxLevel,
            cleanerConstraints,
            schedule.anchorTask ?? null
          );
          
          if (candidate.feasible) {
            if (!bestCandidate || candidate.totalScore < bestCandidate.totalScore) {
              bestCandidate = candidate;
              bestScheduleIdx = sIdx;
              bestPosition = pos;
            }
          }
        }
        
        if (iterationsUsed > params.maxInsertionAttempts) break;
      }
      
      if (bestCandidate && bestCandidate.feasible) {
        const chosenSchedule = schedules[bestScheduleIdx];
        const chosenConstraints = constraintsByCleaner.get(String(chosenSchedule.cleanerId)) || null;
        const updatedSchedule = applyInsertion(
          chosenSchedule,
          task,
          bestPosition,
          workDate,
          tasksMap,
          priorityWindows,
          chosenSchedule.anchorTask ?? null,
          chosenConstraints
        );
        
        schedules[bestScheduleIdx] = updatedSchedule;
        
        taskResults.push({
          taskId: task.taskId,
          logisticCode: task.logisticCode,
          status: 'inserted',
          cleanerId: bestCandidate.cleanerId,
          position: bestPosition,
          score: bestCandidate.totalScore
        });
        finalizedTaskIds.add(task.taskId);
        
        insertedCount++;
        
        events.push({
          eventType: 'PHASE4_TASK_REASSIGNED_INSERTION',
          payload: {
            task_id: task.taskId,
            logistic_code: task.logisticCode,
            cleaner_id: bestCandidate.cleanerId,
            position: bestPosition,
            delta_travel: bestCandidate.deltaTravel,
            delta_wait: bestCandidate.deltaWait,
            priority_penalty: bestCandidate.priorityPenalty,
            underfilled_bonus: bestCandidate.underfilledBonus,
            total_score: bestCandidate.totalScore
          }
        });
      } else {
        const singleResult = trySingleAssignment(
          task,
          getAssignableSchedules(),
          workDate,
          tasksMap,
          priorityWindows,
          params,
          targets,
          currentRelaxLevel,
          constraintsByCleaner
        );
        
        if (singleResult.success && singleResult.updatedSchedule) {
          const scheduleIdx = schedules.findIndex(s => s.cleanerId === singleResult.cleanerId);
          if (scheduleIdx >= 0) {
            schedules[scheduleIdx] = singleResult.updatedSchedule;
          }
          
          taskResults.push({
            taskId: task.taskId,
            logisticCode: task.logisticCode,
            status: 'single_assigned',
            cleanerId: singleResult.cleanerId,
            score: singleResult.score
          });
          finalizedTaskIds.add(task.taskId);
          
          singleAssignedCount++;
          
          events.push({
            eventType: 'PHASE4_TASK_ASSIGNED_SINGLE',
            payload: {
              task_id: task.taskId,
              logistic_code: task.logisticCode,
              cleaner_id: singleResult.cleanerId,
              score: singleResult.score
            }
          });
        } else {
          // Prova swap: rimuovi un task debole per fare spazio
          const isStraordinaria = isTaskEquivalentToStraordinaria(task);
          
          // Calcola la penalità che si eviterebbe assegnando questo task
          const unassignedPenaltyValue = isStraordinaria 
            ? params.baseUnassignedPenalty + params.straordinariaExtraPenalty
            : params.baseUnassignedPenalty;
          
          const swapResult = trySwapForTask(
            task,
            getAssignableSchedules(),
            workDate,
            tasksMap,
            priorityWindows,
            params,
            unassignedPenaltyValue,
            currentRelaxLevel
          );
          
          if (swapResult) {
            // Swap riuscito
            const scheduleIdx = schedules.findIndex(s => s.cleanerId === swapResult.cleanerId);
            if (scheduleIdx >= 0) {
              schedules[scheduleIdx] = swapResult.newSchedule;
            }
            
            taskResults.push({
              taskId: task.taskId,
              logisticCode: task.logisticCode,
              status: 'inserted',
              cleanerId: swapResult.cleanerId,
              score: -swapResult.netGain
            });
            finalizedTaskIds.add(task.taskId);
            
            insertedCount++;
            
            events.push({
              eventType: 'PHASE4_TASK_ASSIGNED_VIA_SWAP',
              payload: {
                task_id: task.taskId,
                logistic_code: task.logisticCode,
                cleaner_id: swapResult.cleanerId,
                removed_task_id: swapResult.removedTaskId,
                removed_task_logistic_code: swapResult.removedTaskLogisticCode,
                net_gain: swapResult.netGain,
                is_straordinaria: isStraordinaria
              }
            });
            
            // CRITICAL: The swapped-out task must be processed again.
            // If it was previously finalized, un-finalize it and remove the old result entry,
            // otherwise it would be skipped and become "missing" (neither assigned nor unassigned).
            if (finalizedTaskIds.has(swapResult.removedTaskId)) {
              finalizedTaskIds.delete(swapResult.removedTaskId);
            }
            const prevIdx = taskResults.findIndex(r => r.taskId === swapResult.removedTaskId && r.status !== 'remain_unassigned');
            if (prevIdx >= 0) {
              const prev = taskResults[prevIdx] as any;
              if (prev?.status === 'single_assigned') {
                singleAssignedCount = Math.max(0, singleAssignedCount - 1);
              } else if (prev?.status === 'inserted') {
                insertedCount = Math.max(0, insertedCount - 1);
              }
              taskResults.splice(prevIdx, 1);
            }

            // Il task rimosso torna nella coda di questo livello per essere ri-processato
            levelQueue.push({
              taskId: swapResult.removedTaskId,
              reasonCode: 'SWAPPED_OUT_FOR_HIGHER_PRIORITY',
              details: { swapped_by: task.taskId },
              wasSwappedOut: true
            });
            
            events.push({
              eventType: 'PHASE4_TASK_SWAPPED_OUT_REQUEUED',
              payload: {
                task_id: swapResult.removedTaskId,
                logistic_code: swapResult.removedTaskLogisticCode,
                replaced_by_task_id: task.taskId,
                replaced_by_is_straordinaria: isStraordinaria,
                requeue_position: levelQueue.length,
                relax_level: currentRelaxLevel
              }
            });
          } else {
            // Nessun swap possibile - metti in stillUnassigned per il prossimo livello
            stillUnassigned.push(unassigned);
            
            if (currentRelaxLevel < params.maxRelaxLevel) {
              events.push({
                eventType: 'PHASE4_TASK_DEFERRED_TO_NEXT_LEVEL',
                payload: {
                  task_id: task.taskId,
                  logistic_code: task.logisticCode,
                  current_relax_level: currentRelaxLevel,
                  next_relax_level: currentRelaxLevel + 1,
                  is_straordinaria: isStraordinaria
                }
              });
            } else {
              // Già al massimo relaxLevel - definitivamente unassigned
              taskResults.push({
                taskId: task.taskId,
                logisticCode: task.logisticCode,
                status: 'remain_unassigned',
                reason: 'NO_FEASIBLE_INSERTION_AT_MAX_RELAX'
              });
              finalizedTaskIds.add(task.taskId);
              
              remainUnassignedCount++;
              
              events.push({
                eventType: 'PHASE4_TASK_REMAIN_UNASSIGNED',
                payload: {
                  task_id: task.taskId,
                  logistic_code: task.logisticCode,
                  original_reason: unassigned.reasonCode,
                  insertion_attempts: iterationsUsed,
                  is_straordinaria: isStraordinaria,
                  swap_attempted: true,
                  max_relax_level_reached: true,
                  final_relax_level: currentRelaxLevel
                }
              });
            }
          }
        }
      }
    }
    
    // Fine del livello corrente - aggiorna remainingTasks per il prossimo livello
    remainingTasks = stillUnassigned.filter(u => !finalizedTaskIds.has(u.taskId));
    
    events.push({
      eventType: 'PHASE4_LEVEL_PASS_COMPLETED',
      payload: {
        relax_level: currentRelaxLevel,
        assigned_this_level: tasksForThisLevel.length - stillUnassigned.length,
        remaining_for_next_level: remainingTasks.length
      }
    });
  }
  
  const phase3AssignedCount = initialSchedules.reduce((sum, s) => sum + s.tasks.length, 0);
  const phase4AssignedCount = schedules.reduce((sum, s) => sum + s.tasks.length, 0);
  const coverageImprovement = phase4AssignedCount - phase3AssignedCount;
  
  // Calcola penalità totale per task non assegnati (penalità progressiva)
  const unassignedPenalty = calculateUnassignedPenalty(taskResults, tasksMap, params);
  
  events.push({
    eventType: 'PHASE4_COMPLETED',
    payload: {
      phase3_assigned_count: phase3AssignedCount,
      phase4_assigned_count: phase4AssignedCount,
      inserted_count: insertedCount,
      single_assigned_count: singleAssignedCount,
      remain_unassigned_count: remainUnassignedCount,
      coverage_improvement: coverageImprovement,
      iterations_used: iterationsUsed,
      unassigned_penalty: unassignedPenalty.totalPenalty,
      normal_unassigned_count: unassignedPenalty.normalCount,
      straordinaria_unassigned_count: unassignedPenalty.straordinariaCount
    }
  });
  
  return {
    taskResults,
    updatedSchedules: schedules,
    events,
    stats: {
      unassignedInput: unassignedTasks.length,
      insertedCount,
      singleAssignedCount,
      remainUnassignedCount,
      iterationsUsed,
      coverageImprovement,
      unassignedPenalty: unassignedPenalty.totalPenalty,
      normalUnassignedCount: unassignedPenalty.normalCount,
      straordinariaUnassignedCount: unassignedPenalty.straordinariaCount
    }
  };
}
