import { TravelTimeProvider, TravelLocation } from './travelTimeProvider';
import { Priority, PriorityWindows, priorityPenalty } from './priorityWindows';

export interface TaskForRecovery {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  durationMin: number;
  priority: Priority;
  reasonCode?: string;
}

export interface CleanerSchedule {
  cleanerId: number;
  baseLat: number;
  baseLng: number;
  startTimeMin: number;
  tasks: ScheduledTask[];
}

export interface ScheduledTask {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  durationMin: number;
  priority: Priority;
  startMin: number;
  endMin: number;
  travelMin: number;
}

export interface InsertionCandidate {
  cleanerId: number;
  position: number;
  cost: number;
  newSchedule: ScheduledTask[];
  bonusApplied: boolean;
}

export interface Phase4Result {
  updatedSchedules: CleanerSchedule[];
  reassigned: TaskForRecovery[];
  stillUnassigned: TaskForRecovery[];
  events: Phase4Event[];
}

export interface Phase4Event {
  eventType: string;
  payload: Record<string, unknown>;
}

const UNDERFILLED_BONUS = 15;

export async function runPhase4Recovery(
  unassignedTasks: TaskForRecovery[],
  cleanerSchedules: CleanerSchedule[],
  priorityWindows: PriorityWindows,
  travelProvider: TravelTimeProvider
): Promise<Phase4Result> {
  const events: Phase4Event[] = [];
  const reassigned: TaskForRecovery[] = [];
  const stillUnassigned: TaskForRecovery[] = [];

  const schedules = cleanerSchedules.map(s => ({
    ...s,
    tasks: [...s.tasks]
  }));

  events.push({
    eventType: 'PHASE4_RETRY_STARTED',
    payload: {
      unassignedCount: unassignedTasks.length,
      cleanerCount: schedules.length
    }
  });

  for (const task of unassignedTasks) {
    const bestInsertion = await findBestInsertion(task, schedules, priorityWindows, travelProvider);

    if (bestInsertion) {
      const schedule = schedules.find(s => s.cleanerId === bestInsertion.cleanerId)!;
      schedule.tasks = bestInsertion.newSchedule;
      reassigned.push(task);

      events.push({
        eventType: bestInsertion.bonusApplied ? 'PHASE4_TASK_REASSIGNED_WITH_BONUS' : 'PHASE4_TASK_REASSIGNED_INSERTION',
        payload: {
          taskId: task.taskId,
          logisticCode: task.logisticCode,
          cleanerId: bestInsertion.cleanerId,
          position: bestInsertion.position,
          cost: bestInsertion.cost,
          bonusApplied: bestInsertion.bonusApplied
        }
      });
    } else {
      const singleResult = await tryAssignAsSingle(task, schedules, priorityWindows, travelProvider);
      
      if (singleResult) {
        const schedule = schedules.find(s => s.cleanerId === singleResult.cleanerId)!;
        schedule.tasks = singleResult.newSchedule;
        reassigned.push(task);

        events.push({
          eventType: 'PHASE4_TASK_ASSIGNED_SINGLE',
          payload: {
            taskId: task.taskId,
            logisticCode: task.logisticCode,
            cleanerId: singleResult.cleanerId
          }
        });
      } else {
        stillUnassigned.push(task);

        events.push({
          eventType: 'PHASE4_TASK_REMAIN_UNASSIGNED',
          payload: {
            taskId: task.taskId,
            logisticCode: task.logisticCode,
            reason: task.reasonCode || 'NO_VALID_INSERTION'
          }
        });
      }
    }
  }

  return {
    updatedSchedules: schedules,
    reassigned,
    stillUnassigned,
    events
  };
}

async function findBestInsertion(
  task: TaskForRecovery,
  schedules: CleanerSchedule[],
  priorityWindows: PriorityWindows,
  travelProvider: TravelTimeProvider
): Promise<InsertionCandidate | null> {
  let bestCandidate: InsertionCandidate | null = null;

  for (const schedule of schedules) {
    if (schedule.tasks.length === 0) continue;

    for (let pos = 0; pos <= schedule.tasks.length; pos++) {
      const result = await simulateInsertion(task, schedule, pos, priorityWindows, travelProvider);
      
      if (result) {
        const wasUnderfilled = schedule.tasks.length === 1;
        let cost = result.cost;
        let bonusApplied = false;

        if (wasUnderfilled) {
          cost -= UNDERFILLED_BONUS;
          bonusApplied = true;
        }

        if (!bestCandidate || cost < bestCandidate.cost) {
          bestCandidate = {
            cleanerId: schedule.cleanerId,
            position: pos,
            cost,
            newSchedule: result.newSchedule,
            bonusApplied
          };
        }
      }
    }
  }

  return bestCandidate;
}

async function tryAssignAsSingle(
  task: TaskForRecovery,
  schedules: CleanerSchedule[],
  priorityWindows: PriorityWindows,
  travelProvider: TravelTimeProvider
): Promise<InsertionCandidate | null> {
  const emptySchedules = schedules.filter(s => s.tasks.length === 0);
  
  for (const schedule of emptySchedules) {
    const result = await simulateInsertion(task, schedule, 0, priorityWindows, travelProvider);
    if (result) {
      return {
        cleanerId: schedule.cleanerId,
        position: 0,
        cost: result.cost,
        newSchedule: result.newSchedule,
        bonusApplied: false
      };
    }
  }

  for (const schedule of schedules) {
    if (schedule.tasks.length === 0) continue;
    
    const result = await simulateInsertion(task, schedule, schedule.tasks.length, priorityWindows, travelProvider);
    if (result) {
      return {
        cleanerId: schedule.cleanerId,
        position: schedule.tasks.length,
        cost: result.cost,
        newSchedule: result.newSchedule,
        bonusApplied: false
      };
    }
  }

  return null;
}

async function simulateInsertion(
  task: TaskForRecovery,
  schedule: CleanerSchedule,
  position: number,
  priorityWindows: PriorityWindows,
  travelProvider: TravelTimeProvider
): Promise<{ cost: number; newSchedule: ScheduledTask[] } | null> {
  const newTask: ScheduledTask = {
    taskId: task.taskId,
    logisticCode: task.logisticCode,
    lat: task.lat,
    lng: task.lng,
    durationMin: task.durationMin,
    priority: task.priority,
    startMin: 0,
    endMin: 0,
    travelMin: 0
  };

  const newTasks = [...schedule.tasks];
  newTasks.splice(position, 0, newTask);

  let currentTime = schedule.startTimeMin;
  let totalTravel = 0;
  let totalWait = 0;
  let totalPenalty = 0;
  let prevLat = schedule.baseLat;
  let prevLng = schedule.baseLng;

  for (let i = 0; i < newTasks.length; i++) {
    const t = newTasks[i];
    
    const travelMin = await travelProvider.getMinutes(
      { lat: prevLat, lng: prevLng },
      { lat: t.lat, lng: t.lng },
      { phase: 'PHASE4' }
    );

    currentTime += travelMin;
    t.travelMin = travelMin;
    t.startMin = currentTime;
    t.endMin = currentTime + t.durationMin;

    const penaltyResult = priorityPenalty(t.priority, t.startMin, priorityWindows);
    
    if (penaltyResult.violation && penaltyResult.penalty > 100) {
      return null;
    }

    totalTravel += travelMin;
    totalPenalty += penaltyResult.penalty;

    currentTime = t.endMin;
    prevLat = t.lat;
    prevLng = t.lng;
  }

  const cost = totalTravel + totalWait + totalPenalty;

  return { cost, newSchedule: newTasks };
}
