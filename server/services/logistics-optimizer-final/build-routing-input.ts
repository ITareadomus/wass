import { LOGISTICS_SERVICE_DURATION_MIN, parseHmToMinutes } from "../../../shared/logistics-scheduling-constraints";
import {
  resolveLogisticsTaskKind,
  type LogisticsTaskKind,
  type LogisticsTaskKindSource,
} from "../../../shared/logistics-task-kind";
import type {
  DriverNode,
  HardConstraintSpec,
  RoutingProblemInput,
  RoutingProblemMetadata,
  SoftConstraintSpec,
  TaskNode,
} from "./input-contract";
import { resolveLogisticsTaskKindModeWithTrace } from "./bag-handling";
import {
  loadLogisticsRoutingSourceData,
  type LogisticsRoutingSourceData,
  type SchedulableLogisticsTaskInput,
} from "./loaders";
import { DEFAULT_DRIVER_END_MIN, normalizePriority } from "./normalizers";
import { buildTaskWindow } from "./windows";
import {
  buildBusinessGroupSoftConstraints,
  buildBusinessGroups,
} from "./groups/build-business-groups";
import { buildDailyTerritoryAssignment } from "./groups/daily-territory-groups";
import { buildDepotNode, buildLocationNodes, buildTravelMatrixMin } from "./travel-matrix";
import { buildRequiredDriverConstraints } from "./timeline-assignment-hints";
import {
  buildRequiredDriverByTaskIdFromConstraints,
  buildSameBuildingDriverConstraints,
} from "./same-building-driver-constraints";
import {
  autoConvokeLogisticsDriversWithPreAssignedTasks,
  type AutoConvokeLogisticsDriversResult,
} from "./auto-convoke-logistics-drivers";
import { validateRoutingProblemInput } from "./validation";
import type { ValidationIssue } from "./validation-contract";

function resolveTaskLogisticsKindWithTrace(taskData: SchedulableLogisticsTaskInput): {
  value: LogisticsTaskKind | null;
  trace: NonNullable<TaskNode["debug"]>["ruleTrace"];
} {
  const persistedKind = resolveLogisticsTaskKind({
    cleanerId: taskData.cleanerId,
    cleanerSequence: taskData.cleanerSequence,
    premium: taskData.premium,
    paxIn: taskData.paxIn,
    logisticsTaskKind: taskData.logisticsTaskKind,
    logisticsTaskKindSource: taskData.logisticsTaskKindSource as LogisticsTaskKindSource | null,
  });

  if (taskData.logisticsTaskKindSource === "manual") {
    return {
      value: persistedKind,
      trace: [
        {
          code: persistedKind
            ? "MANUAL_LOGISTICS_TASK_KIND"
            : "MANUAL_LOGISTICS_TASK_KIND_CLEARED",
          value: {
            logisticsTaskKind: persistedKind,
            logisticsTaskKindSource: taskData.logisticsTaskKindSource,
          },
        },
      ],
    };
  }

  return resolveLogisticsTaskKindModeWithTrace({
    cleanerId: taskData.cleanerId,
    cleanerSequence: taskData.cleanerSequence,
    isPremium: taskData.premium,
    paxIn: taskData.paxIn,
  });
}

function buildDriverNodes(sourceData: LogisticsRoutingSourceData): DriverNode[] {
  return sourceData.selectedDrivers.map((driver) => {
    const startMin = parseHmToMinutes(driver.startTime, 10 * 60) ?? 10 * 60;
    const endMin = parseHmToMinutes(driver.endTime, 20 * 60) ?? 20 * 60;
    return {
      id: driver.id,
      startLocationNodeId: "depot",
      operationalCode: driver.operationalCode,
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

/**
 * There is no fixed "end of day" anymore: the latest a task can run, absent a
 * real business deadline (check-in, cleaner tolerance), is bounded by the
 * latest work-window end among the drivers actually available that day. This
 * keeps a driver's configurable end time meaningful instead of being silently
 * capped by a hardcoded clock value.
 */
function resolveDayEndMin(drivers: DriverNode[]): number {
  if (drivers.length === 0) return DEFAULT_DRIVER_END_MIN;
  return Math.max(...drivers.map((driver) => driver.workWindow.endMin));
}

function buildTaskNode(args: {
  taskData: SchedulableLogisticsTaskInput;
  nodeIndex: number;
  workDate: string;
  sourceData: LogisticsRoutingSourceData;
  dayEndMin: number;
}): { task: TaskNode; hardConstraints: HardConstraintSpec[]; softWindows: SoftConstraintSpec[] } {
  const { taskData, nodeIndex, workDate, sourceData, dayEndMin } = args;
  const priority = normalizePriority(taskData.priority);
  const logisticsTaskKind = resolveTaskLogisticsKindWithTrace(taskData);
  const builtWindow = buildTaskWindow({
    taskId: taskData.taskId,
    priority,
    logisticsTaskKind: logisticsTaskKind.value,
    workDate,
    cleaningTime: taskData.cleaningTime,
    checkoutDate: taskData.checkoutDate,
    checkoutTime: taskData.checkoutTime,
    checkinDate: taskData.checkinDate,
    checkinTime: taskData.checkinTime,
    cleanerStartTime: taskData.cleanerStartTime,
    cleanerTaskStartTime: taskData.cleanerTaskStartTime,
    priorityWindows: sourceData.windowConfig.priorityWindows,
    dayEndMin,
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
      premium: taskData.premium === true,
      straordinaria: taskData.straordinaria === true,
      logisticsTaskKind: logisticsTaskKind.value,
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
        ruleTrace: [...logisticsTaskKind.trace, ...builtWindow.ruleTrace],
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

function isTaskHardWindowFeasible(task: TaskNode): boolean {
  const { earliestStartMin, latestStartMin, latestEndMin } = task.hardWindow;
  if (
    !Number.isFinite(earliestStartMin) ||
    !Number.isFinite(latestStartMin) ||
    !Number.isFinite(latestEndMin)
  ) {
    return false;
  }
  if (earliestStartMin > latestStartMin) return false;
  if (latestStartMin + task.serviceDurationMin > latestEndMin) return false;
  return true;
}

function buildTaskNodes(
  sourceData: LogisticsRoutingSourceData,
  workDate: string,
  dayEndMin: number
): {
  tasks: TaskNode[];
  hardConstraints: HardConstraintSpec[];
  softConstraints: SoftConstraintSpec[];
  excludedInvalidHardWindowTasks: Array<{
    taskId: number;
    logisticCode: number | null;
    detail: string;
  }>;
} {
  const tasks: TaskNode[] = [];
  const hardConstraints: HardConstraintSpec[] = [];
  const softConstraints: SoftConstraintSpec[] = [
    { type: "MINIMIZE_TOTAL_TRAVEL", weight: 1 },
    { type: "BALANCE_DRIVER_LOAD", weight: 1 },
  ];
  const excludedInvalidHardWindowTasks: Array<{
    taskId: number;
    logisticCode: number | null;
    detail: string;
  }> = [];

  for (const taskData of sourceData.schedulableTasks) {
    const builtTask = buildTaskNode({
      taskData,
      // Temporary index; compacted after filtering infeasible windows.
      nodeIndex: tasks.length + 1,
      workDate,
      sourceData,
      dayEndMin,
    });

    if (!isTaskHardWindowFeasible(builtTask.task)) {
      const { earliestStartMin, latestStartMin, latestEndMin } = builtTask.task.hardWindow;
      excludedInvalidHardWindowTasks.push({
        taskId: builtTask.task.taskId,
        logisticCode: Number.isFinite(builtTask.task.logisticCode)
          ? builtTask.task.logisticCode
          : null,
        detail: `earliestStart=${earliestStartMin}, latestStart=${latestStartMin}, latestEnd=${latestEndMin}`,
      });
      continue;
    }

    const nodeIndex = tasks.length + 1;
    builtTask.task.nodeIndex = nodeIndex;
    for (const constraint of builtTask.hardConstraints) {
      // Constraints reference taskId, not nodeIndex — safe as-is.
      hardConstraints.push(constraint);
    }
    softConstraints.push(...builtTask.softWindows);
    tasks.push(builtTask.task);
  }

  return { tasks, hardConstraints, softConstraints, excludedInvalidHardWindowTasks };
}

function buildDriverConstraints(drivers: DriverNode[]): HardConstraintSpec[] {
  return drivers.map((driver) => ({
    type: "DRIVER_WORK_WINDOW" as const,
    driverId: driver.id,
    startMin: driver.workWindow.startMin,
    endMin: driver.workWindow.endMin,
  }));
}

function buildMetadata(args: {
  sourceData: LogisticsRoutingSourceData;
  preAssignedRequiredCount: number;
  skippedTimelineAssignmentHintsCount: number;
  sameBuildingDriverLockCount: number;
  skippedSameBuildingGroupsCount: number;
  excludedInvalidHardWindowTasks: Array<{
    taskId: number;
    logisticCode: number | null;
    detail: string;
  }>;
  autoConvokeResult?: AutoConvokeLogisticsDriversResult;
}): RoutingProblemMetadata {
  const {
    sourceData,
    preAssignedRequiredCount,
    skippedTimelineAssignmentHintsCount,
    sameBuildingDriverLockCount,
    skippedSameBuildingGroupsCount,
    excludedInvalidHardWindowTasks,
    autoConvokeResult,
  } = args;
  const autoConvokedDriverIds = autoConvokeResult?.autoConvokedDriverIds ?? [];
  const autoConvokeMissingInDbDriverIds = autoConvokeResult?.missingInDbDriverIds ?? [];
  const noCoordinateIds = sourceData.tasksExcludedNoCoordinatesIds;
  const lockedTasks = sourceData.allTaskData.filter((task) => task.locked);
  const timelineAssignmentHints = sourceData.timelineAssignmentHints;
  const invalidHardWindowIds = excludedInvalidHardWindowTasks.map((entry) => entry.taskId);
  return {
    generatedAt: new Date().toISOString(),
    totalLogisticsTasks: sourceData.allTaskData.length,
    lockedTasksExcluded: sourceData.lockedTasksExcluded,
    tasksExcludedNoCoordinatesCount: noCoordinateIds.length,
    tasksExcludedNoCoordinatesIds: noCoordinateIds,
    tasksExcludedInvalidHardWindowCount: invalidHardWindowIds.length,
    tasksExcludedInvalidHardWindowIds: invalidHardWindowIds,
    noSelectedDrivers: sourceData.selectedDrivers.length === 0,
    timelineAssignmentHints,
    timelineAssignmentHintsCount: timelineAssignmentHints.length,
    preAssignedRequiredCount,
    skippedTimelineAssignmentHintsCount,
    autoConvokedDriverIds,
    autoConvokedDriversCount: autoConvokedDriverIds.length,
    autoConvokeMissingInDbDriverIds,
    autoConvokeMissingInDbDriversCount: autoConvokeMissingInDbDriverIds.length,
    sameBuildingDriverLockCount,
    skippedSameBuildingGroupsCount,
    lockedAssignmentsSolverIntegration: "integrated_v4b",
    excludedTasks: [
      ...lockedTasks.map((task) => ({
        taskId: task.taskId,
        reason: "LOCKED" as const,
        detail: task.lockedReason,
        logisticCode: task.logisticCode,
      })),
      ...noCoordinateIds.map((taskId) => ({
        taskId,
        reason: "NO_COORDINATES" as const,
      })),
      ...excludedInvalidHardWindowTasks.map((entry) => ({
        taskId: entry.taskId,
        reason: "INVALID_HARD_WINDOW" as const,
        detail: entry.detail,
        logisticCode: entry.logisticCode,
      })),
    ],
    validation: {
      valid: true,
      errors: [],
      warnings: [],
    },
  };
}

function mergeRequiredDriverBuildErrors(
  validation: RoutingProblemMetadata["validation"],
  buildErrors: ReturnType<typeof buildRequiredDriverConstraints>["errors"]
): RoutingProblemMetadata["validation"] {
  if (buildErrors.length === 0) return validation;

  const errors: ValidationIssue[] = [...validation.errors];
  for (const buildError of buildErrors) {
    errors.push({
      severity: "error",
      code: "MULTIPLE_REQUIRED_DRIVERS_FOR_TASK",
      message: `Task ${buildError.taskId} has multiple required drivers in timeline: ${buildError.driverIds.join(", ")}`,
      taskId: buildError.taskId,
      path: "hardConstraints",
      actual: buildError.driverIds,
    });
  }

  return {
    ...validation,
    valid: false,
    errors,
  };
}

export function buildRoutingProblemInputFromSource(
  sourceData: LogisticsRoutingSourceData,
  options?: { autoConvokeResult?: AutoConvokeLogisticsDriversResult }
): RoutingProblemInput {
  const workDate = sourceData.workDate;
  const drivers = buildDriverNodes(sourceData);
  const dayEndMin = resolveDayEndMin(drivers);
  const {
    tasks,
    hardConstraints,
    softConstraints: taskSoftConstraints,
    excludedInvalidHardWindowTasks,
  } = buildTaskNodes(sourceData, workDate, dayEndMin);
  const requiredDriverBuild = buildRequiredDriverConstraints({
    hints: sourceData.timelineAssignmentHints,
    schedulableTaskIds: tasks.map((task) => task.taskId),
    selectedDriverIds: drivers.map((driver) => driver.id),
  });
  const nodes = buildLocationNodes(tasks);
  const travelMatrixMin = buildTravelMatrixMin(nodes);
  const baseBusinessGroups = buildBusinessGroups(tasks, travelMatrixMin);
  const existingRequiredDriverByTaskId = buildRequiredDriverByTaskIdFromConstraints(
    requiredDriverBuild.constraints
  );
  // Build territories from real timeline assignments only. Synthetic same-building
  // locks are derived afterwards, otherwise their local tie-break can distort the
  // territory-to-driver matching for the entire day.
  const territoryBuild = buildDailyTerritoryAssignment({
    tasks,
    drivers,
    travelMatrixMin,
    requiredDriverByTaskId: existingRequiredDriverByTaskId,
  });
  const preferredDriverByTaskId = new Map(
    territoryBuild.assignment?.taskPreferredDriverId.map((entry) => [
      entry.taskId,
      entry.driverId,
    ]) ?? []
  );
  const sameBuildingDriverBuild = buildSameBuildingDriverConstraints({
    businessGroups: baseBusinessGroups,
    tasks,
    drivers,
    travelMatrixMin,
    existingRequiredDriverByTaskId,
    preferredDriverByTaskId,
  });
  const businessGroups = [...baseBusinessGroups, ...territoryBuild.groups];
  const businessSoftConstraints = buildBusinessGroupSoftConstraints(businessGroups);
  const metadata = buildMetadata({
    sourceData,
    preAssignedRequiredCount: requiredDriverBuild.constraints.length,
    skippedTimelineAssignmentHintsCount: requiredDriverBuild.skippedHints.length,
    sameBuildingDriverLockCount: sameBuildingDriverBuild.lockedGroupCount,
    skippedSameBuildingGroupsCount: sameBuildingDriverBuild.skippedGroups.length,
    excludedInvalidHardWindowTasks,
    autoConvokeResult: options?.autoConvokeResult,
  });
  if (territoryBuild.assignment) {
    metadata.dailyTerritoryAssignment = territoryBuild.assignment;
  }

  // Final safety net: logistics never hard-locks a task to a specific driver.
  const hardConstraintsWithoutRequiredDriver = [
    ...buildDriverConstraints(drivers),
    ...hardConstraints,
    ...requiredDriverBuild.constraints,
    ...sameBuildingDriverBuild.constraints,
  ].filter((constraint) => constraint.type !== "REQUIRED_DRIVER_TASK");

  const input: RoutingProblemInput = {
    schemaVersion: "logistics-routing-input/v1",
    workDate,
    windowConfig: sourceData.windowConfig,
    depot: buildDepotNode(),
    drivers,
    tasks,
    travelMatrixMin,
    serviceDurationMin: LOGISTICS_SERVICE_DURATION_MIN,
    hardConstraints: hardConstraintsWithoutRequiredDriver,
    softConstraints: [...taskSoftConstraints, ...businessSoftConstraints],
    businessGroups,
    metadata,
  };

  input.metadata.validation = mergeRequiredDriverBuildErrors(
    mergeSameBuildingSkippedGroupWarnings(
      validateRoutingProblemInput(input),
      sameBuildingDriverBuild.skippedGroups
    ),
    requiredDriverBuild.errors
  );
  return input;
}

function mergeSameBuildingSkippedGroupWarnings(
  validation: RoutingProblemMetadata["validation"],
  skippedGroups: ReturnType<typeof buildSameBuildingDriverConstraints>["skippedGroups"]
): RoutingProblemMetadata["validation"] {
  if (skippedGroups.length === 0) return validation;

  const warnings: ValidationIssue[] = [...validation.warnings];
  for (const skipped of skippedGroups) {
    warnings.push({
      severity: "warning",
      code: "SAME_BUILDING_GROUP_NOT_LOCKED",
      message: `Same-building group ${skipped.groupId} could not be locked to a single driver (${skipped.reason}).`,
      path: "businessGroups",
      actual: {
        groupId: skipped.groupId,
        taskIds: skipped.taskIds,
        reason: skipped.reason,
        driverIds: skipped.driverIds,
      },
    });
  }

  return {
    ...validation,
    warnings,
  };
}

export interface BuildLogisticsRoutingInputOptions {
  performedBy?: string;
  skipAutoConvoke?: boolean;
  saveSelectedDrivers?: boolean;
}

export async function buildLogisticsRoutingInput(
  workDate: string,
  options?: BuildLogisticsRoutingInputOptions
): Promise<RoutingProblemInput> {
  let autoConvokeResult: AutoConvokeLogisticsDriversResult | undefined;
  if (!options?.skipAutoConvoke) {
    autoConvokeResult = await autoConvokeLogisticsDriversWithPreAssignedTasks(workDate, {
      performedBy: options?.performedBy ?? "logistics-optimizer-final",
      saveSelectedDrivers: options?.saveSelectedDrivers,
    });
  }

  const sourceData = await loadLogisticsRoutingSourceData(workDate);
  return buildRoutingProblemInputFromSource(sourceData, { autoConvokeResult });
}
