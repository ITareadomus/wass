import type { RoutingProblemInput, TaskNode } from "./input-contract";
import {
  GREEDY_SOLVER_ID,
  KNOWN_ROUTING_SOLVER_IDS,
  ROUTING_SOLUTION_SCHEMA_VERSION,
  type RoutingSolution,
} from "./solution-contract";
import type {
  RoutingSolutionValidationResult,
  SolutionValidationIssue,
} from "./solution-validation-contract";
import {
  enrichSolutionIssuesWithLogisticCodes,
  formatRoutingSolutionValidationForUser,
} from "./user-facing-errors";

const DAY_END_MIN = 24 * 60;
const DEPOT_NODE_INDEX = 0;

function pushError(
  errors: SolutionValidationIssue[],
  issue: Omit<SolutionValidationIssue, "severity">
): void {
  errors.push({ ...issue, severity: "error" });
}

function pushWarning(
  warnings: SolutionValidationIssue[],
  issue: Omit<SolutionValidationIssue, "severity">
): void {
  warnings.push({ ...issue, severity: "warning" });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidMinute(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= DAY_END_MIN;
}

export function formatSolutionValidationIssue(issue: SolutionValidationIssue): string {
  const targetParts: string[] = [];
  if (issue.taskId !== undefined) targetParts.push(`taskId=${issue.taskId}`);
  if (issue.logisticCode !== undefined) targetParts.push(`logisticCode=${issue.logisticCode}`);
  if (issue.driverId !== undefined) targetParts.push(`driverId=${issue.driverId}`);
  const target = targetParts.length > 0 ? ` ${targetParts.join(" ")}` : "";
  return `${issue.code}${target}: ${issue.message}`;
}

function getExpectedTravelMin(
  input: RoutingProblemInput,
  fromNodeIndex: number,
  toNodeIndex: number
): number | null {
  const matrix = input.travelMatrixMin;
  if (
    fromNodeIndex < 0 ||
    fromNodeIndex >= matrix.length ||
    toNodeIndex < 0 ||
    toNodeIndex >= (matrix[fromNodeIndex]?.length ?? 0)
  ) {
    return null;
  }

  const travel = matrix[fromNodeIndex][toNodeIndex];
  return isFiniteNumber(travel) ? travel : null;
}

function validateSchemaAndMetadata(
  solution: RoutingSolution,
  errors: SolutionValidationIssue[],
  warnings: SolutionValidationIssue[]
): void {
  if (solution.schemaVersion !== ROUTING_SOLUTION_SCHEMA_VERSION) {
    pushError(errors, {
      code: "UNSUPPORTED_SCHEMA_VERSION",
      message: `Unexpected schemaVersion: ${solution.schemaVersion}`,
      path: "schemaVersion",
      expected: ROUTING_SOLUTION_SCHEMA_VERSION,
      actual: solution.schemaVersion,
    });
  }

  if (!KNOWN_ROUTING_SOLVER_IDS.includes(solution.solverId as (typeof KNOWN_ROUTING_SOLVER_IDS)[number])) {
    pushWarning(warnings, {
      code: "UNEXPECTED_SOLVER_ID",
      message: `Unexpected solverId: ${solution.solverId}`,
      path: "solverId",
      expected: KNOWN_ROUTING_SOLVER_IDS,
      actual: solution.solverId,
    });
  }
}

function validateTaskPartition(
  input: RoutingProblemInput,
  solution: RoutingSolution,
  errors: SolutionValidationIssue[]
): Set<number> {
  const inputTaskIds = new Set(input.tasks.map((task) => task.taskId));
  const assignedTaskIds = new Set<number>();
  const seenAssigned = new Set<number>();

  for (const route of solution.routes) {
    for (const stop of route.stops) {
      if (!inputTaskIds.has(stop.taskId)) {
        pushError(errors, {
          code: "UNKNOWN_TASK_IN_SOLUTION",
          message: "Assigned taskId is not present in routing input",
          path: "routes.stops",
          taskId: stop.taskId,
        });
        continue;
      }

      if (seenAssigned.has(stop.taskId)) {
        pushError(errors, {
          code: "DUPLICATE_ASSIGNED_TASK",
          message: "Task appears in more than one route",
          path: "routes.stops",
          taskId: stop.taskId,
        });
      }
      seenAssigned.add(stop.taskId);
      assignedTaskIds.add(stop.taskId);
    }
  }

  const seenDropped = new Set<number>();

  for (const dropped of solution.droppedTasks) {
    if (!inputTaskIds.has(dropped.taskId)) {
      pushError(errors, {
        code: "UNKNOWN_TASK_IN_SOLUTION",
        message: "Dropped taskId is not present in routing input",
        path: "droppedTasks",
        taskId: dropped.taskId,
      });
    }

    if (seenDropped.has(dropped.taskId)) {
      pushError(errors, {
        code: "DUPLICATE_DROPPED_TASK",
        message: "Task appears more than once in droppedTasks",
        path: "droppedTasks",
        taskId: dropped.taskId,
      });
    }
    seenDropped.add(dropped.taskId);

    if (assignedTaskIds.has(dropped.taskId)) {
      pushError(errors, {
        code: "DUPLICATE_ASSIGNED_TASK",
        message: "Dropped task is also assigned in a route",
        path: "droppedTasks",
        taskId: dropped.taskId,
      });
    }
  }

  const covered = new Set<number>([
    ...assignedTaskIds,
    ...solution.droppedTasks.map((dropped) => dropped.taskId),
  ]);

  for (const taskId of inputTaskIds) {
    if (!covered.has(taskId)) {
      pushError(errors, {
        code: "TASK_PARTITION_MISMATCH",
        message: "Input task is missing from assigned and dropped partitions",
        path: "tasks",
        taskId,
      });
    }
  }

  for (const taskId of covered) {
    if (!inputTaskIds.has(taskId)) {
      pushError(errors, {
        code: "TASK_PARTITION_MISMATCH",
        message: "Solution references taskId not present in input.tasks",
        path: "tasks",
        taskId,
      });
    }
  }

  return assignedTaskIds;
}

function validateRoutes(
  input: RoutingProblemInput,
  solution: RoutingSolution,
  errors: SolutionValidationIssue[],
  warnings: SolutionValidationIssue[]
): void {
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));

  for (const route of solution.routes) {
    if (!driverById.has(route.driverId)) {
      pushError(errors, {
        code: "UNKNOWN_DRIVER_IN_ROUTE",
        message: "Route references unknown driverId",
        path: "routes",
        driverId: route.driverId,
      });
      continue;
    }

    if (route.stops.length === 0) {
      pushWarning(warnings, {
        code: "EMPTY_ROUTE_IN_SOLUTION",
        message: "Route has zero stops and should not be included",
        path: "routes",
        driverId: route.driverId,
      });
      continue;
    }

    const driver = driverById.get(route.driverId)!;
    const sequences = route.stops.map((stop) => stop.sequence).sort((a, b) => a - b);

    for (let index = 0; index < sequences.length; index += 1) {
      if (sequences[index] !== index + 1) {
        pushError(errors, {
          code: "INVALID_ROUTE_SEQUENCE",
          message: "Route stop sequences must be contiguous starting at 1",
          path: "routes.stops",
          driverId: route.driverId,
          expected: index + 1,
          actual: sequences[index],
        });
        break;
      }
    }

    let previousEndMin: number | null = null;

    for (let stopIndex = 0; stopIndex < route.stops.length; stopIndex += 1) {
      const stop = route.stops[stopIndex];
      const previousStop = stopIndex > 0 ? route.stops[stopIndex - 1] : null;
      const task = taskById.get(stop.taskId);
      if (!task) continue;

      if (
        !isValidMinute(stop.arrivalMin) ||
        !isValidMinute(stop.startMin) ||
        !isValidMinute(stop.endMin) ||
        !isValidMinute(stop.travelFromPreviousMin) ||
        !isValidMinute(stop.waitMin)
      ) {
        pushError(errors, {
          code: "NON_MONOTONIC_ROUTE_TIMES",
          message: "Stop contains invalid minute values",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
        });
        continue;
      }

      if (stop.waitMin < 0) {
        pushError(errors, {
          code: "ARRIVAL_WAIT_INCONSISTENT",
          message: "waitMin must be non-negative",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          actual: stop.waitMin,
        });
      }

      if (stop.arrivalMin + stop.waitMin !== stop.startMin) {
        pushError(errors, {
          code: "ARRIVAL_WAIT_INCONSISTENT",
          message: "arrivalMin + waitMin must equal startMin",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: stop.startMin,
          actual: stop.arrivalMin + stop.waitMin,
        });
      }

      if (stop.endMin - stop.startMin !== stop.serviceDurationMin) {
        pushError(errors, {
          code: "INVALID_SERVICE_DURATION",
          message: "endMin - startMin must equal serviceDurationMin",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: stop.serviceDurationMin,
          actual: stop.endMin - stop.startMin,
        });
      }

      if (stop.startMin < task.hardWindow.earliestStartMin) {
        pushError(errors, {
          code: "TASK_HARD_WINDOW_VIOLATION",
          message: "startMin is before task hard earliestStartMin",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: task.hardWindow.earliestStartMin,
          actual: stop.startMin,
        });
      }

      if (stop.startMin > task.hardWindow.latestStartMin) {
        pushError(errors, {
          code: "TASK_HARD_WINDOW_VIOLATION",
          message: "startMin is after task hard latestStartMin",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: task.hardWindow.latestStartMin,
          actual: stop.startMin,
        });
      }

      if (stop.endMin > task.hardWindow.latestEndMin) {
        pushError(errors, {
          code: "TASK_HARD_WINDOW_VIOLATION",
          message: "endMin is after task hard latestEndMin",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: task.hardWindow.latestEndMin,
          actual: stop.endMin,
        });
      }

      if (stop.sequence === 1 && stop.arrivalMin < driver.workWindow.startMin) {
        pushError(errors, {
          code: "DRIVER_WINDOW_VIOLATION",
          message: "First stop arrivalMin is before driver work window start",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: driver.workWindow.startMin,
          actual: stop.arrivalMin,
        });
      }

      if (previousEndMin !== null && stop.startMin < previousEndMin) {
        pushError(errors, {
          code: "NON_MONOTONIC_ROUTE_TIMES",
          message: "startMin must be non-decreasing along the route",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: previousEndMin,
          actual: stop.startMin,
        });
      }

      if (previousEndMin !== null && stop.endMin < previousEndMin) {
        pushError(errors, {
          code: "NON_MONOTONIC_ROUTE_TIMES",
          message: "endMin must be non-decreasing along the route",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: previousEndMin,
          actual: stop.endMin,
        });
      }

      if (stopIndex === 0) {
        if (stop.previousTaskId != null) {
          pushError(errors, {
            code: "PREVIOUS_TASK_MISMATCH",
            message: "First stop must have previousTaskId null for depot departure",
            path: "routes.stops",
            taskId: stop.taskId,
            driverId: route.driverId,
            expected: null,
            actual: stop.previousTaskId,
          });
        }
      } else if (previousStop) {
        if (stop.previousTaskId !== previousStop.taskId) {
          pushError(errors, {
            code: "PREVIOUS_TASK_MISMATCH",
            message: "previousTaskId must match the previous stop in route order",
            path: "routes.stops",
            taskId: stop.taskId,
            driverId: route.driverId,
            expected: previousStop.taskId,
            actual: stop.previousTaskId,
          });
        }
      }

      const fromNodeIndex =
        stopIndex === 0 || previousStop == null
          ? DEPOT_NODE_INDEX
          : (taskById.get(previousStop.taskId)?.nodeIndex ?? -1);

      const expectedTravel = getExpectedTravelMin(input, fromNodeIndex, task.nodeIndex);
      if (expectedTravel === null) {
        pushError(errors, {
          code: "TRAVEL_MATRIX_MISMATCH",
          message: "Unable to resolve expected travel from travel matrix",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
        });
      } else if (stop.travelFromPreviousMin !== expectedTravel) {
        pushError(errors, {
          code: "TRAVEL_MATRIX_MISMATCH",
          message: "travelFromPreviousMin does not match travel matrix",
          path: "routes.stops",
          taskId: stop.taskId,
          driverId: route.driverId,
          expected: expectedTravel,
          actual: stop.travelFromPreviousMin,
        });
      }

      previousEndMin = stop.endMin;
    }

    if (route.stops.length > 0) {
      const expectedServiceTotal = route.stops.reduce(
        (sum, stop) => sum + stop.serviceDurationMin,
        0
      );
      const expectedTravelTotal = route.stops.reduce(
        (sum, stop) => sum + stop.travelFromPreviousMin,
        0
      );
      const expectedWaitTotal = route.stops.reduce((sum, stop) => sum + stop.waitMin, 0);

      if (route.totalServiceMin !== expectedServiceTotal) {
        pushError(errors, {
          code: "ROUTE_TOTALS_MISMATCH",
          message: "route.totalServiceMin does not match sum of stop service durations",
          path: "routes",
          driverId: route.driverId,
          expected: expectedServiceTotal,
          actual: route.totalServiceMin,
        });
      }

      if (route.totalTravelMin !== expectedTravelTotal) {
        pushError(errors, {
          code: "ROUTE_TOTALS_MISMATCH",
          message: "route.totalTravelMin does not match sum of stop travel minutes",
          path: "routes",
          driverId: route.driverId,
          expected: expectedTravelTotal,
          actual: route.totalTravelMin,
        });
      }

      if (route.totalWaitMin !== expectedWaitTotal) {
        pushError(errors, {
          code: "ROUTE_TOTALS_MISMATCH",
          message: "route.totalWaitMin does not match sum of stop wait minutes",
          path: "routes",
          driverId: route.driverId,
          expected: expectedWaitTotal,
          actual: route.totalWaitMin,
        });
      }
    }

    if (route.stops.length > 0) {
      const lastStop = route.stops[route.stops.length - 1];
      if (lastStop.endMin > driver.workWindow.endMin) {
        pushError(errors, {
          code: "DRIVER_WINDOW_VIOLATION",
          message: "Route end exceeds driver work window end",
          path: "routes",
          driverId: route.driverId,
          expected: driver.workWindow.endMin,
          actual: lastStop.endMin,
        });
      }

      if (route.endMin !== lastStop.endMin) {
        pushError(errors, {
          code: "NON_MONOTONIC_ROUTE_TIMES",
          message: "route.endMin must equal last stop endMin",
          path: "routes",
          driverId: route.driverId,
          expected: lastStop.endMin,
          actual: route.endMin,
        });
      }
    }
  }
}

function validateRequiredDriverConstraints(
  input: RoutingProblemInput,
  solution: RoutingSolution,
  errors: SolutionValidationIssue[]
): void {
  const requiredConstraints = input.hardConstraints.filter(
    (constraint) => constraint.type === "REQUIRED_DRIVER_TASK"
  );
  if (requiredConstraints.length === 0) return;

  const droppedTaskIds = new Set(solution.droppedTasks.map((dropped) => dropped.taskId));
  const assignedDriverByTaskId = new Map<number, number>();

  for (const route of solution.routes) {
    for (const stop of route.stops) {
      assignedDriverByTaskId.set(stop.taskId, route.driverId);
    }
  }

  for (const constraint of requiredConstraints) {
    if (droppedTaskIds.has(constraint.taskId)) {
      pushError(errors, {
        code: "REQUIRED_DRIVER_DROPPED",
        message: "Task with REQUIRED_DRIVER_TASK was dropped from the solution",
        path: "droppedTasks",
        taskId: constraint.taskId,
        driverId: constraint.driverId,
      });
      continue;
    }

    const assignedDriverId = assignedDriverByTaskId.get(constraint.taskId);
    if (assignedDriverId !== undefined && assignedDriverId !== constraint.driverId) {
      pushError(errors, {
        code: "REQUIRED_DRIVER_VIOLATION",
        message: "Task with REQUIRED_DRIVER_TASK was assigned to a different driver",
        path: "routes.stops",
        taskId: constraint.taskId,
        driverId: assignedDriverId,
        expected: constraint.driverId,
        actual: assignedDriverId,
      });
    }
  }
}

function validateStatus(
  solution: RoutingSolution,
  errors: SolutionValidationIssue[]
): void {
  const assignedCount = solution.routes.reduce((sum, route) => sum + route.stops.length, 0);
  const droppedCount = solution.droppedTasks.length;
  const hasRequiredErrors = errors.some(
    (issue) => issue.code === "REQUIRED_DRIVER_DROPPED" || issue.code === "REQUIRED_DRIVER_VIOLATION"
  );

  if ((solution.status === "FEASIBLE" || solution.status === "PARTIAL") && hasRequiredErrors) {
    pushError(errors, {
      code: "INVALID_SOLUTION_STATUS",
      message: "FEASIBLE/PARTIAL status is invalid when REQUIRED_DRIVER_TASK constraints are violated",
      path: "status",
      expected: "INVALID",
      actual: solution.status,
    });
  }

  if (solution.status === "FEASIBLE" && droppedCount > 0) {
    pushError(errors, {
      code: "INVALID_SOLUTION_STATUS",
      message: "FEASIBLE status requires zero dropped tasks",
      path: "status",
      expected: "FEASIBLE with droppedTasks.length === 0",
      actual: solution.status,
    });
  }

  if (solution.status === "PARTIAL" && droppedCount === 0) {
    pushError(errors, {
      code: "INVALID_SOLUTION_STATUS",
      message: "PARTIAL status requires at least one dropped task",
      path: "status",
      expected: "PARTIAL with droppedTasks.length > 0",
      actual: solution.status,
    });
  }

  if (solution.status === "INFEASIBLE" && assignedCount > 0) {
    pushError(errors, {
      code: "INVALID_SOLUTION_STATUS",
      message: "INFEASIBLE status requires zero assigned tasks",
      path: "status",
      expected: "INFEASIBLE with zero assigned stops",
      actual: solution.status,
    });
  }
}

function validateObjectiveBreakdown(
  solution: RoutingSolution,
  warnings: SolutionValidationIssue[]
): void {
  if (!solution.objectiveBreakdown) return;

  const assignedCount = solution.routes.reduce((sum, route) => sum + route.stops.length, 0);
  const droppedCount = solution.droppedTasks.length;
  const totalTravel = solution.routes.reduce((sum, route) => sum + route.totalTravelMin, 0);
  const totalWait = solution.routes.reduce((sum, route) => sum + route.totalWaitMin, 0);

  const breakdown = solution.objectiveBreakdown;

  if (breakdown.assignedTasks !== assignedCount) {
    pushWarning(warnings, {
      code: "OBJECTIVE_BREAKDOWN_MISMATCH",
      message: "objectiveBreakdown.assignedTasks does not match assigned stop count",
      path: "objectiveBreakdown.assignedTasks",
      expected: assignedCount,
      actual: breakdown.assignedTasks,
    });
  }

  if (breakdown.droppedTasks !== droppedCount) {
    pushWarning(warnings, {
      code: "OBJECTIVE_BREAKDOWN_MISMATCH",
      message: "objectiveBreakdown.droppedTasks does not match dropped task count",
      path: "objectiveBreakdown.droppedTasks",
      expected: droppedCount,
      actual: breakdown.droppedTasks,
    });
  }

  if (breakdown.totalTravelMin !== totalTravel) {
    pushWarning(warnings, {
      code: "OBJECTIVE_BREAKDOWN_MISMATCH",
      message: "objectiveBreakdown.totalTravelMin does not match route totals",
      path: "objectiveBreakdown.totalTravelMin",
      expected: totalTravel,
      actual: breakdown.totalTravelMin,
    });
  }

  if (breakdown.totalWaitMin !== totalWait) {
    pushWarning(warnings, {
      code: "OBJECTIVE_BREAKDOWN_MISMATCH",
      message: "objectiveBreakdown.totalWaitMin does not match route totals",
      path: "objectiveBreakdown.totalWaitMin",
      expected: totalWait,
      actual: breakdown.totalWaitMin,
    });
  }
}

export function validateRoutingSolution(
  input: RoutingProblemInput,
  solution: RoutingSolution
): RoutingSolutionValidationResult {
  const errors: SolutionValidationIssue[] = [];
  const warnings: SolutionValidationIssue[] = [];

  validateSchemaAndMetadata(solution, errors, warnings);
  validateTaskPartition(input, solution, errors);
  validateRoutes(input, solution, errors, warnings);
  validateRequiredDriverConstraints(input, solution, errors);
  validateStatus(solution, errors);
  validateObjectiveBreakdown(solution, warnings);

  return {
    valid: errors.length === 0,
    errors: enrichSolutionIssuesWithLogisticCodes(input, errors),
    warnings: enrichSolutionIssuesWithLogisticCodes(input, warnings),
  };
}

export class RoutingSolutionValidationError extends Error {
  readonly solutionValidation: RoutingSolutionValidationResult;

  constructor(solutionValidation: RoutingSolutionValidationResult) {
    super(formatRoutingSolutionValidationForUser(solutionValidation));
    this.name = "RoutingSolutionValidationError";
    this.solutionValidation = solutionValidation;
  }
}

export function assertRoutingSolutionValid(
  input: RoutingProblemInput,
  solution: RoutingSolution
): void {
  const validation = validateRoutingSolution(input, solution);
  if (!validation.valid) {
    throw new RoutingSolutionValidationError(validation);
  }
}

export type {
  RoutingSolutionValidationResult,
  SolutionValidationIssue,
  SolutionValidationIssueCode,
} from "./solution-validation-contract";
