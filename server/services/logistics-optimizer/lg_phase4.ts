import * as workspaceFiles from '../workspace-files';
import {
  hydrateTasksFromLogisticsContainers,
  recalculateLogisticsDriverTimes
} from '../logistics-timeline-utils';
import type { DriverInput, Phase1Result } from './types';

function minutesToHHMM(m: number): string {
  const x = Math.max(0, Math.min(24 * 60 - 1, Math.round(m)));
  const h = Math.floor(x / 60);
  const min = x % 60;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseDriverStartMin(d: DriverInput): number {
  const p = d.startTime.split(':');
  const h = parseInt(p[0], 10);
  const m = parseInt(p[1] || '0', 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return 8 * 60;
  return h * 60 + m;
}

/**
 * Build payload compatible with workspace `saveLogisticsTimeline` / `getNormalizedLogisticsTimeline`.
 */
type AnyTask = Record<string, any>;

function indexContainerTasks(containersData: any): Map<number, AnyTask> {
  const byId = new Map<number, AnyTask>();
  const buckets = ['early_out', 'high_priority', 'low_priority'];
  for (const bucket of buckets) {
    const list = containersData?.containers?.[bucket]?.tasks;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const tid = Number(raw?.task_id);
      if (!Number.isFinite(tid)) continue;
      if (!byId.has(tid)) {
        byId.set(tid, JSON.parse(JSON.stringify(raw)));
      }
    }
  }
  return byId;
}

export async function runLgPhase4(
  workDate: string,
  phase1: Phase1Result,
  routesByDriverId: Map<number, number[]>,
  arrivalMinByTaskId: Map<number, number> | undefined,
  modifiedBy: string
): Promise<{ timeline: Record<string, unknown>; assignedCount: number }> {
  const { tasks, drivers, travelMatrixMin } = phase1;
  const taskById = new Map(tasks.map((t) => [t.taskId, t]));
  const sorted = [...tasks].sort((a, b) => a.taskId - b.taskId);
  const indexOfTaskId = new Map<number, number>();
  sorted.forEach((t, i) => indexOfTaskId.set(t.taskId, i + 1));
  const containersData = await workspaceFiles.loadLogisticsContainers(workDate);
  const containerTaskById = indexContainerTasks(containersData);

  const drivers_assignments: any[] = [];
  let assignedCount = 0;

  for (const d of drivers) {
    const route = routesByDriverId.get(d.driverId) || [];
    const taskRows: any[] = [];
    let prevIdx = 0;
    let clock = parseDriverStartMin(d);

    for (let seq = 0; seq < route.length; seq++) {
      const tid = route[seq];
      const t = taskById.get(tid);
      if (!t) continue;
      const idx = indexOfTaskId.get(tid)!;
      const travelMin = travelMatrixMin[prevIdx]?.[idx] ?? 0;
      const solverArrival = arrivalMinByTaskId?.get(tid);
      let arrive = solverArrival != null ? solverArrival : clock + travelMin;
      const startSvc = Math.max(arrive, t.hkStartMin);
      const endSvc = startSvc + t.serviceMinutes;
      clock = endSvc;
      prevIdx = idx;
      const base = containerTaskById.get(tid) || {};
      const reasons = Array.isArray(base.reasons) ? [...base.reasons] : [];
      if (!reasons.includes('logistics_optimizer_v0')) {
        reasons.push('logistics_optimizer_v0');
      }

      taskRows.push({
        task_id: Number(base.task_id ?? t.taskId),
        logistic_code: Number(base.logistic_code ?? t.logisticCode),
        client_id: base.client_id ?? null,
        premium: Boolean(base.premium),
        address: base.address ?? null,
        lat: base.lat ?? t.lat,
        lng: base.lng ?? t.lng,
        cleaning_time: Number(base.cleaning_time ?? t.serviceMinutes),
        checkin_date: base.checkin_date ?? null,
        checkout_date: base.checkout_date ?? null,
        checkin_time: base.checkin_time ?? null,
        checkout_time: base.checkout_time ?? null,
        pax_in: base.pax_in ?? 0,
        pax_out: base.pax_out ?? 0,
        small_equipment: Boolean(base.small_equipment),
        operation_id: base.operation_id !== undefined ? base.operation_id : 2,
        confirmed_operation:
          base.confirmed_operation !== undefined ? Boolean(base.confirmed_operation) : true,
        straordinaria: Boolean(base.straordinaria),
        type_apt: base.type_apt ?? null,
        alias: base.alias ?? null,
        customer_name: base.customer_name ?? base.type ?? null,
        customer_reference: base.customer_reference ?? null,
        reasons,
        manually_moved: false,
        priority: base.priority ?? 'low_priority',
        start_time: minutesToHHMM(startSvc),
        end_time: minutesToHHMM(endSvc),
        followup: seq > 0,
        sequence: seq + 1,
        travel_time: travelMin
      });
      assignedCount++;
    }

    drivers_assignments.push({
      driver: {
        id: d.driverId,
        name: d.name || 'Driver',
        lastname: d.lastname || '',
        role: 'Driver',
        premium: false,
        start_time: d.startTime
      },
      tasks: taskRows
    });
    if (taskRows.length > 0) {
      try {
        await hydrateTasksFromLogisticsContainers(drivers_assignments[drivers_assignments.length - 1], workDate);
        const updated = await recalculateLogisticsDriverTimes(
          drivers_assignments[drivers_assignments.length - 1],
          workDate
        );
        drivers_assignments[drivers_assignments.length - 1] = updated;
      } catch (e: any) {
        throw new Error(
          `Failed logistics recalculate for driver ${d.driverId}: ${e?.message || String(e)}`
        );
      }
    }
  }

  const timeline = {
    drivers_assignments,
    metadata: {
      date: workDate,
      last_updated: new Date().toISOString(),
      created_by: modifiedBy,
      modified_by: [modifiedBy]
    },
    meta: {
      total_drivers: drivers_assignments.length,
      used_drivers: drivers_assignments.filter((x: any) => (x as any).tasks?.length > 0).length,
      assigned_tasks: assignedCount
    }
  };

  return { timeline, assignedCount };
}
