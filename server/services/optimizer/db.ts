import pool from '../../../shared/pg-db';
import { TaskInput, Phase1Params, CandidateGroup } from './phase1';

export interface OptimizerRun {
  runId: string;
  workDate: string;
  algorithmVersion: string;
  params: Phase1Params;
  status: 'success' | 'partial' | 'failed';
  summary?: Record<string, any>;
}

export interface OptimizerDecision {
  runId: string;
  phase: number;
  eventType: string;
  payload: Record<string, any>;
}

export async function loadTasksForDate(workDate: string): Promise<TaskInput[]> {
  const result = await pool.query(`
    SELECT 
      task_id as "taskId",
      logistic_code as "logisticCode",
      lat,
      lng,
      priority
    FROM daily_containers
    WHERE work_date = $1
      AND lat IS NOT NULL 
      AND lng IS NOT NULL
    ORDER BY task_id
  `, [workDate]);

  return result.rows.map(row => ({
    taskId: row.taskId,
    logisticCode: row.logisticCode,
    lat: parseFloat(row.lat),
    lng: parseFloat(row.lng),
    priority: row.priority
  }));
}

export async function createRun(run: OptimizerRun): Promise<void> {
  await pool.query(`
    INSERT INTO optimizer.optimizer_run (
      run_id, work_date, algorithm_version, params, status, summary
    ) VALUES ($1, $2, $3, $4, $5, $6)
  `, [
    run.runId,
    run.workDate,
    run.algorithmVersion,
    JSON.stringify(run.params),
    run.status,
    run.summary ? JSON.stringify(run.summary) : null
  ]);
}

export async function updateRunStatus(
  runId: string, 
  status: 'success' | 'partial' | 'failed',
  summary?: Record<string, any>
): Promise<void> {
  await pool.query(`
    UPDATE optimizer.optimizer_run 
    SET status = $2, summary = $3
    WHERE run_id = $1
  `, [runId, status, summary ? JSON.stringify(summary) : null]);
}

export async function insertDecisionsBatch(decisions: OptimizerDecision[]): Promise<number> {
  if (decisions.length === 0) return 0;

  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < decisions.length; i += BATCH_SIZE) {
    const batch = decisions.slice(i, i + BATCH_SIZE);
    
    const values: any[] = [];
    const placeholders: string[] = [];
    
    batch.forEach((d, idx) => {
      const offset = idx * 4;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      values.push(d.runId, d.phase, d.eventType, JSON.stringify(d.payload));
    });

    await pool.query(`
      INSERT INTO optimizer.optimizer_decision (run_id, phase, event_type, payload)
      VALUES ${placeholders.join(', ')}
    `, values);

    inserted += batch.length;
  }

  return inserted;
}

export function groupToDecision(
  runId: string,
  group: CandidateGroup
): OptimizerDecision {
  return {
    runId,
    phase: 1,
    eventType: 'PHASE1_GROUP_CANDIDATE',
    payload: {
      tasks: group.taskIds,
      logistic_codes: group.logisticCodes,
      zone: group.zone,
      avg_travel_min: group.avgTravelMin,
      max_travel_min: group.maxTravelMin,
      score: group.score,
      seed_task: group.seedTaskId,
      seed_logistic_code: group.seedLogisticCode
    }
  };
}

export async function getLatestRunForDate(workDate: string): Promise<OptimizerRun | null> {
  const result = await pool.query(`
    SELECT 
      run_id as "runId",
      work_date as "workDate",
      algorithm_version as "algorithmVersion",
      params,
      status,
      summary
    FROM optimizer.optimizer_run
    WHERE work_date = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [workDate]);

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    runId: row.runId,
    workDate: row.workDate,
    algorithmVersion: row.algorithmVersion,
    params: row.params,
    status: row.status,
    summary: row.summary
  };
}

export async function getDecisionsForRun(runId: string, phase?: number): Promise<OptimizerDecision[]> {
  let query = `
    SELECT run_id as "runId", phase, event_type as "eventType", payload
    FROM optimizer.optimizer_decision
    WHERE run_id = $1
  `;
  const params: any[] = [runId];

  if (phase !== undefined) {
    query += ` AND phase = $2`;
    params.push(phase);
  }

  query += ` ORDER BY id`;

  const result = await pool.query(query, params);
  return result.rows;
}
