import { 
  loadTasksWithLockStatus, 
  insertDecisionsBatch, 
  insertUnassignedBatch,
  deletePhase0Data,
  updateRunStatus,
  TaskInputWithLock
} from './db';
import { filterLockedTasks, Phase0Result } from './phase0';
import { buildTimelineContext, TimelineContext } from './timelineContext';

export interface Phase0RunResult {
  runId: string;
  workDate: string;
  totalTasks: number;
  lockedTasks: number;
  alreadyOnTimelineTasks: number;
  unlockedTasks: number;
  decisionsInserted: number;
  unassignedInserted: number;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
  unlockedTaskData: TaskInputWithLock[];
  timelineContext: TimelineContext;
}

export async function runPhase0(
  workDate: string,
  runId: string
): Promise<Phase0RunResult> {
  const startTime = Date.now();

  const timelineContext = await buildTimelineContext(workDate);
  
  const result: Phase0RunResult = {
    runId,
    workDate,
    totalTasks: 0,
    lockedTasks: 0,
    alreadyOnTimelineTasks: 0,
    unlockedTasks: 0,
    decisionsInserted: 0,
    unassignedInserted: 0,
    durationMs: 0,
    status: 'partial',
    unlockedTaskData: [],
    timelineContext
  };

  try {
    console.log(`[Phase0] Starting for workDate=${workDate}, runId=${runId}`);
    console.log(`[Phase0.A] Timeline context: ${timelineContext.alreadyOnTimelineTaskIds.size} tasks already on timeline`);

    const deletedData = await deletePhase0Data(runId);
    if (deletedData.decisionsDeleted > 0 || deletedData.unassignedDeleted > 0) {
      console.log(`[Phase0] Idempotency: deleted ${deletedData.decisionsDeleted} decisions, ${deletedData.unassignedDeleted} unassigned`);
    }

    const tasks = await loadTasksWithLockStatus(workDate);
    result.totalTasks = tasks.length;

    if (tasks.length === 0) {
      console.log(`[Phase0] No tasks found for date ${workDate}`);
      result.status = 'success';
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const phase0Result: Phase0Result = filterLockedTasks(tasks, { workDate, runId, timelineContext });

    result.lockedTasks = phase0Result.lockedTasks.length;
    result.alreadyOnTimelineTasks = phase0Result.alreadyOnTimelineTasks.length;
    result.unlockedTasks = phase0Result.unlockedTasks.length;
    result.unlockedTaskData = phase0Result.unlockedTasks;

    console.log(`[Phase0.B] Total: ${result.totalTasks}, Locked: ${result.lockedTasks}, AlreadyOnTimeline: ${result.alreadyOnTimelineTasks}, Unlocked: ${result.unlockedTasks}`);

    if (phase0Result.decisionEvents.length > 0) {
      result.decisionsInserted = await insertDecisionsBatch(phase0Result.decisionEvents);
      console.log(`[Phase0] Inserted ${result.decisionsInserted} decision events`);
    }

    if (phase0Result.unassignedRows.length > 0) {
      result.unassignedInserted = await insertUnassignedBatch(phase0Result.unassignedRows);
      console.log(`[Phase0] Inserted ${result.unassignedInserted} unassigned records`);
    }

    result.status = 'success';

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message || 'Unknown error in Phase0';
    console.error(`[Phase0] Error:`, error);

    try {
      await updateRunStatus(runId, 'failed', { phase0_error: result.error });
    } catch (updateError) {
      console.error('[Phase0] Failed to update run status:', updateError);
    }
  }

  result.durationMs = Date.now() - startTime;
  console.log(`[Phase0] Completed in ${result.durationMs}ms`);
  return result;
}

export function getPhase0Summary(result: Phase0RunResult): Record<string, any> {
  return {
    phase: 0,
    total_tasks: result.totalTasks,
    locked_tasks: result.lockedTasks,
    already_on_timeline_tasks: result.alreadyOnTimelineTasks,
    unlocked_tasks: result.unlockedTasks,
    decisions_inserted: result.decisionsInserted,
    unassigned_inserted: result.unassignedInserted,
    duration_ms: result.durationMs,
    status: result.status,
    error: result.error
  };
}
