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
  priority?: 'early-out' | 'high' | 'low'; // Filter to only process tasks of this priority
}

export async function runAllPhases(
  workDate: string,
  options: RunAllPhasesOptions = {}
): Promise<AllPhasesRunResult> {
  const startTime = Date.now();
  const runId = uuidv4();
  const { skipPhase4 = false, applyToProduction = false, priority } = options;

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
    if (priority) {
      console.log(`[runAllPhases] Filtering by priority: ${priority}`);
    }
    result.phase0 = await runPhase0(workDate, runId, { priority });
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
        priority, start_time, end_time, followup, sequence, travel_time,
        cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time,
        customer_reference, base_cleaning_time
      )
      SELECT 
        $2 as work_date,
        oa.cleaner_id,
        oa.task_id,
        oa.logistic_code,
        dc.client_id,
        dc.premium,
        dc.address,
        dc.lat::numeric,
        dc.lng::numeric,
        dc.cleaning_time::integer,
        dc.checkin_date::date,
        dc.checkout_date::date,
        dc.checkin_time::time,
        dc.checkout_time::time,
        dc.pax_in::integer,
        dc.pax_out::integer,
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
        COALESCE(oa.travel_minutes_from_prev, 0) as travel_time,
        c.name as cleaner_name,
        c.lastname as cleaner_lastname,
        c.role as cleaner_role,
        false as cleaner_premium,
        COALESCE(c.start_time, '10:00') as cleaner_start_time,
        dc.customer_reference,
        dc.cleaning_time as base_cleaning_time
      FROM optimizer.optimizer_assignment oa
      JOIN daily_containers dc ON dc.task_id = oa.task_id AND dc.work_date = $2
      LEFT JOIN cleaners c ON c.cleaner_id = oa.cleaner_id AND c.work_date = $2
      WHERE oa.run_id = $1
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_task_locks 
          WHERE work_date = $2 AND locked = true
        )
    `;

    const insertResult = await client.query(insertQuery, [runId, workDate]);
    result.insertedCount = insertResult.rowCount || 0;
    console.log(`[applyToProduction] Inserted ${result.insertedCount} new assignments`);

    // Get next revision number for history
    const revisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_history WHERE work_date = $1`,
      [workDate]
    );
    const nextRevision = revisionResult.rows[0].next_revision;
    
    await client.query(`
      INSERT INTO daily_assignments_history (
        work_date, revision, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time,
        created_by
      )
      SELECT 
        work_date, $3, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time,
        'optimizer-' || $1
      FROM daily_assignments_current
      WHERE work_date = $2
    `, [runId, workDate, nextRevision]);

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

export interface ApplyWaveResult {
  runId: string;
  workDate: string;
  wave: 'EO' | 'HP' | 'LP';
  insertedCount: number;
  skippedCount: number;
  success: boolean;
  error?: string;
}

export async function applyOptimizerWaveToProduction(
  runId: string,
  workDate: string,
  wave: 'EO' | 'HP' | 'LP'
): Promise<ApplyWaveResult> {
  // Map wave to priority_type used in optimizer_assignment
  const priorityMap: Record<string, string> = {
    'EO': 'early-out',
    'HP': 'high',
    'LP': 'low'
  };
  const priorityType = priorityMap[wave];

  const result: ApplyWaveResult = {
    runId,
    workDate,
    wave,
    insertedCount: 0,
    skippedCount: 0,
    success: false
  };

  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');

    // Validate runId belongs to the specified workDate
    const runValidation = await client.query(`
      SELECT work_date FROM optimizer.optimizer_run WHERE run_id = $1
    `, [runId]);
    
    if (runValidation.rows.length === 0) {
      result.error = `Run ${runId} not found`;
      await client.query('ROLLBACK');
      return result;
    }
    
    const runWorkDate = runValidation.rows[0].work_date;
    if (runWorkDate !== workDate) {
      result.error = `Run ${runId} is for date ${runWorkDate}, not ${workDate}`;
      await client.query('ROLLBACK');
      return result;
    }

    // Count how many tasks of this wave exist in optimizer_assignment
    const countResult = await client.query(`
      SELECT COUNT(*) as total FROM optimizer.optimizer_assignment 
      WHERE run_id = $1 AND priority_type = $2
    `, [runId, priorityType]);
    const totalInWave = parseInt(countResult.rows[0]?.total || '0');

    // INSERT only tasks of this wave that are NOT already in daily_assignments_current
    // This is the key: non-destructive, incremental INSERT
    const insertQuery = `
      INSERT INTO daily_assignments_current (
        work_date, cleaner_id, task_id, logistic_code, client_id,
        premium, address, lat, lng, cleaning_time,
        checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
        type_apt, alias, customer_name, reasons,
        priority, start_time, end_time, followup, sequence, travel_time,
        cleaner_name, cleaner_lastname, cleaner_role, cleaner_premium, cleaner_start_time,
        customer_reference, base_cleaning_time
      )
      SELECT 
        $2 as work_date,
        oa.cleaner_id,
        oa.task_id,
        oa.logistic_code,
        dc.client_id,
        dc.premium,
        dc.address,
        dc.lat::numeric,
        dc.lng::numeric,
        dc.cleaning_time::integer,
        dc.checkin_date::date,
        dc.checkout_date::date,
        dc.checkin_time::time,
        dc.checkout_time::time,
        dc.pax_in::integer,
        dc.pax_out::integer,
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
        COALESCE(oa.travel_minutes_from_prev, 0) as travel_time,
        c.name as cleaner_name,
        c.lastname as cleaner_lastname,
        c.role as cleaner_role,
        false as cleaner_premium,
        COALESCE(c.start_time, '10:00') as cleaner_start_time,
        dc.customer_reference,
        dc.cleaning_time as base_cleaning_time
      FROM optimizer.optimizer_assignment oa
      JOIN daily_containers dc ON dc.task_id = oa.task_id AND dc.work_date = $2
      LEFT JOIN cleaners c ON c.cleaner_id = oa.cleaner_id AND c.work_date = $2
      WHERE oa.run_id = $1
        AND oa.priority_type = $3
        AND NOT EXISTS (
          SELECT 1 FROM daily_assignments_current dac 
          WHERE dac.task_id = oa.task_id AND dac.work_date = $2
        )
    `;

    const insertResult = await client.query(insertQuery, [runId, workDate, priorityType]);
    result.insertedCount = insertResult.rowCount || 0;
    result.skippedCount = totalInWave - result.insertedCount;
    
    console.log(`[applyWaveToProduction] Wave ${wave}: Inserted ${result.insertedCount}, Skipped ${result.skippedCount} (already in timeline)`);

    // Only save to history if we actually inserted something
    if (result.insertedCount > 0) {
      const revisionResult = await client.query(
        `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_history WHERE work_date = $1`,
        [workDate]
      );
      const nextRevision = revisionResult.rows[0].next_revision;
      
      await client.query(`
        INSERT INTO daily_assignments_history (
          work_date, revision, cleaner_id, task_id, logistic_code, client_id,
          premium, address, lat, lng, cleaning_time,
          checkin_date, checkout_date, checkin_time, checkout_time,
          pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
          type_apt, alias, customer_name, reasons,
          priority, start_time, end_time, followup, sequence, travel_time,
          created_by
        )
        SELECT 
          work_date, $3, cleaner_id, task_id, logistic_code, client_id,
          premium, address, lat, lng, cleaning_time,
          checkin_date, checkout_date, checkin_time, checkout_time,
          pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria,
          type_apt, alias, customer_name, reasons,
          priority, start_time, end_time, followup, sequence, travel_time,
          'optimizer-wave-' || $4 || '-' || $1
        FROM daily_assignments_current
        WHERE work_date = $2
      `, [runId, workDate, nextRevision, wave]);
      
      console.log(`[applyWaveToProduction] Saved history revision ${nextRevision}`);
    } else {
      console.log(`[applyWaveToProduction] Skipping history - no new rows inserted`);
    }

    await client.query('COMMIT');
    result.success = true;

  } catch (error: any) {
    await client.query('ROLLBACK');
    result.success = false;
    result.error = error.message;
    console.error(`[applyWaveToProduction] Error:`, error);
  } finally {
    client.release();
  }

  return result;
}
