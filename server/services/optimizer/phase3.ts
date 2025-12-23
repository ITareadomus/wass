import { estimateTravelMinutes, TaskInput } from './phase1';

export interface TaskForScheduling {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  cleaningTimeMinutes: number;
  checkoutTime: string | null;
  checkinTime: string | null;
}

export interface CleanerForScheduling {
  cleanerId: number;
  name: string;
  startTime: string;
}

export interface ScheduleRow {
  taskId: number;
  sequence: number;
  startTime: Date;
  endTime: Date;
  travelMinutesFromPrev: number;
  waitMinutes: number;
}

export interface SimulationResult {
  ok: boolean;
  scheduleRows: ScheduleRow[];
  totalTravel: number;
  totalWait: number;
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
  previousTask: TaskForScheduling | null = null
): SimulationResult {
  const startMinutes = parseTimeToMinutes(startTimeStr) ?? 540;
  let currentMinutes = startMinutes;
  const scheduleRows: ScheduleRow[] = [];
  let totalTravel = 0;
  let totalWait = 0;

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
        endTime: null,
        failReason: 'TIME_WINDOW_IMPOSSIBLE',
        failedTaskId: task.taskId
      };
    }

    scheduleRows.push({
      taskId: task.taskId,
      sequence: i + 1,
      startTime: minutesToDate(workDate, earliestStart),
      endTime: minutesToDate(workDate, endMinutes),
      travelMinutesFromPrev: travelMin,
      waitMinutes: waitMin
    });

    currentMinutes = endMinutes;
  }

  return {
    ok: true,
    scheduleRows,
    totalTravel,
    totalWait,
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

export function scheduleSingleGroup(
  workDate: string,
  taskIds: number[],
  tasksMap: Map<number, TaskForScheduling>,
  cleanerStartTime: string,
  previousTask: TaskForScheduling | null = null
): { 
  ok: boolean; 
  scheduleRows: ScheduleRow[]; 
  chosenOrder: number[];
  totalTravel: number;
  totalWait: number;
  endTime: Date | null;
  permutationsChecked: number;
  droppedTasks: number[];
  failReason?: string;
} {
  const tasks = taskIds.map(id => tasksMap.get(id)).filter(Boolean) as TaskForScheduling[];
  
  if (tasks.length === 0) {
    return {
      ok: false,
      scheduleRows: [],
      chosenOrder: [],
      totalTravel: 0,
      totalWait: 0,
      endTime: null,
      permutationsChecked: 0,
      droppedTasks: taskIds,
      failReason: 'MISSING_TASK_DATA'
    };
  }

  if (tasks.length === 1) {
    const result = simulateSequence(workDate, tasks, cleanerStartTime, tasksMap, previousTask);
    return {
      ok: result.ok,
      scheduleRows: result.scheduleRows,
      chosenOrder: result.ok ? [tasks[0].taskId] : [],
      totalTravel: result.totalTravel,
      totalWait: result.totalWait,
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
    const result = simulateSequence(workDate, perm, cleanerStartTime, tasksMap, previousTask);
    
    if (result.ok) {
      if (!bestResult || 
          (result.endTime && bestResult.endTime && result.endTime < bestResult.endTime) ||
          (result.endTime && bestResult.endTime && result.endTime.getTime() === bestResult.endTime.getTime() && result.totalWait < bestResult.totalWait) ||
          (result.endTime && bestResult.endTime && result.endTime.getTime() === bestResult.endTime.getTime() && result.totalWait === bestResult.totalWait && result.totalTravel < bestResult.totalTravel)) {
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
      endTime: bestResult.endTime,
      permutationsChecked,
      droppedTasks: []
    };
  }

  const droppedTasks: number[] = [];
  for (let dropCount = 1; dropCount < tasks.length; dropCount++) {
    for (let dropIdx = 0; dropIdx < tasks.length; dropIdx++) {
      const remaining = tasks.filter((_, idx) => idx !== dropIdx);
      const remainingIds = remaining.map(t => t.taskId);
      
      const subResult = scheduleSingleGroup(workDate, remainingIds, tasksMap, cleanerStartTime, previousTask);
      
      if (subResult.ok) {
        return {
          ok: true,
          scheduleRows: subResult.scheduleRows,
          chosenOrder: subResult.chosenOrder,
          totalTravel: subResult.totalTravel,
          totalWait: subResult.totalWait,
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
  tasksMap: Map<number, TaskForScheduling>
): Phase3Result {
  const events: Phase3Event[] = [];
  const scheduledGroups: GroupScheduleResult[] = [];
  const unassignedTasks: { taskId: number; reasonCode: string; details: Record<string, any> }[] = [];
  
  let tasksScheduled = 0;
  let groupsScheduled = 0;

  for (const cg of cleanerGroups) {
    let currentTimeStr = cg.startTime;
    let globalSequence = 0;
    let lastTask: TaskForScheduling | null = null;

    for (const group of cg.groups) {
      const result = scheduleSingleGroup(workDate, group.taskIds, tasksMap, currentTimeStr, lastTask);

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
          endTime: result.endTime,
          droppedTasks: result.droppedTasks,
          permutationsChecked: result.permutationsChecked
        });

        globalSequence += adjustedRows.length;
        tasksScheduled += adjustedRows.length;
        groupsScheduled++;

        currentTimeStr = formatTimeFromMinutes(dateToMinutes(result.endTime));
        
        if (result.chosenOrder.length > 0) {
          lastTask = tasksMap.get(result.chosenOrder[result.chosenOrder.length - 1]) || null;
        }

        events.push({
          eventType: 'PHASE3_GROUP_SCHEDULED',
          payload: {
            cleaner_id: cg.cleanerId,
            cleaner_name: cg.cleanerName,
            task_ids: group.taskIds,
            chosen_order: result.chosenOrder,
            total_travel: result.totalTravel,
            total_wait: result.totalWait,
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
              checkout_time: task?.checkoutTime,
              checkin_time: task?.checkinTime,
              cleaning_time: task?.cleaningTimeMinutes,
              dropped_from_group: group.taskIds
            }
          });

          events.push({
            eventType: 'PHASE3_TASK_DROPPED_TIME',
            payload: {
              cleaner_id: cg.cleanerId,
              dropped_task_id: droppedId,
              reason: 'TIME_WINDOW_IMPOSSIBLE',
              remaining_tasks: result.chosenOrder
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
              checkout_time: task?.checkoutTime,
              checkin_time: task?.checkinTime,
              cleaning_time: task?.cleaningTimeMinutes,
              group_tasks: group.taskIds,
              permutations_checked: result.permutationsChecked
            }
          });

          events.push({
            eventType: 'PHASE3_TASK_UNASSIGNED_FINAL',
            payload: {
              task_id: taskId,
              reason_code: result.failReason || 'GROUP_SCHEDULING_FAILED',
              cleaner_id: cg.cleanerId,
              group_tasks: group.taskIds
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
      groupsScheduled
    }
  };
}
