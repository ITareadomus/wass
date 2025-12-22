import { v4 as uuidv4 } from 'uuid';
import { generateCandidateGroups, Phase1Params, DEFAULT_PHASE1_PARAMS, CandidateGroup } from './phase1';
import { loadTasksForDate, createRun, updateRunStatus, insertDecisionsBatch, groupToDecision, OptimizerRun } from './db';

export interface Phase1Result {
  runId: string;
  workDate: string;
  tasksLoaded: number;
  groupsGenerated: number;
  decisionsInserted: number;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
}

export async function runPhase1(
  workDate: string, 
  params: Partial<Phase1Params> = {}
): Promise<Phase1Result> {
  const startTime = Date.now();
  const runId = uuidv4();
  
  const fullParams: Phase1Params = {
    ...DEFAULT_PHASE1_PARAMS,
    ...params
  };

  const result: Phase1Result = {
    runId,
    workDate,
    tasksLoaded: 0,
    groupsGenerated: 0,
    decisionsInserted: 0,
    durationMs: 0,
    status: 'partial'
  };

  try {
    const run: OptimizerRun = {
      runId,
      workDate,
      algorithmVersion: 'phase1-shadow-v1',
      params: fullParams,
      status: 'partial'
    };
    await createRun(run);

    const tasks = await loadTasksForDate(workDate);
    result.tasksLoaded = tasks.length;

    if (tasks.length === 0) {
      result.status = 'failed';
      result.error = 'No tasks found for date';
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const groups: CandidateGroup[] = generateCandidateGroups(tasks, fullParams);
    result.groupsGenerated = groups.length;

    const decisions = groups.map(g => groupToDecision(runId, g));
    result.decisionsInserted = await insertDecisionsBatch(decisions);

    const summary = {
      tasks_loaded: result.tasksLoaded,
      groups_generated: result.groupsGenerated,
      decisions_inserted: result.decisionsInserted,
      duration_ms: Date.now() - startTime
    };

    result.status = 'success';
    await updateRunStatus(runId, 'success', summary);

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message || 'Unknown error';
    
    try {
      await updateRunStatus(runId, 'failed', { error: result.error });
    } catch (updateError) {
      console.error('Failed to update run status:', updateError);
    }
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

export async function getPhase1Stats(workDate: string): Promise<{
  hasRun: boolean;
  latestRun?: {
    runId: string;
    status: string;
    groupsGenerated: number;
    createdAt?: string;
  };
}> {
  const { getLatestRunForDate } = await import('./db');
  const run = await getLatestRunForDate(workDate);
  
  if (!run) {
    return { hasRun: false };
  }

  return {
    hasRun: true,
    latestRun: {
      runId: run.runId,
      status: run.status,
      groupsGenerated: run.summary?.groups_generated || 0
    }
  };
}
