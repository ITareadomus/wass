import { v4 as uuidv4 } from 'uuid';
import pool from '../../../shared/pg-db';
import { runPhase0, Phase0RunResult } from './runPhase0';
import { runPhase1, Phase1RunResult } from './runPhase1';
import { runPhase2, Phase2RunResult } from './runPhase2';
import { runPhase3, Phase3RunResult } from './runPhase3';
import { runPhase4, Phase4RunResult } from './runPhase4';
import { createRun, updateRunStatus, OptimizerRun } from './db';
import { DEFAULT_PHASE1_PARAMS } from './phase1';
import { calculateDynamicLimits } from './phase2';
import path from 'path';

export interface UnassignedBreakdown {
  taskId: number;
  logisticCode: number;
  isStraordinaria: boolean;
  reason: string;
  compatibleCleanersCount: number;
}

type PythonRecalcTask = {
  task_id: number;
  logistic_code: number;
  sequence: number;
  cleaning_time: number;
  address: string | null;
  lat: number | string | null;
  lng: number | string | null;
  start_time: string | null;
  end_time: string | null;
  travel_time: number | null;
};

async function recalculateCleanerTimesViaPython(cleanerData: any): Promise<any> {
  const { spawn } = await import('child_process');

  return await new Promise((resolve, reject) => {
    const scriptPath = path.join(process.cwd(), 'client/public/scripts/recalculate_times.py');
    const cleanerDataJson = JSON.stringify(cleanerData);

    const pythonProcess = spawn('python3', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    pythonProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Python script exited with code ${code}: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout);
        if (!result.success) {
          reject(new Error(result.error || 'Unknown error from Python script'));
          return;
        }
        resolve(result.cleaner_data);
      } catch (parseError: any) {
        reject(new Error(`Failed to parse Python output: ${parseError.message}`));
      }
    });

    pythonProcess.on('error', (error) => {
      reject(new Error(`Failed to spawn Python process: ${error.message}`));
    });

    try {
      pythonProcess.stdin.write(cleanerDataJson);
      pythonProcess.stdin.end();
    } catch (writeError: any) {
      reject(new Error(`Failed to write to Python process: ${writeError.message}`));
    }
  });
}

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
  metrics: {
    totalTasks: number;
    assignedTasks: number;
    unassignedTasks: number;
    otTotal: number;
    otAssigned: number;
    otUnassigned: number;
    unassignedByReason: Record<string, number>;
    unassignedDetails: UnassignedBreakdown[];
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
    },
    metrics: {
      totalTasks: 0,
      assignedTasks: 0,
      unassignedTasks: 0,
      otTotal: 0,
      otAssigned: 0,
      otUnassigned: 0,
      unassignedByReason: {},
      unassignedDetails: []
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

    const cleanersRes = await pool.query<{ cleaners: number[] }>(
      `SELECT cleaners FROM daily_selected_cleaners WHERE work_date = $1`,
      [workDate]
    );
    const numCleaners = cleanersRes.rows[0]?.cleaners?.length || 1;
    const totalTasks = result.phase0.unlockedTasks;
    const dynamicLimits = calculateDynamicLimits(totalTasks, numCleaners);

    const mergeMode = (result.phase0?.timelineContext?.alreadyOnTimelineTaskIds?.size ?? 0) > 0;
    if (mergeMode) {
      console.log(`[runAllPhases] MERGE MODE (append-only): preserving existing timeline, assigning remaining tasks after anchors`);

      // In MERGE append-only we skip phases 1-3 (which may insert before/around fixed blocks)
      // and directly use Phase 4 algorithm with append-only + anchorTask support.
      result.phase1 = null;
      result.phase2 = null;
      result.phase3 = null;

      if (!skipPhase4) {
        console.log(`[runAllPhases] === PHASE 4 (MERGE APPEND-ONLY): Assignment ===`);
        result.phase4 = await runPhase4(workDate, runId, {
          params: {
            dynamicMaxTasks: dynamicLimits.baseMax,
            appendOnly: true
          },
          timelineContext: result.phase0?.timelineContext
        });
        if (result.phase4.status === 'failed') {
          console.warn(`[runAllPhases] Phase 4 failed (non-critical): ${result.phase4.error}`);
        } else {
          console.log(`[runAllPhases] Phase 4 complete: inserted=${result.phase4.insertedCount}, single=${result.phase4.singleAssignedCount}, remaining=${result.phase4.remainUnassignedCount}`);
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
        totalTasksProcessed: result.phase0?.unlockedTasks || 0,
        tasksAssigned: parseInt(assignmentCount.rows[0]?.count || '0'),
        tasksUnassigned: parseInt(unassignedCount.rows[0]?.count || '0'),
        cleanersUsed: parseInt(cleanerCount.rows[0]?.count || '0')
      };

      // === METRICHE DETTAGLIATE ===
      await collectDetailedMetrics(runId, workDate, result);

      if (applyToProduction) {
        console.log(`[runAllPhases] === APPLYING TO PRODUCTION ===`);
        const applyResult = await applyOptimizerToProduction(runId, workDate);
        console.log(`[runAllPhases] Applied ${applyResult.insertedCount} assignments to production`);
      }

      result.status = 'success';
      await updateRunStatus(runId, 'success', result.summary);

      result.totalDurationMs = Date.now() - startTime;
      console.log(`[runAllPhases] Complete in ${result.totalDurationMs}ms - Status: ${result.status}`);
      return result;
    }
    
    // Phase 1: usa maxGroupSize = baseMax + 1 per permettere gruppi più grandi
    // Il bonus travel viene applicato per-cleaner in Phase 2/4
    const phase1MaxGroupSize = dynamicLimits.baseMax + 1;
    
    console.log(`[runAllPhases] Dynamic limits: ${totalTasks} tasks / ${numCleaners} cleaners = baseMax=${dynamicLimits.baseMax}, phase1MaxGroup=${phase1MaxGroupSize}`);

    console.log(`[runAllPhases] === PHASE 1: Candidate Group Generation ===`);
    result.phase1 = await runPhase1(workDate, {
      existingRunId: runId,
      preFilteredTasks: result.phase0.unlockedTaskData,
      params: {
        minGroupSize: dynamicLimits.minTasks,
        maxGroupSize: phase1MaxGroupSize
      }
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
    // Passa baseMax - il bonus travel (+1) viene applicato per-cleaner basato su avgTravel ≤ 10min
    // Passa timelineContext per fairness scoring (pre-existing load)
    result.phase2 = await runPhase2(workDate, runId, { 
      params: { dynamicMaxTasks: dynamicLimits.baseMax },
      timelineContext: result.phase0?.timelineContext
    });
    if (result.phase2.status === 'failed') {
      result.status = 'failed';
      result.error = `Phase 2 failed: ${result.phase2.error}`;
      await updateRunStatus(runId, 'failed', { error: result.error });
      result.totalDurationMs = Date.now() - startTime;
      return result;
    }
    console.log(`[runAllPhases] Phase 2 complete: ${result.phase2.groupsAssigned} groups assigned`);

    console.log(`[runAllPhases] === PHASE 3: Scheduling ===`);
    // Passa timelineContext per collision avoidance (occupiedBlocks)
    result.phase3 = await runPhase3(workDate, runId, { 
      timelineContext: result.phase0?.timelineContext 
    });
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
      // Passa baseMax - il bonus travel (+1) viene applicato per-cleaner basato su avgTravel ≤ 10min
      // Passa timelineContext per recovery constraints
      result.phase4 = await runPhase4(workDate, runId, { 
        params: { dynamicMaxTasks: dynamicLimits.baseMax },
        timelineContext: result.phase0?.timelineContext
      });
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
      totalTasksProcessed: result.phase0?.unlockedTasks || 0,  // Use unlockedTasks (excludes locked)
      tasksAssigned: parseInt(assignmentCount.rows[0]?.count || '0'),
      tasksUnassigned: parseInt(unassignedCount.rows[0]?.count || '0'),
      cleanersUsed: parseInt(cleanerCount.rows[0]?.count || '0')
    };

    // === METRICHE DETTAGLIATE ===
    await collectDetailedMetrics(runId, workDate, result);

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

async function collectDetailedMetrics(
  runId: string,
  workDate: string,
  result: AllPhasesRunResult
): Promise<void> {
  try {
    // Query per contare OT totali, assegnate e non assegnate
    const otStats = await pool.query(`
      WITH all_tasks AS (
        SELECT DISTINCT task_id, 
          COALESCE(dc.straordinaria, false) as is_ot
        FROM daily_containers dc
        WHERE dc.work_date = $1
      ),
      assigned_tasks AS (
        SELECT task_id FROM optimizer.optimizer_assignment WHERE run_id = $2
      ),
      unassigned_tasks AS (
        SELECT task_id, reason_code FROM optimizer.optimizer_unassigned WHERE run_id = $2
      )
      SELECT 
        COUNT(*) FILTER (WHERE at.is_ot = true) as ot_total,
        COUNT(*) FILTER (WHERE at.is_ot = true AND ast.task_id IS NOT NULL) as ot_assigned,
        COUNT(*) FILTER (WHERE at.is_ot = true AND ust.task_id IS NOT NULL) as ot_unassigned
      FROM all_tasks at
      LEFT JOIN assigned_tasks ast ON at.task_id = ast.task_id
      LEFT JOIN unassigned_tasks ust ON at.task_id = ust.task_id
    `, [workDate, runId]);

    // Query per breakdown dei non assegnati per reason
    const unassignedByReason = await pool.query(`
      SELECT reason_code, COUNT(*) as count
      FROM optimizer.optimizer_unassigned
      WHERE run_id = $1
      GROUP BY reason_code
      ORDER BY count DESC
    `, [runId]);

    // Query per dettagli dei non assegnati (incluso OT)
    // Calcola i cleaners compatibili basandosi sui selected_cleaners e le regole di compatibilità
    // NOTA: La compatibilità si basa su role (Premium/Standard) + can_do_straordinaria
    // Le settings apartment_types sono caricate in Phase2/Phase4 per la logica completa
    // Qui usiamo una versione semplificata che considera:
    // - Premium task → richiede cleaner Premium
    // - Straordinaria → richiede can_do_straordinaria
    // - typeApt: tutti i ruoli possono fare tutti i tipi di appartamento (secondo current settings)
    const unassignedDetails = await pool.query(`
      WITH selected_cleaners AS (
        SELECT UNNEST(cleaners) as cleaner_id FROM daily_selected_cleaners WHERE work_date = $2
      ),
      cleaner_details AS (
        SELECT 
          c.cleaner_id,
          COALESCE(c.role, 'Standard') as role,
          COALESCE(c.can_do_straordinaria, false) as can_do_straordinaria
        FROM cleaners c
        WHERE c.work_date = $2 AND c.cleaner_id IN (SELECT cleaner_id FROM selected_cleaners)
      ),
      unassigned_with_compat AS (
        SELECT 
          ou.task_id,
          ou.logistic_code,
          COALESCE(dc.straordinaria, false) as is_straordinaria,
          ou.reason_code,
          dc.premium,
          COALESCE(dc.type_apt, 'C') as type_apt,
          (
            SELECT COUNT(*)
            FROM cleaner_details cd
            WHERE 
              (NOT COALESCE(dc.premium, false) OR cd.role = 'Premium')
              AND (NOT COALESCE(dc.straordinaria, false) OR cd.can_do_straordinaria)
          ) as compatible_cleaners_count
        FROM optimizer.optimizer_unassigned ou
        LEFT JOIN daily_containers dc ON dc.task_id = ou.task_id AND dc.work_date = $2
        WHERE ou.run_id = $1
      )
      SELECT * FROM unassigned_with_compat
      ORDER BY is_straordinaria DESC, compatible_cleaners_count ASC
    `, [runId, workDate]);

    result.metrics = {
      totalTasks: result.phase0?.unlockedTasks || 0,  // Use unlockedTasks to exclude locked tasks from count
      assignedTasks: result.summary.tasksAssigned,
      unassignedTasks: result.summary.tasksUnassigned,
      otTotal: parseInt(otStats.rows[0]?.ot_total || '0'),
      otAssigned: parseInt(otStats.rows[0]?.ot_assigned || '0'),
      otUnassigned: parseInt(otStats.rows[0]?.ot_unassigned || '0'),
      unassignedByReason: {},
      unassignedDetails: []
    };

    // Popola unassignedByReason
    for (const row of unassignedByReason.rows) {
      result.metrics.unassignedByReason[row.reason_code || 'UNKNOWN'] = parseInt(row.count);
    }

    // Popola unassignedDetails
    result.metrics.unassignedDetails = unassignedDetails.rows.map((row: any) => ({
      taskId: row.task_id,
      logisticCode: row.logistic_code,
      isStraordinaria: row.is_straordinaria,
      reason: row.reason_code || 'UNKNOWN',
      compatibleCleanersCount: row.compatible_cleaners_count
    }));

    // Log delle metriche
    console.log(`[runAllPhases] === METRICHE FINALI ===`);
    console.log(`   Totale task: ${result.metrics.totalTasks}`);
    console.log(`   Assegnati: ${result.metrics.assignedTasks}`);
    console.log(`   Non assegnati: ${result.metrics.unassignedTasks}`);
    console.log(`   OT totali: ${result.metrics.otTotal}, assegnate: ${result.metrics.otAssigned}, non assegnate: ${result.metrics.otUnassigned}`);

    // Check di coerenza: assigned + unassigned deve essere uguale a total
    const expectedTotal = result.metrics.assignedTasks + result.metrics.unassignedTasks;
    if (expectedTotal !== result.metrics.totalTasks) {
      const missing = result.metrics.totalTasks - expectedTotal;
      console.warn(`   ⚠️ WARNING: Conteggio incoerente! assigned(${result.metrics.assignedTasks}) + unassigned(${result.metrics.unassignedTasks}) = ${expectedTotal}, ma total = ${result.metrics.totalTasks}`);
      console.warn(`   ⚠️ ${missing} task mancanti dal sistema di conteggio!`);
      
      // Query per trovare i task_id mancanti
      try {
        const missingTasksQuery = await pool.query(`
          WITH all_unlocked AS (
            SELECT task_id FROM daily_containers 
            WHERE work_date = $1
              AND task_id NOT IN (SELECT task_id FROM daily_task_locks WHERE work_date = $1 AND locked = true)
          ),
          accounted AS (
            SELECT task_id FROM optimizer.optimizer_assignment WHERE run_id = $2
            UNION
            SELECT task_id FROM optimizer.optimizer_unassigned WHERE run_id = $2
          )
          SELECT task_id FROM all_unlocked WHERE task_id NOT IN (SELECT task_id FROM accounted)
        `, [workDate, runId]);
        
        if (missingTasksQuery.rows.length > 0) {
          const missingIds = missingTasksQuery.rows.map(r => r.task_id);
          console.warn(`   ⚠️ Task IDs mancanti: ${missingIds.join(', ')}`);
        }
      } catch (e: any) {
        console.warn(`   ⚠️ Impossibile recuperare task mancanti: ${e.message}`);
      }
    }
    
    if (Object.keys(result.metrics.unassignedByReason).length > 0) {
      console.log(`   Non assegnati per reason:`);
      for (const [reason, count] of Object.entries(result.metrics.unassignedByReason)) {
        console.log(`      - ${reason}: ${count}`);
      }
    }

    // Log dettagliato per OT non assegnate
    const unassignedOTs = result.metrics.unassignedDetails.filter(d => d.isStraordinaria);
    if (unassignedOTs.length > 0) {
      console.log(`   ⚠️ STRAORDINARIE NON ASSEGNATE (${unassignedOTs.length}):`);
      for (const ot of unassignedOTs) {
        console.log(`      - Task ${ot.taskId} (LC: ${ot.logisticCode}): ${ot.reason}, cleaners compatibili: ${ot.compatibleCleanersCount}`);
      }
    }

  } catch (error: any) {
    console.warn(`[runAllPhases] Warning: failed to collect detailed metrics: ${error.message}`);
  }
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

    // Ensure PK sequence is aligned. If the table was bulk-loaded with explicit IDs
    // (or restored), the underlying sequence can lag behind and generate duplicates.
    // This would break MERGE MODE inserts with "duplicate key ... daily_assignments_current_pkey".
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('daily_assignments_current', 'id'),
        (SELECT COALESCE(MAX(id), 0) FROM daily_assignments_current),
        true
      )
    `);

    const existingTasksResult = await client.query(`
      SELECT DISTINCT task_id::text FROM daily_assignments_current WHERE work_date = $1
    `, [workDate]);
    const existingTaskIds = new Set(existingTasksResult.rows.map(r => r.task_id));
    console.log(`[applyToProduction] Found ${existingTaskIds.size} existing tasks in timeline (will be preserved)`);
    const hasExistingTimeline = existingTaskIds.size > 0;

    result.deletedCount = 0;
    console.log(`[applyToProduction] MERGE MODE: Skipping delete, preserving existing timeline`);

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
        CASE WHEN (bs.base_seq + oa.sequence) > 1 THEN true ELSE false END as followup,
        (bs.base_seq + oa.sequence) as sequence,
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
      LEFT JOIN LATERAL (
        SELECT COALESCE(MAX(sequence), 0) as base_seq
        FROM daily_assignments_current dac
        WHERE dac.work_date = $2 AND dac.cleaner_id = oa.cleaner_id
      ) bs ON true
      WHERE oa.run_id = $1
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_task_locks 
          WHERE work_date = $2 AND locked = true
        )
        AND oa.task_id NOT IN (
          SELECT task_id FROM daily_assignments_current
          WHERE work_date = $2
        )
    `;

    const insertResult = await client.query(insertQuery, [runId, workDate]);
    result.insertedCount = insertResult.rowCount || 0;
    console.log(`[applyToProduction] MERGE MODE: Inserted ${result.insertedCount} new assignments (existing preserved)`);

    // IMPORTANT:
    // - If the day already has manual timeline tasks, we must preserve them (MERGE append-only).
    //   Therefore we skip the global Python recalculation here, because it can retime/resequence existing rows.
    // - If there is no pre-existing timeline, recalculation is safe and can normalize timings.
    if (!hasExistingTimeline) {
      try {
        const affectedCleanersResult = await client.query(
          `SELECT DISTINCT cleaner_id FROM optimizer.optimizer_assignment WHERE run_id = $1`,
          [runId]
        );
        const cleanerIds: number[] = affectedCleanersResult.rows
          .map((r: any) => Number(r.cleaner_id))
          .filter((n: number) => Number.isFinite(n));

        for (const cleanerId of cleanerIds) {
          const tasksResult = await client.query(
            `SELECT task_id, logistic_code, cleaner_id,
                    sequence, cleaning_time, address, lat, lng,
                    start_time, end_time, travel_time
             FROM daily_assignments_current
             WHERE work_date = $1 AND cleaner_id = $2
             ORDER BY sequence`,
            [workDate, cleanerId]
          );

          if (tasksResult.rows.length === 0) continue;

          const startTimeResult = await client.query(
            `SELECT COALESCE(start_time, '10:00') as start_time
             FROM cleaners
             WHERE work_date = $1 AND cleaner_id = $2
             LIMIT 1`,
            [workDate, cleanerId]
          );
          const cleanerStartTime = startTimeResult.rows[0]?.start_time || '10:00';

          const cleanerData = {
            cleaner: { id: cleanerId, start_time: cleanerStartTime },
            tasks: tasksResult.rows.map((r: any): PythonRecalcTask => ({
              task_id: Number(r.task_id),
              logistic_code: Number(r.logistic_code),
              sequence: Number(r.sequence),
              cleaning_time: Number(r.cleaning_time) || 0,
              address: r.address ?? null,
              lat: r.lat ?? null,
              lng: r.lng ?? null,
              start_time: r.start_time ?? null,
              end_time: r.end_time ?? null,
              travel_time: r.travel_time ?? null
            }))
          };

          const updatedCleanerData = await recalculateCleanerTimesViaPython(cleanerData);
          const recalculatedTasks = Array.isArray(updatedCleanerData?.tasks) ? updatedCleanerData.tasks : [];

          const toMinutes = (t?: string | null): number => {
            if (!t) return Number.POSITIVE_INFINITY;
            const parts = String(t).split(':');
            if (parts.length < 2) return Number.POSITIVE_INFINITY;
            const h = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.POSITIVE_INFINITY;
            return h * 60 + m;
          };

          const orderedTasks = [...recalculatedTasks].sort((a: any, b: any) => {
            const ma = toMinutes(a.start_time);
            const mb = toMinutes(b.start_time);
            if (ma !== mb) return ma - mb;
            const sa = Number(a.sequence);
            const sb = Number(b.sequence);
            if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
            return Number(a.task_id) - Number(b.task_id);
          });

          for (let i = 0; i < orderedTasks.length; i++) {
            const task = orderedTasks[i];
            const newSeq = i + 1;
            const followup = newSeq > 1;
            await client.query(
              `UPDATE daily_assignments_current
               SET start_time = $1, end_time = $2, travel_time = $3, sequence = $4, followup = $5
               WHERE work_date = $6 AND cleaner_id = $7 AND task_id = $8`,
              [
                task.start_time,
                task.end_time,
                task.travel_time,
                newSeq,
                followup,
                workDate,
                cleanerId,
                task.task_id
              ]
            );
          }
        }
        console.log(`[applyToProduction] Recalculated travel/start/end times for ${cleanerIds.length} cleaners`);
      } catch (recalcError: any) {
        console.warn(`[applyToProduction] Warning: failed to recalculate travel times: ${recalcError.message}`);
      }
    } else {
      console.log(`[applyToProduction] MERGE append-only: skipping global recalculation to preserve manual timeline`);
    }

    // Get next revision number for history table
    const historyRevisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_history WHERE work_date = $1`,
      [workDate]
    );
    const historyNextRevision = historyRevisionResult.rows[0].next_revision;
    
    // Get next revision number for revisions table (separate sequence)
    const revisionsRevisionResult = await client.query(
      `SELECT COALESCE(MAX(revision), 0) + 1 as next_revision FROM daily_assignments_revisions WHERE work_date = $1`,
      [workDate]
    );
    const revisionsNextRevision = revisionsRevisionResult.rows[0].next_revision;
    
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
    `, [runId, workDate, historyNextRevision]);

    await client.query(`
      INSERT INTO daily_assignments_revisions (work_date, revision, task_count, created_by, modification_type)
      VALUES ($1, $2, $3, $4, 'optimizer_auto_assign')
    `, [workDate, revisionsNextRevision, result.insertedCount, 'optimizer-' + runId]);

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
