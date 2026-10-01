import { resolveDeliveryQuotas } from "../../../shared/logistics-delivery-quotas";
import { formatLogisticsDriverDisplayName } from "../../../shared/logistics-zone-start-plan";
import type { LogisticsZoneStartPlan } from "../../../shared/logistics-zone-start-plan";
import {
  buildLogisticsRoutingInput,
  type BuildLogisticsRoutingInputOptions,
} from "./build-routing-input";
import {
  partitionExclusiveWorkZones,
  type ExclusiveWorkZoneSpec,
} from "./exclusive-work-zones";
import type { DriverNode, RoutingProblemInput, TaskNode } from "./input-contract";
import { RoutingInputValidationError } from "./run-routing-dry";
import { validateRoutingProblemInput } from "./validation";

function fallbackSingleZone(input: RoutingProblemInput): ExclusiveWorkZoneSpec[] {
  if (input.drivers.length === 0) return [];
  return [
    {
      zoneIndex: 0,
      zoneId: "exclusive-zone:0",
      label: "Zona 1",
      driverId: input.drivers[0].id,
      taskIds: input.tasks.map((task) => task.taskId),
      centroid: { lat: 0, lng: 0 },
      color: "#4575b4",
    },
  ];
}

function taskOption(task: TaskNode) {
  const lat = Number(task.location.lat);
  const lng = Number(task.location.lng);
  return {
    taskId: task.taskId,
    logisticCode: task.logisticCode,
    address: task.location.address ?? null,
    priority: task.priority ?? null,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
  };
}

export class DeliveryQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeliveryQuotaError";
  }
}

export function buildZoneStartPlanFromInput(
  input: RoutingProblemInput,
  targetTaskCountsByDriverId?: Map<number, number>,
): LogisticsZoneStartPlan {
  const partitioned = partitionExclusiveWorkZones(input, targetTaskCountsByDriverId);
  const zones = partitioned.length > 0 ? partitioned : fallbackSingleZone(input);
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));
  const driverById = new Map(input.drivers.map((driver) => [driver.id, driver]));

  const drivers = [...zones]
    .sort((left, right) => left.zoneIndex - right.zoneIndex)
    .map((zone) => {
      const driver: DriverNode | undefined = driverById.get(zone.driverId);
      const tasks = zone.taskIds
        .map((taskId) => taskById.get(taskId))
        .filter((task): task is TaskNode => task !== undefined)
        .sort((left, right) => left.logisticCode - right.logisticCode)
        .map(taskOption);
      return {
        driverId: zone.driverId,
        driverName:
          driver?.displayName ||
          formatLogisticsDriverDisplayName({
            id: zone.driverId,
            operationalCode: driver?.operationalCode,
          }),
        zoneIndex: zone.zoneIndex,
        zoneLabel: zone.label,
        zoneColor: zone.color,
        tasks,
      };
    })
    .filter((entry) => entry.tasks.length > 0);

  return {
    workDate: input.workDate,
    drivers,
  };
}

export async function planLogisticsZoneStarts(
  workDate: string,
  options: BuildLogisticsRoutingInputOptions & {
    /** null o assente = l'algoritmo divide in parti uguali. */
    deliveryQuotas?: Map<number, number | null> | null;
  } = {}
): Promise<LogisticsZoneStartPlan> {
  const input = await buildLogisticsRoutingInput(workDate, options);
  const inputValidation = validateRoutingProblemInput(input, { mode: "solver" });
  if (!inputValidation.valid) {
    throw new RoutingInputValidationError(inputValidation);
  }

  let targetTaskCountsByDriverId: Map<number, number> | undefined;
  if (options.deliveryQuotas && options.deliveryQuotas.size > 0) {
    const resolution = resolveDeliveryQuotas({
      total: input.tasks.length,
      drivers: input.drivers.map((driver) => ({
        driverId: driver.id,
        driverName: driver.displayName || `Autista ${driver.id}`,
        quota: options.deliveryQuotas?.has(driver.id)
          ? (options.deliveryQuotas.get(driver.id) ?? null)
          : null,
      })),
    });
    if (resolution.error) {
      throw new DeliveryQuotaError(resolution.error);
    }
    if (resolution.counts) {
      targetTaskCountsByDriverId = resolution.counts;
    }
  }

  return buildZoneStartPlanFromInput(input, targetTaskCountsByDriverId);
}
