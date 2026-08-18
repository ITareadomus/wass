import { exec } from 'child_process';
import path from 'path';
import * as workspaceFiles from './workspace-files';
import {
  syncTimelineAssignmentsFromAdam,
  type AssignmentSyncResult,
  type RefreshSyncMode,
} from './adam-timeline-assignment-sync';

export interface RefreshContainersResult {
  success: boolean;
  containersData: any;
  removedCount: number;
  error?: string;
  mode?: RefreshSyncMode;
  assignmentSync?: AssignmentSyncResult;
  needsUnlockConfirm?: boolean;
  lockedTasks?: AssignmentSyncResult['lockedTasks'];
}

const CREATE_CONTAINERS_TIMEOUT_MS = 120000;

/** Logistics: create_containers.py --workflow logistics → daily_logistics_* */
export async function refreshLogisticsContainersFromAdam(
  workDate: string,
  modifiedBy: string = 'system'
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

    // Come housekeeping: togli dai containers i task già presenti in timeline.
    const timelineData = await workspaceFiles.loadLogisticsTimeline(workDate);
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
    for (const containerType of ['early_out', 'high_priority', 'low_priority'] as const) {
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
    confirmUnlockLocked?: boolean;
    /** Skip create_containers (e.g. unlock retry after apt already refreshed). */
    skipContainersRefresh?: boolean;
  } = {}
): Promise<RefreshContainersResult> {
  const mode: RefreshSyncMode = options.mode === 'assignments' ? 'assignments' : 'apt';
  console.log(
    `🔄 refreshContainersFromAdam: ${workDate} mode=${mode} unlock=${Boolean(options.confirmUnlockLocked)}`
  );

  try {
    let containersData: any = null;
    let removedCount = 0;

    if (!options.skipContainersRefresh) {
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
        workflow,
        { confirmUnlockLocked: options.confirmUnlockLocked }
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

      if (assignmentSync.needsUnlockConfirm) {
        return {
          success: true,
          containersData,
          removedCount,
          mode,
          assignmentSync,
          needsUnlockConfirm: true,
          lockedTasks: assignmentSync.lockedTasks,
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
