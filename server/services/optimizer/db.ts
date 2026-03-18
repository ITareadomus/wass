import pool from '../../../shared/pg-db';
import { TaskInput, Phase1Params, CandidateGroup, Phase1Event } from './phase1';

let planTableEnsured = false;

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

export interface OptimizerUnassigned {
  runId: string;
  taskId: number;
  reasonCode: string;
  details?: Record<string, any>;
}

export interface TaskInputWithLock extends TaskInput {
  locked: boolean;
  lockedReason?: string | null;
}

export async function loadTasksForDate(workDate: string): Promise<TaskInput[]> {
  const result = await pool.query(`
    SELECT 
      task_id as "taskId",
      logistic_code as "logisticCode",
      lat,
      lng,
      priority,
      straordinaria,
      COALESCE(cleaning_time, 60) as "cleaningTimeMinutes"
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
    priority: row.priority,
    straordinaria: row.straordinaria === true,
    cleaningTimeMinutes: parseInt(row.cleaningTimeMinutes, 10) || 60
  }));
}

export async function loadTasksWithLockStatus(workDate: string): Promise<TaskInputWithLock[]> {
  const result = await pool.query(`
    SELECT 
      task_id as "taskId",
      logistic_code as "logisticCode",
      lat,
      lng,
      priority,
      straordinaria,
      COALESCE(cleaning_time, 60) as "cleaningTimeMinutes",
      COALESCE(locked, false) as "locked",
      locked_reason as "lockedReason"
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
    priority: row.priority,
    straordinaria: row.straordinaria === true,
    cleaningTimeMinutes: parseInt(row.cleaningTimeMinutes, 10) || 60,
    locked: row.locked === true,
    lockedReason: row.lockedReason
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
  const payload: Record<string, any> = {
    tasks: group.taskIds,
    logistic_codes: group.logisticCodes,
    zone: group.zone,
    avg_travel_min: group.avgTravelMin,
    max_travel_min: group.maxTravelMin,
    score: group.score,
    seed_task: group.seedTaskId,
    seed_logistic_code: group.seedLogisticCode
  };
  
  if (group.isSingle) {
    payload.is_single = true;
    payload.reason = group.reason;
  }

  if (group.anchoredCleanerId !== undefined) {
    payload.anchored_cleaner_id = group.anchoredCleanerId;
  }
  if (group.timelineTaskIds && group.timelineTaskIds.length > 0) {
    payload.timeline_task_ids = group.timelineTaskIds;
  }
  
  return {
    runId,
    phase: 1,
    eventType: group.isSingle ? 'PHASE1_GROUP_SINGLE_CREATED' : 'PHASE1_GROUP_CANDIDATE',
    payload
  };
}

export function eventToDecision(
  runId: string,
  event: Phase1Event
): OptimizerDecision {
  return {
    runId,
    phase: 1,
    eventType: event.eventType,
    payload: event.payload as Record<string, any>
  };
}

export async function getLatestRunForDate(workDate: string): Promise<OptimizerRun | null> {
  if (!workDate || workDate.trim() === '') return null;
  
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

export async function insertUnassignedBatch(unassigned: OptimizerUnassigned[]): Promise<number> {
  if (unassigned.length === 0) return 0;

  const BATCH_SIZE = 500;
  let inserted = 0;

  for (let i = 0; i < unassigned.length; i += BATCH_SIZE) {
    const batch = unassigned.slice(i, i + BATCH_SIZE);
    
    const values: any[] = [];
    const placeholders: string[] = [];
    
    batch.forEach((u, idx) => {
      const offset = idx * 4;
      placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
      values.push(u.runId, u.taskId, u.reasonCode, u.details ? JSON.stringify(u.details) : null);
    });

    await pool.query(`
      INSERT INTO optimizer.optimizer_unassigned (run_id, task_id, reason_code, details)
      VALUES ${placeholders.join(', ')}
    `, values);

    inserted += batch.length;
  }

  return inserted;
}

export async function deletePhase0Data(runId: string): Promise<{ decisionsDeleted: number; unassignedDeleted: number }> {
  const decisionsResult = await pool.query(`
    DELETE FROM optimizer.optimizer_decision
    WHERE run_id = $1 AND phase = 0 AND event_type = 'PHASE0_TASK_LOCKED'
  `, [runId]);

  const unassignedResult = await pool.query(`
    DELETE FROM optimizer.optimizer_unassigned
    WHERE run_id = $1 AND reason_code = 'LOCKED'
  `, [runId]);

  return {
    decisionsDeleted: decisionsResult.rowCount || 0,
    unassignedDeleted: unassignedResult.rowCount || 0
  };
}

export async function loadLockedCleanerIds(workDate: string): Promise<number[]> {
  const result = await pool.query(
    `
      SELECT cleaner_id
      FROM daily_cleaner_locks
      WHERE work_date = $1 AND is_locked = true
    `,
    [workDate]
  );

  return result.rows
    .map((r: any) => Number(r.cleaner_id))
    .filter((n: number) => Number.isFinite(n));
}

async function ensureOptimizerPlanTable(): Promise<void> {
  if (planTableEnsured) return;

  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS optimizer;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS optimizer.optimizer_plan_for_date (
      work_date date PRIMARY KEY,
      plan_run_id uuid NOT NULL REFERENCES optimizer.optimizer_run(run_id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_optimizer_plan_for_date_run_id
      ON optimizer.optimizer_plan_for_date(plan_run_id);
  `);

  planTableEnsured = true;
}

export async function getPlanRunIdForDate(workDate: string): Promise<string | null> {
  if (!workDate || workDate.trim() === '') return null;
  await ensureOptimizerPlanTable();

  const result = await pool.query<{ plan_run_id: string }>(`
    SELECT plan_run_id
    FROM optimizer.optimizer_plan_for_date
    WHERE work_date = $1
    LIMIT 1
  `, [workDate]);

  if (result.rows.length === 0) return null;
  return result.rows[0].plan_run_id;
}

export async function setPlanRunIdForDate(workDate: string, planRunId: string): Promise<void> {
  if (!workDate || workDate.trim() === '') {
    throw new Error('workDate is required');
  }
  if (!planRunId || planRunId.trim() === '') {
    throw new Error('planRunId is required');
  }

  await ensureOptimizerPlanTable();

  await pool.query(`
    INSERT INTO optimizer.optimizer_plan_for_date (work_date, plan_run_id, updated_at)
    VALUES ($1, $2, now())
    ON CONFLICT (work_date)
    DO UPDATE SET
      plan_run_id = EXCLUDED.plan_run_id,
      updated_at = now()
  `, [workDate, planRunId]);
}
