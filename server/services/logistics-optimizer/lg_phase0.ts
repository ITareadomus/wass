import {
  hasAnyHousekeepingAssignments,
  loadHousekeepingWindows,
  loadLogisticsTasksFromDb
} from './db';
import type { Phase0Result } from './types';

/**
 * Hard gate: housekeeping timeline must exist in daily_assignments_current,
 * and every schedulable logistics task must have [hkStart, hkEnd].
 */
export async function runLgPhase0(workDate: string): Promise<Phase0Result> {
  const anyHk = await hasAnyHousekeepingAssignments(workDate);
  if (!anyHk) {
    return {
      ok: false,
      reason: 'NO_HK_TIMELINE',
      message:
        'Nessuna assegnazione housekeeping in daily_assignments_current per questa data. Pianificare HK prima della logistica.'
    };
  }

  const windowsByTaskId = await loadHousekeepingWindows(workDate);
  if (windowsByTaskId.size === 0) {
    return {
      ok: false,
      reason: 'NO_HK_TIMELINE',
      message:
        'Timeline housekeeping presente ma senza start_time/end_time valorizzati. Completare gli orari prima della logistica.'
    };
  }

  const logisticsTasks = await loadLogisticsTasksFromDb(workDate);
  const required = logisticsTasks.filter((t) => !t.locked);
  const missing: number[] = [];
  for (const t of required) {
    const w = windowsByTaskId.get(t.taskId);
    if (!w || w.endMin < w.startMin) {
      missing.push(t.taskId);
      continue;
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'HK_WINDOW_MISSING',
      message: `${missing.length} task logistici senza finestra housekeeping valida in daily_assignments_current.`,
      missingTaskIds: missing
    };
  }

  return { ok: true, windowsByTaskId };
}
