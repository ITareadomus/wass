import { estimateTravelMinutes, TaskInput } from './phase1';

export interface CleanerInput {
  cleanerId: number;
  name: string;
  role: string; // Premium, Standard, Straordinario, Formatore
  contractType: string; // A, B, C, 'a chiamata'
  preferredCustomers: number[];
  counterHours: number;
  lat?: number;
  lng?: number;
}

export interface TaskForPhase2 {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  clientId: number;
  premium: boolean;
  straordinaria: boolean;
  typeApt: string; // A, B, C
  priority: string;
  cleaningTime: number;
}

export interface GroupCandidate {
  taskIds: number[];
  logisticCodes: number[];
  zone: number;
  score: number;
  avgTravelMin: number;
  maxTravelMin: number;
  isSingle?: boolean;
  hasStraordinaria?: boolean;
  isLongStraordinaria?: boolean;
  minCompatibleCleaners?: number; // Scarcity: min cleaners compatibili tra i task del gruppo
  anchoredCleanerId?: number;     // Wave: group is anchored to this cleaner (contains their timeline task)
}

export interface ApartmentTypes {
  standard_apt: string[];
  premium_apt: string[];
  straordinario_apt: string[];
  formatore_apt: string[];
}

export const DEFAULT_APARTMENT_TYPES: ApartmentTypes = {
  standard_apt: ['A', 'B', 'C', 'D', 'E', 'F', 'X'],
  premium_apt: ['A', 'B', 'C', 'D', 'E', 'F', 'X'],
  straordinario_apt: ['A', 'B', 'C', 'D', 'E', 'F', 'X'],
  formatore_apt: ['B', 'C']
};

export interface FairnessParams {
  wT: number;              // weight for travel in load calculation (loadMin = workMin + wT * travelMin)
  k_under: number;         // bonus multiplier for underfilled cleaners
  k_over: number;          // penalty multiplier for overloaded cleaners (quadratic)
  k_balance: number;       // continuous penalty per minute above average (eliminates dead zone between minTarget and maxTarget)
  zeroBonus: number;       // bonus in "equivalent minutes" for cleaners with zero load
  minTargetRatio: number;  // ratio for minimum target (e.g., 0.6 = 60% of average)
  maxTargetRatio: number;  // ratio for maximum target (e.g., 1.25 = 125% of average)
}

export const DEFAULT_FAIRNESS_PARAMS: FairnessParams = {
  wT: 1.0,                 // travel counts as much as work
  k_under: 6,              // 30 min gap = ~20 points bonus (stronger pull toward underfilled cleaners)
  k_over: 0.05,            // quadratic penalty: (over^2) * k_over
  k_balance: 2,            // continuous: 2 pts per minute above average (soft nudge, main rebalancing happens in Phase 5)
  zeroBonus: 30,           // 30 min equivalent bonus for empty cleaners
  minTargetRatio: 0.6,     // cleaners under 60% of target get bonus
  maxTargetRatio: 1.25     // cleaners over 125% of target get penalty
};

export interface CleanerFixedStats {
  fixedTaskCount: number;
  fixedHasAnyOT: boolean;
  fixedHasLongOT: boolean;
  fixedWorkMinutes: number;
  fixedTravelMinutes: number;
}

export interface Phase2Params {
  travelWeight: number;
  loadWeight: number;
  preferenceBonus: number;
  apartmentTypes: ApartmentTypes;
  dynamicMaxTasks?: number;  // base max from totalTasks/numCleaners, bonus +1 per-cleaner if avgTravel ≤ 10min
  fairness: FairnessParams;  // minutes-based fairness parameters
  initialLoadByCleanerMin?: Map<number, number>; // Pre-existing load from timeline (minutes)
  initialLastPositionByCleaner?: Map<number, { lat: number; lng: number }>; // Last known geographic position from timeline
  initialFixedStatsByCleaner?: Map<number, CleanerFixedStats>; // Pre-existing task/OT counts from timeline
}

export const DEFAULT_PHASE2_PARAMS: Phase2Params = {
  travelWeight: 2,
  loadWeight: 5,
  preferenceBonus: 10,
  apartmentTypes: DEFAULT_APARTMENT_TYPES,
  dynamicMaxTasks: undefined,
  fairness: DEFAULT_FAIRNESS_PARAMS
};

export interface DynamicLimits {
  baseMax: number;    // ceil(totalTasks / numCleaners) - limite base
  minTasks: number;   // min task per gruppo (Phase 1)
}

// Calcola limiti dinamici basati su totalTasks e numCleaners
// Il bonus travel (+1 se avgTravel ≤ 10min) viene applicato per-cleaner in Phase 2/4
export function calculateDynamicLimits(
  totalTasks: number,
  numCleaners: number
): DynamicLimits {
  if (numCleaners <= 0) {
    return { baseMax: 3, minTasks: 1 };
  }
  
  const baseMax = Math.ceil(totalTasks / numCleaners);
  const minTasks = Math.max(1, baseMax - 1);
  
  return { baseMax, minTasks };
}

// Minutes-based fairness targets
export interface MinutesBasedTargets {
  targetLoadMin: number;   // average load per cleaner (totalWorkMin / numCleaners)
  minTarget: number;       // minimum target (targetLoadMin * minTargetRatio)
  maxTarget: number;       // maximum target (targetLoadMin * maxTargetRatio)
  totalWorkMin: number;    // total work minutes
  numCleaners: number;     // number of cleaners
}

// Calculate minutes-based fairness targets
export function calculateMinutesBasedTargets(
  tasks: TaskForPhase2[],
  numCleaners: number,
  fairness: FairnessParams,
  preExistingTotalLoadMin: number = 0
): MinutesBasedTargets {
  if (numCleaners <= 0) {
    return { targetLoadMin: 60, minTarget: 36, maxTarget: 75, totalWorkMin: 60, numCleaners: 1 };
  }
  
  const remainingWorkMin = tasks.reduce((sum, t) => sum + (t.cleaningTime || 60), 0);
  const totalWorkMin = remainingWorkMin + preExistingTotalLoadMin;
  const targetLoadMin = totalWorkMin / numCleaners;
  
  return {
    targetLoadMin,
    minTarget: targetLoadMin * fairness.minTargetRatio,
    maxTarget: targetLoadMin * fairness.maxTargetRatio,
    totalWorkMin,
    numCleaners
  };
}

export interface CleanerScore {
  cleanerId: number;
  name: string;
  score: number;
  travelMin: number;
  currentLoadMin: number;    // workMin + wT * travelMin (pre-assignment)
  newLoadMin: number;        // loadMin after adding this group
  hasPreference: boolean;
  breakdown: {
    baseScore: number;
    travelPenalty: number;
    preferenceBonus: number;
    underBonus: number;      // bonus for underfilled cleaners
    overPenalty: number;     // penalty for overloaded cleaners
    balancePenalty: number;  // continuous penalty for load above average
    zeroBonus: number;       // bonus for empty cleaners
  };
}

export interface Phase2Event {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface AssignmentResult {
  groupTaskIds: number[];
  groupLogisticCodes: number[];
  cleanerId: number | null;
  cleanerName: string | null;
  assigned: boolean;
  droppedTasks: number[];
  retryCount: number;
}

export interface Phase2Result {
  assignments: AssignmentResult[];
  events: Phase2Event[];
  stats: {
    groupsProcessed: number;
    groupsAssigned: number;
    groupsUnassigned: number;
    tasksDropped: number;
  };
}

function normalizeCleanerRole(role: string): string {
  if (!role) return 'standard_cleaner';
  const normalized = role.toLowerCase().trim();
  if (normalized.includes('standard')) return 'standard_cleaner';
  if (normalized.includes('premium')) return 'premium_cleaner';
  if (normalized.includes('straord')) return 'straordinario_cleaner';
  if (normalized.includes('formatore')) return 'formatore_cleaner';
  return 'standard_cleaner';
}

function canCleanerHandleApartment(
  cleanerRole: string,
  typeApt: string,
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
    default:
      return true;
  }
  
  return allowedApts.map(a => a.toUpperCase()).includes(normalizedApt);
}

export function isCleanerCompatible(
  cleaner: CleanerInput,
  task: TaskForPhase2,
  apartmentTypes: ApartmentTypes = DEFAULT_APARTMENT_TYPES
): { compatible: boolean; reason?: string } {
  const normalizedRole = normalizeCleanerRole(cleaner.role);
  if (task.premium && normalizedRole !== 'premium_cleaner') {
    return { compatible: false, reason: 'ROLE_MISMATCH_PREMIUM_REQUIRED' };
  }
  
  if (task.straordinaria && normalizedRole !== 'straordinario_cleaner') {
    return { compatible: false, reason: 'CANNOT_DO_STRAORDINARIA' };
  }
  
  if (!canCleanerHandleApartment(cleaner.role, task.typeApt, apartmentTypes)) {
    return { compatible: false, reason: `ROLE_APT_MISMATCH_${cleaner.role}_vs_${task.typeApt}` };
  }
  
  return { compatible: true };
}

export function isCleanerCompatibleWithGroup(
  cleaner: CleanerInput,
  tasks: TaskForPhase2[],
  apartmentTypes: ApartmentTypes = DEFAULT_APARTMENT_TYPES
): { compatible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  
  for (const task of tasks) {
    const result = isCleanerCompatible(cleaner, task, apartmentTypes);
    if (!result.compatible) {
      reasons.push(`task_${task.taskId}:${result.reason}`);
    }
  }
  
  return { compatible: reasons.length === 0, reasons };
}

export function scoreCleanerForGroup(
  cleaner: CleanerInput,
  tasks: TaskForPhase2[],
  cleanerLastPosition: Map<number, { lat: number; lng: number }>,
  cleanerWorkMin: Map<number, number>,
  cleanerTravelMin: Map<number, number>,
  targets: MinutesBasedTargets,
  params: Phase2Params
): CleanerScore {
  const baseScore = 100;
  const { fairness } = params;
  
  // Calculate incremental travel to first task
  let travelMin = 0;
  const lastPos = cleanerLastPosition.get(cleaner.cleanerId);
  if (lastPos && tasks.length > 0) {
    const firstTask = tasks[0];
    const fakeTaskA: TaskInput = { taskId: 0, logisticCode: 0, lat: lastPos.lat, lng: lastPos.lng };
    const fakeTaskB: TaskInput = { taskId: 0, logisticCode: 0, lat: firstTask.lat, lng: firstTask.lng };
    travelMin = estimateTravelMinutes(fakeTaskA, fakeTaskB);
  }
  
  // Minutes-based load calculation
  const currentWorkMin = cleanerWorkMin.get(cleaner.cleanerId) || 0;
  const currentTravelMin = cleanerTravelMin.get(cleaner.cleanerId) || 0;
  const currentLoadMin = currentWorkMin + fairness.wT * currentTravelMin;
  
  // Calculate delta for this group
  const groupWorkMin = tasks.reduce((sum, t) => sum + (t.cleaningTime || 60), 0);
  const groupTravelMin = travelMin; // travel to first task of group
  const deltaLoadMin = groupWorkMin + fairness.wT * groupTravelMin;
  const newLoadMin = currentLoadMin + deltaLoadMin;
  
  const clientIds = tasks.map(t => t.clientId);
  const hasPreference = clientIds.some(cid => cleaner.preferredCustomers.includes(cid));
  
  // Travel and preference scoring
  const travelPenalty = travelMin * params.travelWeight;
  const prefBonus = hasPreference ? params.preferenceBonus : 0;
  
  // Minutes-based fairness bonuses/penalties (replaces legacy task-count loadPenalty)
  // Bonus for underfilled cleaners (linear) - uses newLoadMin (post-assignment)
  // This rewards assignments that keep a cleaner under target AFTER the assignment
  const underGap = Math.max(0, targets.minTarget - newLoadMin);
  const underBonus = underGap * fairness.k_under;
  
  // Penalty for overloaded cleaners (quadratic)
  const overGap = Math.max(0, newLoadMin - targets.maxTarget);
  const overPenalty = Math.pow(overGap, 2) * fairness.k_over;
  
  // Continuous balance penalty: penalizes any load above average (eliminates dead zone)
  const aboveAvg = Math.max(0, newLoadMin - targets.targetLoadMin);
  const balancePenalty = aboveAvg * fairness.k_balance;
  
  // Bonus for empty cleaners
  const zeroBonus = currentLoadMin === 0 ? fairness.zeroBonus : 0;
  
  // Final score: base + bonuses - penalties
  const finalScore = baseScore 
    - travelPenalty 
    + prefBonus 
    + underBonus 
    + zeroBonus 
    - overPenalty
    - balancePenalty;
  
  return {
    cleanerId: cleaner.cleanerId,
    name: cleaner.name,
    score: Math.round(finalScore * 10) / 10,
    travelMin,
    currentLoadMin: Math.round(currentLoadMin),
    newLoadMin: Math.round(newLoadMin),
    hasPreference,
    breakdown: {
      baseScore,
      travelPenalty: Math.round(travelPenalty * 10) / 10,
      preferenceBonus: prefBonus,
      underBonus: Math.round(underBonus * 10) / 10,
      overPenalty: Math.round(overPenalty * 10) / 10,
      balancePenalty: Math.round(balancePenalty * 10) / 10,
      zeroBonus
    }
  };
}

export function findMostExpensiveTask(
  tasks: TaskForPhase2[],
  cleaners: CleanerInput[],
  apartmentTypes: ApartmentTypes = DEFAULT_APARTMENT_TYPES
): { task: TaskForPhase2; reason: string } | null {
  if (tasks.length <= 1) return null;
  
  let worstTask: TaskForPhase2 | null = null;
  let worstScore = Infinity;
  let worstReason = '';
  
  for (const task of tasks) {
    const remaining = tasks.filter(t => t.taskId !== task.taskId);
    let compatibleCount = 0;
    
    for (const cleaner of cleaners) {
      const result = isCleanerCompatibleWithGroup(cleaner, remaining, apartmentTypes);
      if (result.compatible) compatibleCount++;
    }
    
    if (compatibleCount > 0 && compatibleCount < worstScore) {
      continue;
    }
    
    let incompatCount = 0;
    for (const cleaner of cleaners) {
      const result = isCleanerCompatible(cleaner, task, apartmentTypes);
      if (!result.compatible) incompatCount++;
    }
    
    const score = compatibleCount * 100 - incompatCount;
    if (score < worstScore) {
      worstScore = score;
      worstTask = task;
      worstReason = incompatCount > cleaners.length / 2 
        ? 'LOW_CLEANER_COMPATIBILITY' 
        : 'REDUCES_GROUP_COMPATIBILITY';
    }
  }
  
  return worstTask ? { task: worstTask, reason: worstReason } : null;
}

// Straordinaria constraints
const STRAORDINARIA_LONG_THRESHOLD_MIN = 360; // 6 hours - cleaner can only do this task
const STRAORDINARIA_EXTRA_TASK_MAX_MIN = 120; // 2 hours - max duration of extra task when straordinaria < 6h

export function runPhase2Algorithm(
  groups: GroupCandidate[],
  tasksMap: Map<number, TaskForPhase2>,
  cleaners: CleanerInput[],
  params: Phase2Params
): Phase2Result {
  const events: Phase2Event[] = [];
  const assignments: AssignmentResult[] = [];
  const cleanerTaskCount = new Map<number, number>();  // Task count (for straordinaria rules)
  const cleanerLoadMin = new Map<number, number>();    // Minutes-based load = workMin + wT * travelMin
  const cleanerTotalTravel = new Map<number, number>(); // Track cumulative travel time
  const cleanerLastPosition = new Map<number, { lat: number; lng: number }>();
  // Straordinaria tracking per cleaner
  const cleanerHasStraordinaria = new Map<number, boolean>();
  const cleanerStraordinariaDuration = new Map<number, number>(); // Duration in minutes
  const cleanerTotalCleaningTime = new Map<number, number>(); // Total cleaning time assigned
  
  // Minutes-based fairness tracking
  const cleanerWorkMin = new Map<number, number>();     // Total work minutes assigned
  const cleanerTravelMin = new Map<number, number>();   // Total travel minutes assigned
  
  const initialLoad = params.initialLoadByCleanerMin ?? new Map<number, number>();
  const initialPositions = params.initialLastPositionByCleaner ?? new Map<number, { lat: number; lng: number }>();
  const initialFixedStats = params.initialFixedStatsByCleaner ?? new Map<number, CleanerFixedStats>();
  
  cleaners.forEach(c => {
    const preLoad = initialLoad.get(c.cleanerId) ?? 0;
    const fixedStats = initialFixedStats.get(c.cleanerId);

    // Seed task/OT counts from existing timeline so constraints reflect remaining capacity.
    // For straordinariaDuration: use 0 for short OT (< 6h) or 999 for long OT (≥ 6h) so
    // the threshold comparison STRAORDINARIA_LONG_THRESHOLD_MIN=360 works correctly even
    // though fixedWorkMinutes includes all task durations, not just the OT.
    const fixedOtDurationProxy = fixedStats?.fixedHasLongOT ? 999 : 0;
    cleanerTaskCount.set(c.cleanerId, fixedStats?.fixedTaskCount ?? 0);
    cleanerLoadMin.set(c.cleanerId, preLoad);    // Minutes-based load = workMin + wT * travelMin (includes pre-existing)
    cleanerTotalTravel.set(c.cleanerId, 0);
    cleanerHasStraordinaria.set(c.cleanerId, fixedStats?.fixedHasAnyOT ?? false);
    cleanerStraordinariaDuration.set(c.cleanerId, fixedOtDurationProxy);
    cleanerTotalCleaningTime.set(c.cleanerId, fixedStats?.fixedWorkMinutes ?? 0);
    cleanerWorkMin.set(c.cleanerId, preLoad);  // Pre-existing work minutes
    cleanerTravelMin.set(c.cleanerId, 0);
    const pos = initialPositions.get(c.cleanerId);
    if (pos) {
      cleanerLastPosition.set(c.cleanerId, pos);
    }
  });
  
  // Calculate minutes-based fairness targets (include pre-existing load so maxTarget reflects total day's work)
  const allTasks = Array.from(tasksMap.values());
  const preExistingTotalLoadMin = Array.from(initialLoad.values()).reduce((sum, v) => sum + v, 0);
  const targets = calculateMinutesBasedTargets(allTasks, cleaners.length, params.fairness, preExistingTotalLoadMin);
  
  events.push({
    eventType: 'PHASE2_FAIRNESS_TARGETS',
    payload: {
      totalWorkMin: Math.round(targets.totalWorkMin),
      numCleaners: targets.numCleaners,
      targetLoadMin: Math.round(targets.targetLoadMin),
      minTarget: Math.round(targets.minTarget),
      maxTarget: Math.round(targets.maxTarget),
      fairnessParams: params.fairness
    }
  });
  
  // Pre-calcola scarcity per ogni task (quanti cleaners compatibili)
  const taskScarcity = new Map<number, number>();
  tasksMap.forEach((task, taskId) => {
    let compatibleCount = 0;
    for (const cleaner of cleaners) {
      const result = isCleanerCompatible(cleaner, task, params.apartmentTypes);
      if (result.compatible) compatibleCount++;
    }
    taskScarcity.set(taskId, compatibleCount);
  });
  
  // Calcola minCompatibleCleaners per ogni gruppo
  for (const group of groups) {
    const scarcities = group.taskIds.map(id => taskScarcity.get(id) ?? cleaners.length);
    group.minCompatibleCleaners = Math.min(...scarcities);
  }
  
  // Ordina gruppi: OT first, poi per scarcity (più raro prima), poi per score
  // Questo garantisce che:
  // 1. Le straordinarie vengano processate prima
  // 2. I task rari (pochi cleaners compatibili) vengano assegnati prima
  const sortedGroups = [...groups].sort((a, b) => {
    // Prima controlla se contengono straordinaria
    const aHasOT = a.hasStraordinaria === true;
    const bHasOT = b.hasStraordinaria === true;
    
    // OT first
    if (aHasOT && !bHasOT) return -1;
    if (!aHasOT && bHasOT) return 1;
    
    // Poi per scarcity (più raro prima, minCompatibleCleaners basso = priorità alta)
    const aScarcity = a.minCompatibleCleaners ?? cleaners.length;
    const bScarcity = b.minCompatibleCleaners ?? cleaners.length;
    if (aScarcity !== bScarcity) return aScarcity - bScarcity;
    
    // Infine per score
    return b.score - a.score;
  });
  
  let groupsAssigned = 0;
  let groupsUnassigned = 0;
  let tasksDropped = 0;
  
  const otTaskIds = new Set<number>();
  tasksMap.forEach((task, taskId) => {
    if (task.straordinaria) otTaskIds.add(taskId);
  });
  const assignedOtTaskIds = new Set<number>();
  
  for (let groupIndex = 0; groupIndex < sortedGroups.length; groupIndex++) {
    const group = sortedGroups[groupIndex];
    let currentTaskIds = [...group.taskIds];
    let currentLogisticCodes = [...group.logisticCodes];
    const droppedTasks: number[] = [];
    let retryCount = 0;
    let assigned = false;
    let assignedCleaner: CleanerInput | null = null;
    
    while (currentTaskIds.length > 0 && !assigned) {
      const tasks = currentTaskIds
        .map(id => tasksMap.get(id))
        .filter((t): t is TaskForPhase2 => t !== undefined);
      
      if (tasks.length === 0) break;
      
      const compatibleCleaners: CleanerInput[] = [];
      const incompatibleReasons: { cleanerId: number; reasons: string[] }[] = [];
      
      // Check if current group contains straordinaria and its duration
      const groupHasStraordinaria = tasks.some(t => t.straordinaria);
      const groupStraordinariaDuration = tasks.filter(t => t.straordinaria).reduce((sum, t) => sum + t.cleaningTime, 0);
      const groupTotalCleaningTime = tasks.reduce((sum, t) => sum + t.cleaningTime, 0);
      const groupStraordinariaCount = tasks.filter(t => t.straordinaria).length;
      
      // Pre-check: valida gruppi con straordinaria
      // Regole: OT lunga (≥6h) → solo 1 task, OT corta (<6h) → max 2 task (OT + 1 extra ≤2h)
      // IMPORTANTE: un gruppo può avere al massimo 1 OT
      // Invece di reject, droppa task fino a forma valida
      if (groupHasStraordinaria && tasks.length > 1) {
        const otTasks = tasks.filter(t => t.straordinaria);
        const nonOtTasks = tasks.filter(t => !t.straordinaria);
        
        // Se ci sono multipli OT, tieni solo il primo e droppa gli altri
        if (otTasks.length > 1) {
          const keptOt = otTasks[0];
          const extraOts = otTasks.slice(1);
          
          for (const extraOt of extraOts) {
            const idx = currentTaskIds.indexOf(extraOt.taskId);
            if (idx !== -1) {
              currentTaskIds.splice(idx, 1);
              currentLogisticCodes.splice(idx, 1);
              droppedTasks.push(extraOt.taskId);
              tasksDropped++;
            }
          }
          events.push({
            eventType: 'PHASE2_OT_GROUP_FIXED',
            payload: {
              original_tasks: group.taskIds,
              kept_tasks: currentTaskIds,
              dropped_ots: extraOts.map(t => t.taskId),
              reason: 'MULTIPLE_OT_REDUCED_TO_ONE',
              kept_ot: keptOt.taskId
            }
          });
          retryCount++;
          continue; // Riprova con un solo OT
        }
        
        const otTask = otTasks[0]; // Ora sappiamo che c'è esattamente 1 OT
        const otDuration = otTask.cleaningTime;
        const isLongOT = otDuration >= STRAORDINARIA_LONG_THRESHOLD_MIN;
        
        if (isLongOT) {
          // OT lunga: droppa tutti i task non-OT, tieni solo l'OT
          for (const extraTask of nonOtTasks) {
            const idx = currentTaskIds.indexOf(extraTask.taskId);
            if (idx !== -1) {
              currentTaskIds.splice(idx, 1);
              currentLogisticCodes.splice(idx, 1);
              droppedTasks.push(extraTask.taskId);
              tasksDropped++;
            }
          }
          events.push({
            eventType: 'PHASE2_OT_GROUP_FIXED',
            payload: {
              original_tasks: group.taskIds,
              kept_tasks: currentTaskIds,
              dropped_tasks: nonOtTasks.map(t => t.taskId),
              reason: 'LONG_STRAORDINARIA_KEPT_SOLO',
              ot_duration: otDuration
            }
          });
          retryCount++;
          continue; // Riprova con solo l'OT
        } else if (tasks.length > 2) {
          // OT corta: max 2 task totali (1 OT + 1 non-OT ≤2h)
          // Mantieni OT + il task non-OT con durata minore (solo se ≤2h)
          const sortedNonOt = [...nonOtTasks].sort((a, b) => a.cleaningTime - b.cleaningTime);
          
          // Trova il primo non-OT valido (≤2h), altrimenti nessuno
          const validNonOt = sortedNonOt.find(t => t.cleaningTime <= STRAORDINARIA_EXTRA_TASK_MAX_MIN);
          
          // Droppa tutti i non-OT tranne quello valido (se esiste)
          const tasksToDrop = validNonOt 
            ? sortedNonOt.filter(t => t.taskId !== validNonOt.taskId)
            : sortedNonOt; // Se nessun valido, droppa tutti i non-OT
          
          for (const task of tasksToDrop) {
            const idx = currentTaskIds.indexOf(task.taskId);
            if (idx !== -1) {
              currentTaskIds.splice(idx, 1);
              currentLogisticCodes.splice(idx, 1);
              droppedTasks.push(task.taskId);
              tasksDropped++;
            }
          }
          events.push({
            eventType: 'PHASE2_OT_GROUP_FIXED',
            payload: {
              original_tasks: group.taskIds,
              kept_tasks: currentTaskIds,
              dropped_tasks: tasksToDrop.map(t => t.taskId),
              reason: validNonOt ? 'SHORT_STRAORDINARIA_REDUCED_TO_2' : 'SHORT_STRAORDINARIA_NO_VALID_EXTRA',
              ot_duration: otDuration
            }
          });
          retryCount++;
          continue; // Riprova con gruppo ridotto
        } else {
          // OT corta + 1 task extra: verifica che extra sia ≤2h
          const extraTask = tasks.find(t => !t.straordinaria);
          if (extraTask && extraTask.cleaningTime > STRAORDINARIA_EXTRA_TASK_MAX_MIN) {
            // Extra troppo lungo: droppa l'extra, tieni solo l'OT
            const idx = currentTaskIds.indexOf(extraTask.taskId);
            if (idx !== -1) {
              currentTaskIds.splice(idx, 1);
              currentLogisticCodes.splice(idx, 1);
              droppedTasks.push(extraTask.taskId);
              tasksDropped++;
            }
            events.push({
              eventType: 'PHASE2_OT_GROUP_FIXED',
              payload: {
                original_tasks: group.taskIds,
                kept_tasks: currentTaskIds,
                dropped_task: extraTask.taskId,
                reason: 'EXTRA_TASK_TOO_LONG_DROPPED',
                extra_task_duration: extraTask.cleaningTime
              }
            });
            retryCount++;
            continue; // Riprova con solo l'OT
          }
          // Gruppo valido: OT corta + 1 task ≤2h
        }
      }
      
      // Calcola quante OT TASK REALI sono ancora da assegnare
      // Usa otTaskIds (task reali) invece di gruppi candidati per evitare blocchi eccessivi
      const remainingOtTasks = otTaskIds.size - assignedOtTaskIds.size;
      
      // For anchored groups, try the anchor cleaner first.
      // If the anchor is already at/above maxTarget, fall back to all cleaners
      // so the task isn't forced onto an overloaded cleaner.
      let cleanerPool: CleanerInput[];
      if (group.anchoredCleanerId !== undefined) {
        const anchorLoad = cleanerLoadMin.get(group.anchoredCleanerId) || 0;
        if (anchorLoad >= targets.maxTarget) {
          cleanerPool = cleaners;
        } else {
          cleanerPool = cleaners.filter(c => c.cleanerId === group.anchoredCleanerId);
        }
      } else {
        cleanerPool = cleaners;
      }

      for (const cleaner of cleanerPool) {
        const taskCount = cleanerTaskCount.get(cleaner.cleanerId) || 0;
        const currentLoadMinValue = cleanerLoadMin.get(cleaner.cleanerId) || 0;
        const totalTravel = cleanerTotalTravel.get(cleaner.cleanerId) || 0;
        
        // Calculate deltaLoadMin for this group
        const groupWorkMinForCap = tasks.reduce((sum, t) => sum + (t.cleaningTime || 60), 0);
        const groupTravelMinForCap = group.avgTravelMin || 15; // Use group's avg travel estimate
        const deltaLoadMinForCap = groupWorkMinForCap + params.fairness.wT * groupTravelMinForCap;
        const newLoadMinValue = currentLoadMinValue + deltaLoadMinForCap;
        
        // Check if cleaner can fit this group using MINUTES-BASED cap
        // Cap = maxTarget (from fairness targets calculation)
        if (newLoadMinValue > targets.maxTarget) continue;
        
        // Also keep a sanity check on task count for extreme cases
        const maxTasksPerCleaner = 6; // Hard limit regardless of minutes
        if (taskCount + tasks.length > maxTasksPerCleaner) continue;
        
        // Straordinaria constraints
        const hasStraordinaria = cleanerHasStraordinaria.get(cleaner.cleanerId) || false;
        const straordinariaDuration = cleanerStraordinariaDuration.get(cleaner.cleanerId) || 0;
        
        // Rule 0: Riserva cleaner straordinari per OT TASK REALI non ancora assegnate
        // Skip OT reservation for anchored groups (the cleaner is fixed by the timeline)
        if (!groupHasStraordinaria && remainingOtTasks > 0 && normalizeCleanerRole(cleaner.role) === 'straordinario_cleaner'
            && group.anchoredCleanerId === undefined) {
          incompatibleReasons.push({ cleanerId: cleaner.cleanerId, reasons: ['RESERVED_FOR_PENDING_OT'] });
          continue;
        }
        
        // Rule 1: If cleaner already has straordinaria, they cannot take any more tasks
        if (hasStraordinaria) {
          // Exception: If existing straordinaria < 6h, can add exactly 1 task with duration <= 2h
          if (straordinariaDuration < STRAORDINARIA_LONG_THRESHOLD_MIN && taskCount === 1) {
            // Can add 1 more task if: exactly 1 task, no straordinaria, and duration <= 2h
            if (tasks.length !== 1 || groupHasStraordinaria || groupTotalCleaningTime > STRAORDINARIA_EXTRA_TASK_MAX_MIN) {
              incompatibleReasons.push({ cleanerId: cleaner.cleanerId, reasons: ['STRAORDINARIA_EXTRA_TASK_INVALID'] });
              continue;
            }
          } else {
            incompatibleReasons.push({ cleanerId: cleaner.cleanerId, reasons: ['ALREADY_HAS_STRAORDINARIA'] });
            continue;
          }
        }
        
        // Rule 2: If this group has straordinaria >= 6h, cleaner must be empty (no other tasks allowed)
        if (groupHasStraordinaria && groupStraordinariaDuration >= STRAORDINARIA_LONG_THRESHOLD_MIN) {
          if (taskCount > 0) {
            incompatibleReasons.push({ cleanerId: cleaner.cleanerId, reasons: ['STRAORDINARIA_LONG_REQUIRES_EMPTY_CLEANER'] });
            continue;
          }
        }
        
        // Rule 3: If cleaner has non-straordinaria tasks, can only add straordinaria < 6h 
        // if the existing task is exactly 1 and its duration <= 2h
        if (groupHasStraordinaria && taskCount > 0 && !hasStraordinaria) {
          const existingCleaningTime = cleanerTotalCleaningTime.get(cleaner.cleanerId) || 0;
          // Allow only if: exactly 1 existing task, its duration <= 2h, and straordinaria < 6h
          if (taskCount !== 1 || existingCleaningTime > STRAORDINARIA_EXTRA_TASK_MAX_MIN || 
              groupStraordinariaDuration >= STRAORDINARIA_LONG_THRESHOLD_MIN) {
            incompatibleReasons.push({ cleanerId: cleaner.cleanerId, reasons: ['CANNOT_ADD_STRAORDINARIA_TO_EXISTING_TASKS'] });
            continue;
          }
          // OK: Cleaner has 1 task <= 2h and new straordinaria is < 6h - allowed
        }
        
        const result = isCleanerCompatibleWithGroup(cleaner, tasks, params.apartmentTypes);
        if (result.compatible) {
          compatibleCleaners.push(cleaner);
        } else {
          incompatibleReasons.push({ cleanerId: cleaner.cleanerId, reasons: result.reasons });
        }
      }
      
      if (compatibleCleaners.length > 0) {
        const scores = compatibleCleaners.map(c => 
          scoreCleanerForGroup(c, tasks, cleanerLastPosition, cleanerWorkMin, cleanerTravelMin, targets, params)
        ).sort((a, b) => b.score - a.score);
        
        scores.slice(0, 3).forEach(s => {
          events.push({
            eventType: 'PHASE2_CLEANER_CANDIDATE',
            payload: {
              group_tasks: currentTaskIds,
              cleaner_id: s.cleanerId,
              cleaner_name: s.name,
              score: s.score,
              travel_min: s.travelMin,
              current_load_min: s.currentLoadMin,
              new_load_min: s.newLoadMin,
              has_preference: s.hasPreference,
              breakdown: s.breakdown
            }
          });
        });
        
        const bestCleaner = scores[0];
        assignedCleaner = compatibleCleaners.find(c => c.cleanerId === bestCleaner.cleanerId)!;
        
        // Update task count (for straordinaria rules)
        const newTaskCount = (cleanerTaskCount.get(assignedCleaner.cleanerId) || 0) + tasks.length;
        cleanerTaskCount.set(assignedCleaner.cleanerId, newTaskCount);
        
        // Update cumulative travel time for logging
        const currentTravel = cleanerTotalTravel.get(assignedCleaner.cleanerId) || 0;
        cleanerTotalTravel.set(assignedCleaner.cleanerId, currentTravel + bestCleaner.travelMin);
        
        // Update minutes-based fairness tracking
        const groupWorkMin = tasks.reduce((sum, t) => sum + (t.cleaningTime || 60), 0);
        const currentWorkMin = cleanerWorkMin.get(assignedCleaner.cleanerId) || 0;
        const currentTravelMin = cleanerTravelMin.get(assignedCleaner.cleanerId) || 0;
        cleanerWorkMin.set(assignedCleaner.cleanerId, currentWorkMin + groupWorkMin);
        cleanerTravelMin.set(assignedCleaner.cleanerId, currentTravelMin + bestCleaner.travelMin);
        
        // Update loadMin (minutes-based load)
        const newLoadMinValue = (currentWorkMin + groupWorkMin) + params.fairness.wT * (currentTravelMin + bestCleaner.travelMin);
        cleanerLoadMin.set(assignedCleaner.cleanerId, newLoadMinValue);
        
        // Update straordinaria tracking
        if (groupHasStraordinaria) {
          cleanerHasStraordinaria.set(assignedCleaner.cleanerId, true);
          const existingStraDuration = cleanerStraordinariaDuration.get(assignedCleaner.cleanerId) || 0;
          cleanerStraordinariaDuration.set(assignedCleaner.cleanerId, existingStraDuration + groupStraordinariaDuration);
          // Marca le OT task come assegnate per rilasciare riserva cleaner straordinari
          tasks.filter(t => t.straordinaria).forEach(t => assignedOtTaskIds.add(t.taskId));
        }
        const existingCleaningTime = cleanerTotalCleaningTime.get(assignedCleaner.cleanerId) || 0;
        cleanerTotalCleaningTime.set(assignedCleaner.cleanerId, existingCleaningTime + groupTotalCleaningTime);
        
        const lastTask = tasks[tasks.length - 1];
        cleanerLastPosition.set(assignedCleaner.cleanerId, { lat: lastTask.lat, lng: lastTask.lng });
        
        events.push({
          eventType: 'PHASE2_GROUP_ASSIGNED',
          payload: {
            group_tasks: currentTaskIds,
            group_logistic_codes: currentLogisticCodes,
            cleaner_id: assignedCleaner.cleanerId,
            cleaner_name: assignedCleaner.name,
            score: bestCleaner.score,
            travel_min: bestCleaner.travelMin,
            dropped_tasks: droppedTasks,
            retry_count: retryCount
          }
        });
        
        assigned = true;
        groupsAssigned++;
      } else {
        incompatibleReasons.slice(0, 3).forEach(r => {
          events.push({
            eventType: 'PHASE2_CLEANER_REJECT',
            payload: {
              group_tasks: currentTaskIds,
              cleaner_id: r.cleanerId,
              reasons: r.reasons
            }
          });
        });
        
        if (currentTaskIds.length > 1) {
          const dropResult = findMostExpensiveTask(tasks, cleaners, params.apartmentTypes);
          if (dropResult) {
            const droppedId = dropResult.task.taskId;
            const droppedIdx = currentTaskIds.indexOf(droppedId);
            
            events.push({
              eventType: 'PHASE2_TASK_DROPPED',
              payload: {
                group_tasks: currentTaskIds,
                dropped_task: droppedId,
                dropped_logistic_code: currentLogisticCodes[droppedIdx],
                reason: dropResult.reason,
                retry_count: retryCount
              }
            });
            
            droppedTasks.push(droppedId);
            currentTaskIds = currentTaskIds.filter(id => id !== droppedId);
            currentLogisticCodes = currentLogisticCodes.filter((_, i) => i !== droppedIdx);
            tasksDropped++;
            retryCount++;
          } else {
            break;
          }
        } else {
          events.push({
            eventType: 'PHASE2_GROUP_UNASSIGNED_CANDIDATE',
            payload: {
              group_tasks: currentTaskIds,
              group_logistic_codes: currentLogisticCodes,
              reason: 'NO_COMPATIBLE_CLEANER',
              dropped_tasks: droppedTasks,
              retry_count: retryCount
            }
          });
          groupsUnassigned++;
          // SOLO se questo è un gruppo OT singolo (solo l'OT task) che fallisce,
          // marca l'OT come "processata" per rilasciare la riserva
          // Se è un gruppo OT+altri task, altri gruppi candidati potrebbero avere successo
          if (groupHasStraordinaria && tasks.length === 1 && tasks[0].straordinaria) {
            assignedOtTaskIds.add(tasks[0].taskId);
          }
          break;
        }
      }
    }
    
    assignments.push({
      groupTaskIds: group.taskIds,
      groupLogisticCodes: group.logisticCodes,
      cleanerId: assignedCleaner?.cleanerId || null,
      cleanerName: assignedCleaner?.name || null,
      assigned,
      droppedTasks,
      retryCount
    });
  }
  
  // Final fairness metrics
  const loadMinValues: number[] = [];
  const cleanerFairnessDetails: { cleanerId: number; name: string; loadMin: number; workMin: number; travelMin: number }[] = [];
  
  cleaners.forEach(c => {
    const workMin = cleanerWorkMin.get(c.cleanerId) || 0;
    const travelMin = cleanerTravelMin.get(c.cleanerId) || 0;
    const loadMin = workMin + params.fairness.wT * travelMin;
    loadMinValues.push(loadMin);
    cleanerFairnessDetails.push({
      cleanerId: c.cleanerId,
      name: c.name,
      loadMin: Math.round(loadMin),
      workMin,
      travelMin: Math.round(travelMin)
    });
  });
  
  const usedCleaners = loadMinValues.filter(l => l > 0).length;
  const sortedLoads = [...loadMinValues].filter(l => l > 0).sort((a, b) => a - b);
  const minLoad = sortedLoads.length > 0 ? sortedLoads[0] : 0;
  const maxLoad = sortedLoads.length > 0 ? sortedLoads[sortedLoads.length - 1] : 0;
  const medianLoad = sortedLoads.length > 0 ? sortedLoads[Math.floor(sortedLoads.length / 2)] : 0;
  const underTarget = loadMinValues.filter(l => l > 0 && l < targets.minTarget).length;
  const overTarget = loadMinValues.filter(l => l > targets.maxTarget).length;
  
  events.push({
    eventType: 'PHASE2_FAIRNESS_FINAL_METRICS',
    payload: {
      usedCleaners,
      totalCleaners: cleaners.length,
      minLoadMin: Math.round(minLoad),
      maxLoadMin: Math.round(maxLoad),
      medianLoadMin: Math.round(medianLoad),
      targetLoadMin: Math.round(targets.targetLoadMin),
      cleanersUnderMinTarget: underTarget,
      cleanersOverMaxTarget: overTarget,
      loadSpread: Math.round(maxLoad - minLoad),
      cleanerDetails: cleanerFairnessDetails.filter(c => c.loadMin > 0)
    }
  });
  
  return {
    assignments,
    events,
    stats: {
      groupsProcessed: sortedGroups.length,
      groupsAssigned,
      groupsUnassigned,
      tasksDropped
    }
  };
}
