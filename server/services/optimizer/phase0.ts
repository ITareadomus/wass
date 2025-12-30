import { TaskInputWithLock, OptimizerDecision, OptimizerUnassigned } from './db';

export interface Phase0Context {
  workDate: string;
  runId: string;
}

export interface Phase0Result {
  unlockedTasks: TaskInputWithLock[];
  lockedTasks: TaskInputWithLock[];
  decisionEvents: OptimizerDecision[];
  unassignedRows: OptimizerUnassigned[];
}

export function filterLockedTasks(
  tasks: TaskInputWithLock[],
  ctx: Phase0Context
): Phase0Result {
  const lockedTasks: TaskInputWithLock[] = [];
  const unlockedTasks: TaskInputWithLock[] = [];

  for (const task of tasks) {
    if (task.locked === true) {
      lockedTasks.push(task);
    } else {
      unlockedTasks.push(task);
    }
  }

  const decisionEvents: OptimizerDecision[] = lockedTasks.map(task => ({
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
  }));

  const unassignedRows: OptimizerUnassigned[] = lockedTasks.map(task => ({
    runId: ctx.runId,
    taskId: task.taskId,
    reasonCode: 'LOCKED',
    details: {
      logistic_code: task.logisticCode,
      priority: task.priority,
      locked_reason: task.lockedReason || null,
      work_date: ctx.workDate
    }
  }));

  return {
    unlockedTasks,
    lockedTasks,
    decisionEvents,
    unassignedRows
  };
}
