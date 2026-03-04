import { computeZone, getAdjacentZones, ZoneId } from "./zone";
import { scoreGroup } from "./scoring";
import { TravelTimeProvider } from './travelTimeProvider';

export type TaskInput = {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  zone?: number | null;
  priority?: string | null;
  straordinaria?: boolean;
  cleaningTimeMinutes?: number;
};

export type Phase1Params = {
  nearbySeedMaxMin: number;        // 15 (soglia vicino)
  fallbackSeedMaxMin: number;      // 20 (soglia fallback)
  minNearbyBeforeFallback: number; // 8 (quando attivare fallback)
  createSingleGroups: boolean;     // true
  neighborLimit: number;
  maxGroupsTotal: number;
  useAdjacentZones: boolean;
  minGroupSize?: number;           // Dynamic: min task per gruppo
  maxGroupSize?: number;           // Dynamic: max task per gruppo
  // Merge/wave: remaining task slots per cleaner (cleanerId → slots left)
  // Limits neighborLimit and maxGroupSize for each anchored cleaner so
  // cleaners with many pre-existing tasks don't get overloaded.
  remainingSlotsPerCleaner?: Map<number, number>;
};

export const DEFAULT_PHASE1_PARAMS: Phase1Params = {
  nearbySeedMaxMin: 15,
  fallbackSeedMaxMin: 25,
  minNearbyBeforeFallback: 8,
  createSingleGroups: true,
  neighborLimit: 15,
  maxGroupsTotal: 3000,
  useAdjacentZones: true,
  minGroupSize: 1,
  maxGroupSize: 4
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
  hasStraordinaria?: boolean;
  isLongStraordinaria?: boolean;
  anchoredCleanerId?: number;
  timelineTaskIds?: number[];
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

const NON_LINEAR_PATH_FACTOR = 1.5;
const BASE_TIME_MIN = 5.0;
const MIN_TRAVEL = 2;
const MAX_TRAVEL = 45;

export function estimateTravelMinutes(a: TaskInput, b: TaskInput): number {
  const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  const km = meters / 1000;
  const distReale = km * NON_LINEAR_PATH_FACTOR;
  
  let travelTime: number;
  if (distReale < 0.8) {
    travelTime = distReale * 6.0;
  } else if (distReale < 2.5) {
    travelTime = distReale * 10.0;
  } else {
    travelTime = distReale * 5.0;
  }
  
  const totalTime = BASE_TIME_MIN + travelTime;
  return Math.round(Math.max(MIN_TRAVEL, Math.min(MAX_TRAVEL, totalTime)));
}

export function estimateTravelMinutesWithProvider(
  a: TaskInput, 
  b: TaskInput, 
  provider?: TravelTimeProvider
): number {
  if (provider) {
    return provider.getTravelMinutesSync(
      { lat: a.lat, lng: a.lng },
      { lat: b.lat, lng: b.lng }
    );
  }
  return estimateTravelMinutes(a, b);
}

export function generateCandidateGroups(
  tasks: TaskInput[],
  params: Phase1Params,
  timelineSeeds?: Map<number, number>
): Phase1Result {
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

  if (timelineSeeds && timelineSeeds.size > 0) {
    // =========================================================================
    // MERGE / WAVE MODE: groups centered on cleaner positions
    // Seeds are ONLY the cleaner's last timeline task. Neighbors are ONLY new
    // tasks. Every group is born anchored to its cleaner.
    // =========================================================================
    const seedTaskIds = new Set(timelineSeeds.keys());
    const cleanerSeeds = tasksWithZone.filter(t => seedTaskIds.has(t.taskId));
    const newTasks = tasksWithZone.filter(t => !seedTaskIds.has(t.taskId));

    const newByZone = new Map<number, TaskInput[]>();
    for (const t of newTasks) {
      const z = t.zone as number;
      if (!newByZone.has(z)) newByZone.set(z, []);
      newByZone.get(z)!.push(t);
    }

    const coveredTaskIds = new Set<number>();

    for (const seed of cleanerSeeds) {
      const cleanerId = timelineSeeds.get(seed.taskId)!;
      const seedZone = seed.zone as number;

      let pool: TaskInput[] = [...(newByZone.get(seedZone) ?? [])];
      if (params.useAdjacentZones) {
        const adj = getAdjacentZones(seedZone as ZoneId, false);
        for (const z of adj) {
          pool.push(...(newByZone.get(z) ?? []));
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
            cleaner_id: cleanerId,
            nearby_count_15: nearby15.length,
            neighbors_count_selected: ranked.length,
            nearby_threshold: params.nearbySeedMaxMin,
            fallback_threshold: params.fallbackSeedMaxMin
          }
        });
      }

      // Cap neighborLimit and maxGroupSize based on how many task slots remain for
      // this cleaner. A cleaner with 3 pre-existing tasks and a baseMax of 4 has
      // only 1 remaining slot → no point generating groups larger than 1 new task.
      // When remainingSlots = 0, the cleaner is at/above target — skip group generation
      // so their nearby tasks become non-anchored singles assignable to any cleaner.
      const remainingSlots = params.remainingSlotsPerCleaner?.get(cleanerId) ?? params.neighborLimit;

      if (remainingSlots <= 0) {
        events.push({
          eventType: "PHASE1_CLEANER_SEED_SKIPPED",
          payload: {
            cleaner_id: cleanerId,
            seed_task: seed.taskId,
            seed_logistic_code: seed.logisticCode,
            seed_zone: seedZone,
            remaining_slots: 0,
            reason: 'CLEANER_AT_OR_ABOVE_TARGET'
          }
        });
        continue;
      }

      const effectiveNeighborLimit = Math.min(params.neighborLimit, remainingSlots);
      const neighbors = ranked.slice(0, effectiveNeighborLimit).map(x => x.t);
      // Seed is a positional anchor (already assigned), not a real task to schedule.
      // Override minGroupSize to 2 (seed + 1 new task) so pairs aren't rejected
      // by dynamic limits meant for the normal optimizer.
      const anchoredMinGS = 2;
      // Also cap maxGroupSize: a cleaner with 1 remaining slot should only form pairs
      // (seed + 1 new task), not larger groups.
      const maxGS = Math.min(params.maxGroupSize ?? 4, 1 + remainingSlots);

      for (const a of neighbors) {
        addGroup([seed, a], seed, seedZone, groupMap, anchoredMinGS, maxGS);
      }

      const candidates2 = comb2(neighbors);
      for (const [a, b] of candidates2) {
        addGroup([seed, a, b], seed, seedZone, groupMap, anchoredMinGS, maxGS);
      }

      const candidates3 = comb3(neighbors);
      for (const [a, b, c] of candidates3) {
        const g4 = [seed, a, b, c];
        if (allowFourth(g4) && maxGS >= 4) {
          addGroup(g4, seed, seedZone, groupMap, anchoredMinGS, maxGS);
        }
        addGroup([seed, a, b], seed, seedZone, groupMap, anchoredMinGS, maxGS);
        addGroup([seed, a, c], seed, seedZone, groupMap, anchoredMinGS, maxGS);
        addGroup([seed, b, c], seed, seedZone, groupMap, anchoredMinGS, maxGS);
      }

      for (const n of neighbors) {
        coveredTaskIds.add(n.taskId);
      }

      events.push({
        eventType: "PHASE1_CLEANER_SEED_PROCESSED",
        payload: {
          cleaner_id: cleanerId,
          seed_task: seed.taskId,
          seed_logistic_code: seed.logisticCode,
          seed_zone: seedZone,
          nearby_new_tasks: neighbors.length,
          remaining_slots: remainingSlots,
          groups_created: groupMap.size
        }
      });
    }

    // Tag all groups containing a timeline seed with anchoredCleanerId
    const toRemove: string[] = [];
    groupMap.forEach((group, key) => {
      let anchorCleanerId: number | undefined;
      let hasNewTask = false;
      let mixedCleaners = false;
      const tlTaskIds: number[] = [];

      for (let i = 0; i < group.taskIds.length; i++) {
        const cid = timelineSeeds.get(group.taskIds[i]);
        if (cid !== undefined) {
          tlTaskIds.push(group.taskIds[i]);
          if (anchorCleanerId === undefined) {
            anchorCleanerId = cid;
          } else if (anchorCleanerId !== cid) {
            mixedCleaners = true;
          }
        } else {
          hasNewTask = true;
        }
      }

      if (tlTaskIds.length > 0) {
        if (mixedCleaners || !hasNewTask) {
          toRemove.push(key);
        } else {
          group.anchoredCleanerId = anchorCleanerId;
          group.timelineTaskIds = tlTaskIds;
        }
      }
    });

    for (let i = 0; i < toRemove.length; i++) {
      groupMap.delete(toRemove[i]);
    }

    // Create single groups for new tasks not near any cleaner (deferred to Phase 4)
    for (const task of newTasks) {
      if (coveredTaskIds.has(task.taskId)) continue;
      const taskZone = task.zone as number;
      const isOT = task.straordinaria === true;
      const cleaningTime = task.cleaningTimeMinutes ?? 60;
      const isLongOT = isOT && cleaningTime >= 360;
      const singleKey = String(task.taskId);

      if (!groupMap.has(singleKey)) {
        if (isOT) {
          const singleScore = isLongOT ? 50 : 35;
          groupMap.set(singleKey, {
            taskIds: [task.taskId],
            logisticCodes: [task.logisticCode],
            zone: taskZone,
            seedTaskId: task.taskId,
            seedLogisticCode: task.logisticCode,
            avgTravelMin: 0,
            maxTravelMin: 0,
            score: singleScore,
            isSingle: true,
            reason: "STRAORDINARIA_SINGLE_VALID",
            hasStraordinaria: true,
            isLongStraordinaria: isLongOT
          });
          singleGroupCount++;
        } else {
          events.push({
            eventType: "PHASE1_TASK_NOT_NEAR_ANY_CLEANER",
            payload: {
              task_id: task.taskId,
              logistic_code: task.logisticCode,
              zone: taskZone,
              reason: "NO_NEARBY_CLEANER_POSITION"
            }
          });
        }
      }
    }

  } else {
    // =========================================================================
    // NORMAL OPTIMIZER: groups by mutual task proximity (unchanged)
    // =========================================================================
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

      const minGS = params.minGroupSize ?? 1;
      const maxGS = params.maxGroupSize ?? 4;

      for (const a of neighbors) {
        addGroup([seed, a], seed, seedZone, groupMap, minGS, maxGS);
      }

      const candidates2 = comb2(neighbors);
      for (const [a, b] of candidates2) {
        addGroup([seed, a, b], seed, seedZone, groupMap, minGS, maxGS);
      }

      const candidates3 = comb3(neighbors);
      for (const [a, b, c] of candidates3) {
        const g4 = [seed, a, b, c];
        if (allowFourth(g4) && maxGS >= 4) {
          addGroup(g4, seed, seedZone, groupMap, minGS, maxGS);
        }
        addGroup([seed, a, b], seed, seedZone, groupMap, minGS, maxGS);
        addGroup([seed, a, c], seed, seedZone, groupMap, minGS, maxGS);
        addGroup([seed, b, c], seed, seedZone, groupMap, minGS, maxGS);
      }

      groupsAddedForSeed = groupMap.size - countBefore;

      const isStraordinariaSeed = seed.straordinaria === true;
      const cleaningTime = seed.cleaningTimeMinutes ?? 60;
      const isLongOT = isStraordinariaSeed && cleaningTime >= 360;

      if (groupsAddedForSeed === 0 && params.createSingleGroups) {
        const singleKey = String(seed.taskId);
        if (!groupMap.has(singleKey)) {
          if (isStraordinariaSeed) {
            const singleScore = isLongOT ? 50 : 35;
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
              reason: "STRAORDINARIA_SINGLE_VALID",
              hasStraordinaria: true,
              isLongStraordinaria: isLongOT
            });
            singleGroupCount++;
            events.push({
              eventType: "PHASE1_GROUP_SINGLE_OT_CREATED",
              payload: {
                tasks: [seed.taskId],
                logistic_codes: [seed.logisticCode],
                zone: seedZone,
                score: singleScore,
                reason: "STRAORDINARIA_SINGLE_VALID",
                is_long_ot: isLongOT
              }
            });
          } else {
            events.push({
              eventType: "PHASE1_TASK_ISOLATED_DEFER_TO_PHASE4",
              payload: {
                task_id: seed.taskId,
                logistic_code: seed.logisticCode,
                zone: seedZone,
                reason: "ISOLATED_NO_NEIGHBORS_UNDER_20_NORMAL_TASK"
              }
            });
          }
        }
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
  groupMap: Map<string, CandidateGroup>,
  minGroupSize: number = 1,
  maxGroupSize: number = 4
): void {
  if (groupTasks.length < minGroupSize || groupTasks.length > maxGroupSize) return;

  // Regola OT: riduci gruppi con straordinaria a forma valida
  const straordinariaTask = groupTasks.find(t => t.straordinaria === true);
  if (straordinariaTask) {
    const otCleaningTime = straordinariaTask.cleaningTimeMinutes ?? 60;
    const isLongOT = otCleaningTime >= 360; // ≥6h
    
    if (isLongOT) {
      // OT lunga: può stare solo da sola, non creare gruppi multi-task
      return;
    } else {
      // OT corta (<6h): può avere max 1 task extra di max 2h
      const otherTasks = groupTasks.filter(t => t.taskId !== straordinariaTask.taskId);
      if (otherTasks.length > 1) {
        // Troppi task extra, non valido
        return;
      }
      if (otherTasks.length === 1) {
        const extraTaskTime = otherTasks[0].cleaningTimeMinutes ?? 60;
        if (extraTaskTime > 120) {
          // Task extra troppo lungo (>2h)
          return;
        }
        
        // Check distanza tra OT corta e task extra: max 25 min
        const travelToExtra = estimateTravelMinutes(straordinariaTask, otherTasks[0]);
        if (travelToExtra > 25) {
          // Task extra troppo distante (>25 min)
          return;
        }
      }
      // Gruppo valido: OT corta + max 1 task ≤2h e ≤25 min travel
    }
  }

  const ids = groupTasks.map(t => t.taskId).sort((a, b) => a - b);
  const key = ids.join("-");
  if (groupMap.has(key)) return;

  const { avgTravelMin, maxTravelMin, totalTravelMin } = travelStats(groupTasks);

  const zones = new Set(groupTasks.map(t => t.zone));
  const sameZone = zones.size === 1;
  
  // Check if any task in the group is a straordinaria and determine if it's long (>=6h)
  const otTask = groupTasks.find(t => t.straordinaria === true);
  const hasStraordinaria = otTask !== undefined;
  const isLongStraordinaria = hasStraordinaria && (otTask.cleaningTimeMinutes ?? 60) >= 360;

  const score = scoreGroup(avgTravelMin, maxTravelMin, sameZone, groupTasks.length, totalTravelMin, { hasStraordinaria, isLong: isLongStraordinaria });

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
    score,
    hasStraordinaria,
    isLongStraordinaria
  });
}

const MAX_TOTAL_TRAVEL_FOR_FOUR_TASKS = 30;

function allowFourth(tasks: TaskInput[]): boolean {
  if (tasks.length !== 4) return false;
  
  // Calculate total travel for 4 tasks using MST approximation
  const { totalTravelMin } = travelStats(tasks);
  
  // Allow 4th task only if total travel < 30 min
  return totalTravelMin < MAX_TOTAL_TRAVEL_FOR_FOUR_TASKS;
}

function travelStats(tasks: TaskInput[]): { avgTravelMin: number; maxTravelMin: number; totalTravelMin: number } {
  const n = tasks.length;
  if (n <= 1) {
    return { avgTravelMin: 0, maxTravelMin: 0, totalTravelMin: 0 };
  }
  
  // Build distance matrix
  const dist: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  const allDists: number[] = [];
  
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = estimateTravelMinutes(tasks[i], tasks[j]);
      dist[i][j] = d;
      dist[j][i] = d;
      allDists.push(d);
    }
  }
  
  const avg = allDists.reduce((s, x) => s + x, 0) / allDists.length;
  const max = Math.max(...allDists);
  
  // Calculate MST using Prim's algorithm (proper MST for small sets)
  const inMST = new Array(n).fill(false);
  const minEdge = new Array(n).fill(Infinity);
  minEdge[0] = 0;
  let mstWeight = 0;
  
  for (let count = 0; count < n; count++) {
    // Find minimum edge to add
    let u = -1;
    for (let i = 0; i < n; i++) {
      if (!inMST[i] && (u === -1 || minEdge[i] < minEdge[u])) {
        u = i;
      }
    }
    
    inMST[u] = true;
    mstWeight += minEdge[u];
    
    // Update edges to remaining nodes
    for (let v = 0; v < n; v++) {
      if (!inMST[v] && dist[u][v] < minEdge[v]) {
        minEdge[v] = dist[u][v];
      }
    }
  }
  
  return { 
    avgTravelMin: Math.round(avg * 10) / 10, 
    maxTravelMin: max,
    totalTravelMin: Math.round(mstWeight)
  };
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
