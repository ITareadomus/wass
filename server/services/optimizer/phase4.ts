import { estimateTravelMinutes, TaskInput } from './phase1';
import { 
  TaskForScheduling, 
  simulateSequence, 
  ScheduleRow,
  PriorityViolation
} from './phase3';
import { PriorityWindows, priorityPenalty, Priority } from './priorityWindows';

export interface Phase4Params {
  maxInsertionAttempts: number;
  underfilledBonus: number;
  singleAssignmentPenalty: number;
  // Penalità per task non assegnati (sistema progressivo)
  baseUnassignedPenalty: number;       // Penalità base per ogni task normale non assegnato
  straordinariaExtraPenalty: number;   // Penalità extra per straordinarie non assegnate
  progressiveMultiplier: number;       // Incremento penalità per ogni task successivo non assegnato
  rarityExtraPenalty: number;          // Extra per task con pochi cleaners compatibili (rarity ≤ 2)
  rarityThreshold: number;             // Soglia per considerare un task "raro" (compatibleCleaners ≤ threshold)
}

export const DEFAULT_PHASE4_PARAMS: Phase4Params = {
  maxInsertionAttempts: 1000,
  underfilledBonus: 5,
  singleAssignmentPenalty: 20,
  // Penalità per task non assegnati
  baseUnassignedPenalty: 1500,         // Ogni task non assegnato costa 1500
  straordinariaExtraPenalty: 2500,     // Extra per OT → totale 4000
  progressiveMultiplier: 0.5,          // 1° = 1500, 2° = 2250, 3° = 3000...
  rarityExtraPenalty: 500,             // Extra per task rari
  rarityThreshold: 2                   // Task con ≤2 cleaners compatibili sono "rari"
};

export interface CleanerSchedule {
  cleanerId: number;
  cleanerName: string;
  startTime: string;
  tasks: ScheduleRow[];
  endTimeMinutes: number;
  totalTravel: number;
  totalWait: number;
  totalPriorityPenalty: number;
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
  return d.getHours() * 60 + d.getMinutes();
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
  params: Phase4Params
): InsertionCandidate {
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
    null,
    priorityWindows
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
  
  let underfilledBonus = 0;
  if (schedule.tasks.length === 1) {
    underfilledBonus = params.underfilledBonus;
  }
  
  const totalScore = deltaTravel + (deltaWait * 0.5) + (deltaPriorityPenalty * 2) - underfilledBonus;
  
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
  priorityWindows: PriorityWindows | null
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
    null,
    priorityWindows
  );
  
  return {
    cleanerId: schedule.cleanerId,
    cleanerName: schedule.cleanerName,
    startTime: schedule.startTime,
    tasks: simResult.scheduleRows,
    endTimeMinutes: simResult.endTime ? dateToMinutes(simResult.endTime) : schedule.endTimeMinutes,
    totalTravel: simResult.totalTravel,
    totalWait: simResult.totalWait,
    totalPriorityPenalty: simResult.totalPriorityPenalty
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
  unassignedPenaltyValue: number // Penalità che si evita assegnando questo task
): SwapCandidate | null {
  let bestSwap: SwapCandidate | null = null;
  
  for (const schedule of schedules) {
    // Prova a rimuovere ciascun task (non OT) e inserire il nuovo task
    for (let i = 0; i < schedule.tasks.length; i++) {
      const taskToRemove = schedule.tasks[i];
      const removedTask = tasksMap.get(taskToRemove.taskId);
      
      // Non rimuovere straordinarie per fare spazio ad altri task
      if (removedTask?.straordinaria) continue;
      
      // Calcola il "valore" del task rimosso (approssimativo)
      // Un task normale vale circa la baseUnassignedPenalty
      const removedTaskScore = params.baseUnassignedPenalty;
      
      // Crea schedule senza questo task
      const tasksWithoutRemoved = schedule.tasks.filter((_, idx) => idx !== i);
      const tasksForSim: TaskForScheduling[] = tasksWithoutRemoved
        .map(r => tasksMap.get(r.taskId))
        .filter((t): t is TaskForScheduling => t !== undefined);
      
      // Aggiungi il nuovo task alla fine
      tasksForSim.push(task);
      
      const simResult = simulateSequence(
        workDate,
        tasksForSim,
        schedule.startTime,
        tasksMap,
        null,
        priorityWindows
      );
      
      if (!simResult.ok) continue;
      
      // Calcola guadagno netto
      // Guadagno: evito penalità del nuovo task
      // Perdita: devo poi riassegnare il task rimosso (che potrebbe non essere riassegnabile)
      const netGain = unassignedPenaltyValue - removedTaskScore;
      
      // Accetta solo se il guadagno è positivo (vale la pena fare lo swap)
      if (netGain > 0) {
        if (!bestSwap || netGain > bestSwap.netGain) {
          bestSwap = {
            cleanerId: schedule.cleanerId,
            removedTaskId: taskToRemove.taskId,
            removedTaskLogisticCode: taskToRemove.logisticCode,
            removedTaskScore,
            newSchedule: {
              cleanerId: schedule.cleanerId,
              cleanerName: schedule.cleanerName,
              startTime: schedule.startTime,
              tasks: simResult.scheduleRows,
              endTimeMinutes: simResult.endTime ? dateToMinutes(simResult.endTime) : schedule.endTimeMinutes,
              totalTravel: simResult.totalTravel,
              totalWait: simResult.totalWait,
              totalPriorityPenalty: simResult.totalPriorityPenalty
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
  params: Phase4Params
): { success: boolean; cleanerId?: number; updatedSchedule?: CleanerSchedule; score?: number } {
  let bestOption: { cleanerId: number; schedule: CleanerSchedule; score: number } | null = null;
  
  for (const schedule of schedules) {
    const position = schedule.tasks.length;
    
    const candidate = tryInsertTask(
      schedule,
      task,
      position,
      workDate,
      tasksMap,
      priorityWindows,
      params
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
          priorityWindows
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
    if (task?.straordinaria) {
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

export function runPhase4Algorithm(
  workDate: string,
  initialSchedules: CleanerSchedule[],
  unassignedTasks: { taskId: number; reasonCode: string; details: Record<string, any> }[],
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null,
  params: Phase4Params = DEFAULT_PHASE4_PARAMS
): Phase4Result {
  const events: Phase4Event[] = [];
  const taskResults: Phase4TaskResult[] = [];
  let schedules = [...initialSchedules];
  
  let insertedCount = 0;
  let singleAssignedCount = 0;
  let remainUnassignedCount = 0;
  let iterationsUsed = 0;
  
  events.push({
    eventType: 'PHASE4_RETRY_STARTED',
    payload: {
      unassigned_count: unassignedTasks.length,
      schedules_count: schedules.length,
      params
    }
  });
  
  // Sort unassigned tasks: straordinarie first, then by priority (EO, HP, LP)
  const sortedUnassigned = [...unassignedTasks].sort((a, b) => {
    const taskA = tasksMap.get(a.taskId);
    const taskB = tasksMap.get(b.taskId);
    
    // Straordinarie get highest priority (0 = straordinaria, 1 = normal)
    const straordA = taskA?.straordinaria ? 0 : 1;
    const straordB = taskB?.straordinaria ? 0 : 1;
    if (straordA !== straordB) return straordA - straordB;
    
    // Then by priority type
    const priorityOrder: Record<string, number> = { 'EO': 0, 'HP': 1, 'LP': 2 };
    const priorityA = priorityOrder[taskA?.priorityType || ''] ?? 3;
    const priorityB = priorityOrder[taskB?.priorityType || ''] ?? 3;
    
    return priorityA - priorityB;
  });
  
  for (const unassigned of sortedUnassigned) {
    const task = tasksMap.get(unassigned.taskId);
    if (!task) {
      taskResults.push({
        taskId: unassigned.taskId,
        logisticCode: 0,
        status: 'remain_unassigned',
        reason: 'TASK_NOT_FOUND'
      });
      remainUnassignedCount++;
      continue;
    }
    
    let bestCandidate: InsertionCandidate | null = null;
    let bestScheduleIdx = -1;
    let bestPosition = -1;
    
    for (let sIdx = 0; sIdx < schedules.length; sIdx++) {
      const schedule = schedules[sIdx];
      
      for (let pos = 0; pos <= schedule.tasks.length; pos++) {
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
        
        const candidate = tryInsertTask(
          schedule,
          task,
          pos,
          workDate,
          tasksMap,
          priorityWindows,
          params
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
      const updatedSchedule = applyInsertion(
        schedules[bestScheduleIdx],
        task,
        bestPosition,
        workDate,
        tasksMap,
        priorityWindows
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
        schedules,
        workDate,
        tasksMap,
        priorityWindows,
        params
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
        const isStraordinaria = task.straordinaria === true;
        
        // Calcola la penalità che si eviterebbe assegnando questo task
        const unassignedPenaltyValue = isStraordinaria 
          ? params.baseUnassignedPenalty + params.straordinariaExtraPenalty
          : params.baseUnassignedPenalty;
        
        const swapResult = trySwapForTask(
          task,
          schedules,
          workDate,
          tasksMap,
          priorityWindows,
          params,
          unassignedPenaltyValue
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
            score: -swapResult.netGain // Negativo perché è un guadagno
          });
          
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
          
          // Il task rimosso torna nella coda dei non assegnati
          // (verrà processato in un prossimo ciclo o rimarrà unassigned)
          // Per semplicità, lo aggiungo ai results come unassigned
          // In futuro potremmo implementare un ciclo di riassegnazione
          taskResults.push({
            taskId: swapResult.removedTaskId,
            logisticCode: swapResult.removedTaskLogisticCode,
            status: 'remain_unassigned',
            reason: 'SWAPPED_OUT_FOR_HIGHER_PRIORITY'
          });
          remainUnassignedCount++;
          
          events.push({
            eventType: 'PHASE4_TASK_SWAPPED_OUT',
            payload: {
              task_id: swapResult.removedTaskId,
              logistic_code: swapResult.removedTaskLogisticCode,
              replaced_by_task_id: task.taskId,
              replaced_by_is_straordinaria: isStraordinaria
            }
          });
        } else {
          // Nessun swap possibile
          taskResults.push({
            taskId: task.taskId,
            logisticCode: task.logisticCode,
            status: 'remain_unassigned',
            reason: 'NO_FEASIBLE_INSERTION_OR_SWAP'
          });
          
          remainUnassignedCount++;
          
          events.push({
            eventType: 'PHASE4_TASK_REMAIN_UNASSIGNED',
            payload: {
              task_id: task.taskId,
              logistic_code: task.logisticCode,
              original_reason: unassigned.reasonCode,
              insertion_attempts: iterationsUsed,
              is_straordinaria: isStraordinaria,
              swap_attempted: true
            }
          });
        }
      }
    }
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
