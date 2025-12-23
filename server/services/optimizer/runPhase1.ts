import { v4 as uuidv4 } from 'uuid';
import { generateCandidateGroups, Phase1Params, DEFAULT_PHASE1_PARAMS, Phase1Result as Phase1GeneratorResult } from './phase1';
import { loadTasksForDate, createRun, updateRunStatus, insertDecisionsBatch, groupToDecision, eventToDecision, OptimizerRun } from './db';

export interface Phase1RunResult {
  runId: string;
  workDate: string;
  tasksLoaded: number;
  groupsGenerated: number;
  singleGroupCount: number;
  fallbackSeedCount: number;
  decisionsInserted: number;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
  thresholds: { nearby: number; fallback: number };
}

export async function runPhase1(
  workDate: string, 
  params: Partial<Phase1Params> = {}
): Promise<Phase1RunResult> {
  const startTime = Date.now();
  const runId = uuidv4();
  
  const fullParams: Phase1Params = {
    ...DEFAULT_PHASE1_PARAMS,
    ...params
  };

  const result: Phase1RunResult = {
    runId,
    workDate,
    tasksLoaded: 0,
    groupsGenerated: 0,
    singleGroupCount: 0,
    fallbackSeedCount: 0,
    decisionsInserted: 0,
    durationMs: 0,
    status: 'partial',
    thresholds: {
      nearby: fullParams.nearbySeedMaxMin,
      fallback: fullParams.fallbackSeedMaxMin
    }
  };

  try {
    const run: OptimizerRun = {
      runId,
      workDate,
      algorithmVersion: 'phase1.5-shadow-v1',
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

    const phase1Result: Phase1GeneratorResult = generateCandidateGroups(tasks, fullParams);
    result.groupsGenerated = phase1Result.stats.groupCount;
    result.singleGroupCount = phase1Result.stats.singleGroupCount;
    result.fallbackSeedCount = phase1Result.stats.fallbackSeedCount;

    const groupDecisions = phase1Result.groups.map(g => groupToDecision(runId, g));
    
    const eventDecisions = phase1Result.events
      .filter(e => e.eventType === 'PHASE1_USED_FALLBACK_20')
      .map(e => eventToDecision(runId, e));
    
    const allDecisions = [...groupDecisions, ...eventDecisions];
    result.decisionsInserted = await insertDecisionsBatch(allDecisions);

    const summary = {
      task_count: result.tasksLoaded,
      group_count: result.groupsGenerated,
      single_group_count: result.singleGroupCount,
      fallback_seed_count: result.fallbackSeedCount,
      decisions_inserted: result.decisionsInserted,
      duration_ms: Date.now() - startTime,
      thresholds: result.thresholds
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
    singleGroupCount: number;
    fallbackSeedCount: number;
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
      groupsGenerated: run.summary?.group_count || 0,
      singleGroupCount: run.summary?.single_group_count || 0,
      fallbackSeedCount: run.summary?.fallback_seed_count || 0
    }
  };
}
