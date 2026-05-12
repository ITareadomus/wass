import { exec } from 'child_process';
import path from 'path';
import * as workspaceFiles from './workspace-files';

export interface RefreshContainersResult {
  success: boolean;
  containersData: any;
  removedCount: number;
  error?: string;
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

    await workspaceFiles.saveLogisticsContainers(workDate, containersData);
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveLogisticsContainersToHistory(
      workDate,
      modifiedBy,
      'logistics_synced_from_adam'
    );
    console.log(`✅ Logistics containers sincronizzati per ${workDate}`);

    return {
      success: true,
      containersData,
      removedCount: 0,
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
  workflow: 'housekeeping' | 'office' = 'housekeeping'
): Promise<RefreshContainersResult> {
  console.log(`🔄 refreshContainersFromAdam: Rigenerazione containers dal DB ADAM per ${workDate}...`);

  try {
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

    let containersData = await workspaceFiles.loadContainers(workDate);
    
    if (!containersData) {
      containersData = {
        containers: { 
          early_out: { tasks: [], count: 0 }, 
          high_priority: { tasks: [], count: 0 }, 
          low_priority: { tasks: [], count: 0 } 
        },
        summary: { early_out: 0, high_priority: 0, low_priority: 0, total_tasks: 0 },
        metadata: { date: workDate }
      };
    }
    
    console.log(`✅ Containers rigenerati dal DB ADAM per ${workDate}`);

    const timelineData = await workspaceFiles.loadTimeline(workDate);
    
    const assignedTaskIds = new Set<number>();
    if (timelineData?.cleaners_assignments) {
      for (const cleanerEntry of timelineData.cleaners_assignments) {
        for (const task of cleanerEntry.tasks || []) {
          assignedTaskIds.add(task.task_id);
        }
      }
    }

    console.log(`🔍 Task assegnate trovate in timeline: ${assignedTaskIds.size}`);

    let removedCount = 0;
    for (const containerType of ['early_out', 'high_priority', 'low_priority']) {
      const container = containersData.containers?.[containerType];
      if (container?.tasks) {
        const originalCount = container.tasks.length;
        container.tasks = container.tasks.filter((t: any) => !assignedTaskIds.has(t.task_id));
        container.count = container.tasks.length;
        removedCount += (originalCount - container.tasks.length);
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

    await workspaceFiles.saveContainers(workDate, containersData, modifiedBy, 'containers_synced_from_adam');
    
    // Save to history for auditing
    const { pgDailyAssignmentsService } = await import('./pg-daily-assignments-service');
    await pgDailyAssignmentsService.saveContainersToHistory(workDate, modifiedBy, 'containers_synced_from_adam');
    
    console.log(`✅ Containers sincronizzati: rimosse ${removedCount} task già assegnate, salvati su PostgreSQL`);

    return {
      success: true,
      containersData,
      removedCount
    };
  } catch (error: any) {
    console.error('❌ Errore nella rigenerazione containers:', error);
    return {
      success: false,
      containersData: null,
      removedCount: 0,
      error: error.message
    };
  }
}
