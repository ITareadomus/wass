import { LOGISTICS_SERVICE_DURATION_MIN, parseHmToMinutes } from "../../../shared/logistics-scheduling-constraints";
import type {
  DriverNode,
  HardConstraintSpec,
  RoutingProblemInput,
  RoutingProblemMetadata,
  SoftConstraintSpec,
  TaskNode,
} from "./input-contract";
import { resolveBagHandlingModeWithTrace } from "./bag-handling";
import {
  loadLogisticsRoutingSourceData,
  type LogisticsRoutingSourceData,
  type SchedulableLogisticsTaskInput,
} from "./loaders";
import { normalizePriority } from "./normalizers";
import { buildTaskWindow } from "./windows";
import { buildDepotNode, buildLocationNodes, buildTravelMatrixMin } from "./travel-matrix";
import { validateRoutingProblemInput } from "./validation";

function buildDriverNodes(sourceData: LogisticsRoutingSourceData): DriverNode[] {
  return sourceData.selectedDrivers.map((driver) => {
    const startMin = parseHmToMinutes(driver.startTime, 10 * 60) ?? 10 * 60;
    const endMin = parseHmToMinutes(driver.endTime, 20 * 60) ?? 20 * 60;
    return {
      id: driver.id,
      startLocationNodeId: "depot",
      workWindow: {
        startMin,
        endMin,
        startSource: driver.startTimeSource,
        endSource: driver.endTimeSource,
      },
      selected: true,
    };
  });
}

function buildTaskNode(args: {
  taskData: SchedulableLogisticsTaskInput;
  nodeIndex: number;
  workDate: string;
  sourceData: LogisticsRoutingSourceData;
}): { task: TaskNode; hardConstraints: HardConstraintSpec[]; softWindows: SoftConstraintSpec[] } {
  const { taskData, nodeIndex, workDate, sourceData } = args;
  const priority = normalizePriority(taskData.priority);
  const bagHandling = resolveBagHandlingModeWithTrace({
    cleanerId: taskData.cleanerId,
    cleanerSequence: taskData.cleanerSequence,
    isPremium: taskData.premium,
    paxIn: taskData.paxIn,
  });
  const builtWindow = buildTaskWindow({
    taskId: taskData.taskId,
    priority,
    bagHandling: bagHandling.value,
    workDate,
    cleaningTime: taskData.cleaningTime,
    checkoutDate: taskData.checkoutDate,
    checkoutTime: taskData.checkoutTime,
    checkinDate: taskData.checkinDate,
    checkinTime: taskData.checkinTime,
    cleanerStartTime: taskData.cleanerStartTime,
    cleanerTaskStartTime: taskData.cleanerTaskStartTime,
    priorityWindows: sourceData.windowConfig.priorityWindows,
  });

  const softWindows: SoftConstraintSpec[] = builtWindow.softWindows
    .filter((window) => window.type === "preferred_start" && window.startMin !== undefined)
    .map((window) => ({
      type: "PREFERRED_PRIORITY_WINDOW" as const,
      taskId: taskData.taskId,
      startMin: window.startMin!,
      endMin: window.endMin,
      penaltyPerMinOutside: window.penaltyPerMin ?? 1,
    }));

  return {
    task: {
      taskId: taskData.taskId,
      logisticCode: taskData.logisticCode,
      nodeIndex,
      location: {
        lat: taskData.lat,
        lng: taskData.lng,
        addressGroupId: null,
      },
      priority,
      bagHandling: bagHandling.value,
      serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
      rawTimes: {
        checkoutDate: taskData.checkoutDate,
        checkoutTime: taskData.checkoutTime,
        checkinDate: taskData.checkinDate,
        checkinTime: taskData.checkinTime,
        cleanerStartTime: taskData.cleanerStartTime,
        cleanerTaskStartTime: taskData.cleanerTaskStartTime,
      },
      hardWindow: builtWindow.hardWindow,
      softWindows: builtWindow.softWindows,
      debug: {
        ruleTrace: [...bagHandling.trace, ...builtWindow.ruleTrace],
        sourceTimes: builtWindow.sourceTimes,
      },
      groupingHints: {
        cleanerId: taskData.cleanerId,
        cleanerSequence: taskData.cleanerSequence,
        addressGroupId: null,
        sameLogisticCodeGroup: Number.isFinite(taskData.logisticCode) ? taskData.logisticCode : null,
      },
      eligibility: {
        schedulable: true,
        exclusionReasons: [],
      },
    },
    hardConstraints: builtWindow.hardConstraints,
    softWindows,
  };
}

function buildTaskNodes(sourceData: LogisticsRoutingSourceData, workDate: string): {
  tasks: TaskNode[];
  hardConstraints: HardConstraintSpec[];
  softConstraints: SoftConstraintSpec[];
} {
  const tasks: TaskNode[] = [];
  const hardConstraints: HardConstraintSpec[] = [];
  const softConstraints: SoftConstraintSpec[] = [
    { type: "MINIMIZE_TOTAL_TRAVEL", weight: 1 },
    { type: "BALANCE_DRIVER_LOAD", weight: 1 },
  ];

  sourceData.schedulableTasks.forEach((taskData, index) => {
    const builtTask = buildTaskNode({
      taskData,
      nodeIndex: index + 1,
      workDate,
      sourceData,
    });
    tasks.push(builtTask.task);
    hardConstraints.push(...builtTask.hardConstraints);
    softConstraints.push(...builtTask.softWindows);
  });

  return { tasks, hardConstraints, softConstraints };
}

function buildDriverConstraints(drivers: DriverNode[]): HardConstraintSpec[] {
  return drivers.map((driver) => ({
    type: "DRIVER_WORK_WINDOW" as const,
    driverId: driver.id,
    startMin: driver.workWindow.startMin,
    endMin: driver.workWindow.endMin,
  }));
}

function buildMetadata(sourceData: LogisticsRoutingSourceData): RoutingProblemMetadata {
  const noCoordinateIds = sourceData.tasksExcludedNoCoordinatesIds;
  const lockedTasks = sourceData.allTaskData.filter((task) => task.locked);
  const existingLockedAssignments = sourceData.existingLockedAssignments;
  return {
    generatedAt: new Date().toISOString(),
    totalLogisticsTasks: sourceData.allTaskData.length,
    lockedTasksExcluded: sourceData.lockedTasksExcluded,
    tasksExcludedNoCoordinatesCount: noCoordinateIds.length,
    tasksExcludedNoCoordinatesIds: noCoordinateIds,
    noSelectedDrivers: sourceData.selectedDrivers.length === 0,
    existingLockedAssignments,
    existingLockedAssignmentsCount: existingLockedAssignments.length,
    lockedAssignmentsSolverIntegration: "pending",
    excludedTasks: [
      ...lockedTasks.map((task) => ({
        taskId: task.taskId,
        reason: "LOCKED" as const,
        detail: task.lockedReason,
      })),
      ...noCoordinateIds.map((taskId) => ({
        taskId,
        reason: "NO_COORDINATES" as const,
      })),
    ],
    validation: {
      valid: true,
      errors: [],
      warnings: [],
    },
  };
}

export function buildRoutingProblemInputFromSource(sourceData: LogisticsRoutingSourceData): RoutingProblemInput {
  const workDate = sourceData.workDate;
  const drivers = buildDriverNodes(sourceData);
  const { tasks, hardConstraints, softConstraints } = buildTaskNodes(sourceData, workDate);
  const nodes = buildLocationNodes(tasks);
  const metadata = buildMetadata(sourceData);

  const input: RoutingProblemInput = {
    schemaVersion: "logistics-routing-input/v1",
    workDate,
    windowConfig: sourceData.windowConfig,
    depot: buildDepotNode(),
    drivers,
    tasks,
    travelMatrixMin: buildTravelMatrixMin(nodes),
    serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
    hardConstraints: [...buildDriverConstraints(drivers), ...hardConstraints],
    softConstraints,
    metadata,
  };

  input.metadata.validation = validateRoutingProblemInput(input);
  return input;
}

export async function buildLogisticsRoutingInput(workDate: string): Promise<RoutingProblemInput> {
  const sourceData = await loadLogisticsRoutingSourceData(workDate);
  return buildRoutingProblemInputFromSource(sourceData);
}
