import {
  isCheckinApplicableOnWorkDate,
  isCheckinEndViolation,
  isCheckoutApplicableOnWorkDate,
  isCheckoutWaitFeasible,
  isStartAtOrAfterCheckin,
  LOGISTICS_SERVICE_DURATION_MIN,
  minutesToHm,
  parseHmToMinutes,
  resolveCheckoutSchedule,
} from "../../../shared/logistics-scheduling-constraints";
import { estimateCarTravelMinutes, LOGISTICS_DEPOT_LAT, LOGISTICS_DEPOT_LNG } from "../logistics-timeline-utils";

export interface LogisticsScheduleTaskInput {
  taskId: number;
  logisticCode: number;
  lat: number | null;
  lng: number | null;
  checkoutTime?: string | null;
  checkoutDate?: string | null;
  checkinTime?: string | null;
  checkinDate?: string | null;
}

export interface LogisticsScheduledTaskRow {
  taskId: number;
  logisticCode: number;
  sequence: number;
  startMin: number;
  endMin: number;
  startTime: string;
  endTime: string;
  travelMinutes: number;
  checkoutWaitMinutes: number;
  checkoutWaitExceeded: boolean;
  checkinViolated: boolean;
  startAtOrAfterCheckin: boolean;
}

export interface LogisticsScheduleViolationRow {
  taskId: number;
  logisticCode: number;
  sequence: number;
}

export interface BuildLogisticsScheduleForDriverResult {
  tasks: LogisticsScheduledTaskRow[];
  violations: {
    checkin: LogisticsScheduleViolationRow[];
    checkoutWaitExceeded: LogisticsScheduleViolationRow[];
  };
  projectedClockMin: number;
  lastLat: number | null;
  lastLng: number | null;
}

function toFiniteCoord(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Motore temporale unico: stesso calcolo usato in Phase2 (simulazione winner) e in apply (recalculate).
 */
export function buildLogisticsScheduleForDriver(args: {
  tasks: LogisticsScheduleTaskInput[];
  driverStartMin: number;
  workDate: string;
  startFromDepot?: boolean;
}): BuildLogisticsScheduleForDriverResult {
  const { tasks, driverStartMin, workDate, startFromDepot = true } = args;
  const scheduled: LogisticsScheduledTaskRow[] = [];
  const checkinViolations: LogisticsScheduleViolationRow[] = [];
  const checkoutWaitViolations: LogisticsScheduleViolationRow[] = [];

  let clockMin = driverStartMin;
  let prevLat: number | null = startFromDepot ? LOGISTICS_DEPOT_LAT : null;
  let prevLng: number | null = startFromDepot ? LOGISTICS_DEPOT_LNG : null;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const lat = toFiniteCoord(task.lat);
    const lng = toFiniteCoord(task.lng);
    let travel = 0;
    if (prevLat !== null && prevLng !== null && lat !== null && lng !== null) {
      travel = estimateCarTravelMinutes({ lat: prevLat, lng: prevLng }, { lat, lng });
    }

    const arrivalMin = clockMin + travel;
    let checkoutWaitMinutes = 0;
    let checkoutWaitExceeded = false;
    let startMin = arrivalMin;

    if (isCheckoutApplicableOnWorkDate(task.checkoutTime, task.checkoutDate, workDate)) {
      const checkoutMin = parseHmToMinutes(task.checkoutTime, 0) ?? 0;
      const resolved = resolveCheckoutSchedule(arrivalMin, checkoutMin);
      startMin = resolved.startMin;
      checkoutWaitMinutes = resolved.checkoutWaitMinutes;
      checkoutWaitExceeded = resolved.checkoutWaitExceeded;
    }

    const endMin = startMin + LOGISTICS_SERVICE_DURATION_MIN;

    let checkinViolated = false;
    let startAtOrAfterCheckin = false;
    if (task.checkinTime && isCheckinApplicableOnWorkDate(task.checkinDate, workDate)) {
      const checkinMin = parseHmToMinutes(task.checkinTime, null);
      if (checkinMin != null) {
        checkinViolated = isCheckinEndViolation(endMin, checkinMin);
        startAtOrAfterCheckin = isStartAtOrAfterCheckin(startMin, checkinMin);
      }
    }

    const row: LogisticsScheduledTaskRow = {
      taskId: task.taskId,
      logisticCode: task.logisticCode,
      sequence: i + 1,
      startMin,
      endMin,
      startTime: minutesToHm(startMin),
      endTime: minutesToHm(endMin),
      travelMinutes: travel,
      checkoutWaitMinutes,
      checkoutWaitExceeded,
      checkinViolated,
      startAtOrAfterCheckin,
    };
    scheduled.push(row);

    if (checkinViolated || startAtOrAfterCheckin) {
      checkinViolations.push({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        sequence: i + 1,
      });
    }
    if (checkoutWaitExceeded || !isCheckoutWaitFeasible(checkoutWaitMinutes)) {
      checkoutWaitViolations.push({
        taskId: task.taskId,
        logisticCode: task.logisticCode,
        sequence: i + 1,
      });
    }

    clockMin = endMin;
    prevLat = lat;
    prevLng = lng;
  }

  return {
    tasks: scheduled,
    violations: {
      checkin: checkinViolations,
      checkoutWaitExceeded: checkoutWaitViolations,
    },
    projectedClockMin: clockMin,
    lastLat: prevLat,
    lastLng: prevLng,
  };
}

export function toLogisticsScheduleTaskInput(task: {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  checkoutTime?: string | null;
  checkoutDate?: string | null;
  checkinTime?: string | null;
  checkinDate?: string | null;
}): LogisticsScheduleTaskInput {
  return {
    taskId: task.taskId,
    logisticCode: task.logisticCode,
    lat: task.lat,
    lng: task.lng,
    checkoutTime: task.checkoutTime ?? null,
    checkoutDate: task.checkoutDate ?? null,
    checkinTime: task.checkinTime ?? null,
    checkinDate: task.checkinDate ?? null,
  };
}
