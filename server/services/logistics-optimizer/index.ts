import { runLogisticsPhase0, LogisticsPhase0Result } from "./phase0";
import { runLogisticsPhase1, LogisticsPhase1Result } from "./phase1";
import { LogisticsPhase2Result, runLogisticsPhase2 } from "./phase2";
import { pgDailyAssignmentsService } from "../pg-daily-assignments-service";
import {
  loadLogisticsContainers,
  loadLogisticsTimeline,
  saveLogisticsContainers,
  saveLogisticsTimeline,
} from "../workspace-files";

export interface LogisticsOptimizerRunResult extends LogisticsPhase0Result {
  phase1: LogisticsPhase1Result;
  phase2: LogisticsPhase2Result;
  apply: LogisticsOptimizerApplyResult;
}

export interface LogisticsOptimizerApplyResult {
  applied: boolean;
  insertedTasks: number;
  totalTasksOnTimeline: number;
  removedFromContainers: number;
}

function toTaskIdSet(tasks: Array<{ taskId: number }>): Set<number> {
  return new Set(tasks.map((task) => Number(task.taskId)).filter((id) => Number.isFinite(id)));
}

function flattenContainerTasks(containersData: any): Map<number, any> {
  const byTaskId = new Map<number, any>();
  const allTasks = [
    ...(containersData?.containers?.early_out?.tasks || []),
    ...(containersData?.containers?.high_priority?.tasks || []),
    ...(containersData?.containers?.low_priority?.tasks || []),
  ];
  for (const task of allTasks) {
    const taskId = Number(task?.task_id);
    if (!Number.isFinite(taskId)) continue;
    byTaskId.set(taskId, task);
  }
  return byTaskId;
}

function ensureArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

async function applyLogisticsOptimizerResult(
  workDate: string,
  phase0: LogisticsPhase0Result,
  phase1: LogisticsPhase1Result,
  phase2: LogisticsPhase2Result
): Promise<LogisticsOptimizerApplyResult> {
  const selectedDriverIds = phase1.selectedDrivers.map((driver) => Number(driver.id)).filter((id) => Number.isFinite(id));
  const [driverRows, containersData, currentTimeline] = await Promise.all([
    pgDailyAssignmentsService.loadLgDriversByIds(selectedDriverIds, workDate),
    loadLogisticsContainers(workDate),
    loadLogisticsTimeline(workDate),
  ]);

  const driverById = new Map<number, any>(
    ensureArray(driverRows).map((row: any) => [Number(row.id), row])
  );
  const taskById = flattenContainerTasks(containersData);
  const unlockedTaskIds = toTaskIdSet(phase0.unlockedTaskData);

  const optimizerTaskIds = new Set<number>();
  for (const driverPlan of phase2.driverPlans) {
    for (const assignment of driverPlan.assignments || []) {
      const taskId = Number(assignment.taskId);
      if (Number.isFinite(taskId)) optimizerTaskIds.add(taskId);
    }
  }

  // Preserve tasks that optimizer did not schedule (manual/locked/already present).
  const preservedByDriver = new Map<number, any[]>();
  for (const da of ensureArray(currentTimeline?.drivers_assignments)) {
    const driverId = Number(da?.driver?.id);
    if (!Number.isFinite(driverId)) continue;
    const preserved = ensureArray(da?.tasks).filter((task: any) => {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId)) return false;
      if (optimizerTaskIds.has(taskId)) return false;
      if (!unlockedTaskIds.has(taskId)) return true;
      return true;
    });
    if (preserved.length > 0) {
      preservedByDriver.set(driverId, preserved);
    }
  }

  const driverAssignments = new Map<number, { driver: any; tasks: any[] }>();

  for (const plan of phase2.driverPlans) {
    const driverId = Number(plan.driverId);
    if (!Number.isFinite(driverId)) continue;
    const driverRow = driverById.get(driverId);
    const driver = {
      id: driverId,
      name: driverRow?.name ?? "Driver",
      lastname: driverRow?.lastname ?? String(driverId),
      role: driverRow?.role ?? "Driver",
      premium: driverRow?.role === "Premium",
      start_time: driverRow?.start_time ?? plan.driverStartTime ?? "10:00",
    };

    const preservedTasks = [...(preservedByDriver.get(driverId) || [])].sort(
      (a: any, b: any) => Number(a?.sequence || 0) - Number(b?.sequence || 0)
    );

    const optimizedTasks = [...(plan.assignments || [])]
      .sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0))
      .map((assignment: any) => {
        const taskId = Number(assignment.taskId);
        const containerTask = taskById.get(taskId) || {};
        const logisticCode = Number(assignment.logisticCode || containerTask.logistic_code || 0);
        return {
          task_id: taskId,
          logistic_code: logisticCode,
          client_id: containerTask.client_id != null ? Number(containerTask.client_id) : null,
          premium: Boolean(containerTask.premium),
          address: containerTask.address || "",
          lat: containerTask.lat != null ? Number(containerTask.lat) : null,
          lng: containerTask.lng != null ? Number(containerTask.lng) : null,
          cleaning_time:
            containerTask.cleaning_time != null ? Number(containerTask.cleaning_time) : 15,
          base_cleaning_time:
            containerTask.base_cleaning_time != null
              ? Number(containerTask.base_cleaning_time)
              : containerTask.cleaning_time != null
                ? Number(containerTask.cleaning_time)
                : 15,
          checkin_date: containerTask.checkin_date || null,
          checkout_date: containerTask.checkout_date || null,
          checkin_time: containerTask.checkin_time || null,
          checkout_time: containerTask.checkout_time || null,
          pax_in: containerTask.pax_in != null ? Number(containerTask.pax_in) : null,
          pax_out: containerTask.pax_out != null ? Number(containerTask.pax_out) : null,
          small_equipment:
            containerTask.small_equipment != null ? Boolean(containerTask.small_equipment) : null,
          operation_id:
            containerTask.operation_id != null ? Number(containerTask.operation_id) : null,
          confirmed_operation:
            containerTask.confirmed_operation != null
              ? Boolean(containerTask.confirmed_operation)
              : null,
          straordinaria: containerTask.straordinaria != null ? Boolean(containerTask.straordinaria) : null,
          type_apt: containerTask.type_apt || null,
          alias: containerTask.alias || null,
          customer_name: containerTask.customer_name || null,
          customer_reference: containerTask.customer_reference || null,
          customer_note: containerTask.customer_note || null,
          customer_note_history: Array.isArray(containerTask.customer_note_history)
            ? containerTask.customer_note_history
            : [],
          reasons: Array.isArray(containerTask.reasons) ? containerTask.reasons : [],
          priority: containerTask.priority || null,
          start_time: assignment.startTime || null,
          end_time: assignment.endTime || null,
          sequence: Number(assignment.sequence || 0),
          travel_time: Number(assignment.travelMinutes || 0),
          manually_moved: false,
        };
      });

    const combined = [...preservedTasks, ...optimizedTasks].map((task: any, idx: number) => ({
      ...task,
      sequence: idx + 1,
      followup: idx > 0,
    }));

    if (combined.length > 0) {
      driverAssignments.set(driverId, { driver, tasks: combined });
    }
  }

  // Keep untouched drivers that are outside optimizer output.
  for (const da of ensureArray(currentTimeline?.drivers_assignments)) {
    const driverId = Number(da?.driver?.id);
    if (!Number.isFinite(driverId)) continue;
    if (driverAssignments.has(driverId)) continue;
    const tasks = ensureArray(da?.tasks);
    if (tasks.length > 0) {
      driverAssignments.set(driverId, {
        driver: da.driver,
        tasks: tasks
          .slice()
          .sort((a: any, b: any) => Number(a?.sequence || 0) - Number(b?.sequence || 0))
          .map((task: any, idx: number) => ({
            ...task,
            sequence: idx + 1,
            followup: idx > 0,
          })),
      });
    }
  }

  const drivers_assignments = Array.from(driverAssignments.values()).sort(
    (a, b) => Number(a.driver?.id || 0) - Number(b.driver?.id || 0)
  );
  const totalTasksOnTimeline = drivers_assignments.reduce(
    (sum, entry) => sum + ensureArray(entry.tasks).length,
    0
  );
  const insertedTasks = optimizerTaskIds.size;

  const timeline = {
    metadata: {
      date: workDate,
      generated_by: "logistics_optimizer",
    },
    drivers_assignments,
    meta: {
      total_drivers: drivers_assignments.length,
      used_drivers: drivers_assignments.filter((entry) => ensureArray(entry.tasks).length > 0).length,
      assigned_tasks: totalTasksOnTimeline,
    },
  };

  const saved = await saveLogisticsTimeline(
    workDate,
    timeline,
    false,
    "optimizer-logistics",
    "optimizer_auto_assign"
  );

  if (!saved) {
    throw new Error("Impossibile salvare la timeline logistica su PostgreSQL");
  }

  let removedFromContainers = 0;
  if (containersData?.containers) {
    try {
      await pgDailyAssignmentsService.saveLogisticsContainersToHistory(
        workDate,
        "optimizer-logistics",
        "optimizer_auto_assign"
      );
    } catch {
      // Non bloccare l'apply se lo snapshot history fallisce.
    }

    for (const [, containerAny] of Object.entries(containersData.containers)) {
      const container = containerAny as { tasks?: any[]; count?: number };
      if (!Array.isArray(container.tasks)) continue;
      const prevLen = container.tasks.length;
      container.tasks = container.tasks.filter((task: any) => {
        const taskId = Number(task?.task_id);
        return !Number.isFinite(taskId) || !optimizerTaskIds.has(taskId);
      });
      removedFromContainers += prevLen - container.tasks.length;
      container.count = container.tasks.length;
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

    const containersSaved = await saveLogisticsContainers(workDate, containersData, "optimizer-logistics", "optimizer_auto_assign");
    if (!containersSaved) {
      throw new Error("Impossibile aggiornare i containers logistici dopo l'optimizer");
    }
  }

  return {
    applied: true,
    insertedTasks,
    totalTasksOnTimeline,
    removedFromContainers,
  };
}

export async function runLogisticsOptimizer(workDate: string): Promise<LogisticsOptimizerRunResult> {
  const phase0 = await runLogisticsPhase0(workDate);
  const phase1 = await runLogisticsPhase1(workDate, phase0.unlockedTaskData);
  const phase2 = await runLogisticsPhase2(workDate, phase0.unlockedTaskData, phase1);
  const canRun = phase0.canRun && phase1.canRun && phase2.canRun;
  const apply = canRun
    ? await applyLogisticsOptimizerResult(workDate, phase0, phase1, phase2)
    : { applied: false, insertedTasks: 0, totalTasksOnTimeline: 0, removedFromContainers: 0 };

  return {
    ...phase0,
    canRun,
    phase1,
    phase2,
    apply,
  };
}
