import { v4 as uuidv4 } from 'uuid';
import {
  insertLogisticsDecisionsBatch,
  insertLogisticsOptimizerRun,
  loadLogisticsTasksFromDb,
  updateLogisticsOptimizerRun
} from './db';
import { runLgPhase0 } from './lg_phase0';
import { runLgPhase1 } from './lg_phase1';
import { runLgPhase2 } from './lg_phase2';
import { runLgPhase3 } from './lg_phase3';
import { runLgPhase4 } from './lg_phase4';
import type { LogisticsPipelineResult, UnassignedEntry } from './types';
import { hasAnyHousekeepingAssignments, loadHousekeepingWindows } from './db';

export type RunAllPhasesLogisticsOptions = {
  /** If true, do not write optimizer_run / decisions (still computes pipeline) */
  dryRun?: boolean;
  modifiedBy?: string;
};

export async function getLogisticsOptimizerPrerequisites(workDate: string): Promise<{
  workDate: string;
  hkTimelineHasRows: boolean;
  hkWindowsCount: number;
  logisticsTaskCount: number;
  logisticsUnlockedWithCoords: number;
  missingHousekeepingWindowTaskIds: number[];
}> {
  const hkTimelineHasRows = await hasAnyHousekeepingAssignments(workDate);
  const windows = await loadHousekeepingWindows(workDate);
  const logisticsTasks = await loadLogisticsTasksFromDb(workDate);
  const unlocked = logisticsTasks.filter((t) => !t.locked);
  const missing: number[] = [];
  for (const t of unlocked) {
    const w = windows.get(t.taskId);
    if (!w || w.endMin < w.startMin) missing.push(t.taskId);
  }
  return {
    workDate,
    hkTimelineHasRows,
    hkWindowsCount: windows.size,
    logisticsTaskCount: logisticsTasks.length,
    logisticsUnlockedWithCoords: unlocked.length,
    missingHousekeepingWindowTaskIds: missing
  };
}

export async function runAllPhasesLogistics(
  workDate: string,
  options: RunAllPhasesLogisticsOptions = {}
): Promise<LogisticsPipelineResult> {
  const start = Date.now();
  const runId = uuidv4();
  const modifiedBy = options.modifiedBy || 'logistics-optimizer';
  const unassigned: UnassignedEntry[] = [];
  const decisions: { runId: string; phase: number; eventType: string; payload: Record<string, unknown> }[] = [];

  const result: LogisticsPipelineResult = {
    runId,
    workDate,
    status: 'failed',
    phase0: { ok: false, reason: 'NO_HK_TIMELINE', message: '' },
    unassigned,
    decisionsInserted: 0,
    durationMs: 0
  };

  if (!options.dryRun) {
    await insertLogisticsOptimizerRun(runId, workDate, 'logistics-v0', { dryRun: false }, 'partial', null);
  }

  try {
    const phase0 = await runLgPhase0(workDate);
    result.phase0 = phase0;
    decisions.push({
      runId,
      phase: 0,
      eventType: phase0.ok ? 'LG_PHASE0_OK' : 'LG_PHASE0_FAIL',
      payload: phase0.ok ? { windows: phase0.windowsByTaskId.size } : { ...phase0 }
    });

    if (!phase0.ok) {
      result.error = phase0.message;
      result.status = 'failed';
      if (!options.dryRun) {
        result.decisionsInserted = await insertLogisticsDecisionsBatch(decisions);
        await updateLogisticsOptimizerRun(runId, 'failed', {
          error: phase0.message,
          reason: phase0.reason
        });
      }
      result.durationMs = Date.now() - start;
      return result;
    }

    const allLogisticsTasks = await loadLogisticsTasksFromDb(workDate);
    const phase1 = await runLgPhase1(workDate, phase0, allLogisticsTasks);
    if (!phase1) {
      result.error = 'Fase 1 non disponibile';
      if (!options.dryRun) {
        await updateLogisticsOptimizerRun(runId, 'failed', { error: result.error });
        result.decisionsInserted = await insertLogisticsDecisionsBatch(decisions);
      }
      result.durationMs = Date.now() - start;
      return result;
    }
    result.phase1 = phase1;
    if (phase1.drivers.length === 0) {
      result.status = 'failed';
      result.error = 'Nessun autista selezionato (lg_selected_drivers) per questa data';
      decisions.push({
        runId,
        phase: 1,
        eventType: 'LG_PHASE1_NO_DRIVERS',
        payload: { taskCount: phase1.tasks.length }
      });
      if (!options.dryRun) {
        result.decisionsInserted = await insertLogisticsDecisionsBatch(decisions);
        await updateLogisticsOptimizerRun(runId, 'failed', { error: result.error });
      }
      result.durationMs = Date.now() - start;
      return result;
    }
    if (phase1.tasks.length === 0) {
      result.status = 'partial';
      result.error =
        'Nessun task logistico sbloccato con coordinate e finestra HK (tutti locked o fuori contesto)';
      decisions.push({
        runId,
        phase: 1,
        eventType: 'LG_PHASE1_NO_TASKS',
        payload: { drivers: phase1.drivers.length }
      });
      if (!options.dryRun) {
        result.decisionsInserted = await insertLogisticsDecisionsBatch(decisions);
        await updateLogisticsOptimizerRun(runId, 'partial', { assigned: 0 });
      }
      result.durationMs = Date.now() - start;
      return result;
    }

    decisions.push({
      runId,
      phase: 1,
      eventType: 'LG_PHASE1_OK',
      payload: { taskCount: phase1.tasks.length, driverCount: phase1.drivers.length }
    });

    const phase2 = runLgPhase2(phase1);
    result.phase2 = phase2;
    decisions.push({
      runId,
      phase: 2,
      eventType: 'LG_PHASE2_OK',
      payload: {
        targetMin: phase2.targetMinPerDriver,
        targetMax: phase2.targetMaxPerDriver
      }
    });

    const phase3 = await runLgPhase3(phase1, phase2);
    if (!phase3.ok) {
      result.phase3 = phase3;
      result.status = 'failed';
      result.error = phase3.message;
      decisions.push({
        runId,
        phase: 3,
        eventType: 'LG_PHASE3_FAIL',
        payload: { reason: phase3.reason, message: phase3.message }
      });
      if (!options.dryRun) {
        result.decisionsInserted = await insertLogisticsDecisionsBatch(decisions);
        await updateLogisticsOptimizerRun(runId, 'failed', {
          error: phase3.message,
          reason: phase3.reason
        });
      }
      result.durationMs = Date.now() - start;
      return result;
    }
    decisions.push({
      runId,
      phase: 3,
      eventType: 'LG_PHASE3_ORTOOLS_OK',
      payload: {}
    });

    result.phase3 = phase3;

    const assignedSet = new Set<number>();
    if (phase3.ok) {
      for (const ids of phase3.routesByDriverId.values()) {
        for (const id of ids) assignedSet.add(id);
      }
    }

    const unassignedIds = new Set(unassigned.map((u) => u.taskId));
    for (const t of phase1.tasks) {
      if (!assignedSet.has(t.taskId) && !unassignedIds.has(t.taskId)) {
        unassigned.push({
          taskId: t.taskId,
          reasonCode: 'NOT_IN_ROUTE',
          details: {}
        });
      }
    }

    for (const t of allLogisticsTasks) {
      if (t.locked) {
        unassigned.push({
          taskId: t.taskId,
          reasonCode: 'LOCKED_SKIP',
          details: {}
        });
      }
    }

    const phase4 = await runLgPhase4(
      workDate,
      phase1,
      phase3.routesByDriverId,
      phase3.arrivalMinByTaskId,
      modifiedBy
    );
    result.timelinePayload = phase4.timeline;
    decisions.push({
      runId,
      phase: 4,
      eventType: 'LG_PHASE4_OK',
      payload: { assignedCount: phase4.assignedCount }
    });

    result.status =
      unassigned.filter((u) => u.reasonCode !== 'LOCKED_SKIP').length > 0 ? 'partial' : 'success';

    if (!options.dryRun) {
      result.decisionsInserted = await insertLogisticsDecisionsBatch(decisions);
      await updateLogisticsOptimizerRun(runId, result.status, {
        assignedCount: phase4.assignedCount,
        unassignedCount: unassigned.length
      });
    }
  } catch (e: any) {
    result.status = 'failed';
    result.error = e?.message || String(e);
    if (!options.dryRun) {
      try {
        decisions.push({
          runId,
          phase: -1,
          eventType: 'LG_PIPELINE_ERROR',
          payload: { message: result.error }
        });
        result.decisionsInserted = await insertLogisticsDecisionsBatch(decisions);
        await updateLogisticsOptimizerRun(runId, 'failed', { error: result.error });
      } catch {
        /* ignore */
      }
    }
  }

  result.durationMs = Date.now() - start;
  return result;
}
