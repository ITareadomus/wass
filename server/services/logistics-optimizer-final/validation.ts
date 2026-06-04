import type { RoutingProblemInput } from "./input-contract";

export interface RoutingProblemValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateRoutingProblemInput(input: RoutingProblemInput): RoutingProblemValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.schemaVersion !== "logistics-routing-input/v1") {
    errors.push(`Unsupported schemaVersion: ${input.schemaVersion}`);
  }

  if (input.drivers.length === 0) {
    warnings.push("NO_SELECTED_DRIVERS");
  }

  if (input.windowConfig.priorityWindows === null) {
    warnings.push("PRIORITY_WINDOWS_UNAVAILABLE");
  }

  const expectedMatrixSize = input.tasks.length + 1;
  if (input.travelMatrixMin.length !== expectedMatrixSize) {
    errors.push(`travelMatrixMin row count ${input.travelMatrixMin.length} !== ${expectedMatrixSize}`);
  }

  input.travelMatrixMin.forEach((row, rowIndex) => {
    if (row.length !== expectedMatrixSize) {
      errors.push(`travelMatrixMin[${rowIndex}] length ${row.length} !== ${expectedMatrixSize}`);
    }
  });

  const nodeIndices = new Set<number>([input.depot.nodeIndex]);
  if (input.depot.nodeIndex !== 0) {
    errors.push("Depot nodeIndex must be 0");
  }

  for (const task of input.tasks) {
    if (nodeIndices.has(task.nodeIndex)) {
      errors.push(`Duplicate nodeIndex ${task.nodeIndex}`);
    }
    nodeIndices.add(task.nodeIndex);

    if (!task.eligibility.schedulable) {
      errors.push(`Task ${task.taskId} included but marked unschedulable`);
    }

    if (task.hardWindow.earliestStartMin > task.hardWindow.latestStartMin) {
      errors.push(
        `Task ${task.taskId} has inconsistent start window: ${task.hardWindow.earliestStartMin} > ${task.hardWindow.latestStartMin}`
      );
    }

    if (task.hardWindow.latestStartMin + input.serviceDurationMin > task.hardWindow.latestEndMin) {
      errors.push(`Task ${task.taskId} latestStart + service exceeds latestEnd`);
    }

    if (!Number.isFinite(task.location.lat) || !Number.isFinite(task.location.lng)) {
      errors.push(`Task ${task.taskId} has invalid coordinates`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
