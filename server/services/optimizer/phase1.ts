import { computeZone, getAdjacentZones, ZoneId } from "./zone";
import { scoreGroup } from "./scoring";

export type TaskInput = {
  taskId: number;
  lat: number;
  lng: number;
  zone?: number | null;
  priority?: string | null;
};

export type Phase1Params = {
  maxApts: number;
  allowFourthIfTravelLeMin: number;
  neighborLimit: number;
  nearbySeedMaxMin: number;
  maxGroupsTotal: number;
  useAdjacentZones: boolean;
};

export const DEFAULT_PHASE1_PARAMS: Phase1Params = {
  maxApts: 3,
  allowFourthIfTravelLeMin: 5,
  neighborLimit: 15,
  nearbySeedMaxMin: 12,
  maxGroupsTotal: 3000,
  useAdjacentZones: true
};

export type CandidateGroup = {
  taskIds: number[];
  zone: number;
  seedTaskId: number;
  avgTravelMin: number;
  maxTravelMin: number;
  score: number;
};

const AVG_SPEED_KMH = 18;

export function estimateTravelMinutes(a: TaskInput, b: TaskInput): number {
  const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  const km = meters / 1000;
  const hours = km / AVG_SPEED_KMH;
  return Math.max(1, Math.round(hours * 60));
}

export function generateCandidateGroups(tasks: TaskInput[], params: Phase1Params): CandidateGroup[] {
  const tasksWithZone = tasks.map(t => ({
    ...t,
    zone: (t.zone ?? computeZone(t.lat, t.lng))
  }));

  const byZone = new Map<number, TaskInput[]>();
  for (const t of tasksWithZone) {
    const z = t.zone as number;
    if (!byZone.has(z)) byZone.set(z, []);
    byZone.get(z)!.push(t);
  }

  const groupMap = new Map<string, CandidateGroup>();

  for (const seed of tasksWithZone) {
    const seedZone = seed.zone as number;

    let pool: TaskInput[] = [...(byZone.get(seedZone) ?? [])].filter(t => t.taskId !== seed.taskId);

    if (params.useAdjacentZones) {
      const adj = getAdjacentZones(seedZone as ZoneId, false);
      for (const z of adj) {
        pool.push(...(byZone.get(z) ?? []));
      }
    }

    const seen = new Set<number>();
    pool = pool.filter(t => {
      if (seen.has(t.taskId)) return false;
      seen.add(t.taskId);
      return true;
    });

    const ranked = pool
      .map(t => ({ t, d: estimateTravelMinutes(seed, t) }))
      .filter(x => x.d <= params.nearbySeedMaxMin)
      .sort((a, b) => a.d - b.d)
      .slice(0, params.neighborLimit)
      .map(x => x.t);

    for (const a of ranked) {
      addGroup([seed, a], seed, seedZone, groupMap);
    }

    const candidates2 = comb2(ranked);
    for (const [a, b] of candidates2) {
      addGroup([seed, a, b], seed, seedZone, groupMap);
    }

    const candidates3 = comb3(ranked);
    for (const [a, b, c] of candidates3) {
      const g4 = [seed, a, b, c];
      if (allowFourth(g4, params.allowFourthIfTravelLeMin)) {
        addGroup(g4, seed, seedZone, groupMap);
      }
      addGroup([seed, a, b], seed, seedZone, groupMap);
      addGroup([seed, a, c], seed, seedZone, groupMap);
      addGroup([seed, b, c], seed, seedZone, groupMap);
    }
  }

  const all = Array.from(groupMap.values())
    .sort((x, y) => y.score - x.score)
    .slice(0, params.maxGroupsTotal);

  return all;
}

function addGroup(
  groupTasks: TaskInput[],
  seed: TaskInput,
  seedZone: number,
  groupMap: Map<string, CandidateGroup>
): void {
  if (groupTasks.length < 2 || groupTasks.length > 4) return;

  const ids = groupTasks.map(t => t.taskId).sort((a, b) => a - b);
  const key = ids.join("-");
  if (groupMap.has(key)) return;

  const { avgTravelMin, maxTravelMin } = travelStats(groupTasks);

  const zones = new Set(groupTasks.map(t => t.zone));
  const sameZone = zones.size === 1;

  const score = scoreGroup(avgTravelMin, maxTravelMin, sameZone);

  groupMap.set(key, {
    taskIds: ids,
    zone: seedZone,
    seedTaskId: seed.taskId,
    avgTravelMin,
    maxTravelMin,
    score
  });
}

function allowFourth(tasks: TaskInput[], thresholdMin: number): boolean {
  if (tasks.length !== 4) return false;
  const t4 = tasks[3];
  for (let i = 0; i < 3; i++) {
    const d = estimateTravelMinutes(t4, tasks[i]);
    if (d <= thresholdMin) return true;
  }
  return false;
}

function travelStats(tasks: TaskInput[]): { avgTravelMin: number; maxTravelMin: number } {
  const dists: number[] = [];
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      dists.push(estimateTravelMinutes(tasks[i], tasks[j]));
    }
  }
  const avg = dists.reduce((s, x) => s + x, 0) / Math.max(1, dists.length);
  const max = dists.length ? Math.max(...dists) : 0;
  return { avgTravelMin: Math.round(avg * 10) / 10, maxTravelMin: max };
}

function comb2<T>(arr: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      out.push([arr[i], arr[j]]);
    }
  }
  return out;
}

function comb3<T>(arr: T[]): [T, T, T][] {
  const out: [T, T, T][] = [];
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      for (let k = j + 1; k < arr.length; k++) {
        out.push([arr[i], arr[j], arr[k]]);
      }
    }
  }
  return out;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
