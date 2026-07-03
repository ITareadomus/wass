import { mapPriorityType, type PriorityWindows } from "../optimizer/priorityWindows";
import {
  buildLogisticsScheduleForDriver,
  type LogisticsScheduleTaskInput,
} from "../logistics-optimizer/logistics-driver-schedule";
import type { RoutingProblemInput } from "./input-contract";
import type { RoutingRouteSolution, RoutingStopSolution } from "./solution-contract";

function toScheduleInputs(args: {
  stops: RoutingStopSolution[];
  input: RoutingProblemInput;
  containerTaskById: Map<number, any>;
}): LogisticsScheduleTaskInput[] {
  const { stops, input, containerTaskById } = args;
  const inputTaskById = new Map(input.tasks.map((task) => [task.taskId, task]));

  return stops.map((stop) => {
    const inputTask = inputTaskById.get(stop.taskId);
    const containerTask = containerTaskById.get(stop.taskId) || {};
    return {
      taskId: stop.taskId,
      logisticCode: Number(inputTask?.logisticCode ?? containerTask.logistic_code ?? 0),
      lat:
        containerTask.lat != null
          ? Number(containerTask.lat)
          : inputTask?.location.lat ?? null,
      lng:
        containerTask.lng != null
          ? Number(containerTask.lng)
          : inputTask?.location.lng ?? null,
      priorityType: mapPriorityType(containerTask.priority ?? inputTask?.priority ?? null),
      checkoutTime: containerTask.checkout_time ?? inputTask?.rawTimes.checkoutTime ?? null,
      checkoutDate: containerTask.checkout_date ?? inputTask?.rawTimes.checkoutDate ?? null,
      checkinTime: containerTask.checkin_time ?? inputTask?.rawTimes.checkinTime ?? null,
      checkinDate: containerTask.checkin_date ?? inputTask?.rawTimes.checkinDate ?? null,
      travelMinutesFromPrevious: Number(stop.travelFromPreviousMin || 0),
    };
  });
}

function mapBuiltScheduleToStops(args: {
  originalStops: RoutingStopSolution[];
  builtTasks: ReturnType<typeof buildLogisticsScheduleForDriver>["tasks"];
  effectiveDriverStartMin: number;
}): RoutingStopSolution[] {
  const { originalStops, builtTasks, effectiveDriverStartMin } = args;

  return originalStops.map((stop, index) => {
    const row = builtTasks[index];
    if (!row) return stop;

    const previousEndMin =
      index === 0 ? effectiveDriverStartMin : builtTasks[index - 1]?.endMin ?? effectiveDriverStartMin;
    const arrivalMin = previousEndMin + row.travelMinutes;
    const waitMin = Math.max(0, row.startMin - arrivalMin);

    return {
      ...stop,
      sequence: index + 1,
      arrivalMin,
      startMin: row.startMin,
      endMin: row.endMin,
      serviceDurationMin: row.endMin - row.startMin,
      travelFromPreviousMin: row.travelMinutes,
      waitMin,
      previousTaskId: index === 0 ? null : originalStops[index - 1]?.taskId ?? null,
    };
  });
}

export function applyEarlyRouteWaitAbsorptionToRoute(args: {
  route: RoutingRouteSolution;
  driverStartMin: number;
  input: RoutingProblemInput;
  containerTaskById: Map<number, any>;
  workDate: string;
  priorityWindows?: PriorityWindows | null;
}): { route: RoutingRouteSolution; effectiveDriverStartMin: number } {
  const { route, driverStartMin, input, containerTaskById, workDate, priorityWindows = null } = args;
  const sortedStops = [...route.stops].sort((left, right) => left.sequence - right.sequence);
  if (sortedStops.length === 0) {
    return { route, effectiveDriverStartMin: driverStartMin };
  }

  const scheduleInputs = toScheduleInputs({
    stops: sortedStops,
    input,
    containerTaskById,
  });

  const built = buildLogisticsScheduleForDriver({
    tasks: scheduleInputs,
    driverStartMin,
    workDate,
    priorityWindows,
  });

  const rescheduledStops = mapBuiltScheduleToStops({
    originalStops: sortedStops,
    builtTasks: built.tasks,
    effectiveDriverStartMin: built.effectiveDriverStartMin,
  });

  const totalTravelMin = rescheduledStops.reduce(
    (sum, stop) => sum + Number(stop.travelFromPreviousMin || 0),
    0
  );
  const totalWaitMin = rescheduledStops.reduce((sum, stop) => sum + Number(stop.waitMin || 0), 0);
  const totalServiceMin = rescheduledStops.reduce(
    (sum, stop) => sum + Number(stop.serviceDurationMin || 0),
    0
  );
  const endMin =
    rescheduledStops.length > 0
      ? rescheduledStops[rescheduledStops.length - 1].endMin
      : built.effectiveDriverStartMin;

  return {
    effectiveDriverStartMin: built.effectiveDriverStartMin,
    route: {
      ...route,
      startMin: built.effectiveDriverStartMin,
      endMin,
      totalTravelMin,
      totalWaitMin,
      totalServiceMin,
      stops: rescheduledStops,
    },
  };
}
