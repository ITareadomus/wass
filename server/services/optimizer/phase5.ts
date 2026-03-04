import { TaskForScheduling, simulateSequence, Phase3TimelineConstraints } from './phase3';
import { PriorityWindows } from './priorityWindows';
import { CleanerSchedule } from './phase4';
import { FairnessParams, DEFAULT_FAIRNESS_PARAMS } from './phase2';

export interface Phase5Params {
  maxIterations: number;
  minImprovementMin: number;
  dynamicMaxTasks?: number;
  fairness: FairnessParams;
  maxFairnessIterations: number;
  maxTravelIncreaseForFairness: number; // max acceptable net travel increase (min) for a fairness move
  fairnessOverloadedRatio: number;      // threshold: cleaner is overloaded when load > avg * ratio
  fairnessUnderloadedRatio: number;     // threshold: cleaner is underloaded when load < avg * ratio
}

export const DEFAULT_PHASE5_PARAMS: Phase5Params = {
  maxIterations: 80,
  minImprovementMin: 3,
  dynamicMaxTasks: undefined,
  fairness: DEFAULT_FAIRNESS_PARAMS,
  maxFairnessIterations: 30,
  maxTravelIncreaseForFairness: 20,
  fairnessOverloadedRatio: 1.20,
  fairnessUnderloadedRatio: 0.80
};

export interface Phase5Event {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface Phase5Result {
  updatedSchedules: CleanerSchedule[];
  events: Phase5Event[];
  stats: {
    relocationsExecuted: number;
    swapsExecuted: number;
    iterationsUsed: number;
    travelBefore: number;
    travelAfter: number;
    travelReduced: number;
    fairnessRelocations: number;
    fairnessIterationsUsed: number;
    loadSpreadBefore: number;
    loadSpreadAfter: number;
  };
}

interface MoveCandidate {
  type: 'relocation' | 'swap';
  improvement: number;
  fromIdx?: number;
  fromTaskIdx?: number;
  toIdx?: number;
  toPosition?: number;
  cleanerAIdx?: number;
  taskAIdx?: number;
  cleanerBIdx?: number;
  taskBIdx?: number;
}

function isTaskMovableToCleaner(
  task: TaskForScheduling,
  target: CleanerSchedule,
  tasksMap: Map<number, TaskForScheduling>
): boolean {
  if (task.straordinaria) return false;

  if (task.premium) {
    const role = (target.role || 'Standard').toLowerCase();
    if (!role.includes('premium')) return false;
  }

  if (target.fixedHasAnyOT || target.fixedHasLongOT) return false;

  const hasExistingOT = target.tasks.some(r => {
    const t = tasksMap.get(r.taskId);
    return t?.straordinaria;
  });
  if (hasExistingOT) return false;

  const role = (target.role || 'Standard').toLowerCase();
  if (role.includes('formatore') && task.typeApt) {
    const apt = task.typeApt.toUpperCase();
    if (!['B', 'C'].includes(apt)) return false;
  }

  return true;
}

function tasksWithout(
  schedule: CleanerSchedule,
  tasksMap: Map<number, TaskForScheduling>,
  excludeIdx: number
): TaskForScheduling[] {
  return schedule.tasks
    .filter((_, i) => i !== excludeIdx)
    .map(r => tasksMap.get(r.taskId))
    .filter((t): t is TaskForScheduling => !!t);
}

function tasksWithInsert(
  schedule: CleanerSchedule,
  tasksMap: Map<number, TaskForScheduling>,
  newTask: TaskForScheduling,
  insertAt: number
): TaskForScheduling[] {
  const result: TaskForScheduling[] = [];
  let inserted = false;

  for (let i = 0; i < schedule.tasks.length; i++) {
    if (i === insertAt && !inserted) {
      result.push(newTask);
      inserted = true;
    }
    const t = tasksMap.get(schedule.tasks[i].taskId);
    if (t) result.push(t);
  }

  if (!inserted) result.push(newTask);
  return result;
}

function tasksWithReplace(
  schedule: CleanerSchedule,
  tasksMap: Map<number, TaskForScheduling>,
  replaceIdx: number,
  replacement: TaskForScheduling
): TaskForScheduling[] {
  return schedule.tasks.map((r, i) => {
    if (i === replaceIdx) return replacement;
    return tasksMap.get(r.taskId) ?? null;
  }).filter((t): t is TaskForScheduling => !!t);
}

function dateToMinutes(d: Date): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function applySimResult(
  original: CleanerSchedule,
  sim: { scheduleRows: any[]; totalTravel: number; totalWait: number; totalPriorityPenalty: number; endTime: Date | null },
  newTasks: TaskForScheduling[]
): CleanerSchedule {
  return {
    ...original,
    tasks: sim.scheduleRows,
    totalTravel: sim.totalTravel,
    totalWait: sim.totalWait,
    totalPriorityPenalty: sim.totalPriorityPenalty,
    endTimeMinutes: sim.endTime ? dateToMinutes(sim.endTime) : original.endTimeMinutes,
    totalWorkMinutes: newTasks.reduce((s, t) => s + (t.cleaningTimeMinutes ?? 60), 0)
  };
}

function computeCleanerLoadMin(schedule: CleanerSchedule, fairness: FairnessParams): number {
  const workMin = (schedule.fixedWorkMinutes ?? 0) + (schedule.totalWorkMinutes ?? 0);
  const travelMin = (schedule.fixedTravelMinutes ?? 0) + (schedule.totalTravel ?? 0);
  return workMin + fairness.wT * travelMin;
}

interface FairnessCandidate {
  fromIdx: number;
  fromTaskIdx: number;
  toIdx: number;
  toPosition: number;
  balanceImprovement: number;
  netTravelIncrease: number;
}

export function runPhase5Algorithm(
  workDate: string,
  schedules: CleanerSchedule[],
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null,
  params: Phase5Params = DEFAULT_PHASE5_PARAMS,
  constraintsByCleaner: Map<string, Phase3TimelineConstraints> = new Map(),
  lockedCleanerIds: number[] = []
): Phase5Result {
  const events: Phase5Event[] = [];
  let relocationsExecuted = 0;
  let swapsExecuted = 0;
  let iterationsUsed = 0;
  const lockedSet = new Set(lockedCleanerIds);

  const travelBefore = schedules.reduce((sum, s) => sum + s.totalTravel, 0);

  const current = schedules.map(s => ({
    ...s,
    tasks: [...s.tasks]
  }));

  events.push({
    eventType: 'PHASE5_STARTED',
    payload: {
      schedules_count: current.length,
      total_travel_before: travelBefore,
      locked_cleaners: lockedCleanerIds.length,
      params
    }
  });

  for (let iteration = 0; iteration < params.maxIterations; iteration++) {
    iterationsUsed++;
    let bestMove: MoveCandidate | null = null;

    // === RELOCATIONS: move a task from cleaner A to cleaner B ===
    for (let aIdx = 0; aIdx < current.length; aIdx++) {
      const schedA = current[aIdx];
      if (lockedSet.has(schedA.cleanerId)) continue;
      if (schedA.tasks.length === 0) continue;

      for (let tIdx = 0; tIdx < schedA.tasks.length; tIdx++) {
        const task = tasksMap.get(schedA.tasks[tIdx].taskId);
        if (!task || task.straordinaria) continue;

        const listAWithout = tasksWithout(schedA, tasksMap, tIdx);
        const cA = constraintsByCleaner.get(String(schedA.cleanerId)) || null;
        const simAWithout = simulateSequence(
          workDate, listAWithout, schedA.startTime, tasksMap,
          schedA.anchorTask ?? null, priorityWindows, cA
        );
        if (!simAWithout.ok && listAWithout.length > 0) continue;

        const savedA = schedA.totalTravel - (simAWithout.ok ? simAWithout.totalTravel : 0);

        for (let bIdx = 0; bIdx < current.length; bIdx++) {
          if (bIdx === aIdx) continue;
          const schedB = current[bIdx];
          if (lockedSet.has(schedB.cleanerId)) continue;

          if (!isTaskMovableToCleaner(task, schedB, tasksMap)) continue;

          const fixedB = schedB.fixedTaskCount ?? 0;
          const maxLoad = params.dynamicMaxTasks ?? 6;
          if (fixedB + schedB.tasks.length + 1 > maxLoad + 1) continue;

          const cB = constraintsByCleaner.get(String(schedB.cleanerId)) || null;

          for (let pos = 0; pos <= schedB.tasks.length; pos++) {
            const listBWith = tasksWithInsert(schedB, tasksMap, task, pos);
            const simBWith = simulateSequence(
              workDate, listBWith, schedB.startTime, tasksMap,
              schedB.anchorTask ?? null, priorityWindows, cB
            );
            if (!simBWith.ok) continue;

            const addedB = simBWith.totalTravel - schedB.totalTravel;
            const net = savedA - addedB;

            const penaltyDelta =
              (simBWith.totalPriorityPenalty - schedB.totalPriorityPenalty) +
              ((simAWithout.ok ? simAWithout.totalPriorityPenalty : 0) - schedA.totalPriorityPenalty);

            if (net >= params.minImprovementMin && penaltyDelta <= 10) {
              if (!bestMove || net > bestMove.improvement) {
                bestMove = {
                  type: 'relocation',
                  improvement: net,
                  fromIdx: aIdx,
                  fromTaskIdx: tIdx,
                  toIdx: bIdx,
                  toPosition: pos
                };
              }
            }
          }
        }
      }
    }

    // === PAIRWISE SWAPS: exchange one task between A and B ===
    for (let aIdx = 0; aIdx < current.length; aIdx++) {
      const schedA = current[aIdx];
      if (lockedSet.has(schedA.cleanerId) || schedA.tasks.length === 0) continue;

      for (let bIdx = aIdx + 1; bIdx < current.length; bIdx++) {
        const schedB = current[bIdx];
        if (lockedSet.has(schedB.cleanerId) || schedB.tasks.length === 0) continue;

        for (let tA = 0; tA < schedA.tasks.length; tA++) {
          const taskA = tasksMap.get(schedA.tasks[tA].taskId);
          if (!taskA || taskA.straordinaria) continue;

          for (let tB = 0; tB < schedB.tasks.length; tB++) {
            const taskB = tasksMap.get(schedB.tasks[tB].taskId);
            if (!taskB || taskB.straordinaria) continue;

            if (!isTaskMovableToCleaner(taskA, schedB, tasksMap)) continue;
            if (!isTaskMovableToCleaner(taskB, schedA, tasksMap)) continue;

            const cA = constraintsByCleaner.get(String(schedA.cleanerId)) || null;
            const listASwapped = tasksWithReplace(schedA, tasksMap, tA, taskB);
            const simASwapped = simulateSequence(
              workDate, listASwapped, schedA.startTime, tasksMap,
              schedA.anchorTask ?? null, priorityWindows, cA
            );
            if (!simASwapped.ok) continue;

            const cB = constraintsByCleaner.get(String(schedB.cleanerId)) || null;
            const listBSwapped = tasksWithReplace(schedB, tasksMap, tB, taskA);
            const simBSwapped = simulateSequence(
              workDate, listBSwapped, schedB.startTime, tasksMap,
              schedB.anchorTask ?? null, priorityWindows, cB
            );
            if (!simBSwapped.ok) continue;

            const oldTravel = schedA.totalTravel + schedB.totalTravel;
            const newTravel = simASwapped.totalTravel + simBSwapped.totalTravel;
            const improvement = oldTravel - newTravel;

            const oldPenalty = schedA.totalPriorityPenalty + schedB.totalPriorityPenalty;
            const newPenalty = simASwapped.totalPriorityPenalty + simBSwapped.totalPriorityPenalty;
            const penaltyDelta = newPenalty - oldPenalty;

            if (improvement >= params.minImprovementMin && penaltyDelta <= 10) {
              if (!bestMove || improvement > bestMove.improvement) {
                bestMove = {
                  type: 'swap',
                  improvement,
                  cleanerAIdx: aIdx,
                  taskAIdx: tA,
                  cleanerBIdx: bIdx,
                  taskBIdx: tB
                };
              }
            }
          }
        }
      }
    }

    if (!bestMove) break;

    if (bestMove.type === 'relocation') {
      const fromSched = current[bestMove.fromIdx!];
      const toSched = current[bestMove.toIdx!];
      const task = tasksMap.get(fromSched.tasks[bestMove.fromTaskIdx!].taskId)!;

      const listA = tasksWithout(fromSched, tasksMap, bestMove.fromTaskIdx!);
      const cA = constraintsByCleaner.get(String(fromSched.cleanerId)) || null;
      const simA = simulateSequence(workDate, listA, fromSched.startTime, tasksMap, fromSched.anchorTask ?? null, priorityWindows, cA);

      const listB = tasksWithInsert(toSched, tasksMap, task, bestMove.toPosition!);
      const cB = constraintsByCleaner.get(String(toSched.cleanerId)) || null;
      const simB = simulateSequence(workDate, listB, toSched.startTime, tasksMap, toSched.anchorTask ?? null, priorityWindows, cB);

      if (simA.ok || listA.length === 0) {
        current[bestMove.fromIdx!] = applySimResult(fromSched, simA.ok ? simA : { scheduleRows: [], totalTravel: 0, totalWait: 0, totalPriorityPenalty: 0, endTime: null }, listA);
      }
      if (simB.ok) {
        current[bestMove.toIdx!] = applySimResult(toSched, simB, listB);
      }

      relocationsExecuted++;
      events.push({
        eventType: 'PHASE5_RELOCATION',
        payload: {
          task_id: task.taskId,
          logistic_code: task.logisticCode,
          from_cleaner: fromSched.cleanerId,
          from_cleaner_name: fromSched.cleanerName,
          to_cleaner: toSched.cleanerId,
          to_cleaner_name: toSched.cleanerName,
          position: bestMove.toPosition,
          travel_saved: bestMove.improvement,
          iteration
        }
      });
    } else {
      const schedA = current[bestMove.cleanerAIdx!];
      const schedB = current[bestMove.cleanerBIdx!];
      const taskA = tasksMap.get(schedA.tasks[bestMove.taskAIdx!].taskId)!;
      const taskB = tasksMap.get(schedB.tasks[bestMove.taskBIdx!].taskId)!;

      const cA = constraintsByCleaner.get(String(schedA.cleanerId)) || null;
      const listA = tasksWithReplace(schedA, tasksMap, bestMove.taskAIdx!, taskB);
      const simA = simulateSequence(workDate, listA, schedA.startTime, tasksMap, schedA.anchorTask ?? null, priorityWindows, cA);

      const cB = constraintsByCleaner.get(String(schedB.cleanerId)) || null;
      const listB = tasksWithReplace(schedB, tasksMap, bestMove.taskBIdx!, taskA);
      const simB = simulateSequence(workDate, listB, schedB.startTime, tasksMap, schedB.anchorTask ?? null, priorityWindows, cB);

      if (simA.ok && simB.ok) {
        current[bestMove.cleanerAIdx!] = applySimResult(schedA, simA, listA);
        current[bestMove.cleanerBIdx!] = applySimResult(schedB, simB, listB);

        swapsExecuted++;
        events.push({
          eventType: 'PHASE5_SWAP',
          payload: {
            taskA_id: taskA.taskId,
            taskA_logistic_code: taskA.logisticCode,
            cleanerA: schedA.cleanerId,
            cleanerA_name: schedA.cleanerName,
            taskB_id: taskB.taskId,
            taskB_logistic_code: taskB.logisticCode,
            cleanerB: schedB.cleanerId,
            cleanerB_name: schedB.cleanerName,
            travel_saved: bestMove.improvement,
            iteration
          }
        });
      }
    }
  }

  const travelAfterOpt = current.reduce((sum, s) => sum + s.totalTravel, 0);

  events.push({
    eventType: 'PHASE5_TRAVEL_OPT_COMPLETED',
    payload: {
      relocations: relocationsExecuted,
      swaps: swapsExecuted,
      iterations: iterationsUsed,
      travel_before: travelBefore,
      travel_after: travelAfterOpt,
      travel_reduced: travelBefore - travelAfterOpt
    }
  });

  // === FAIRNESS REBALANCING PASS ===
  const activeSchedules = current.filter(s => s.tasks.length > 0 || (s.fixedWorkMinutes ?? 0) > 0);
  const loadsBefore = activeSchedules.map(s => computeCleanerLoadMin(s, params.fairness));
  const loadSpreadBefore = loadsBefore.length > 0 ? Math.max(...loadsBefore) - Math.min(...loadsBefore) : 0;

  let fairnessRelocations = 0;
  let fairnessIterationsUsed = 0;

  for (let fIter = 0; fIter < params.maxFairnessIterations; fIter++) {
    fairnessIterationsUsed++;

    const loads = current.map((s, idx) => ({ idx, load: computeCleanerLoadMin(s, params.fairness), taskCount: s.tasks.length + (s.fixedTaskCount ?? 0) }));
    const activLoads = loads.filter(l => l.taskCount > 0 || l.load > 0);
    if (activLoads.length <= 1) break;

    const avgLoad = activLoads.reduce((sum, l) => sum + l.load, 0) / activLoads.length;
    const overThreshold = avgLoad * params.fairnessOverloadedRatio;
    const underThreshold = avgLoad * params.fairnessUnderloadedRatio;

    const overloaded = loads.filter(l => l.load > overThreshold && l.taskCount > 1);
    const underloaded = loads.filter(l => l.load < underThreshold);

    if (overloaded.length === 0 || underloaded.length === 0) break;

    let bestFairness: FairnessCandidate | null = null;

    for (const over of overloaded) {
      const schedA = current[over.idx];
      if (lockedSet.has(schedA.cleanerId)) continue;

      for (let tIdx = 0; tIdx < schedA.tasks.length; tIdx++) {
        const task = tasksMap.get(schedA.tasks[tIdx].taskId);
        if (!task || task.straordinaria) continue;

        const listAWithout = tasksWithout(schedA, tasksMap, tIdx);
        const cA = constraintsByCleaner.get(String(schedA.cleanerId)) || null;
        const simAWithout = simulateSequence(
          workDate, listAWithout, schedA.startTime, tasksMap,
          schedA.anchorTask ?? null, priorityWindows, cA
        );
        if (!simAWithout.ok && listAWithout.length > 0) continue;

        const savedTravelA = schedA.totalTravel - (simAWithout.ok ? simAWithout.totalTravel : 0);
        const loadAAfter = computeCleanerLoadMin(
          applySimResult(schedA, simAWithout.ok ? simAWithout : { scheduleRows: [], totalTravel: 0, totalWait: 0, totalPriorityPenalty: 0, endTime: null }, listAWithout),
          params.fairness
        );

        for (const under of underloaded) {
          const schedB = current[under.idx];
          if (lockedSet.has(schedB.cleanerId)) continue;
          if (over.idx === under.idx) continue;

          if (!isTaskMovableToCleaner(task, schedB, tasksMap)) continue;

          const fixedB = schedB.fixedTaskCount ?? 0;
          const maxLoad = params.dynamicMaxTasks ?? 6;
          if (fixedB + schedB.tasks.length + 1 > maxLoad + 1) continue;

          const cB = constraintsByCleaner.get(String(schedB.cleanerId)) || null;

          for (let pos = 0; pos <= schedB.tasks.length; pos++) {
            const listBWith = tasksWithInsert(schedB, tasksMap, task, pos);
            const simBWith = simulateSequence(
              workDate, listBWith, schedB.startTime, tasksMap,
              schedB.anchorTask ?? null, priorityWindows, cB
            );
            if (!simBWith.ok) continue;

            const penaltyDelta =
              (simBWith.totalPriorityPenalty - schedB.totalPriorityPenalty) +
              ((simAWithout.ok ? simAWithout.totalPriorityPenalty : 0) - schedA.totalPriorityPenalty);
            if (penaltyDelta > 10) continue;

            const addedTravelB = simBWith.totalTravel - schedB.totalTravel;
            const netTravelIncrease = addedTravelB - savedTravelA;

            if (netTravelIncrease > params.maxTravelIncreaseForFairness) continue;

            const loadBAfter = computeCleanerLoadMin(
              applySimResult(schedB, simBWith, listBWith),
              params.fairness
            );

            const distBefore = Math.abs(over.load - avgLoad) + Math.abs(under.load - avgLoad);
            const distAfter = Math.abs(loadAAfter - avgLoad) + Math.abs(loadBAfter - avgLoad);
            const balanceImprovement = distBefore - distAfter;

            if (balanceImprovement <= 0) continue;

            const score = balanceImprovement - netTravelIncrease * 0.5;
            if (!bestFairness || score > bestFairness.balanceImprovement - bestFairness.netTravelIncrease * 0.5) {
              bestFairness = {
                fromIdx: over.idx,
                fromTaskIdx: tIdx,
                toIdx: under.idx,
                toPosition: pos,
                balanceImprovement,
                netTravelIncrease
              };
            }
          }
        }
      }
    }

    if (!bestFairness) break;

    const fromSched = current[bestFairness.fromIdx];
    const toSched = current[bestFairness.toIdx];
    const task = tasksMap.get(fromSched.tasks[bestFairness.fromTaskIdx].taskId)!;

    const listA = tasksWithout(fromSched, tasksMap, bestFairness.fromTaskIdx);
    const cA = constraintsByCleaner.get(String(fromSched.cleanerId)) || null;
    const simA = simulateSequence(workDate, listA, fromSched.startTime, tasksMap, fromSched.anchorTask ?? null, priorityWindows, cA);

    const listB = tasksWithInsert(toSched, tasksMap, task, bestFairness.toPosition);
    const cB = constraintsByCleaner.get(String(toSched.cleanerId)) || null;
    const simB = simulateSequence(workDate, listB, toSched.startTime, tasksMap, toSched.anchorTask ?? null, priorityWindows, cB);

    if ((simA.ok || listA.length === 0) && simB.ok) {
      current[bestFairness.fromIdx] = applySimResult(fromSched, simA.ok ? simA : { scheduleRows: [], totalTravel: 0, totalWait: 0, totalPriorityPenalty: 0, endTime: null }, listA);
      current[bestFairness.toIdx] = applySimResult(toSched, simB, listB);

      fairnessRelocations++;
      events.push({
        eventType: 'PHASE5_FAIRNESS_RELOCATION',
        payload: {
          task_id: task.taskId,
          logistic_code: task.logisticCode,
          from_cleaner: fromSched.cleanerId,
          from_cleaner_name: fromSched.cleanerName,
          to_cleaner: toSched.cleanerId,
          to_cleaner_name: toSched.cleanerName,
          position: bestFairness.toPosition,
          balance_improvement: Math.round(bestFairness.balanceImprovement),
          net_travel_increase: Math.round(bestFairness.netTravelIncrease),
          iteration: fIter
        }
      });
    }
  }

  const activeSchedulesAfter = current.filter(s => s.tasks.length > 0 || (s.fixedWorkMinutes ?? 0) > 0);
  const loadsAfter = activeSchedulesAfter.map(s => computeCleanerLoadMin(s, params.fairness));
  const loadSpreadAfter = loadsAfter.length > 0 ? Math.max(...loadsAfter) - Math.min(...loadsAfter) : 0;

  const travelAfter = current.reduce((sum, s) => sum + s.totalTravel, 0);

  events.push({
    eventType: 'PHASE5_FAIRNESS_COMPLETED',
    payload: {
      fairness_relocations: fairnessRelocations,
      fairness_iterations: fairnessIterationsUsed,
      load_spread_before: Math.round(loadSpreadBefore),
      load_spread_after: Math.round(loadSpreadAfter),
      travel_after_fairness: travelAfter
    }
  });

  events.push({
    eventType: 'PHASE5_COMPLETED',
    payload: {
      relocations: relocationsExecuted,
      swaps: swapsExecuted,
      fairness_relocations: fairnessRelocations,
      iterations: iterationsUsed,
      travel_before: travelBefore,
      travel_after: travelAfter,
      travel_reduced: travelBefore - travelAfter,
      load_spread_before: Math.round(loadSpreadBefore),
      load_spread_after: Math.round(loadSpreadAfter)
    }
  });

  return {
    updatedSchedules: current,
    events,
    stats: {
      relocationsExecuted,
      swapsExecuted,
      iterationsUsed,
      travelBefore,
      travelAfter,
      travelReduced: travelBefore - travelAfter,
      fairnessRelocations,
      fairnessIterationsUsed,
      loadSpreadBefore: Math.round(loadSpreadBefore),
      loadSpreadAfter: Math.round(loadSpreadAfter)
    }
  };
}
