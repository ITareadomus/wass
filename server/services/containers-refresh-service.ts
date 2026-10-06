import { exec } from 'child_process';
import path from 'path';
import * as workspaceFiles from './workspace-files';
import {
  collectManualCleaningTimeOverrides,
  restoreManualCleaningTimeOverrides,
  type ManualCleaningTimeOverride,
} from '../../shared/wass-cleaning-time';
import {
  syncTimelineAssignmentsFromAdam,
  type AssignmentSyncResult,
  type RefreshSyncMode,
} from './adam-timeline-assignment-sync';
import pool from '../../shared/pg-db';
import { formatHmTime } from '../../shared/logistics-task-windows';
import {
  normalizeLogisticsTaskKind,
  resolveAutoLogisticsTaskKind,
} from '../../shared/logistics-task-kind';
import {
  diffAssignedLogisticsContext,
  diffLogisticsProgramFields,
  LOGISTICS_ASSIGNED_PROGRAM_FIELDS,
  logisticsCleanerDisplayLabel,
  sameLogisticsField,
  type LogisticsAssignedSyncNotice,
  type LogisticsAssignedTaskChange,
} from '../../shared/logistics-assigned-sync-diff';
import { loadCleanerContextByTaskIds } from './logistics-task-kind-enrichment';

export interface RefreshContainersResult {
  success: boolean;
  containersData: any;
  removedCount: number;
  error?: string;
  mode?: RefreshSyncMode;
  assignmentSync?: AssignmentSyncResult;
  assignedChanges?: LogisticsAssignedSyncNotice;
}

const inflightAdamRefresh = new Map<string, Promise<RefreshContainersResult>>();
const inflightLogisticsRefresh = new Map<string, Promise<RefreshContainersResult>>();

const CREATE_CONTAINERS_TIMEOUT_MS = 120000;

const LOGISTICS_BUCKETS = ['early_out', 'high_priority', 'low_priority'] as const;

/** Dati appartamento copiati da ADAM. Non includono driver, sequenza o orari del giro. */
const LOGISTICS_PROGRAM_FIELDS = LOGISTICS_ASSIGNED_PROGRAM_FIELDS
  .map((field) => field.field)
  .filter((field) => field !== 'base_cleaning_time' && field !== 'priority');

function collectFreshLogisticsTasks(containersData: any): Map<number, { task: any; priority: string }> {
  const fresh = new Map<number, { task: any; priority: string }>();
  for (const priority of LOGISTICS_BUCKETS) {
    const tasks = containersData?.containers?.[priority]?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (const task of tasks) {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId) || fresh.has(taskId)) continue;
      fresh.set(taskId, { task, priority });
    }
  }
  return fresh;
}

function snapshotAssignedTask(task: any): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const { field } of LOGISTICS_ASSIGNED_PROGRAM_FIELDS) {
    snapshot[field] = task?.[field];
  }
  snapshot.logistics_task_kind = task?.logistics_task_kind ?? null;
  snapshot.logistics_task_kind_source = task?.logistics_task_kind_source ?? null;
  snapshot.cleaner_id = task?.cleaner_id ?? null;
  snapshot.cleaner_sequence = task?.cleaner_sequence ?? null;
  snapshot.cleaner_name = task?.cleaner_name ?? null;
  snapshot.cleaner_lastname = task?.cleaner_lastname ?? null;
  snapshot.cleaner_alias = task?.cleaner_alias ?? null;
  snapshot.hk_start_time = task?.hk_start_time ?? null;
  snapshot.hk_end_time = task?.hk_end_time ?? null;
  snapshot.adam_assignment_observed = task?.adam_assignment_observed === true;
  return snapshot;
}

function sameAssignmentSnapshot(
  left: Record<string, unknown> | null,
  right: Record<string, unknown>
): boolean {
  if (!left) return false;
  const keys = [
    "observed",
    "kind",
    "kindSource",
    "cleanerId",
    "cleanerSequence",
    "cleanerName",
    "cleanerLastname",
    "cleanerAlias",
    "hkStart",
    "hkEnd",
  ];
  return keys.every((key) => String(left[key] ?? "") === String(right[key] ?? ""));
}

function readAssignmentSnapshot(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
  return typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function taskLogisticCode(task: any, taskId: number): string {
  const code = task?.logistic_code;
  if (code != null && String(code).trim() !== '') return String(code);
  return String(taskId);
}

function upsertTaskChange(
  changes: LogisticsAssignedTaskChange[],
  taskId: number,
  logisticCode: string,
  next: LogisticsAssignedTaskChange['changes']
) {
  if (next.length === 0) return;
  const existing = changes.find((change) => change.taskId === taskId && !change.removed);
  if (!existing) {
    changes.push({ taskId, logisticCode, removed: false, changes: next });
    return;
  }
  if (logisticCode) existing.logisticCode = logisticCode;
  existing.changes.push(...next);
}

/**
 * Aggiorna i dati programma sulle task già in timeline e toglie quelle
 * uscite dal perimetro logistica. Driver, sequenza e orari del giro restano.
 */
function syncLogisticsTimelineProgram(
  timelineData: any,
  freshByTaskId: Map<number, { task: any; priority: string }>
): {
  changed: boolean;
  removedCount: number;
  taskChanges: LogisticsAssignedTaskChange[];
  kept: Array<{ task: any; before: Record<string, unknown> }>;
} {
  if (!Array.isArray(timelineData?.drivers_assignments)) {
    return { changed: false, removedCount: 0, taskChanges: [], kept: [] };
  }

  let changed = false;
  let removedCount = 0;
  const taskChanges: LogisticsAssignedTaskChange[] = [];
  const kept: Array<{ task: any; before: Record<string, unknown> }> = [];
  const reportedTaskIds = new Set<number>();

  for (const entry of timelineData.drivers_assignments) {
    const nextTasks: any[] = [];
    for (const task of entry?.tasks || []) {
      const before = snapshotAssignedTask(task);
      const taskId = Number(task?.task_id);
      const fresh = Number.isFinite(taskId) ? freshByTaskId.get(taskId) : undefined;
      if (!fresh) {
        removedCount += 1;
        changed = true;
        if (Number.isFinite(taskId)) {
          taskChanges.push({
            taskId,
            logisticCode: taskLogisticCode(before, taskId),
            removed: true,
            changes: [
              {
                field: 'timeline',
                label: 'Timeline',
                from: 'Assegnata',
                to: 'Uscita dal programma',
              },
            ],
          });
        }
        continue;
      }

      for (const field of LOGISTICS_PROGRAM_FIELDS) {
        if (!(field in fresh.task)) continue;
        if (sameLogisticsField(field, task[field], fresh.task[field])) continue;
        task[field] = fresh.task[field];
        changed = true;
      }
      if (fresh.task.cleaning_time != null && !sameLogisticsField('base_cleaning_time', task.base_cleaning_time, fresh.task.cleaning_time)) {
        task.base_cleaning_time = fresh.task.cleaning_time;
        changed = true;
      }
      if (!sameLogisticsField('priority', task.priority, fresh.priority)) {
        task.priority = fresh.priority;
        changed = true;
      }
      if (Number.isFinite(taskId)) {
        if (!reportedTaskIds.has(taskId)) {
          upsertTaskChange(
            taskChanges,
            taskId,
            taskLogisticCode(task, taskId),
            diffLogisticsProgramFields(before, task)
          );
          reportedTaskIds.add(taskId);
        }
        kept.push({ task, before });
      }
      nextTasks.push(task);
    }
    entry.tasks = nextTasks;
  }

  return { changed, removedCount, taskChanges, kept };
}

async function loadCleanerAliases(cleanerIds: number[]): Promise<Map<number, string>> {
  const uniqueIds = Array.from(new Set(cleanerIds.filter((id) => Number.isFinite(id) && id > 0)));
  if (uniqueIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT cleaner_id, alias FROM aliases WHERE cleaner_id = ANY($1::int[])`,
    [uniqueIds]
  );
  const aliases = new Map<number, string>();
  for (const row of result.rows) {
    const cleanerId = Number(row.cleaner_id);
    const alias = row.alias != null ? String(row.alias).trim() : '';
    if (Number.isFinite(cleanerId) && alias) aliases.set(cleanerId, alias);
  }
  return aliases;
}

/** Allinea tipo operazione, cleaner e finestra HK al dato ADAM e ne registra il diff. */
async function applyAssignedAdamContext(
  workDate: string,
  kept: Array<{ task: any; before: Record<string, unknown> }>,
  taskChanges: LogisticsAssignedTaskChange[]
): Promise<boolean> {
  if (kept.length === 0) return false;

  const taskIds = kept
    .map(({ task }) => Number(task?.task_id))
    .filter((id) => Number.isFinite(id));
  const contextByTaskId = await loadCleanerContextByTaskIds(workDate, taskIds);
  const aliases = await loadCleanerAliases(
    Array.from(contextByTaskId.values())
      .map((context) => Number(context.cleanerId))
      .filter((id) => Number.isFinite(id))
  );

  let changed = false;
  const reportedTaskIds = new Set<number>();
  for (const { task } of kept) {
    const taskId = Number(task?.task_id);
    const context = contextByTaskId.get(taskId);
    const cleanerId = context?.cleanerId ?? null;
    const alias = cleanerId != null ? aliases.get(cleanerId) ?? null : null;
    const previous = readAssignmentSnapshot(task.adam_assignment_snapshot);
    const observed = previous?.observed === true;
    const previousSource = observed
      ? previous?.kindSource
      : task.persisted_logistics_task_kind_source;
    const manualKind = previousSource === "manual";
    const storedKind = normalizeLogisticsTaskKind(
      observed ? previous?.kind : task.persisted_logistics_task_kind,
      manualKind ? "manual" : typeof previousSource === "string" ? previousSource : null
    );
    const beforeKind = storedKind;
    const afterKind = manualKind
      ? storedKind
      : resolveAutoLogisticsTaskKind({
          cleanerId,
          cleanerSequence: context?.cleanerSequence ?? null,
          premium: task?.premium === true,
          paxIn: task?.pax_in,
        });

    const beforeLabel = observed
      ? logisticsCleanerDisplayLabel({
          alias: previous?.cleanerAlias as string | null,
          name: previous?.cleanerName as string | null,
          lastname: previous?.cleanerLastname as string | null,
          cleanerId: positiveInt(previous?.cleanerId),
        })
      : "";
    const afterLabel = logisticsCleanerDisplayLabel({
      alias,
      name: context?.cleanerName,
      lastname: context?.cleanerLastname,
      cleanerId,
    });
    const beforeSequence = observed ? positiveInt(previous?.cleanerSequence) : null;
    const afterSequence = context?.cleanerSequence ?? null;
    const beforeHkStart = observed ? formatHmTime(previous?.hkStart) : null;
    const afterHkStart = formatHmTime(context?.cleanerTaskStartTime ?? null);
    const beforeHkEnd = observed ? formatHmTime(previous?.hkEnd) : null;
    const afterHkEnd = formatHmTime(context?.cleanerTaskEndTime ?? null);

    if (!reportedTaskIds.has(taskId)) {
      upsertTaskChange(
        taskChanges,
        taskId,
        taskLogisticCode(task, taskId),
        diffAssignedLogisticsContext({
          observed,
          manualKind,
          hadStoredKind: storedKind != null,
          beforeKind,
          afterKind,
          beforeCleanerLabel: beforeLabel,
          afterCleanerLabel: afterLabel,
          beforeSequence,
          afterSequence,
          beforeHkStart,
          afterHkStart,
          beforeHkEnd,
          afterHkEnd,
        })
      );
      reportedTaskIds.add(taskId);
    }

    const nextSnapshot = {
      observed: true,
      kind: manualKind ? storedKind : afterKind,
      kindSource: manualKind ? "manual" : afterKind ? "auto" : null,
      cleanerId,
      cleanerSequence: afterSequence,
      cleanerName: context?.cleanerName ?? null,
      cleanerLastname: context?.cleanerLastname ?? null,
      cleanerAlias: alias,
      hkStart: afterHkStart,
      hkEnd: afterHkEnd,
    };
    if (!sameAssignmentSnapshot(readAssignmentSnapshot(task.adam_assignment_snapshot), nextSnapshot)) {
      task.adam_assignment_snapshot = nextSnapshot;
      changed = true;
    }
    if (!manualKind) {
      if (task.logistics_task_kind !== afterKind) {
        task.logistics_task_kind = afterKind;
        changed = true;
      }
      const nextSource = afterKind ? "auto" : null;
      if ((task.logistics_task_kind_source ?? null) !== nextSource) {
        task.logistics_task_kind_source = nextSource;
        changed = true;
      }
    }
  }

  return changed;
}

/** Logistics: create_containers.py --workflow logistics → daily_logistics_* */
export async function refreshLogisticsContainersFromAdam(
  workDate: string,
  modifiedBy: string = 'system'
): Promise<RefreshContainersResult> {
  const existing = inflightLogisticsRefresh.get(workDate);
  if (existing) {
    console.log(`⏳ refreshLogisticsContainersFromAdam: attendo refresh già in corso (${workDate})`);
    return existing;
  }

  const pending = runRefreshLogisticsContainersFromAdam(workDate, modifiedBy).finally(() => {
    if (inflightLogisticsRefresh.get(workDate) === pending) {
      inflightLogisticsRefresh.delete(workDate);
    }
  });
  inflightLogisticsRefresh.set(workDate, pending);
  return pending;
}

async function runRefreshLogisticsContainersFromAdam(
  workDate: string,
  modifiedBy: string
): Promise<RefreshContainersResult> {
  console.log(`🔄 refreshLogisticsContainersFromAdam: ${workDate}...`);
  try {
    const createContainersPath = path.join(process.cwd(), 'client/public/scripts/create_containers.py');
    await new Promise<string>((resolve, reject) => {
      exec(
        `python3 "${createContainersPath}" --date "${workDate}" --skip-extract --use-api --workflow logistics`,
        { timeout: CREATE_CONTAINERS_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            if ((error as any).killed) {
              const timeoutSeconds = Math.floor(CREATE_CONTAINERS_TIMEOUT_MS / 1000);
              reject(new Error(`create_containers logistics timeout dopo ${timeoutSeconds}s`));
              return;
            }
            console.error(`❌ Errore create_containers (logistics): ${error.message}`);
            reject(new Error(stderr || error.message));
          } else {
            console.log(`create_containers (logistics) output: ${stdout}`);
            resolve(stdout);
          }
        }
      );
    });

    let containersData = await workspaceFiles.loadLogisticsContainers(workDate);
    if (!containersData) {
      containersData = {
        containers: {
          early_out: { tasks: [], count: 0 },
          high_priority: { tasks: [], count: 0 },
          low_priority: { tasks: [], count: 0 },
        },
        summary: { early_out: 0, high_priority: 0, low_priority: 0, total_tasks: 0 },
        metadata: { date: workDate },
      };
    }

    // I container appena rigenerati includono anche le task già assegnate:
    // servono per aggiornare il programma in timeline prima di toglierle dai container.
    const freshByTaskId = collectFreshLogisticsTasks(containersData);
    const timelineData = await workspaceFiles.loadLogisticsTimeline(workDate);
    const timelineSync = syncLogisticsTimelineProgram(timelineData, freshByTaskId);
    const assignmentChanged = await applyAssignedAdamContext(
      workDate,
      timelineSync.kept,
      timelineSync.taskChanges
    );
    if ((timelineSync.changed || assignmentChanged) && timelineData) {
      const timelineSaved = await workspaceFiles.saveLogisticsTimeline(
        workDate,
        timelineData,
        false,
        modifiedBy,
        'logistics_program_sync'
      );
      if (!timelineSaved) {
        throw new Error('Salvataggio timeline logistica dopo sync programma non riuscito');
      }
      console.log(
        `✅ Logistics timeline aggiornata per ${workDate}: rimosse ${timelineSync.removedCount} task uscite dal programma, ${timelineSync.taskChanges.length} task con cambiamenti`
      );
    }
    const assignedChanges: LogisticsAssignedSyncNotice = {
      syncedAt: new Date().toISOString(),
      tasks: timelineSync.taskChanges,
    };

    const assignedTaskIds = new Set<number>();
    if (timelineData?.drivers_assignments) {
      for (const driverEntry of timelineData.drivers_assignments) {
        for (const task of driverEntry.tasks || []) {
          const tid = Number(task?.task_id);
          if (Number.isFinite(tid)) assignedTaskIds.add(tid);
        }
      }
    }

    console.log(`🔍 Logistics: task assegnate in timeline: ${assignedTaskIds.size}`);

    let removedCount = 0;
    for (const containerType of LOGISTICS_BUCKETS) {
      const container = containersData.containers?.[containerType];
      if (!container?.tasks) continue;
      const originalCount = container.tasks.length;
      container.tasks = container.tasks.filter((t: any) => {
        const tid = Number(t?.task_id);
        return !Number.isFinite(tid) || !assignedTaskIds.has(tid);
      });
      container.count = container.tasks.length;
      removedCount += originalCount - container.tasks.length;
    }

    if (containersData.summary) {
      containersData.summary.early_out = containersData.containers.early_out?.count || 0;
      containersData.summary.high_priority = containersData.containers.high_priority?.count || 0;
      containersData.summary.low_priority = containersData.containers.low_priority?.count || 0;
      containersData.summary.total_tasks =
        containersData.summary.early_out +
        containersData.summary.high_priority +
        containersData.summary.low_priority;
    }

    await workspaceFiles.saveLogisticsContainers(workDate, containersData);
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveLogisticsContainersToHistory(
      workDate,
      modifiedBy,
      'logistics_synced_from_adam'
    );
    console.log(
      `✅ Logistics containers sincronizzati per ${workDate}: rimosse ${removedCount} task già in timeline`
    );

    return {
      success: true,
      containersData,
      removedCount,
      assignedChanges,
    };
  } catch (error: any) {
    console.error('❌ refreshLogisticsContainersFromAdam:', error);
    return {
      success: false,
      containersData: null,
      removedCount: 0,
      error: error.message,
    };
  }
}

export async function refreshContainersFromAdam(
  workDate: string,
  modifiedBy: string = 'system',
  workflow: 'housekeeping' | 'office' = 'housekeeping',
  options: {
    mode?: RefreshSyncMode;
    /** Skip create_containers (e.g. retry after apt already refreshed). */
    skipContainersRefresh?: boolean;
    extraManualOverrides?: Map<number, ManualCleaningTimeOverride>;
  } = {}
): Promise<RefreshContainersResult> {
  const lockKey = `${workflow}:${workDate}`;
  const existing = inflightAdamRefresh.get(lockKey);
  if (existing) {
    console.log(`⏳ refreshContainersFromAdam: attendo refresh già in corso (${lockKey})`);
    return existing;
  }

  const pending = runRefreshContainersFromAdam(
    workDate,
    modifiedBy,
    workflow,
    options
  ).finally(() => {
    if (inflightAdamRefresh.get(lockKey) === pending) {
      inflightAdamRefresh.delete(lockKey);
    }
  });
  inflightAdamRefresh.set(lockKey, pending);
  return pending;
}

async function runRefreshContainersFromAdam(
  workDate: string,
  modifiedBy: string,
  workflow: 'housekeeping' | 'office',
  options: {
    mode?: RefreshSyncMode;
    skipContainersRefresh?: boolean;
    extraManualOverrides?: Map<number, ManualCleaningTimeOverride>;
  }
): Promise<RefreshContainersResult> {
  const mode: RefreshSyncMode = options.mode === 'assignments' ? 'assignments' : 'apt';
  console.log(`🔄 refreshContainersFromAdam: ${workDate} mode=${mode}`);

  try {
    let containersData: any = null;
    let removedCount = 0;

    if (!options.skipContainersRefresh) {
      const previousContainers = await workspaceFiles.loadContainers(workDate, workflow);
      const previousTimeline = await workspaceFiles.loadTimeline(workDate, workflow);
      const manualOverrides = collectManualCleaningTimeOverrides(
        previousContainers,
        previousTimeline
      );
      if (options.extraManualOverrides) {
        for (const [taskId, override] of options.extraManualOverrides.entries()) {
          manualOverrides.set(taskId, override);
        }
      }

      const createContainersPath = path.join(process.cwd(), 'client/public/scripts/create_containers.py');

      const workflowArg = workflow === 'office' ? ' --workflow office' : '';
      await new Promise<string>((resolve, reject) => {
        exec(
          `python3 "${createContainersPath}" --date "${workDate}" --skip-extract --use-api${workflowArg}`,
          { timeout: CREATE_CONTAINERS_TIMEOUT_MS, maxBuffer: 5 * 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error) {
              if ((error as any).killed) {
                const timeoutSeconds = Math.floor(CREATE_CONTAINERS_TIMEOUT_MS / 1000);
                reject(new Error(`create_containers timeout dopo ${timeoutSeconds}s`));
                return;
              }
              console.error(`❌ Errore create_containers: ${error.message}`);
              reject(new Error(stderr || error.message));
            } else {
              console.log(`create_containers output: ${stdout}`);
              resolve(stdout);
            }
          }
        );
      });

      containersData = await workspaceFiles.loadContainers(workDate, workflow);

      if (!containersData) {
        containersData = {
          containers: {
            early_out: { tasks: [], count: 0 },
            high_priority: { tasks: [], count: 0 },
            low_priority: { tasks: [], count: 0 },
          },
          summary: { early_out: 0, high_priority: 0, low_priority: 0, total_tasks: 0 },
          metadata: { date: workDate },
        };
      }

      console.log(`✅ Containers rigenerati dal DB ADAM per ${workDate}`);

      const timelineData = await workspaceFiles.loadTimeline(workDate, workflow);

      const assignedTaskIds = new Set<number>();
      if (timelineData?.cleaners_assignments) {
        for (const cleanerEntry of timelineData.cleaners_assignments) {
          for (const task of cleanerEntry.tasks || []) {
            assignedTaskIds.add(task.task_id);
          }
        }
      }

      console.log(`🔍 Task assegnate trovate in timeline: ${assignedTaskIds.size}`);

      for (const containerType of ['early_out', 'high_priority', 'low_priority']) {
        const container = containersData.containers?.[containerType];
        if (container?.tasks) {
          const originalCount = container.tasks.length;
          container.tasks = container.tasks.filter((t: any) => !assignedTaskIds.has(t.task_id));
          container.count = container.tasks.length;
          removedCount += originalCount - container.tasks.length;
        }
      }

      if (containersData.summary) {
        containersData.summary.early_out = containersData.containers.early_out?.count || 0;
        containersData.summary.high_priority = containersData.containers.high_priority?.count || 0;
        containersData.summary.low_priority = containersData.containers.low_priority?.count || 0;
        containersData.summary.total_tasks =
          containersData.summary.early_out +
          containersData.summary.high_priority +
          containersData.summary.low_priority;
      }

      const restoredManual = restoreManualCleaningTimeOverrides(
        containersData,
        manualOverrides
      );
      if (restoredManual > 0) {
        console.log(
          `🔒 Restore durata WASS manuale su ${restoredManual} task nei containers dopo refresh ADAM`
        );
      }

      await workspaceFiles.saveContainers(
        workDate,
        containersData,
        modifiedBy,
        'containers_synced_from_adam',
        workflow
      );

      const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
      await pgDailyAssignmentsService.saveContainersToHistory(
        workDate,
        modifiedBy,
        'containers_synced_from_adam'
      );

      console.log(
        `✅ Containers sincronizzati: rimosse ${removedCount} task già assegnate, salvati su PostgreSQL`
      );
    } else {
      containersData = await workspaceFiles.loadContainers(workDate, workflow);
    }

    if (mode === 'assignments') {
      const assignmentSync = await syncTimelineAssignmentsFromAdam(
        workDate,
        modifiedBy,
        workflow
      );

      if (!assignmentSync.success) {
        return {
          success: false,
          containersData,
          removedCount,
          mode,
          assignmentSync,
          error: assignmentSync.error || 'Errore sync assegnazioni da ADAM',
        };
      }

      // Re-load containers after assignment sync may have changed them
      containersData = await workspaceFiles.loadContainers(workDate, workflow);

      return {
        success: true,
        containersData,
        removedCount,
        mode,
        assignmentSync,
      };
    }

    return {
      success: true,
      containersData,
      removedCount,
      mode,
    };
  } catch (error: any) {
    console.error('❌ Errore nella rigenerazione containers:', error);
    return {
      success: false,
      containersData: null,
      removedCount: 0,
      mode,
      error: error.message,
    };
  }
}
