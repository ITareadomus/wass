import { computeZone, getAdjacentZones, ZoneId } from "./zone";
import { scoreGroup } from "./scoring";

export type TaskInput = {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  zone?: number | null;
  priority?: string | null;
};

export type Phase1Params = {
  nearbySeedMaxMin: number;        // 15 (soglia vicino)
  fallbackSeedMaxMin: number;      // 20 (soglia fallback)
  minNearbyBeforeFallback: number; // 8 (quando attivare fallback)
  createSingleGroups: boolean;     // true
  neighborLimit: number;
  maxGroupsTotal: number;
  allowFourthIfTravelLeMin: number; // 5
  useAdjacentZones: boolean;
};

export const DEFAULT_PHASE1_PARAMS: Phase1Params = {
  nearbySeedMaxMin: 15,
  fallbackSeedMaxMin: 20,
  minNearbyBeforeFallback: 8,
  createSingleGroups: true,
  neighborLimit: 15,
  maxGroupsTotal: 3000,
  allowFourthIfTravelLeMin: 5,
  useAdjacentZones: true
};

export type CandidateGroup = {
  taskIds: number[];
  logisticCodes: number[];
  zone: number;
  seedTaskId: number;
  seedLogisticCode: number;
  avgTravelMin: number;
  maxTravelMin: number;
  score: number;
  isSingle?: boolean;
  reason?: string;
};

export type Phase1Event = {
  eventType: string;
  payload: Record<string, unknown>;
};

export type Phase1Result = {
  groups: CandidateGroup[];
  events: Phase1Event[];
  stats: {
    taskCount: number;
    groupCount: number;
    singleGroupCount: number;
    fallbackSeedCount: number;
    thresholds: { nearby: number; fallback: number };
  };
};

const AVG_SPEED_KMH = 18;
const NON_LINEAR_PATH_FACTOR = 1.5;

export function estimateTravelMinutes(a: TaskInput, b: TaskInput): number {
  const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  const km = (meters / 1000) * NON_LINEAR_PATH_FACTOR;
  const hours = km / AVG_SPEED_KMH;
  return Math.max(1, Math.round(hours * 60));
}

export function generateCandidateGroups(tasks: TaskInput[], params: Phase1Params): Phase1Result {
  const events: Phase1Event[] = [];
  let fallbackSeedCount = 0;
  let singleGroupCount = 0;

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

    const rankedAll = pool
      .map(t => ({ t, d: estimateTravelMinutes(seed, t) }))
      .sort((a, b) => a.d - b.d);

    const nearby15 = rankedAll.filter(x => x.d <= params.nearbySeedMaxMin);

    let ranked = nearby15;
    let usedFallback = false;

    if (nearby15.length < params.minNearbyBeforeFallback) {
      ranked = rankedAll.filter(x => x.d <= params.fallbackSeedMaxMin);
      usedFallback = ranked.length > nearby15.length;
    }

    if (usedFallback) {
      fallbackSeedCount++;
      events.push({
        eventType: "PHASE1_USED_FALLBACK_20",
        payload: {
          seed_task: seed.taskId,
          seed_logistic_code: seed.logisticCode,
          seed_zone: seedZone,
          nearby_count_15: nearby15.length,
          neighbors_count_selected: ranked.length,
          nearby_threshold: params.nearbySeedMaxMin,
          fallback_threshold: params.fallbackSeedMaxMin
        }
      });
    }

    const neighbors = ranked.slice(0, params.neighborLimit).map(x => x.t);

    let groupsAddedForSeed = 0;
    const countBefore = groupMap.size;

    for (const a of neighbors) {
      addGroup([seed, a], seed, seedZone, groupMap);
    }

    const candidates2 = comb2(neighbors);
    for (const [a, b] of candidates2) {
      addGroup([seed, a, b], seed, seedZone, groupMap);
    }

    const candidates3 = comb3(neighbors);
    for (const [a, b, c] of candidates3) {
      const g4 = [seed, a, b, c];
      if (allowFourth(g4, params.allowFourthIfTravelLeMin)) {
        addGroup(g4, seed, seedZone, groupMap);
      }
      addGroup([seed, a, b], seed, seedZone, groupMap);
      addGroup([seed, a, c], seed, seedZone, groupMap);
      addGroup([seed, b, c], seed, seedZone, groupMap);
    }

    groupsAddedForSeed = groupMap.size - countBefore;

    if (groupsAddedForSeed === 0 && params.createSingleGroups) {
      const singleKey = String(seed.taskId);
      if (!groupMap.has(singleKey)) {
        const singleScore = 15;
        groupMap.set(singleKey, {
          taskIds: [seed.taskId],
          logisticCodes: [seed.logisticCode],
          zone: seedZone,
          seedTaskId: seed.taskId,
          seedLogisticCode: seed.logisticCode,
          avgTravelMin: 0,
          maxTravelMin: 0,
          score: singleScore,
          isSingle: true,
          reason: "ISOLATED_NO_NEIGHBORS_UNDER_20"
        });
        singleGroupCount++;
        events.push({
          eventType: "PHASE1_GROUP_SINGLE_CREATED",
          payload: {
            tasks: [seed.taskId],
            logistic_codes: [seed.logisticCode],
            zone: seedZone,
            score: singleScore,
            reason: "ISOLATED_NO_NEIGHBORS_UNDER_20"
          }
        });
      }
    }
  }

  const all = Array.from(groupMap.values())
    .sort((x, y) => y.score - x.score)
    .slice(0, params.maxGroupsTotal);

  return {
    groups: all,
    events,
    stats: {
      taskCount: tasks.length,
      groupCount: all.length,
      singleGroupCount,
      fallbackSeedCount,
      thresholds: {
        nearby: params.nearbySeedMaxMin,
        fallback: params.fallbackSeedMaxMin
      }
    }
  };
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

  const sortedTasks = [...groupTasks].sort((a, b) => a.taskId - b.taskId);
  const logisticCodes = sortedTasks.map(t => t.logisticCode);

  groupMap.set(key, {
    taskIds: ids,
    logisticCodes,
    zone: seedZone,
    seedTaskId: seed.taskId,
    seedLogisticCode: seed.logisticCode,
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
