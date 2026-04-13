import type { DriverInput, Phase1Result, Phase2Result, PreparedTask } from './types';

/**
 * Deterministic geographic seeding: partition tasks by nearest of N anchor points on a circle around centroid.
 * Then rebalance counts toward [floor(T/N), ceil(T/N)] by moving border tasks (by taskId order).
 */
export function runLgPhase2(phase1: Phase1Result): Phase2Result {
  const { tasks, drivers } = phase1;
  const n = drivers.length;
  const T = tasks.length;
  if (n === 0 || T === 0) {
    return { seedAssignment: new Map(), targetMinPerDriver: 0, targetMaxPerDriver: 0 };
  }

  const targetMin = Math.floor(T / n);
  const targetMax = Math.ceil(T / n);

  let sumLat = 0;
  let sumLng = 0;
  for (const t of tasks) {
    sumLat += t.lat;
    sumLng += t.lng;
  }
  const cx = sumLat / T;
  const cy = sumLng / T;

  const radiusDeg = 0.02;
  const anchors: { lat: number; lng: number; driverId: number }[] = [];
  for (let k = 0; k < n; k++) {
    const angle = (2 * Math.PI * k) / n;
    anchors.push({
      lat: cx + radiusDeg * Math.cos(angle),
      lng: cy + radiusDeg * Math.sin(angle),
      driverId: drivers[k].driverId
    });
  }

  function nearestDriverId(t: PreparedTask): number {
    let best = anchors[0].driverId;
    let bestD = Infinity;
    for (const a of anchors) {
      const dx = t.lat - a.lat;
      const dy = t.lng - a.lng;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = a.driverId;
      }
    }
    return best;
  }

  const byDriver = new Map<number, PreparedTask[]>();
  for (const d of drivers) byDriver.set(d.driverId, []);

  const sorted = [...tasks].sort((a, b) => a.taskId - b.taskId);
  for (const t of sorted) {
    const did = nearestDriverId(t);
    byDriver.get(did)!.push(t);
  }

  function rebalance() {
    for (let iter = 0; iter < T * 3; iter++) {
      let moved = false;
      for (const d of drivers) {
        const list = byDriver.get(d.driverId)!;
        while (list.length > targetMax) {
          const victim = list.pop()!;
          let bestTo: number | null = null;
          let bestSize = Infinity;
          for (const o of drivers) {
            if (o.driverId === d.driverId) continue;
            const sz = byDriver.get(o.driverId)!.length;
            if (sz < bestSize) {
              bestSize = sz;
              bestTo = o.driverId;
            }
          }
          if (bestTo == null) break;
          byDriver.get(bestTo)!.push(victim);
          byDriver.get(bestTo)!.sort((a, b) => a.taskId - b.taskId);
          moved = true;
        }
      }
      for (const d of drivers) {
        const list = byDriver.get(d.driverId)!;
        while (list.length < targetMin) {
          let donor: DriverInput | null = null;
          let donorList: PreparedTask[] | null = null;
          for (const o of drivers) {
            if (o.driverId === d.driverId) continue;
            const L = byDriver.get(o.driverId)!;
            if (L.length > targetMin && (donorList == null || L.length > donorList.length)) {
              donor = o;
              donorList = L;
            }
          }
          if (!donor || !donorList || donorList.length === 0) break;
          donorList.sort((a, b) => a.taskId - b.taskId);
          const victim = donorList.pop()!;
          list.push(victim);
          list.sort((a, b) => a.taskId - b.taskId);
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  rebalance();

  const seedAssignment = new Map<number, number>();
  for (const d of drivers) {
    for (const t of byDriver.get(d.driverId) || []) {
      seedAssignment.set(t.taskId, d.driverId);
    }
  }

  return { seedAssignment, targetMinPerDriver: targetMin, targetMaxPerDriver: targetMax };
}
