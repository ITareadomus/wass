import type { DriverNode, RoutingProblemInput, TaskId, TaskNode } from "./input-contract";
import type { RoutingRouteSolution, RoutingStopSolution } from "./solution-contract";

const DEPOT_NODE_INDEX = 0;

/**
 * Replays a visiting order against the travel matrix and the hard windows.
 * Returns null as soon as any window or the driver shift is violated.
 */
export function simulateRouteTiming(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  orderedTaskIds: TaskId[];
  taskById: Map<TaskId, TaskNode>;
}): RoutingRouteSolution | null {
  const { input, driver, orderedTaskIds, taskById } = args;
  const stops: RoutingStopSolution[] = [];

  let previousNodeIndex = DEPOT_NODE_INDEX;
  let previousTaskId: TaskId | null = null;
  let previousEndMin = driver.workWindow.startMin;
  let totalTravelMin = 0;
  let totalWaitMin = 0;
  let totalServiceMin = 0;

  for (let index = 0; index < orderedTaskIds.length; index += 1) {
    const taskId = orderedTaskIds[index];
    const task = taskById.get(taskId);
    if (!task) return null;

    const travel = input.travelMatrixMin[previousNodeIndex]?.[task.nodeIndex];
    if (!Number.isFinite(travel)) return null;

    const arrivalMin = previousEndMin + travel;
    const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
    const endMin = startMin + task.serviceDurationMin;

    if (startMin > task.hardWindow.latestStartMin) return null;
    if (endMin > task.hardWindow.latestEndMin) return null;
    if (endMin > driver.workWindow.endMin) return null;

    stops.push({
      sequence: index + 1,
      taskId,
      arrivalMin,
      startMin,
      endMin,
      serviceDurationMin: task.serviceDurationMin,
      travelFromPreviousMin: travel,
      waitMin: Math.max(0, startMin - arrivalMin),
      previousTaskId,
    });

    totalTravelMin += travel;
    totalWaitMin += Math.max(0, startMin - arrivalMin);
    totalServiceMin += task.serviceDurationMin;
    previousNodeIndex = task.nodeIndex;
    previousTaskId = taskId;
    previousEndMin = endMin;
  }

  if (stops.length === 0) return null;

  return {
    driverId: driver.id,
    startMin: driver.workWindow.startMin,
    endMin: stops[stops.length - 1].endMin,
    totalServiceMin,
    totalTravelMin,
    totalWaitMin,
    stops,
  };
}
