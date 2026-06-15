import { minutesToHm } from "../../../shared/logistics-scheduling-constraints";
import { computeBagPolicy } from "../logistics-optimizer/bag-rule";
import {
  assertLogisticsTimelineValidAfterRecalc,
  buildFinalTimelineValidation,
  type LogisticsFinalTimelineValidation,
  writeFinalTimelineValidationDebugFile,
} from "../logistics-optimizer/apply-validation";
import { recalculateLogisticsTimeline } from "../logistics-timeline-utils";
import { pgDailyAssignmentsService } from "../pg-daily-assignments-service";
import {
  loadLogisticsContainers,
  loadLogisticsTimeline,
  saveLogisticsContainers,
  saveLogisticsTimeline,
} from "../workspace-files";
import type { RoutingProblemInput } from "./input-contract";
import { assertSolutionCanBeApplied } from "./solution-apply-gate";
import type { RoutingSolution, RoutingStopSolution } from "./solution-contract";
import { assertRoutingProblemInputValid } from "./validation";

const TIMELINE_ACTOR = "optimizer-logistics";
const TIMELINE_REASON = "optimizer_auto_assign";

export interface ApplyRoutingSolutionResult {
  applied: boolean;
  insertedTasks: number;
  removedFromContainers: number;
  totalTasksOnTimeline: number;
  preservedOutsideSolverInputTasks: number;
  preservedUnassignedRoutingTasks: number;
  /** @deprecated Use preservedOutsideSolverInputTasks */
  preservedContainerLockedTasks: number;
  finalValidation: LogisticsFinalTimelineValidation;
}

export interface ApplyLogisticsRoutingSolutionArgs {
  workDate: string;
  input: RoutingProblemInput;
  solution: RoutingSolution;
  performedBy?: string;
  allowPartial?: boolean;
  debugDir?: string;
}

function ensureArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
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

function resolveTaskCleanerId(
  taskId: number,
  task: any,
  driverId: number | null,
  cleanerIdByTaskId: Map<number, number>
): number | null {
  if (Number.isFinite(taskId) && cleanerIdByTaskId.has(taskId)) {
    return cleanerIdByTaskId.get(taskId)!;
  }
  const candidate = Number(task?.cleaner_id ?? task?.cleanerId);
  if (Number.isFinite(candidate)) return candidate;
  return Number.isFinite(driverId) ? Number(driverId) : null;
}

function resolveTaskCleanerSequence(
  taskId: number,
  task: any,
  cleanerSequenceByTaskId: Map<number, number>
): number | null {
  if (Number.isFinite(taskId) && cleanerSequenceByTaskId.has(taskId)) {
    return cleanerSequenceByTaskId.get(taskId)!;
  }
  const candidate = Number(task?.cleaner_sequence ?? task?.cleanerSequence);
  return Number.isFinite(candidate) ? candidate : null;
}

function buildTimelineTaskFromStop(args: {
  stop: RoutingStopSolution;
  inputTask: RoutingProblemInput["tasks"][number] | undefined;
  containerTask: any;
}): any {
  const { stop, inputTask, containerTask } = args;
  const taskId = stop.taskId;
  const logisticCode = Number(
    inputTask?.logisticCode ?? containerTask.logistic_code ?? 0
  );

  return {
    task_id: taskId,
    logistic_code: logisticCode,
    client_id: containerTask.client_id != null ? Number(containerTask.client_id) : null,
    premium: Boolean(containerTask.premium),
    address: containerTask.address || "",
    lat:
      containerTask.lat != null
        ? Number(containerTask.lat)
        : inputTask?.location.lat ?? null,
    lng:
      containerTask.lng != null
        ? Number(containerTask.lng)
        : inputTask?.location.lng ?? null,
    cleaning_time:
      containerTask.cleaning_time != null ? Number(containerTask.cleaning_time) : 15,
    base_cleaning_time:
      containerTask.base_cleaning_time != null
        ? Number(containerTask.base_cleaning_time)
        : containerTask.cleaning_time != null
          ? Number(containerTask.cleaning_time)
          : 15,
    checkin_date: containerTask.checkin_date || inputTask?.rawTimes.checkinDate || null,
    checkout_date: containerTask.checkout_date || inputTask?.rawTimes.checkoutDate || null,
    checkin_time: containerTask.checkin_time || inputTask?.rawTimes.checkinTime || null,
    checkout_time: containerTask.checkout_time || inputTask?.rawTimes.checkoutTime || null,
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
    straordinaria:
      containerTask.straordinaria != null ? Boolean(containerTask.straordinaria) : null,
    type_apt: containerTask.type_apt || null,
    alias: containerTask.alias || null,
    customer_name: containerTask.customer_name || null,
    customer_reference: containerTask.customer_reference || null,
    customer_note: containerTask.customer_note || null,
    customer_note_history: Array.isArray(containerTask.customer_note_history)
      ? containerTask.customer_note_history
      : [],
    reasons: Array.isArray(containerTask.reasons) ? containerTask.reasons : [],
    priority: containerTask.priority || inputTask?.priority || null,
    start_time: minutesToHm(stop.startMin),
    end_time: minutesToHm(stop.endMin),
    sequence: stop.sequence,
    travel_time: Number(stop.travelFromPreviousMin || 0),
    checkout_wait_minutes: Number(stop.waitMin || 0),
    manually_moved: false,
  };
}

export async function applyLogisticsRoutingSolution(
  args: ApplyLogisticsRoutingSolutionArgs
): Promise<ApplyRoutingSolutionResult> {
  const { workDate, input, solution, allowPartial, debugDir } = args;

  assertSolutionCanBeApplied(solution, { allowPartial });
  assertRoutingProblemInputValid(input, { mode: "apply" });

  const selectedDriverIds = input.drivers.map((driver) => driver.id).filter((id) => Number.isFinite(id));
  const [driverRows, containersData, currentTimeline] = await Promise.all([
    pgDailyAssignmentsService.loadLgDriversByIds(selectedDriverIds, workDate),
    loadLogisticsContainers(workDate),
    loadLogisticsTimeline(workDate),
  ]);

  const driverById = new Map<number, any>(
    ensureArray(driverRows).map((row: any) => [Number(row.id), row])
  );
  const inputTaskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const routingTaskIds = new Set(input.tasks.map((task) => task.taskId));

  const cleanerIdByTaskId = new Map<number, number>(
    input.tasks
      .map((task) => [task.taskId, Number(task.groupingHints.cleanerId)] as const)
      .filter(([taskId, cleanerId]) => Number.isFinite(taskId) && Number.isFinite(cleanerId))
  );
  const cleanerSequenceByTaskId = new Map<number, number>(
    input.tasks
      .map((task) => [task.taskId, Number(task.groupingHints.cleanerSequence)] as const)
      .filter(([taskId, cleanerSequence]) => Number.isFinite(taskId) && Number.isFinite(cleanerSequence))
  );

  for (const da of ensureArray(currentTimeline?.drivers_assignments)) {
    for (const task of ensureArray(da?.tasks)) {
      const taskId = Number(task?.task_id);
      const cleanerSequence = Number(task?.cleaner_sequence ?? task?.cleanerSequence);
      if (!Number.isFinite(taskId) || !Number.isFinite(cleanerSequence)) continue;
      if (!cleanerSequenceByTaskId.has(taskId)) {
        cleanerSequenceByTaskId.set(taskId, cleanerSequence);
      }
    }
  }

  const taskById = flattenContainerTasks(containersData);

  const solverAssignedTaskIds = new Set<number>();
  for (const route of solution.routes) {
    for (const stop of route.stops) {
      if (Number.isFinite(stop.taskId)) {
        solverAssignedTaskIds.add(stop.taskId);
      }
    }
  }

  let preservedOutsideSolverInputTasks = 0;
  let preservedUnassignedRoutingTasks = 0;
  const preservedByDriver = new Map<number, any[]>();
  for (const da of ensureArray(currentTimeline?.drivers_assignments)) {
    const driverId = Number(da?.driver?.id);
    if (!Number.isFinite(driverId)) continue;
    const preserved = ensureArray(da?.tasks).filter((task: any) => {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId)) return false;
      if (solverAssignedTaskIds.has(taskId)) return false;
      if (!routingTaskIds.has(taskId)) {
        preservedOutsideSolverInputTasks += 1;
        return true;
      }
      preservedUnassignedRoutingTasks += 1;
      return true;
    });
    if (preserved.length > 0) {
      preservedByDriver.set(driverId, preserved);
    }
  }

  const driverAssignments = new Map<number, { driver: any; tasks: any[] }>();

  for (const route of solution.routes) {
    const driverId = route.driverId;
    if (!Number.isFinite(driverId)) continue;
    const driverRow = driverById.get(driverId);
    const inputDriver = input.drivers.find((driver) => driver.id === driverId);
    const driver = {
      id: driverId,
      name: driverRow?.name ?? "Driver",
      lastname: driverRow?.lastname ?? String(driverId),
      role: driverRow?.role ?? "Driver",
      premium: driverRow?.role === "Premium",
      start_time:
        driverRow?.start_time ??
        (inputDriver ? minutesToHm(inputDriver.workWindow.startMin) : "10:00"),
    };

    const preservedTasks = [...(preservedByDriver.get(driverId) || [])].sort(
      (a: any, b: any) => Number(a?.sequence || 0) - Number(b?.sequence || 0)
    );

    const optimizedTasks = [...route.stops]
      .sort((a, b) => a.sequence - b.sequence)
      .map((stop) =>
        buildTimelineTaskFromStop({
          stop,
          inputTask: inputTaskById.get(stop.taskId),
          containerTask: taskById.get(stop.taskId) || {},
        })
      );

    const sortedFinalTasks = [...preservedTasks, ...optimizedTasks]
      .map((task: any, originalIndex: number) => ({ task, originalIndex }))
      .sort((a, b) => {
        const diff = Number(a.task?.sequence || 0) - Number(b.task?.sequence || 0);
        if (diff !== 0) return diff;
        return a.originalIndex - b.originalIndex;
      })
      .map((entry) => entry.task);

    const combined = sortedFinalTasks.map((task: any, idx: number) => {
      const sequence = idx + 1;
      const taskId = Number(task?.task_id);
      const cleanerId = resolveTaskCleanerId(taskId, task, driverId, cleanerIdByTaskId);
      const cleanerSequence = resolveTaskCleanerSequence(taskId, task, cleanerSequenceByTaskId);
      return {
        ...task,
        sequence,
        followup: idx > 0,
        bag_policy: computeBagPolicy({
          cleanerId,
          sequence: cleanerSequence,
          premium: task?.premium === true,
          paxIn: task?.pax_in,
        }),
      };
    });

    if (combined.length > 0) {
      driverAssignments.set(driverId, { driver, tasks: combined });
    }
  }

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
          .map((task: any, idx: number) => {
            const sequence = idx + 1;
            const taskId = Number(task?.task_id);
            const cleanerId = resolveTaskCleanerId(taskId, task, driverId, cleanerIdByTaskId);
            const cleanerSequence = resolveTaskCleanerSequence(taskId, task, cleanerSequenceByTaskId);
            return {
              ...task,
              sequence,
              followup: idx > 0,
              bag_policy: computeBagPolicy({
                cleanerId,
                sequence: cleanerSequence,
                premium: task?.premium === true,
                paxIn: task?.pax_in,
              }),
            };
          }),
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
  const insertedTasks = solverAssignedTaskIds.size;

  const timeline = {
    metadata: {
      date: workDate,
      generated_by: "logistics_optimizer_final",
    },
    drivers_assignments,
    meta: {
      total_drivers: drivers_assignments.length,
      used_drivers: drivers_assignments.filter((entry) => ensureArray(entry.tasks).length > 0).length,
      assigned_tasks: totalTasksOnTimeline,
    },
  };

  await recalculateLogisticsTimeline(timeline, workDate);

  const finalValidation = buildFinalTimelineValidation(timeline, workDate);
  if (debugDir) {
    await writeFinalTimelineValidationDebugFile(debugDir, finalValidation);
  }
  assertLogisticsTimelineValidAfterRecalc(finalValidation);

  const saved = await saveLogisticsTimeline(
    workDate,
    timeline,
    false,
    TIMELINE_ACTOR,
    TIMELINE_REASON
  );

  if (!saved) {
    throw new Error("Impossibile salvare la timeline logistica su PostgreSQL");
  }

  let removedFromContainers = 0;
  if (containersData?.containers) {
    try {
      await pgDailyAssignmentsService.saveLogisticsContainersToHistory(
        workDate,
        TIMELINE_ACTOR,
        TIMELINE_REASON
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
        return !Number.isFinite(taskId) || !solverAssignedTaskIds.has(taskId);
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

    const containersSaved = await saveLogisticsContainers(
      workDate,
      containersData,
      TIMELINE_ACTOR,
      TIMELINE_REASON
    );
    if (!containersSaved) {
      throw new Error("Impossibile aggiornare i containers logistici dopo l'optimizer");
    }
  }

  return {
    applied: true,
    insertedTasks,
    totalTasksOnTimeline,
    removedFromContainers,
    preservedOutsideSolverInputTasks,
    preservedUnassignedRoutingTasks,
    preservedContainerLockedTasks: preservedOutsideSolverInputTasks,
    finalValidation,
  };
}
