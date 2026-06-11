import { LOGISTICS_SERVICE_DURATION_MIN } from "../../../shared/logistics-scheduling-constraints";
import { validateBusinessGroupSemantics } from "./groups/business-group-semantics";
import type { RoutingBusinessGroup } from "./groups/group-contract";
import { BUSINESS_GROUP_THRESHOLDS } from "./groups/group-weights";
import type {
  HardConstraintSpec,
  RoutingProblemInput,
  SoftConstraintSpec,
  TaskNode,
} from "./input-contract";
import type {
  RoutingProblemValidationResult,
  ValidationIssue,
  ValidationIssueCode,
} from "./validation-contract";

const DAY_END_MIN = 24 * 60;

function pushError(
  errors: ValidationIssue[],
  issue: Omit<ValidationIssue, "severity">
): void {
  errors.push({ ...issue, severity: "error" });
}

function pushWarning(
  warnings: ValidationIssue[],
  issue: Omit<ValidationIssue, "severity">
): void {
  warnings.push({ ...issue, severity: "warning" });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidMinute(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= DAY_END_MIN;
}

export function formatValidationIssue(issue: ValidationIssue): string {
  const target =
    issue.taskId !== undefined
      ? ` taskId=${issue.taskId}`
      : issue.driverId !== undefined
        ? ` driverId=${issue.driverId}`
        : issue.nodeIndex !== undefined
          ? ` nodeIndex=${issue.nodeIndex}`
          : "";
  return `${issue.code}${target}: ${issue.message}`;
}

function validateSchemaAndDepot(
  input: RoutingProblemInput,
  errors: ValidationIssue[]
): void {
  if (input.schemaVersion !== "logistics-routing-input/v1") {
    pushError(errors, {
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unsupported schemaVersion: ${input.schemaVersion}`,
      path: "schemaVersion",
      expected: "logistics-routing-input/v1",
      actual: input.schemaVersion,
    });
  }

  if (!Array.isArray(input.tasks)) {
    pushError(errors, {
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: "tasks must be an array",
      path: "tasks",
    });
  }

  if (!Array.isArray(input.drivers)) {
    pushError(errors, {
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: "drivers must be an array",
      path: "drivers",
    });
  }

  if (!Array.isArray(input.hardConstraints)) {
    pushError(errors, {
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: "hardConstraints must be an array",
      path: "hardConstraints",
    });
  }

  if (!Array.isArray(input.softConstraints)) {
    pushError(errors, {
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: "softConstraints must be an array",
      path: "softConstraints",
    });
  }

  if (!Array.isArray(input.businessGroups)) {
    pushError(errors, {
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: "businessGroups must be an array",
      path: "businessGroups",
    });
  }

  if (!Array.isArray(input.travelMatrixMin)) {
    pushError(errors, {
      code: "INVALID_TRAVEL_MATRIX_SIZE",
      message: "travelMatrixMin must be an array",
      path: "travelMatrixMin",
    });
    return;
  }

  if (input.depot.nodeIndex !== 0) {
    pushError(errors, {
      code: "INVALID_DEPOT_NODE",
      message: "Depot nodeIndex must be 0",
      path: "depot.nodeIndex",
      expected: 0,
      actual: input.depot.nodeIndex,
    });
  }

  if (
    !isFiniteNumber(input.depot.lat) ||
    !isFiniteNumber(input.depot.lng) ||
    input.depot.lat < -90 ||
    input.depot.lat > 90 ||
    input.depot.lng < -180 ||
    input.depot.lng > 180
  ) {
    pushError(errors, {
      code: "INVALID_DEPOT_NODE",
      message: "Depot has invalid coordinates",
      path: "depot",
      actual: { lat: input.depot.lat, lng: input.depot.lng },
    });
  }
}

function validateServiceDuration(
  input: RoutingProblemInput,
  errors: ValidationIssue[]
): void {
  if (input.serviceDurationMin !== LOGISTICS_SERVICE_DURATION_MIN) {
    pushError(errors, {
      code: "INVALID_TASK_SERVICE_DURATION",
      message: `Global serviceDurationMin must be ${LOGISTICS_SERVICE_DURATION_MIN}`,
      path: "serviceDurationMin",
      expected: LOGISTICS_SERVICE_DURATION_MIN,
      actual: input.serviceDurationMin,
    });
  }
}

function validateDrivers(input: RoutingProblemInput, errors: ValidationIssue[]): void {
  const seenDriverIds = new Set<number>();

  input.drivers.forEach((driver, index) => {
    if (seenDriverIds.has(driver.id)) {
      pushError(errors, {
        code: "DUPLICATE_DRIVER_ID",
        message: `Duplicate driver id ${driver.id}`,
        driverId: driver.id,
        path: `drivers[${index}].id`,
      });
    }
    seenDriverIds.add(driver.id);

    if (driver.selected !== true) {
      pushError(errors, {
        code: "INVALID_DRIVER_WORK_WINDOW",
        message: `Driver ${driver.id} must be selected`,
        driverId: driver.id,
        path: `drivers[${index}].selected`,
        expected: true,
        actual: driver.selected,
      });
    }

    const { startMin, endMin, startSource, endSource } = driver.workWindow;
    if (
      !isValidMinute(startMin) ||
      !isValidMinute(endMin) ||
      startMin >= endMin ||
      (startSource !== "driver_row" && startSource !== "default") ||
      (endSource !== "driver_row" && endSource !== "default")
    ) {
      pushError(errors, {
        code: "INVALID_DRIVER_WORK_WINDOW",
        message: `Driver ${driver.id} has invalid work window`,
        driverId: driver.id,
        path: `drivers[${index}].workWindow`,
        actual: driver.workWindow,
      });
    }
  });
}

function validateTasks(
  input: RoutingProblemInput,
  errors: ValidationIssue[]
): boolean {
  let hasNodeIndexErrors = false;
  const seenTaskIds = new Set<number>();
  const seenNodeIndices = new Set<number>();
  const expectedNodeIndices = new Set<number>();
  for (let i = 1; i <= input.tasks.length; i++) {
    expectedNodeIndices.add(i);
  }

  input.tasks.forEach((task, index) => {
    if (seenTaskIds.has(task.taskId)) {
      pushError(errors, {
        code: "DUPLICATE_TASK_ID",
        message: `Duplicate task id ${task.taskId}`,
        taskId: task.taskId,
        path: `tasks[${index}].taskId`,
      });
    }
    seenTaskIds.add(task.taskId);

    if (seenNodeIndices.has(task.nodeIndex)) {
      pushError(errors, {
        code: "DUPLICATE_NODE_INDEX",
        message: `Duplicate nodeIndex ${task.nodeIndex}`,
        nodeIndex: task.nodeIndex,
        path: `tasks[${index}].nodeIndex`,
      });
      hasNodeIndexErrors = true;
    }
    seenNodeIndices.add(task.nodeIndex);

    if (
      !isFiniteNumber(task.nodeIndex) ||
      task.nodeIndex < 1 ||
      task.nodeIndex > input.tasks.length ||
      !expectedNodeIndices.has(task.nodeIndex)
    ) {
      pushError(errors, {
        code: "INVALID_NODE_INDEX",
        message: `Task ${task.taskId} has invalid nodeIndex ${task.nodeIndex}; expected 1..${input.tasks.length}`,
        taskId: task.taskId,
        nodeIndex: task.nodeIndex,
        path: `tasks[${index}].nodeIndex`,
        expected: `1..${input.tasks.length}`,
        actual: task.nodeIndex,
      });
      hasNodeIndexErrors = true;
    }

    if (!task.eligibility.schedulable) {
      pushError(errors, {
        code: "TASK_INCLUDED_BUT_UNSCHEDULABLE",
        message: `Task ${task.taskId} included but marked unschedulable`,
        taskId: task.taskId,
        path: `tasks[${index}].eligibility.schedulable`,
      });
    }

    const { lat, lng } = task.location;
    if (
      !isFiniteNumber(lat) ||
      !isFiniteNumber(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      pushError(errors, {
        code: "INVALID_TASK_COORDINATES",
        message: `Task ${task.taskId} has invalid coordinates`,
        taskId: task.taskId,
        path: `tasks[${index}].location`,
        actual: { lat, lng },
      });
    }

    if (task.serviceDurationMin !== input.serviceDurationMin) {
      pushError(errors, {
        code: "INVALID_TASK_SERVICE_DURATION",
        message: `Task ${task.taskId} serviceDurationMin does not match global serviceDurationMin`,
        taskId: task.taskId,
        path: `tasks[${index}].serviceDurationMin`,
        expected: input.serviceDurationMin,
        actual: task.serviceDurationMin,
      });
    }

    validateTaskHardWindow(task, index, errors);
  });

  // Compact sequence: every index 1..tasks.length must appear exactly once
  if (!hasNodeIndexErrors && input.tasks.length > 0) {
    const usedIndices = new Set(input.tasks.map((task) => task.nodeIndex));
    for (let i = 1; i <= input.tasks.length; i++) {
      if (!usedIndices.has(i)) {
        pushError(errors, {
          code: "INVALID_NODE_INDEX",
          message: `Missing nodeIndex ${i} in compact sequence 1..${input.tasks.length}`,
          nodeIndex: i,
          path: "tasks",
          expected: `1..${input.tasks.length}`,
        });
        hasNodeIndexErrors = true;
      }
    }
  }

  return hasNodeIndexErrors;
}

function validateTaskHardWindow(
  task: TaskNode,
  index: number,
  errors: ValidationIssue[]
): void {
  const { earliestStartMin, latestStartMin, latestEndMin } = task.hardWindow;

  if (
    !isValidMinute(earliestStartMin) ||
    !isValidMinute(latestStartMin) ||
    !isValidMinute(latestEndMin) ||
    earliestStartMin > latestStartMin
  ) {
    pushError(errors, {
      code: "INVALID_TASK_HARD_WINDOW",
      message: `Task ${task.taskId} has inconsistent hard window`,
      taskId: task.taskId,
      path: `tasks[${index}].hardWindow`,
      actual: task.hardWindow,
    });
    return;
  }

  if (latestStartMin + task.serviceDurationMin > latestEndMin) {
    pushError(errors, {
      code: "TASK_SERVICE_EXCEEDS_WINDOW",
      message: `Task ${task.taskId} latestStart + service exceeds latestEnd`,
      taskId: task.taskId,
      path: `tasks[${index}].hardWindow`,
      expected: `latestStartMin + ${task.serviceDurationMin} <= latestEndMin`,
      actual: {
        latestStartMin,
        serviceDurationMin: task.serviceDurationMin,
        latestEndMin,
      },
    });
  }
}

function constraintKey(constraint: HardConstraintSpec): string {
  if (constraint.type === "DRIVER_WORK_WINDOW") {
    return `DRIVER_WORK_WINDOW:${constraint.driverId}`;
  }
  return `${constraint.type}:${constraint.taskId}`;
}

function validateHardConstraints(
  input: RoutingProblemInput,
  errors: ValidationIssue[]
): void {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));
  const constraintCounts = new Map<string, number>();

  for (const constraint of input.hardConstraints) {
    const key = constraintKey(constraint);
    constraintCounts.set(key, (constraintCounts.get(key) ?? 0) + 1);

    if (constraint.type === "TASK_TIME_WINDOW" || constraint.type === "TASK_REQUIRED") {
      if (!taskById.has(constraint.taskId)) {
        pushError(errors, {
          code: "UNKNOWN_TASK_IN_CONSTRAINT",
          message: `${constraint.type} references unknown task ${constraint.taskId}`,
          taskId: constraint.taskId,
          path: "hardConstraints",
        });
        continue;
      }
    }

    if (constraint.type === "DRIVER_WORK_WINDOW") {
      if (!driverById.has(constraint.driverId)) {
        pushError(errors, {
          code: "UNKNOWN_DRIVER_IN_CONSTRAINT",
          message: `DRIVER_WORK_WINDOW references unknown driver ${constraint.driverId}`,
          driverId: constraint.driverId,
          path: "hardConstraints",
        });
        continue;
      }
    }

    if (constraint.type === "TASK_TIME_WINDOW") {
      const task = taskById.get(constraint.taskId)!;
      const hw = task.hardWindow;
      if (
        constraint.earliestStartMin !== hw.earliestStartMin ||
        constraint.latestStartMin !== hw.latestStartMin ||
        constraint.latestEndMin !== hw.latestEndMin
      ) {
        pushError(errors, {
          code: "INVALID_HARD_CONSTRAINT",
          message: `TASK_TIME_WINDOW for task ${constraint.taskId} does not match task.hardWindow`,
          taskId: constraint.taskId,
          path: "hardConstraints",
          expected: hw,
          actual: constraint,
        });
      }
    }

    if (constraint.type === "DRIVER_WORK_WINDOW") {
      const driver = driverById.get(constraint.driverId)!;
      const ww = driver.workWindow;
      if (constraint.startMin !== ww.startMin || constraint.endMin !== ww.endMin) {
        pushError(errors, {
          code: "INVALID_HARD_CONSTRAINT",
          message: `DRIVER_WORK_WINDOW for driver ${constraint.driverId} does not match driver.workWindow`,
          driverId: constraint.driverId,
          path: "hardConstraints",
          expected: ww,
          actual: constraint,
        });
      }
    }

    if (constraint.type === "TASK_REQUIRED") {
      if (
        constraint.penaltyIfDropped !== undefined &&
        (!isFiniteNumber(constraint.penaltyIfDropped) || constraint.penaltyIfDropped < 0)
      ) {
        pushError(errors, {
          code: "INVALID_HARD_CONSTRAINT",
          message: `TASK_REQUIRED for task ${constraint.taskId} has invalid penaltyIfDropped`,
          taskId: constraint.taskId,
          path: "hardConstraints",
          actual: constraint.penaltyIfDropped,
        });
      }
    }
  }

  for (const [key, count] of constraintCounts) {
    if (count > 1) {
      const [type, id] = key.split(":");
      const numericId = Number(id);
      const issue: Omit<ValidationIssue, "severity"> = {
        code: "DUPLICATE_HARD_CONSTRAINT",
        message: `${type} appears ${count} times (expected 1)`,
        path: "hardConstraints",
        expected: 1,
        actual: count,
      };
      if (type === "DRIVER_WORK_WINDOW") {
        issue.driverId = numericId;
      } else {
        issue.taskId = numericId;
      }
      pushError(errors, issue);
    }
  }

  for (const task of input.tasks) {
    const timeWindowKey = `TASK_TIME_WINDOW:${task.taskId}`;
    const requiredKey = `TASK_REQUIRED:${task.taskId}`;
    if (!constraintCounts.has(timeWindowKey)) {
      pushError(errors, {
        code: "MISSING_TASK_TIME_WINDOW_CONSTRAINT",
        message: `Task ${task.taskId} is missing TASK_TIME_WINDOW constraint`,
        taskId: task.taskId,
        path: "hardConstraints",
      });
    }
    if (!constraintCounts.has(requiredKey)) {
      pushError(errors, {
        code: "MISSING_TASK_REQUIRED_CONSTRAINT",
        message: `Task ${task.taskId} is missing TASK_REQUIRED constraint`,
        taskId: task.taskId,
        path: "hardConstraints",
      });
    }
  }

  for (const driver of input.drivers) {
    const key = `DRIVER_WORK_WINDOW:${driver.id}`;
    if (!constraintCounts.has(key)) {
      pushError(errors, {
        code: "MISSING_DRIVER_WORK_WINDOW_CONSTRAINT",
        message: `Driver ${driver.id} is missing DRIVER_WORK_WINDOW constraint`,
        driverId: driver.id,
        path: "hardConstraints",
      });
    }
  }
}

function validateBusinessGroups(
  input: RoutingProblemInput,
  errors: ValidationIssue[]
): Map<string, RoutingBusinessGroup> {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const taskIds = new Set(taskById.keys());
  const groupsById = new Map<string, RoutingBusinessGroup>();
  const seenGroupIds = new Set<string>();

  input.businessGroups.forEach((group, index) => {
    if (!group.groupId || typeof group.groupId !== "string") {
      pushError(errors, {
        code: "INVALID_BUSINESS_GROUP",
        message: "Business group must have a non-empty groupId",
        path: `businessGroups[${index}].groupId`,
      });
      return;
    }

    if (seenGroupIds.has(group.groupId)) {
      pushError(errors, {
        code: "DUPLICATE_BUSINESS_GROUP_ID",
        message: `Duplicate business group id ${group.groupId}`,
        path: `businessGroups[${index}].groupId`,
        actual: group.groupId,
      });
    }
    seenGroupIds.add(group.groupId);

    if (!Array.isArray(group.taskIds) || group.taskIds.length < 2) {
      pushError(errors, {
        code: "INVALID_BUSINESS_GROUP",
        message: `Business group ${group.groupId} must include at least two taskIds`,
        path: `businessGroups[${index}].taskIds`,
        actual: group.taskIds,
      });
    }

    const uniqueTaskIds = new Set<number>();
    for (const taskId of group.taskIds ?? []) {
      if (!isFiniteNumber(taskId)) {
        pushError(errors, {
          code: "INVALID_BUSINESS_GROUP",
          message: `Business group ${group.groupId} has invalid taskId`,
          path: `businessGroups[${index}].taskIds`,
          actual: taskId,
        });
        continue;
      }
      if (!taskIds.has(taskId)) {
        pushError(errors, {
          code: "UNKNOWN_TASK_IN_BUSINESS_GROUP",
          message: `Business group ${group.groupId} references unknown task ${taskId}`,
          taskId,
          path: `businessGroups[${index}].taskIds`,
        });
      }
      if (uniqueTaskIds.has(taskId)) {
        pushError(errors, {
          code: "INVALID_BUSINESS_GROUP",
          message: `Business group ${group.groupId} has duplicate taskId ${taskId}`,
          taskId,
          path: `businessGroups[${index}].taskIds`,
        });
      }
      uniqueTaskIds.add(taskId);
    }

    switch (group.type) {
      case "SAME_COORDINATES_BUILDING": {
        if (!isFiniteNumber(group.toleranceMeters) || group.toleranceMeters <= 0) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `SAME_COORDINATES_BUILDING ${group.groupId} requires toleranceMeters > 0`,
            path: `businessGroups[${index}].toleranceMeters`,
            actual: group.toleranceMeters,
          });
        }
        const { lat, lng } = group.centroid ?? {};
        if (
          !isFiniteNumber(lat) ||
          !isFiniteNumber(lng) ||
          lat < -90 ||
          lat > 90 ||
          lng < -180 ||
          lng > 180
        ) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `SAME_COORDINATES_BUILDING ${group.groupId} has invalid centroid`,
            path: `businessGroups[${index}].centroid`,
            actual: group.centroid,
          });
        }
        break;
      }
      case "SAME_CLEANER": {
        if (!isFiniteNumber(group.cleanerId)) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `SAME_CLEANER ${group.groupId} requires finite cleanerId`,
            path: `businessGroups[${index}].cleanerId`,
            actual: group.cleanerId,
          });
        }
        break;
      }
      case "CLEANER_SEQUENCE": {
        if (!isFiniteNumber(group.cleanerId)) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `CLEANER_SEQUENCE ${group.groupId} requires finite cleanerId`,
            path: `businessGroups[${index}].cleanerId`,
            actual: group.cleanerId,
          });
        }
        if (!Array.isArray(group.orderedTaskIds) || group.orderedTaskIds.length < 2) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `CLEANER_SEQUENCE ${group.groupId} requires orderedTaskIds length >= 2`,
            path: `businessGroups[${index}].orderedTaskIds`,
            actual: group.orderedTaskIds,
          });
        } else if (
          group.orderedTaskIds.length !== group.taskIds.length ||
          group.orderedTaskIds.some((taskId, taskIndex) => taskId !== group.taskIds[taskIndex])
        ) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `CLEANER_SEQUENCE ${group.groupId} taskIds must equal orderedTaskIds`,
            path: `businessGroups[${index}].orderedTaskIds`,
            expected: group.taskIds,
            actual: group.orderedTaskIds,
          });
        }
        break;
      }
      case "PRIORITY_COMPATIBLE": {
        const { startMin, endMin } = group.windowOverlap ?? {};
        if (!isValidMinute(startMin) || !isValidMinute(endMin) || startMin > endMin) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `PRIORITY_COMPATIBLE ${group.groupId} has invalid windowOverlap`,
            path: `businessGroups[${index}].windowOverlap`,
            actual: group.windowOverlap,
          });
        } else if (
          endMin - startMin <
          BUSINESS_GROUP_THRESHOLDS.PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN
        ) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `PRIORITY_COMPATIBLE ${group.groupId} overlap is below ${BUSINESS_GROUP_THRESHOLDS.PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN} minutes`,
            path: `businessGroups[${index}].windowOverlap`,
            expected: BUSINESS_GROUP_THRESHOLDS.PRIORITY_COMPATIBLE_MIN_OVERLAP_MIN,
            actual: endMin - startMin,
          });
        }
        break;
      }
      case "NEARBY_CLUSTER": {
        if (!isFiniteNumber(group.maxTravelMin) || group.maxTravelMin <= 0) {
          pushError(errors, {
            code: "INVALID_BUSINESS_GROUP",
            message: `NEARBY_CLUSTER ${group.groupId} requires maxTravelMin > 0`,
            path: `businessGroups[${index}].maxTravelMin`,
            actual: group.maxTravelMin,
          });
        }
        if (!taskIds.has(group.hubTaskId)) {
          pushError(errors, {
            code: "UNKNOWN_TASK_IN_BUSINESS_GROUP",
            message: `NEARBY_CLUSTER ${group.groupId} references unknown hubTaskId ${group.hubTaskId}`,
            taskId: group.hubTaskId,
            path: `businessGroups[${index}].hubTaskId`,
          });
        }
        break;
      }
      default:
        pushError(errors, {
          code: "INVALID_BUSINESS_GROUP",
          message: `Unknown business group type`,
          path: `businessGroups[${index}].type`,
          actual: (group as RoutingBusinessGroup).type,
        });
    }

    for (const semanticIssue of validateBusinessGroupSemantics(
      group,
      taskById,
      input.travelMatrixMin
    )) {
      pushError(errors, {
        code: "INVALID_BUSINESS_GROUP",
        message: semanticIssue.message,
        path: `businessGroups[${index}]`,
        taskId: semanticIssue.taskId,
        expected: semanticIssue.expected,
        actual: semanticIssue.actual,
      });
    }

    groupsById.set(group.groupId, group);
  });

  return groupsById;
}

function validateSoftConstraints(
  input: RoutingProblemInput,
  errors: ValidationIssue[],
  groupsById: Map<string, RoutingBusinessGroup>
): void {
  const taskIds = new Set(input.tasks.map((task) => task.taskId));

  for (const constraint of input.softConstraints) {
    if (constraint.type === "MINIMIZE_TOTAL_TRAVEL") {
      if (!isFiniteNumber(constraint.weight) || constraint.weight <= 0) {
        pushError(errors, {
          code: "INVALID_SOFT_CONSTRAINT",
          message: "MINIMIZE_TOTAL_TRAVEL weight must be > 0",
          path: "softConstraints",
          actual: constraint.weight,
        });
      }
      continue;
    }

    if (constraint.type === "BALANCE_DRIVER_LOAD") {
      if (!isFiniteNumber(constraint.weight) || constraint.weight < 0) {
        pushError(errors, {
          code: "INVALID_SOFT_CONSTRAINT",
          message: "BALANCE_DRIVER_LOAD weight must be >= 0",
          path: "softConstraints",
          actual: constraint.weight,
        });
      }
      continue;
    }

    if (constraint.type === "PREFERRED_PRIORITY_WINDOW") {
      if (!taskIds.has(constraint.taskId)) {
        pushError(errors, {
          code: "UNKNOWN_TASK_IN_CONSTRAINT",
          message: `PREFERRED_PRIORITY_WINDOW references unknown task ${constraint.taskId}`,
          taskId: constraint.taskId,
          path: "softConstraints",
        });
        continue;
      }

      if (!isValidMinute(constraint.startMin)) {
        pushError(errors, {
          code: "INVALID_SOFT_CONSTRAINT",
          message: `PREFERRED_PRIORITY_WINDOW for task ${constraint.taskId} has invalid startMin`,
          taskId: constraint.taskId,
          path: "softConstraints",
          actual: constraint.startMin,
        });
      }

      if (
        constraint.endMin !== undefined &&
        (!isValidMinute(constraint.endMin) || constraint.endMin < constraint.startMin)
      ) {
        pushError(errors, {
          code: "INVALID_SOFT_CONSTRAINT",
          message: `PREFERRED_PRIORITY_WINDOW for task ${constraint.taskId} has invalid endMin`,
          taskId: constraint.taskId,
          path: "softConstraints",
          actual: constraint.endMin,
        });
      }

      if (
        !isFiniteNumber(constraint.penaltyPerMinOutside) ||
        constraint.penaltyPerMinOutside < 0
      ) {
        pushError(errors, {
          code: "INVALID_SOFT_CONSTRAINT",
          message: `PREFERRED_PRIORITY_WINDOW for task ${constraint.taskId} has invalid penaltyPerMinOutside`,
          taskId: constraint.taskId,
          path: "softConstraints",
          actual: constraint.penaltyPerMinOutside,
        });
      }
      continue;
    }

    if (
      constraint.type === "KEEP_SAME_COORDINATES_BUILDING_TOGETHER" ||
      constraint.type === "KEEP_CLEANER_SEQUENCE" ||
      constraint.type === "KEEP_SAME_CLEANER_TASKS_TOGETHER" ||
      constraint.type === "KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER" ||
      constraint.type === "KEEP_NEARBY_CLUSTER_TOGETHER"
    ) {
      if (!isFiniteNumber(constraint.weight) || constraint.weight <= 0) {
        pushError(errors, {
          code: "INVALID_SOFT_CONSTRAINT",
          message: `${constraint.type} weight must be > 0`,
          path: "softConstraints",
          actual: constraint.weight,
        });
      }

      const group = groupsById.get(constraint.groupId);
      if (!group) {
        pushError(errors, {
          code: "UNKNOWN_BUSINESS_GROUP_IN_CONSTRAINT",
          message: `${constraint.type} references unknown group ${constraint.groupId}`,
          path: "softConstraints",
          actual: constraint.groupId,
        });
        continue;
      }

      if (constraint.type === "KEEP_SAME_COORDINATES_BUILDING_TOGETHER") {
        if (group.type !== "SAME_COORDINATES_BUILDING") {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} group type mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: "SAME_COORDINATES_BUILDING",
            actual: group.type,
          });
        } else if (constraint.toleranceMeters !== group.toleranceMeters) {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} toleranceMeters mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: group.toleranceMeters,
            actual: constraint.toleranceMeters,
          });
        }
        continue;
      }

      if (constraint.type === "KEEP_SAME_CLEANER_TASKS_TOGETHER") {
        if (group.type !== "SAME_CLEANER") {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} group type mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: "SAME_CLEANER",
            actual: group.type,
          });
        } else if (constraint.cleanerId !== group.cleanerId) {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} cleanerId mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: group.cleanerId,
            actual: constraint.cleanerId,
          });
        }
        continue;
      }

      if (constraint.type === "KEEP_CLEANER_SEQUENCE") {
        if (group.type !== "CLEANER_SEQUENCE") {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} group type mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: "CLEANER_SEQUENCE",
            actual: group.type,
          });
        } else if (
          constraint.cleanerId !== group.cleanerId ||
          constraint.orderedTaskIds.length !== group.orderedTaskIds.length ||
          constraint.orderedTaskIds.some(
            (taskId, index) => taskId !== group.orderedTaskIds[index]
          )
        ) {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} sequence mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: group.orderedTaskIds,
            actual: constraint.orderedTaskIds,
          });
        }
        continue;
      }

      if (constraint.type === "KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER") {
        if (group.type !== "PRIORITY_COMPATIBLE") {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} group type mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: "PRIORITY_COMPATIBLE",
            actual: group.type,
          });
        } else if (
          constraint.windowOverlap.startMin !== group.windowOverlap.startMin ||
          constraint.windowOverlap.endMin !== group.windowOverlap.endMin
        ) {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} windowOverlap mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: group.windowOverlap,
            actual: constraint.windowOverlap,
          });
        }
        continue;
      }

      if (constraint.type === "KEEP_NEARBY_CLUSTER_TOGETHER") {
        if (group.type !== "NEARBY_CLUSTER") {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} group type mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: "NEARBY_CLUSTER",
            actual: group.type,
          });
        } else if (constraint.maxTravelMin !== group.maxTravelMin) {
          pushError(errors, {
            code: "INVALID_SOFT_CONSTRAINT",
            message: `${constraint.type} maxTravelMin mismatch for ${constraint.groupId}`,
            path: "softConstraints",
            expected: group.maxTravelMin,
            actual: constraint.maxTravelMin,
          });
        }
      }
      continue;
    }

    pushError(errors, {
      code: "INVALID_SOFT_CONSTRAINT",
      message: `Unsupported soft constraint type ${(constraint as SoftConstraintSpec).type}`,
      path: "softConstraints",
      actual: constraint,
    });
  }
}

function validateTravelMatrix(
  input: RoutingProblemInput,
  errors: ValidationIssue[],
  hasNodeIndexErrors: boolean
): void {
  const matrix = input.travelMatrixMin;
  if (!Array.isArray(matrix)) {
    return;
  }

  const expectedMatrixSize = input.tasks.length + 1;

  if (!hasNodeIndexErrors) {
    if (matrix.length !== expectedMatrixSize) {
      pushError(errors, {
        code: "INVALID_TRAVEL_MATRIX_SIZE",
        message: `travelMatrixMin row count ${matrix.length} !== ${expectedMatrixSize}`,
        path: "travelMatrixMin",
        expected: expectedMatrixSize,
        actual: matrix.length,
      });
    }
  }

  matrix.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      pushError(errors, {
        code: "INVALID_TRAVEL_MATRIX_SIZE",
        message: `travelMatrixMin[${rowIndex}] is not an array`,
        path: `travelMatrixMin[${rowIndex}]`,
      });
      return;
    }

    if (!hasNodeIndexErrors && row.length !== expectedMatrixSize) {
      pushError(errors, {
        code: "INVALID_TRAVEL_MATRIX_SIZE",
        message: `travelMatrixMin[${rowIndex}] length ${row.length} !== ${expectedMatrixSize}`,
        path: `travelMatrixMin[${rowIndex}]`,
        expected: expectedMatrixSize,
        actual: row.length,
      });
    }

    row.forEach((value, colIndex) => {
      if (!isFiniteNumber(value)) {
        pushError(errors, {
          code: "INVALID_TRAVEL_MATRIX_VALUE",
          message: `travelMatrixMin[${rowIndex}][${colIndex}] is not a finite number`,
          path: `travelMatrixMin[${rowIndex}][${colIndex}]`,
          actual: value,
        });
        return;
      }

      if (value < 0) {
        pushError(errors, {
          code: "INVALID_TRAVEL_MATRIX_VALUE",
          message: `travelMatrixMin[${rowIndex}][${colIndex}] is negative`,
          path: `travelMatrixMin[${rowIndex}][${colIndex}]`,
          actual: value,
        });
      }

      if (rowIndex === colIndex && value !== 0) {
        pushError(errors, {
          code: "INVALID_TRAVEL_MATRIX_VALUE",
          message: `travelMatrixMin diagonal [${rowIndex}][${colIndex}] must be 0`,
          path: `travelMatrixMin[${rowIndex}][${colIndex}]`,
          expected: 0,
          actual: value,
        });
      }
    });
  });
}

function validateMetadataAndWarnings(
  input: RoutingProblemInput,
  errors: ValidationIssue[],
  warnings: ValidationIssue[]
): void {
  const allowedReasons = new Set(["LOCKED", "NO_COORDINATES"]);
  const seenExcludedTaskIds = new Set<number>();

  for (const excluded of input.metadata.excludedTasks) {
    if (!isFiniteNumber(excluded.taskId)) {
      pushError(errors, {
        code: "INVALID_EXCLUDED_TASK_REASON",
        message: "excludedTasks entry has invalid taskId",
        path: "metadata.excludedTasks",
        actual: excluded.taskId,
      });
      continue;
    }

    if (!excluded.reason || !allowedReasons.has(excluded.reason)) {
      pushError(errors, {
        code: "INVALID_EXCLUDED_TASK_REASON",
        message: `excludedTasks entry has invalid reason: ${excluded.reason}`,
        taskId: excluded.taskId,
        path: "metadata.excludedTasks",
        actual: excluded.reason,
      });
    }

    if (seenExcludedTaskIds.has(excluded.taskId)) {
      pushError(errors, {
        code: "INVALID_EXCLUDED_TASK_REASON",
        message: `Duplicate excludedTasks taskId ${excluded.taskId}`,
        taskId: excluded.taskId,
        path: "metadata.excludedTasks",
      });
    }
    seenExcludedTaskIds.add(excluded.taskId);
  }

  const lockedExcludedCount = input.metadata.excludedTasks.filter(
    (entry) => entry.reason === "LOCKED"
  ).length;
  const noCoordExcludedCount = input.metadata.excludedTasks.filter(
    (entry) => entry.reason === "NO_COORDINATES"
  ).length;

  if (input.metadata.lockedTasksExcluded !== lockedExcludedCount) {
    pushWarning(warnings, {
      code: "EXCLUDED_TASK_COUNT_MISMATCH",
      message: `lockedTasksExcluded (${input.metadata.lockedTasksExcluded}) !== LOCKED excludedTasks count (${lockedExcludedCount})`,
      path: "metadata.lockedTasksExcluded",
      expected: lockedExcludedCount,
      actual: input.metadata.lockedTasksExcluded,
    });
  }

  if (input.metadata.tasksExcludedNoCoordinatesCount !== noCoordExcludedCount) {
    pushWarning(warnings, {
      code: "EXCLUDED_TASK_COUNT_MISMATCH",
      message: `tasksExcludedNoCoordinatesCount (${input.metadata.tasksExcludedNoCoordinatesCount}) !== NO_COORDINATES excludedTasks count (${noCoordExcludedCount})`,
      path: "metadata.tasksExcludedNoCoordinatesCount",
      expected: noCoordExcludedCount,
      actual: input.metadata.tasksExcludedNoCoordinatesCount,
    });
  }

  const noCoordIdsFromExcluded = input.metadata.excludedTasks
    .filter((entry) => entry.reason === "NO_COORDINATES")
    .map((entry) => entry.taskId)
    .sort((a, b) => a - b);
  const noCoordIdsFromMetadata = [...input.metadata.tasksExcludedNoCoordinatesIds].sort(
    (a, b) => a - b
  );
  if (JSON.stringify(noCoordIdsFromExcluded) !== JSON.stringify(noCoordIdsFromMetadata)) {
    pushWarning(warnings, {
      code: "EXCLUDED_TASK_COUNT_MISMATCH",
      message: "tasksExcludedNoCoordinatesIds does not match NO_COORDINATES excludedTasks",
      path: "metadata.tasksExcludedNoCoordinatesIds",
      expected: noCoordIdsFromExcluded,
      actual: noCoordIdsFromMetadata,
    });
  }

  if (
    input.metadata.existingLockedAssignmentsCount !==
    input.metadata.existingLockedAssignments.length
  ) {
    pushWarning(warnings, {
      code: "METADATA_CONSISTENCY_MISMATCH",
      message: "existingLockedAssignmentsCount does not match existingLockedAssignments.length",
      path: "metadata.existingLockedAssignmentsCount",
      expected: input.metadata.existingLockedAssignments.length,
      actual: input.metadata.existingLockedAssignmentsCount,
    });
  }

  const noDrivers = input.drivers.length === 0;
  if (input.metadata.noSelectedDrivers !== noDrivers) {
    pushWarning(warnings, {
      code: "METADATA_CONSISTENCY_MISMATCH",
      message: "noSelectedDrivers does not match drivers.length === 0",
      path: "metadata.noSelectedDrivers",
      expected: noDrivers,
      actual: input.metadata.noSelectedDrivers,
    });
  }

  // NO_SELECTED_DRIVERS is a warning in debug mode.
  // Future solver entrypoint must treat this as blocking
  // (or assertRoutingProblemInputValid should support mode: "debug" | "solver").
  if (noDrivers) {
    pushWarning(warnings, {
      code: "NO_SELECTED_DRIVERS",
      message: "No selected drivers in routing input",
      path: "drivers",
    });
  }

  if (input.windowConfig.priorityWindows === null) {
    pushWarning(warnings, {
      code: "PRIORITY_WINDOWS_UNAVAILABLE",
      message: "Priority windows unavailable; HP/LP/EO rules may use fallback behavior.",
      path: "windowConfig.priorityWindows",
      actual: null,
    });
  }

  if (input.metadata.existingLockedAssignmentsCount > 0) {
    pushWarning(warnings, {
      code: "LOCKED_ASSIGNMENTS_NOT_SOLVER_INTEGRATED",
      message:
        "Existing locked assignments are loaded but not yet integrated as solver constraints.",
      path: "metadata.existingLockedAssignments",
      actual: input.metadata.existingLockedAssignmentsCount,
    });
  }
}

export function validateRoutingProblemInput(
  input: RoutingProblemInput
): RoutingProblemValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  validateSchemaAndDepot(input, errors);
  validateServiceDuration(input, errors);
  validateDrivers(input, errors);
  const hasNodeIndexErrors = validateTasks(input, errors);
  validateHardConstraints(input, errors);
  const groupsById = validateBusinessGroups(input, errors);
  validateSoftConstraints(input, errors, groupsById);
  validateTravelMatrix(input, errors, hasNodeIndexErrors);
  validateMetadataAndWarnings(input, errors, warnings);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function assertRoutingProblemInputValid(input: RoutingProblemInput): void {
  const validation = validateRoutingProblemInput(input);
  if (!validation.valid) {
    const summary = validation.errors.map(formatValidationIssue).join("\n");
    throw new Error(`Invalid RoutingProblemInput:\n${summary}`);
  }
}

export type { RoutingProblemValidationResult, ValidationIssue, ValidationIssueCode };
