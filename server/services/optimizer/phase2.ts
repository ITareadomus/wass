import { estimateTravelMinutes, TaskInput } from './phase1';

export interface CleanerInput {
  cleanerId: number;
  name: string;
  role: string; // Premium, Standard
  contractType: string; // A, B, C, 'a chiamata'
  canDoStraordinaria: boolean;
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
}

export interface Phase2Params {
  travelWeight: number;
  loadWeight: number;
  preferenceBonus: number;
  maxCleanerLoad: number;
}

export const DEFAULT_PHASE2_PARAMS: Phase2Params = {
  travelWeight: 2,
  loadWeight: 5,
  preferenceBonus: 10,
  maxCleanerLoad: 6
};

export interface CleanerScore {
  cleanerId: number;
  name: string;
  score: number;
  travelMin: number;
  currentLoad: number;
  hasPreference: boolean;
  breakdown: {
    baseScore: number;
    travelPenalty: number;
    loadPenalty: number;
    preferenceBonus: number;
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

export function isCleanerCompatible(
  cleaner: CleanerInput,
  task: TaskForPhase2
): { compatible: boolean; reason?: string } {
  if (task.premium && cleaner.role !== 'Premium') {
    return { compatible: false, reason: 'ROLE_MISMATCH_PREMIUM_REQUIRED' };
  }
  
  if (task.straordinaria && !cleaner.canDoStraordinaria) {
    return { compatible: false, reason: 'CANNOT_DO_STRAORDINARIA' };
  }
  
  const normalizedContract = cleaner.contractType.toUpperCase().trim();
  const normalizedApt = task.typeApt.toUpperCase().trim();
  
  if (normalizedContract === 'A CHIAMATA') {
    return { compatible: true };
  }
  
  if (normalizedContract === 'C') {
    return { compatible: true };
  }
  
  if (normalizedContract === 'B' && (normalizedApt === 'A' || normalizedApt === 'B')) {
    return { compatible: true };
  }
  
  if (normalizedContract === 'A' && normalizedApt === 'A') {
    return { compatible: true };
  }
  
  return { compatible: false, reason: `CONTRACT_APT_MISMATCH_${normalizedContract}_vs_${normalizedApt}` };
}

export function isCleanerCompatibleWithGroup(
  cleaner: CleanerInput,
  tasks: TaskForPhase2[]
): { compatible: boolean; reasons: string[] } {
  const reasons: string[] = [];
  
  for (const task of tasks) {
    const result = isCleanerCompatible(cleaner, task);
    if (!result.compatible) {
      reasons.push(`task_${task.taskId}:${result.reason}`);
    }
  }
  
  return { compatible: reasons.length === 0, reasons };
}

export function scoreCleanerForGroup(
  cleaner: CleanerInput,
  tasks: TaskForPhase2[],
  cleanerLoad: Map<number, number>,
  cleanerLastPosition: Map<number, { lat: number; lng: number }>,
  params: Phase2Params
): CleanerScore {
  const baseScore = 100;
  
  let travelMin = 0;
  const lastPos = cleanerLastPosition.get(cleaner.cleanerId);
  if (lastPos && tasks.length > 0) {
    const firstTask = tasks[0];
    const fakeTaskA: TaskInput = { taskId: 0, logisticCode: 0, lat: lastPos.lat, lng: lastPos.lng };
    const fakeTaskB: TaskInput = { taskId: 0, logisticCode: 0, lat: firstTask.lat, lng: firstTask.lng };
    travelMin = estimateTravelMinutes(fakeTaskA, fakeTaskB);
  }
  
  const currentLoad = cleanerLoad.get(cleaner.cleanerId) || 0;
  
  const clientIds = tasks.map(t => t.clientId);
  const hasPreference = clientIds.some(cid => cleaner.preferredCustomers.includes(cid));
  
  const travelPenalty = travelMin * params.travelWeight;
  const loadPenalty = currentLoad * params.loadWeight;
  const prefBonus = hasPreference ? params.preferenceBonus : 0;
  
  const finalScore = baseScore - travelPenalty - loadPenalty + prefBonus;
  
  return {
    cleanerId: cleaner.cleanerId,
    name: cleaner.name,
    score: Math.round(finalScore * 10) / 10,
    travelMin,
    currentLoad,
    hasPreference,
    breakdown: {
      baseScore,
      travelPenalty,
      loadPenalty,
      preferenceBonus: prefBonus
    }
  };
}

export function findMostExpensiveTask(
  tasks: TaskForPhase2[],
  cleaners: CleanerInput[]
): { task: TaskForPhase2; reason: string } | null {
  if (tasks.length <= 1) return null;
  
  let worstTask: TaskForPhase2 | null = null;
  let worstScore = Infinity;
  let worstReason = '';
  
  for (const task of tasks) {
    const remaining = tasks.filter(t => t.taskId !== task.taskId);
    let compatibleCount = 0;
    
    for (const cleaner of cleaners) {
      const result = isCleanerCompatibleWithGroup(cleaner, remaining);
      if (result.compatible) compatibleCount++;
    }
    
    if (compatibleCount > 0 && compatibleCount < worstScore) {
      continue;
    }
    
    let incompatCount = 0;
    for (const cleaner of cleaners) {
      const result = isCleanerCompatible(cleaner, task);
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

export function runPhase2Algorithm(
  groups: GroupCandidate[],
  tasksMap: Map<number, TaskForPhase2>,
  cleaners: CleanerInput[],
  params: Phase2Params
): Phase2Result {
  const events: Phase2Event[] = [];
  const assignments: AssignmentResult[] = [];
  const cleanerLoad = new Map<number, number>();
  const cleanerLastPosition = new Map<number, { lat: number; lng: number }>();
  
  cleaners.forEach(c => cleanerLoad.set(c.cleanerId, 0));
  
  const sortedGroups = [...groups].sort((a, b) => b.score - a.score);
  
  let groupsAssigned = 0;
  let groupsUnassigned = 0;
  let tasksDropped = 0;
  
  for (const group of sortedGroups) {
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
      
      for (const cleaner of cleaners) {
        const load = cleanerLoad.get(cleaner.cleanerId) || 0;
        if (load >= params.maxCleanerLoad) continue;
        
        const result = isCleanerCompatibleWithGroup(cleaner, tasks);
        if (result.compatible) {
          compatibleCleaners.push(cleaner);
        } else {
          incompatibleReasons.push({ cleanerId: cleaner.cleanerId, reasons: result.reasons });
        }
      }
      
      if (compatibleCleaners.length > 0) {
        const scores = compatibleCleaners.map(c => 
          scoreCleanerForGroup(c, tasks, cleanerLoad, cleanerLastPosition, params)
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
              current_load: s.currentLoad,
              has_preference: s.hasPreference,
              breakdown: s.breakdown
            }
          });
        });
        
        const bestCleaner = scores[0];
        assignedCleaner = compatibleCleaners.find(c => c.cleanerId === bestCleaner.cleanerId)!;
        
        const newLoad = (cleanerLoad.get(assignedCleaner.cleanerId) || 0) + tasks.length;
        cleanerLoad.set(assignedCleaner.cleanerId, newLoad);
        
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
          const dropResult = findMostExpensiveTask(tasks, cleaners);
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
