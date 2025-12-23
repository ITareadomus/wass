import { estimateTravelMinutes, TaskInput } from './phase1';
import { Priority, PriorityWindows, priorityPenalty, PriorityPenaltyResult } from './priorityWindows';

export interface TaskForScheduling {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  cleaningTimeMinutes: number;
  checkoutTime: string | null;
  checkinTime: string | null;
  priorityType: Priority | null;
}

export interface CleanerForScheduling {
  cleanerId: number;
  name: string;
  startTime: string;
}

export interface ScheduleRow {
  taskId: number;
  logisticCode: number;
  sequence: number;
  startTime: Date;
  endTime: Date;
  travelMinutesFromPrev: number;
  waitMinutes: number;
  priorityType: Priority | null;
  priorityPenalty: number;
  priorityReasons: string[];
}

export interface PriorityViolation {
  taskId: number;
  priority: Priority;
  startTimeMin: number;
  windowStart: number;
  windowEnd: number | null;
  distanceMin: number;
  reason: string;
}

export interface SimulationResult {
  ok: boolean;
  scheduleRows: ScheduleRow[];
  totalTravel: number;
  totalWait: number;
  totalPriorityPenalty: number;
  priorityViolations: PriorityViolation[];
  endTime: Date | null;
  failReason?: string;
  failedTaskId?: number;
}

export interface Phase3Event {
  eventType: string;
  payload: Record<string, unknown>;
}

export interface GroupScheduleResult {
  cleanerId: number;
  taskIds: number[];
  chosenOrder: number[];
  scheduleRows: ScheduleRow[];
  totalTravel: number;
  totalWait: number;
  totalPriorityPenalty: number;
  priorityViolations: PriorityViolation[];
  endTime: Date;
  droppedTasks: number[];
  permutationsChecked: number;
}

export interface Phase3Result {
  scheduledGroups: GroupScheduleResult[];
  unassignedTasks: { taskId: number; reasonCode: string; details: Record<string, any> }[];
  events: Phase3Event[];
  stats: {
    cleanersProcessed: number;
    tasksScheduled: number;
    tasksUnassigned: number;
    groupsScheduled: number;
    priorityPenaltyTotal: number;
    priorityViolationsTotal: number;
    violationsByType: { EO: number; HP: number; LP: number };
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

function minutesToDate(workDate: string, minutesFromMidnight: number): Date {
  const [year, month, day] = workDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setHours(Math.floor(minutesFromMidnight / 60), minutesFromMidnight % 60, 0, 0);
  return date;
}

function dateToMinutes(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

export function simulateSequence(
  workDate: string,
  tasks: TaskForScheduling[],
  startTimeStr: string,
  tasksMap: Map<number, TaskForScheduling>,
  previousTask: TaskForScheduling | null = null,
  priorityWindows: PriorityWindows | null = null
): SimulationResult {
  const startMinutes = parseTimeToMinutes(startTimeStr) ?? 540;
  let currentMinutes = startMinutes;
  const scheduleRows: ScheduleRow[] = [];
  let totalTravel = 0;
  let totalWait = 0;
  let totalPriorityPenalty = 0;
  const priorityViolations: PriorityViolation[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    let travelMin = 0;

    if (i > 0) {
      const prevTask = tasks[i - 1];
      travelMin = estimateTravelMinutes(
        { taskId: prevTask.taskId, logisticCode: prevTask.logisticCode, lat: prevTask.lat, lng: prevTask.lng },
        { taskId: task.taskId, logisticCode: task.logisticCode, lat: task.lat, lng: task.lng }
      );
    } else if (previousTask) {
      travelMin = estimateTravelMinutes(
        { taskId: previousTask.taskId, logisticCode: previousTask.logisticCode, lat: previousTask.lat, lng: previousTask.lng },
        { taskId: task.taskId, logisticCode: task.logisticCode, lat: task.lat, lng: task.lng }
      );
    }

    totalTravel += travelMin;
    const arrivalMinutes = currentMinutes + travelMin;

    const checkoutMinutes = parseTimeToMinutes(task.checkoutTime);
    const earliestStart = checkoutMinutes !== null ? Math.max(arrivalMinutes, checkoutMinutes) : arrivalMinutes;
    const waitMin = earliestStart - arrivalMinutes;
    totalWait += waitMin;

    const cleaningTime = task.cleaningTimeMinutes || 60;
    const endMinutes = earliestStart + cleaningTime;

    const checkinMinutes = parseTimeToMinutes(task.checkinTime);
    if (checkinMinutes !== null && endMinutes > checkinMinutes) {
      return {
        ok: false,
        scheduleRows,
        totalTravel,
        totalWait,
        totalPriorityPenalty,
        priorityViolations,
        endTime: null,
        failReason: 'TIME_WINDOW_IMPOSSIBLE',
        failedTaskId: task.taskId
      };
    }

    let taskPenalty = 0;
    let taskReasons: string[] = [];
    
    if (priorityWindows && task.priorityType) {
      const penaltyResult = priorityPenalty(task.priorityType, earliestStart, priorityWindows);
      taskPenalty = penaltyResult.penalty;
      taskReasons = penaltyResult.reasons;
      totalPriorityPenalty += taskPenalty;
      
      if (penaltyResult.violation) {
        priorityViolations.push({
          taskId: task.taskId,
          priority: penaltyResult.violation.priority,
          startTimeMin: penaltyResult.violation.startTimeMin,
          windowStart: penaltyResult.violation.windowStart,
          windowEnd: penaltyResult.violation.windowEnd,
          distanceMin: penaltyResult.violation.distanceMin,
          reason: taskReasons[0] || ''
        });
      }
    }

    scheduleRows.push({
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      sequence: i + 1,
      startTime: minutesToDate(workDate, earliestStart),
      endTime: minutesToDate(workDate, endMinutes),
      travelMinutesFromPrev: travelMin,
      waitMinutes: waitMin,
      priorityType: task.priorityType,
      priorityPenalty: taskPenalty,
      priorityReasons: taskReasons
    });

    currentMinutes = endMinutes;
  }

  return {
    ok: true,
    scheduleRows,
    totalTravel,
    totalWait,
    totalPriorityPenalty,
    priorityViolations,
    endTime: minutesToDate(workDate, currentMinutes)
  };
}

function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  if (arr.length === 2) return [arr, [arr[1], arr[0]]];

  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i], ...perm]);
    }
  }
  return result;
}

export interface ScheduleGroupResult {
  ok: boolean; 
  scheduleRows: ScheduleRow[]; 
  chosenOrder: number[];
  totalTravel: number;
  totalWait: number;
  totalPriorityPenalty: number;
  priorityViolations: PriorityViolation[];
  endTime: Date | null;
  permutationsChecked: number;
  droppedTasks: number[];
  failReason?: string;
}

function comparePermutations(a: SimulationResult, b: SimulationResult): number {
  if (!a.endTime || !b.endTime) return 0;
  
  if (a.endTime.getTime() !== b.endTime.getTime()) {
    return a.endTime.getTime() - b.endTime.getTime();
  }
  if (a.totalPriorityPenalty !== b.totalPriorityPenalty) {
    return a.totalPriorityPenalty - b.totalPriorityPenalty;
  }
  if (a.totalWait !== b.totalWait) {
    return a.totalWait - b.totalWait;
  }
  return a.totalTravel - b.totalTravel;
}

export function scheduleSingleGroup(
  workDate: string,
  taskIds: number[],
  tasksMap: Map<number, TaskForScheduling>,
  cleanerStartTime: string,
  previousTask: TaskForScheduling | null = null,
  priorityWindows: PriorityWindows | null = null
): ScheduleGroupResult {
  const tasks = taskIds.map(id => tasksMap.get(id)).filter(Boolean) as TaskForScheduling[];
  
  if (tasks.length === 0) {
    return {
      ok: false,
      scheduleRows: [],
      chosenOrder: [],
      totalTravel: 0,
      totalWait: 0,
      totalPriorityPenalty: 0,
      priorityViolations: [],
      endTime: null,
      permutationsChecked: 0,
      droppedTasks: taskIds,
      failReason: 'MISSING_TASK_DATA'
    };
  }

  if (tasks.length === 1) {
    const result = simulateSequence(workDate, tasks, cleanerStartTime, tasksMap, previousTask, priorityWindows);
    return {
      ok: result.ok,
      scheduleRows: result.scheduleRows,
      chosenOrder: result.ok ? [tasks[0].taskId] : [],
      totalTravel: result.totalTravel,
      totalWait: result.totalWait,
      totalPriorityPenalty: result.totalPriorityPenalty,
      priorityViolations: result.priorityViolations,
      endTime: result.endTime,
      permutationsChecked: 1,
      droppedTasks: result.ok ? [] : [tasks[0].taskId],
      failReason: result.failReason
    };
  }

  const perms = permutations(tasks);
  let bestResult: SimulationResult | null = null;
  let bestOrder: number[] = [];
  let permutationsChecked = 0;

  for (const perm of perms) {
    permutationsChecked++;
    const result = simulateSequence(workDate, perm, cleanerStartTime, tasksMap, previousTask, priorityWindows);
    
    if (result.ok) {
      if (!bestResult || comparePermutations(result, bestResult) < 0) {
        bestResult = result;
        bestOrder = perm.map(t => t.taskId);
      }
    }
  }

  if (bestResult) {
    return {
      ok: true,
      scheduleRows: bestResult.scheduleRows,
      chosenOrder: bestOrder,
      totalTravel: bestResult.totalTravel,
      totalWait: bestResult.totalWait,
      totalPriorityPenalty: bestResult.totalPriorityPenalty,
      priorityViolations: bestResult.priorityViolations,
      endTime: bestResult.endTime,
      permutationsChecked,
      droppedTasks: []
    };
  }

  for (let dropCount = 1; dropCount < tasks.length; dropCount++) {
    for (let dropIdx = 0; dropIdx < tasks.length; dropIdx++) {
      const remaining = tasks.filter((_, idx) => idx !== dropIdx);
      const remainingIds = remaining.map(t => t.taskId);
      
      const subResult = scheduleSingleGroup(workDate, remainingIds, tasksMap, cleanerStartTime, previousTask, priorityWindows);
      
      if (subResult.ok) {
        return {
          ok: true,
          scheduleRows: subResult.scheduleRows,
          chosenOrder: subResult.chosenOrder,
          totalTravel: subResult.totalTravel,
          totalWait: subResult.totalWait,
          totalPriorityPenalty: subResult.totalPriorityPenalty,
          priorityViolations: subResult.priorityViolations,
          endTime: subResult.endTime,
          permutationsChecked: permutationsChecked + subResult.permutationsChecked,
          droppedTasks: [tasks[dropIdx].taskId, ...subResult.droppedTasks]
        };
      }
    }
  }

  return {
    ok: false,
    scheduleRows: [],
    chosenOrder: [],
    totalTravel: 0,
    totalWait: 0,
    totalPriorityPenalty: 0,
    priorityViolations: [],
    endTime: null,
    permutationsChecked,
    droppedTasks: taskIds,
    failReason: 'ALL_PERMUTATIONS_FAILED'
  };
}

export interface CleanerGroups {
  cleanerId: number;
  cleanerName: string;
  startTime: string;
  groups: { taskIds: number[]; score: number }[];
}

function formatTimeFromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

export function runPhase3Algorithm(
  workDate: string,
  cleanerGroups: CleanerGroups[],
  tasksMap: Map<number, TaskForScheduling>,
  priorityWindows: PriorityWindows | null = null
): Phase3Result {
  const events: Phase3Event[] = [];
  const scheduledGroups: GroupScheduleResult[] = [];
  const unassignedTasks: { taskId: number; reasonCode: string; details: Record<string, any> }[] = [];
  
  let tasksScheduled = 0;
  let groupsScheduled = 0;
  let priorityPenaltyTotal = 0;
  let priorityViolationsTotal = 0;
  const violationsByType = { EO: 0, HP: 0, LP: 0 };

  for (const cg of cleanerGroups) {
    let currentTimeStr = cg.startTime;
    let globalSequence = 0;
    let lastTask: TaskForScheduling | null = null;

    for (const group of cg.groups) {
      const result = scheduleSingleGroup(workDate, group.taskIds, tasksMap, currentTimeStr, lastTask, priorityWindows);

      if (result.ok && result.endTime) {
        const adjustedRows = result.scheduleRows.map((row, idx) => ({
          ...row,
          sequence: globalSequence + idx + 1
        }));

        scheduledGroups.push({
          cleanerId: cg.cleanerId,
          taskIds: group.taskIds,
          chosenOrder: result.chosenOrder,
          scheduleRows: adjustedRows,
          totalTravel: result.totalTravel,
          totalWait: result.totalWait,
          totalPriorityPenalty: result.totalPriorityPenalty,
          priorityViolations: result.priorityViolations,
          endTime: result.endTime,
          droppedTasks: result.droppedTasks,
          permutationsChecked: result.permutationsChecked
        });

        priorityPenaltyTotal += result.totalPriorityPenalty;
        priorityViolationsTotal += result.priorityViolations.length;
        for (const v of result.priorityViolations) {
          violationsByType[v.priority]++;
        }

        globalSequence += adjustedRows.length;
        tasksScheduled += adjustedRows.length;
        groupsScheduled++;

        currentTimeStr = formatTimeFromMinutes(dateToMinutes(result.endTime));
        
        if (result.chosenOrder.length > 0) {
          lastTask = tasksMap.get(result.chosenOrder[result.chosenOrder.length - 1]) || null;
        }

        const chosenLogisticCodes = result.chosenOrder.map(id => tasksMap.get(id)?.logisticCode || 0);
        
        events.push({
          eventType: 'PHASE3_GROUP_SCHEDULED',
          payload: {
            cleaner_id: cg.cleanerId,
            cleaner_name: cg.cleanerName,
            task_ids: group.taskIds,
            logistic_codes: group.taskIds.map(id => tasksMap.get(id)?.logisticCode || 0),
            chosen_order: result.chosenOrder,
            chosen_order_logistic_codes: chosenLogisticCodes,
            total_travel: result.totalTravel,
            total_wait: result.totalWait,
            total_priority_penalty: result.totalPriorityPenalty,
            priority_violations: result.priorityViolations,
            end_time: result.endTime.toISOString(),
            permutations_checked: result.permutationsChecked,
            sequence_range: [globalSequence - adjustedRows.length + 1, globalSequence]
          }
        });

        for (const droppedId of result.droppedTasks) {
          const task = tasksMap.get(droppedId);
          unassignedTasks.push({
            taskId: droppedId,
            reasonCode: 'TIME_WINDOW_IMPOSSIBLE',
            details: {
              cleaner_id: cg.cleanerId,
              logistic_code: task?.logisticCode,
              checkout_time: task?.checkoutTime,
              checkin_time: task?.checkinTime,
              cleaning_time: task?.cleaningTimeMinutes,
              dropped_from_group: group.taskIds,
              dropped_from_group_logistic_codes: group.taskIds.map(id => tasksMap.get(id)?.logisticCode || 0)
            }
          });

          events.push({
            eventType: 'PHASE3_TASK_DROPPED_TIME',
            payload: {
              cleaner_id: cg.cleanerId,
              dropped_task_id: droppedId,
              dropped_logistic_code: task?.logisticCode,
              reason: 'TIME_WINDOW_IMPOSSIBLE',
              remaining_tasks: result.chosenOrder,
              remaining_logistic_codes: result.chosenOrder.map(id => tasksMap.get(id)?.logisticCode || 0)
            }
          });
        }
      } else {
        for (const taskId of group.taskIds) {
          const task = tasksMap.get(taskId);
          unassignedTasks.push({
            taskId,
            reasonCode: result.failReason || 'GROUP_SCHEDULING_FAILED',
            details: {
              cleaner_id: cg.cleanerId,
              logistic_code: task?.logisticCode,
              checkout_time: task?.checkoutTime,
              checkin_time: task?.checkinTime,
              cleaning_time: task?.cleaningTimeMinutes,
              group_tasks: group.taskIds,
              group_logistic_codes: group.taskIds.map(id => tasksMap.get(id)?.logisticCode || 0),
              permutations_checked: result.permutationsChecked
            }
          });

          events.push({
            eventType: 'PHASE3_TASK_UNASSIGNED_FINAL',
            payload: {
              task_id: taskId,
              logistic_code: task?.logisticCode,
              reason_code: result.failReason || 'GROUP_SCHEDULING_FAILED',
              cleaner_id: cg.cleanerId,
              group_tasks: group.taskIds,
              group_logistic_codes: group.taskIds.map(id => tasksMap.get(id)?.logisticCode || 0)
            }
          });
        }
      }
    }
  }

  return {
    scheduledGroups,
    unassignedTasks,
    events,
    stats: {
      cleanersProcessed: cleanerGroups.length,
      tasksScheduled,
      tasksUnassigned: unassignedTasks.length,
      groupsScheduled,
      priorityPenaltyTotal,
      priorityViolationsTotal,
      violationsByType
    }
  };
}
