import { TaskInputWithLock, OptimizerDecision, OptimizerUnassigned } from './db';
import { TimelineContext } from './timelineContext';

export interface Phase0Context {
  workDate: string;
  runId: string;
  timelineContext?: TimelineContext;
}

export interface Phase0Result {
  unlockedTasks: TaskInputWithLock[];
  lockedTasks: TaskInputWithLock[];
  alreadyOnTimelineTasks: TaskInputWithLock[];
  decisionEvents: OptimizerDecision[];
  unassignedRows: OptimizerUnassigned[];
}

export function filterLockedTasks(
  tasks: TaskInputWithLock[],
  ctx: Phase0Context
): Phase0Result {
  const lockedTasks: TaskInputWithLock[] = [];
  const alreadyOnTimelineTasks: TaskInputWithLock[] = [];
  const unlockedTasks: TaskInputWithLock[] = [];

  const alreadyOnTimeline = ctx.timelineContext?.alreadyOnTimelineTaskIds ?? new Set<string>();

  for (const task of tasks) {
    if (task.locked === true) {
      lockedTasks.push(task);
    } else if (alreadyOnTimeline.has(String(task.taskId))) {
      alreadyOnTimelineTasks.push(task);
    } else {
      unlockedTasks.push(task);
    }
  }

  const decisionEvents: OptimizerDecision[] = [];
  const unassignedRows: OptimizerUnassigned[] = [];

  for (const task of lockedTasks) {
    decisionEvents.push({
      runId: ctx.runId,
      phase: 0,
      eventType: 'PHASE0_TASK_LOCKED',
      payload: {
        task_id: task.taskId,
        logistic_code: task.logisticCode,
        priority: task.priority,
        locked_reason: task.lockedReason || null,
        work_date: ctx.workDate
      }
    });
    unassignedRows.push({
      runId: ctx.runId,
      taskId: task.taskId,
      reasonCode: 'LOCKED',
      details: {
        logistic_code: task.logisticCode,
        priority: task.priority,
        locked_reason: task.lockedReason || null,
        work_date: ctx.workDate
      }
    });
  }

  for (const task of alreadyOnTimelineTasks) {
    decisionEvents.push({
      runId: ctx.runId,
      phase: 0,
      eventType: 'PHASE0_TASK_ALREADY_ON_TIMELINE',
      payload: {
        task_id: task.taskId,
        logistic_code: task.logisticCode,
        priority: task.priority,
        work_date: ctx.workDate
      }
    });
  }

  return {
    unlockedTasks,
    lockedTasks,
    alreadyOnTimelineTasks,
    decisionEvents,
    unassignedRows
  };
}
