import { buildTravelMatrixMinutes } from './carTravelEstimator';
import {
  loadLogisticsDriversMeta,
  loadLogisticsTasksFromDb,
  loadSelectedLogisticsDriverIds
} from './db';
import type { LogisticsTaskInput, Phase0Result, Phase1Result, PreparedTask } from './types';

export async function runLgPhase1(
  workDate: string,
  phase0: Phase0Result,
  preloadedTasks?: LogisticsTaskInput[]
): Promise<Phase1Result | null> {
  if (!phase0.ok) return null;

  const rawTasks = preloadedTasks ?? (await loadLogisticsTasksFromDb(workDate));
  const driverIds = await loadSelectedLogisticsDriverIds(workDate);
  const drivers = await loadLogisticsDriversMeta(workDate, driverIds);

  const prepared: PreparedTask[] = [];
  for (const t of rawTasks) {
    if (t.locked) continue;
    const w = phase0.windowsByTaskId.get(t.taskId);
    if (!w) continue;
    prepared.push({
      ...t,
      hkStartMin: w.startMin,
      hkEndMin: w.endMin
    });
  }

  if (prepared.length === 0 || drivers.length === 0) {
    return {
      tasks: prepared,
      drivers,
      travelMatrixMin: [],
      windowsByTaskId: phase0.windowsByTaskId
    };
  }

  const centroidLat = prepared.reduce((s, t) => s + t.lat, 0) / prepared.length;
  const centroidLng = prepared.reduce((s, t) => s + t.lng, 0) / prepared.length;
  const points = [{ lat: centroidLat, lng: centroidLng }, ...prepared.map((t) => ({ lat: t.lat, lng: t.lng }))];
  const travelMatrixMin = buildTravelMatrixMinutes(points);

  return {
    tasks: prepared,
    drivers,
    travelMatrixMin,
    windowsByTaskId: phase0.windowsByTaskId
  };
}
