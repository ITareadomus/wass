import { v4 as uuidv4 } from 'uuid';
import pool from '../../../shared/pg-db';
import { runPhase0, Phase0RunResult } from './runPhase0';
import { runPhase1, Phase1RunResult } from './runPhase1';
import { runPhase2, Phase2RunResult } from './runPhase2';
import { runPhase3, Phase3RunResult } from './runPhase3';
import { runPhase4, Phase4RunResult } from './runPhase4';
import { createRun, updateRunStatus, OptimizerRun } from './db';
import { DEFAULT_PHASE1_PARAMS } from './phase1';

export interface AllPhasesRunResult {
  runId: string;
  workDate: string;
  totalDurationMs: number;
  status: 'success' | 'partial' | 'failed';
  error?: string;
  phase0: Phase0RunResult | null;
  phase1: Phase1RunResult | null;
  phase2: Phase2RunResult | null;
  phase3: Phase3RunResult | null;
  phase4: Phase4RunResult | null;
  summary: {
    totalTasksProcessed: number;
    tasksAssigned: number;
    tasksUnassigned: number;
    cleanersUsed: number;
  };
}

export interface RunAllPhasesOptions {
  skipPhase4?: boolean;
  applyToProduction?: boolean;
}

export async function runAllPhases(
  workDate: string,
  options: RunAllPhasesOptions = {}
): Promise<AllPhasesRunResult> {
  const startTime = Date.now();
  const runId = uuidv4();
  const { skipPhase4 = false, applyToProduction = false } = options;

  const result: AllPhasesRunResult = {
    runId,
    workDate,
    totalDurationMs: 0,
    status: 'partial',
    phase0: null,
    phase1: null,
    phase2: null,
    phase3: null,
    phase4: null,
    summary: {
      totalTasksProcessed: 0,
      tasksAssigned: 0,
      tasksUnassigned: 0,
      cleanersUsed: 0
    }
  };

  try {
    console.log(`[runAllPhases] Starting complete optimization for ${workDate}, runId=${runId}`);

    const run: OptimizerRun = {
      runId,
      workDate,
      algorithmVersion: 'v2.0-full',
      params: DEFAULT_PHASE1_PARAMS,
      status: 'partial'
    };
    await createRun(run);

    console.log(`[runAllPhases] === PHASE 0: Locked Task Filter ===`);
    result.phase0 = await runPhase0(workDate, runId);
    if (result.phase0.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 0 failed: ${result.phase0.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 0 complete: ${result.phase0.unlockedTasks} unlocked tasks`);

    console.log(`[runAllPhases] === PHASE 1: Candidate Group Generation ===`);
    result.phase1 = await runPhase1(workDate, {
      existingRunId: runId,
      preFilteredTasks: result.phase0.unlockedTaskData
    });
    if (result.phase1.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 1 failed: ${result.phase1.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 1 complete: ${result.phase1.groupsGenerated} groups generated`);

    console.log(`[runAllPhases] === PHASE 2: Cleaner Assignment ===`);
    result.phase2 = await runPhase2(workDate, runId);
    if (result.phase2.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 2 failed: ${result.phase2.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 2 complete: ${result.phase2.groupsAssigned} groups assigned`);

    console.log(`[runAllPhases] === PHASE 3: Scheduling ===`);
    result.phase3 = await runPhase3(workDate, runId);
    if (result.phase3.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 3 failed: ${result.phase3.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 3 complete: ${result.phase3.tasksScheduled} tasks scheduled`);

    if (!skipPhase4) {
      console.log(`[runAllPhases] === PHASE 4: Recovery ===`);
      result.phase4 = await runPhase4(workDate, runId);
      if (result.phase4.status === 'failed') {
        console.warn(`[runAllPhases] Phase 4 failed (non-critical): ${result.phase4.error}`);
      } else {
        console.log(`[runAllPhases] Phase 4 complete: ${result.phase4.singleAssignedCount} tasks recovered`);
      }
    }

    const assignmentCount = await pool.query(`
      SELECT COUNT(DISTINCT task_id) as count FROM optimizer.optimizer_assignment WHERE run_id = $1
    `, [runId]);
    const unassignedCount = await pool.query(`
      SELECT COUNT(*) as count FROM optimizer.optimizer_unassigned WHERE run_id = $1
    `, [runId]);
    const cleanerCount = await pool.query(`
      SELECT COUNT(DISTINCT cleaner_id) as count FROM optimizer.optimizer_assignment WHERE run_id = $1
    `, [runId]);

    result.summary = {
      totalTasksProcessed: result.phase0?.totalTasks || 0,
      tasksAssigned: parseInt(assignmentCount.rows[0]?.count || '0'),
      tasksUnassigned: parseInt(unassignedCount.rows[0]?.count || '0'),
      cleanersUsed: parseInt(cleanerCount.rows[0]?.count || '0')
    };

    if (applyToProduction) {
      console.log(`[runAllPhases] === APPLYING TO PRODUCTION ===`);
      const applyResult = await applyOptimizerToProduction(runId, workDate);
      console.log(`[runAllPhases] Applied ${applyResult.insertedCount} assignments to production`);
    }

    result.status = 'success';
    await updateRunStatus(runId, 'success', result.summary);

  } catch (error: any) {
    result.status = 'failed';
    result.error = error.message;
    console.error(`[runAllPhases] Error:`, error);
    await updateRunStatus(runId, 'failed', { error: result.error });
  }

  result.totalDurationMs = Date.now() - startTime;
  console.log(`[runAllPhases] Complete in ${result.totalDurationMs}ms - Status: ${result.status}`);
  
  return result;
}

export interface ApplyToProductionResult {
  runId: string;
  workDate: string;
  insertedCount: number;
  deletedCount: number;
  success: boolean;
  error?: string;
}

export async function applyOptimizerToProduction(
  runId: string,
  workDate: string
): Promise<ApplyToProductionResult> {
  const result: ApplyToProductionResult = {
    runId,
    workDate,
    insertedCount: 0,
    deletedCount: 0,
    success: false
  };

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    const deleteResult = await client.query(`
      DELETE FROM daily_assignments_current 
      WHERE work_date = $1 
        AND task_id NOT IN (
          SELECT task_id FROM daily_task_locks 
          WHERE work_date = $1 AND locked = true
        )
    `, [workDate]);
    result.deletedCount = deleteResult.rowCount || 0;
    console.log(`[applyToProduction] Deleted ${result.deletedCount} existing non-locked assignments`);

    const insertQuery = `
      INSERT INTO daily_assignments_current (
        work_date, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time
      )
      SELECT 
        $2 as work_date,
        oa.cleaner_id,
        oa.task_id,
        oa.logistic_code,
        dc.client_id,
        dc.premium,
        dc.address,
        dc.lat,
        dc.lng,
        dc.cleaning_time,
        dc.checkin_date,
        dc.checkout_date,
        dc.checkin_time,
        dc.checkout_time,
        dc.pax_in,
        dc.pax_out,
        dc.small_equipment,
        dc.operation_id,
        dc.confirmed_operation,
        dc.straordinaria,
        dc.type_apt,
        dc.alias,
        dc.customer_name,
        oa.reasons,
        oa.priority_type as priority,
        oa.start_time::time as start_time,
        oa.end_time::time as end_time,
        false as followup,
        oa.sequence,
        COALESCE(oa.travel_minutes_from_prev, 0) as travel_time
      FROM optimizer.optimizer_assignment oa
      JOIN daily_containers dc ON dc.task_id = oa.task_id AND dc.work_date = $2
      WHERE oa.run_id = $1
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_task_locks 
          WHERE work_date = $2 AND locked = true
        )
    `;

    const insertResult = await client.query(insertQuery, [runId, workDate]);
    result.insertedCount = insertResult.rowCount || 0;
    console.log(`[applyToProduction] Inserted ${result.insertedCount} new assignments`);

    await client.query(`
      INSERT INTO daily_assignments_history (
        work_date, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time,
        action_type, action_reason, performed_by
      )
      SELECT 
        work_date, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time,
        'OPTIMIZER_ASSIGN',
        'Applied from optimizer run ' || $1,
        'optimizer'
      FROM daily_assignments_current
      WHERE work_date = $2
    `, [runId, workDate]);

    await client.query('COMMIT');
    result.success = true;

  } catch (error: any) {
    await client.query('ROLLBACK');
    result.success = false;
    result.error = error.message;
    console.error(`[applyToProduction] Error:`, error);
  } finally {
    client.release();
  }

  return result;
}
