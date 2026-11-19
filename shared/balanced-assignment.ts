import {
  HK_SOFT_PENALTY,
  constraintDecision,
  type ConstraintMode,
  type HkConstraintSettings,
} from "./hk-constraint-settings";

/** Posti normali per cleaner. Un quinto si apre solo se con 4 i task non entrano. */
export const BALANCED_BASE_TASKS = 4;
export const BALANCED_EXTRA_TASKS = 5;

export interface BalancedApartmentTypes {
  standard_apt: string[];
  premium_apt: string[];
  straordinario_apt: string[];
  formatore_apt: string[];
  ufficio_apt: string[];
}

export interface BalancedFormatoreRules {
  allowedPriorities: string[];
  standardApt: boolean;
}

export interface BalancedPriorityWindow {
  startMin: number;
  endMin: number | null;
}

export type BalancedPriority = "EO" | "HP" | "LP";

export interface BalancedTask {
  taskId: number;
  logisticCode: number;
  lat: number;
  lng: number;
  cleaningMin: number;
  checkoutMin: number | null;
  checkinMin: number | null;
  priority: BalancedPriority | null;
  triadeWeight: number;
  premium: boolean;
  straordinaria: boolean;
  typeApt: string;
  isOffice: boolean;
}

export interface BalancedCleaner {
  cleanerId: number;
  role: string;
  triadeWeight: number;
  startMin: number;
  endMin: number;
  fixedCount: number;
  fixedWorkMin: number;
  fixedHasLongOt: boolean;
  fixedHasAnyOt: boolean;
  anchor: { lat: number; lng: number; endMin: number } | null;
}

export interface BalancedInput {
  tasks: BalancedTask[];
  cleaners: BalancedCleaner[];
  settings: HkConstraintSettings;
  apartmentTypes: BalancedApartmentTypes;
  formatore: BalancedFormatoreRules | null;
  priorityWindows: Record<BalancedPriority, BalancedPriorityWindow> | null;
}

export interface BalancedAssignmentRow {
  taskId: number;
  cleanerId: number;
  sequence: number;
  startMin: number;
  endMin: number;
  travelMin: number;
  priority: BalancedPriority | null;
  violations: string[];
}

export interface BalancedUnassigned {
  taskId: number;
  reason: string;
}

export interface BalancedResult {
  assignments: BalancedAssignmentRow[];
  unassigned: BalancedUnassigned[];
  /** Cleaner che hanno ricevuto il quinto task. */
  fifthTaskCleaners: number;
}

interface CleanerEval {
  hard: number;
  soft: number;
  travel: number;
  load: number;
  count: number;
  rows: BalancedAssignmentRow[];
}

interface SolutionScore {
  fifths: number;
  hard: number;
  spread: number;
  soft: number;
  travel: number;
}

function travelMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  const distReale = (meters / 1000) * 1.5;
  let moving = distReale * 5;
  if (distReale < 0.8) moving = distReale * 6;
  else if (distReale < 2.5) moving = distReale * 10;
  return Math.round(Math.max(2, 5 + moving));
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

function modeCost(mode: ConstraintMode, violated: boolean, softPenalty: number): { hard: number; soft: number } {
  const decision = constraintDecision(mode, violated, softPenalty);
  if (decision.blocked) return { hard: 1, soft: 0 };
  return { hard: 0, soft: decision.penalty };
}

function addCost(target: { hard: number; soft: number }, mode: ConstraintMode, violated: boolean, softPenalty: number) {
  const cost = modeCost(mode, violated, softPenalty);
  target.hard += cost.hard;
  target.soft += cost.soft;
}

function capsByCleaner(cleaners: BalancedCleaner[], taskCount: number, mode: ConstraintMode): Map<number, number> {
  const caps = new Map<number, number>();
  if (mode === "off") {
    for (const cleaner of cleaners) caps.set(cleaner.cleanerId, taskCount);
    return caps;
  }
  const roomAt = (limit: number) =>
    cleaners.reduce((sum, cleaner) => sum + Math.max(0, limit - cleaner.fixedCount), 0);
  const limit = taskCount <= roomAt(BALANCED_BASE_TASKS) ? BALANCED_BASE_TASKS : BALANCED_EXTRA_TASKS;
  for (const cleaner of cleaners) caps.set(cleaner.cleanerId, Math.max(0, limit - cleaner.fixedCount));
  return caps;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const tail of permutations(rest)) out.push([items[i], ...tail]);
  }
  return out;
}

function nearestOrder(tasks: BalancedTask[], origin: { lat: number; lng: number } | null): BalancedTask[] {
  const left = tasks.slice();
  const ordered: BalancedTask[] = [];
  let cursor = origin;
  while (left.length > 0) {
    let best = 0;
    let bestTravel = Number.POSITIVE_INFINITY;
    for (let i = 0; i < left.length; i++) {
      const travel = cursor ? travelMinutes(cursor, left[i]) : 0;
      if (travel < bestTravel || (travel === bestTravel && left[i].taskId < left[best].taskId)) {
        best = i;
        bestTravel = travel;
      }
    }
    const next = left.splice(best, 1)[0];
    ordered.push(next);
    cursor = next;
  }
  return ordered;
}

function orderCandidates(tasks: BalancedTask[], anchor: BalancedCleaner["anchor"]): BalancedTask[][] {
  if (tasks.length <= BALANCED_EXTRA_TASKS) return permutations(tasks);
  const byWindow = tasks.slice().sort((a, b) => {
    const aKey = a.checkinMin ?? a.checkoutMin ?? 24 * 60;
    const bKey = b.checkinMin ?? b.checkoutMin ?? 24 * 60;
    if (aKey !== bKey) return aKey - bKey;
    return a.taskId - b.taskId;
  });
  const origin = anchor ? { lat: anchor.lat, lng: anchor.lng } : null;
  return [byWindow, nearestOrder(tasks, origin)];
}

function pairViolations(
  cleaner: BalancedCleaner,
  task: BalancedTask,
  input: BalancedInput,
): { hard: number; soft: number; codes: string[] } {
  const settings = input.settings;
  const cost = { hard: 0, soft: 0 };
  const codes: string[] = [];
  const cleanerLevel = cleaner.triadeWeight;
  const taskLevel = task.triadeWeight;
  const violated = cleanerLevel < taskLevel;
  if (violated && settings.triadeCeiling !== "off") {
    addCost(
      cost,
      settings.triadeCeiling,
      true,
      HK_SOFT_PENALTY.triadeCeilingPerLevel * Math.max(1, taskLevel - cleanerLevel),
    );
    if (cost.hard || cost.soft) codes.push("TRIADE_CEILING");
  }
  return { ...cost, codes };
}

function routeShapeViolations(
  legs: number[],
  settings: HkConstraintSettings,
): { hard: number; soft: number; codes: string[] } {
  const cost = { hard: 0, soft: 0 };
  const codes: string[] = [];
  const note = (code: string, mode: ConstraintMode, violated: boolean, penalty: number) => {
    if (!violated || mode === "off") return;
    const before = cost.hard + cost.soft;
    addCost(cost, mode, true, penalty);
    if (cost.hard + cost.soft !== before) codes.push(code);
  };

  if (settings.travel !== "off") {
    const over = legs.filter((leg) => leg > settings.travelHardMaxMin).length;
    note("TRAVEL_MAX", settings.travel, over > 0, over * settings.travelWeight * 100);
  }

  return { ...cost, codes };
}

function simulateOrder(
  cleaner: BalancedCleaner,
  order: BalancedTask[],
  input: BalancedInput,
): CleanerEval {
  const settings = input.settings;
  const rows: BalancedAssignmentRow[] = [];
  let hard = 0;
  let soft = 0;
  let travelSum = 0;
  let cleaning = 0;
  let cursor = cleaner.anchor?.endMin ?? cleaner.startMin;
  let prev: { lat: number; lng: number } | null = cleaner.anchor ? { lat: cleaner.anchor.lat, lng: cleaner.anchor.lng } : null;
  const legs: number[] = [];

  for (const task of order) {
    const pair = pairViolations(cleaner, task, input);
    hard += pair.hard;
    soft += pair.soft;
    const travel = prev ? travelMinutes(prev, task) : 0;
    legs.push(travel);
    travelSum += travel;
    cleaning += task.cleaningMin;
    let start = cursor + travel;
    if (settings.checkout !== "off" && task.checkoutMin != null) start = Math.max(start, task.checkoutMin);
    const end = start + task.cleaningMin;
    const codes = pair.codes.slice();

    const checkin = modeCost(
      settings.checkin,
      task.checkinMin != null && end > task.checkinMin,
      HK_SOFT_PENALTY.checkin,
    );
    if (checkin.hard || checkin.soft) codes.push("CHECKIN");
    hard += checkin.hard;
    soft += checkin.soft;

    rows.push({
      taskId: task.taskId,
      cleanerId: cleaner.cleanerId,
      sequence: rows.length + 1,
      startMin: start,
      endMin: end,
      travelMin: travel,
      priority: task.priority,
      violations: codes,
    });
    cursor = end;
    prev = task;
  }

  const shape = routeShapeViolations(legs, settings);
  hard += shape.hard;
  soft += shape.soft;
  if (shape.codes.length > 0 && rows.length > 0) {
    rows[0] = { ...rows[0], violations: [...rows[0].violations, ...shape.codes] };
  }

  const load = cleaner.fixedWorkMin + cleaning;
  return { hard, soft, travel: travelSum, load, count: order.length, rows };
}

function averageCleaning(input: BalancedInput): number {
  if (input.cleaners.length === 0) return 0;
  const fixed = input.cleaners.reduce((sum, cleaner) => sum + cleaner.fixedWorkMin, 0);
  const fresh = input.tasks.reduce((sum, task) => sum + task.cleaningMin, 0);
  return (fixed + fresh) / input.cleaners.length;
}

function bestOrder(cleaner: BalancedCleaner, tasks: BalancedTask[], input: BalancedInput): CleanerEval {
  if (tasks.length === 0) {
    return {
      hard: 0,
      soft: 0,
      travel: 0,
      load: cleaner.fixedWorkMin,
      count: 0,
      rows: [],
    };
  }
  let best: CleanerEval | null = null;
  for (const order of orderCandidates(tasks, cleaner.anchor)) {
    const trial = simulateOrder(cleaner, order, input);
    if (!best || compareEval(trial, best) < 0) best = trial;
  }
  return best!;
}

function compareEval(a: CleanerEval, b: CleanerEval): number {
  if (a.hard !== b.hard) return a.hard - b.hard;
  if (a.soft !== b.soft) return a.soft - b.soft;
  return a.travel - b.travel;
}

function betterScore(a: SolutionScore, b: SolutionScore, workload: ConstraintMode): boolean {
  if (a.fifths !== b.fifths) return a.fifths < b.fifths;
  if (a.hard !== b.hard) return a.hard < b.hard;
  if (workload === "hard" && a.spread !== b.spread) return a.spread < b.spread;
  if (a.soft !== b.soft) return a.soft < b.soft;
  if (workload === "soft" && a.spread !== b.spread) return a.spread < b.spread;
  return a.travel < b.travel;
}

function scoreOf(
  evals: CleanerEval[],
  travelMatters: boolean,
  balanceMatters: boolean,
  target: number,
): SolutionScore {
  let fifths = 0;
  let hard = 0;
  let soft = 0;
  let travel = 0;
  let spread = 0;
  for (const item of evals) {
    hard += item.hard;
    soft += item.soft;
    travel += travelMatters ? item.travel : 0;
    if (balanceMatters) spread += Math.abs(item.load - target);
    if (item.count > BALANCED_BASE_TASKS) fifths += 1;
  }
  return { fifths, hard, spread, soft, travel };
}

function taskById(tasks: BalancedTask[]): Map<number, BalancedTask> {
  return new Map(tasks.map((task) => [task.taskId, task]));
}

export function assignBalancedDay(input: BalancedInput): BalancedResult {
  const tasks = input.tasks.slice().sort((a, b) => {
    const aDue = a.checkinMin ?? 24 * 60;
    const bDue = b.checkinMin ?? 24 * 60;
    if (aDue !== bDue) return aDue - bDue;
    if (b.cleaningMin !== a.cleaningMin) return b.cleaningMin - a.cleaningMin;
    return a.taskId - b.taskId;
  });
  const cleaners = input.cleaners.slice().sort((a, b) => a.cleanerId - b.cleanerId);
  if (cleaners.length === 0) {
    return {
      assignments: [],
      unassigned: tasks.map((task) => ({ taskId: task.taskId, reason: "NO_CLEANERS" })),
      fifthTaskCleaners: 0,
    };
  }

  const caps = capsByCleaner(cleaners, tasks.length, "hard");
  const buckets = new Map<number, number[]>(cleaners.map((cleaner) => [cleaner.cleanerId, []]));
  const lookup = taskById(tasks);
  const unassigned: BalancedUnassigned[] = [];
  const target = averageCleaning(input);

  for (const task of tasks) {
    let bestCleaner: BalancedCleaner | null = null;
    let bestRank: number[] | null = null;
    for (const cleaner of cleaners) {
      const current = buckets.get(cleaner.cleanerId)!;
      const cap = caps.get(cleaner.cleanerId) ?? 0;
      if (current.length >= cap) continue;
      const trialTasks = current.map((id) => lookup.get(id)!).concat(task);
      const trial = bestOrder(cleaner, trialTasks, input);
      const currentEval = bestOrder(cleaner, current.map((id) => lookup.get(id)!), input);
      const workload = input.settings.workloadBalance;
      const gap = Math.abs(trial.load - target);
      const rank = [
        cleaner.fixedCount + trial.count > BALANCED_BASE_TASKS ? 1 : 0,
        trial.hard - currentEval.hard,
        workload === "hard" ? gap : 0,
        trial.soft - currentEval.soft,
        workload === "soft" ? gap : 0,
        input.settings.travel === "off" ? 0 : trial.travel,
        cleaner.cleanerId,
      ];
      if (!bestRank || compareRank(rank, bestRank) < 0) {
        bestRank = rank;
        bestCleaner = cleaner;
      }
    }
    if (!bestCleaner) {
      unassigned.push({ taskId: task.taskId, reason: "CAPACITY" });
      continue;
    }
    buckets.get(bestCleaner.cleanerId)!.push(task.taskId);
  }

  improve(cleaners, buckets, lookup, input, caps, target);

  const assignments: BalancedAssignmentRow[] = [];
  let fifthTaskCleaners = 0;
  for (const cleaner of cleaners) {
    const ids = buckets.get(cleaner.cleanerId)!;
    const evaluated = bestOrder(cleaner, ids.map((id) => lookup.get(id)!), input);
    if (cleaner.fixedCount + ids.length > BALANCED_BASE_TASKS) fifthTaskCleaners += 1;
    assignments.push(...evaluated.rows);
  }

  return { assignments, unassigned, fifthTaskCleaners };
}

function compareRank(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function improve(
  cleaners: BalancedCleaner[],
  buckets: Map<number, number[]>,
  lookup: Map<number, BalancedTask>,
  input: BalancedInput,
  caps: Map<number, number>,
  target: number,
) {
  const travelMatters = input.settings.travel !== "off";
  const workload = input.settings.workloadBalance;
  const evals = new Map<number, CleanerEval>();
  const refresh = (cleaner: BalancedCleaner) => {
    const ids = buckets.get(cleaner.cleanerId)!;
    evals.set(cleaner.cleanerId, bestOrder(cleaner, ids.map((id) => lookup.get(id)!), input));
  };
  for (const cleaner of cleaners) refresh(cleaner);

  const currentScore = () =>
    scoreOf(
      cleaners.map((cleaner) => evals.get(cleaner.cleanerId)!),
      travelMatters,
      workload !== "off",
      target,
    );

  let score = currentScore();
  let guard = 0;
  let improved = true;
  while (improved && guard < 12) {
    improved = false;
    guard += 1;
    for (const source of cleaners) {
      const sourceIds = buckets.get(source.cleanerId)!;
      for (let index = 0; index < sourceIds.length; index++) {
        const taskId = sourceIds[index];
        for (const dest of cleaners) {
          if (dest.cleanerId === source.cleanerId) continue;
          const destIds = buckets.get(dest.cleanerId)!;
          if (destIds.length >= (caps.get(dest.cleanerId) ?? 0)) continue;
          sourceIds.splice(index, 1);
          destIds.push(taskId);
          const nextSource = bestOrder(source, sourceIds.map((id) => lookup.get(id)!), input);
          const nextDest = bestOrder(dest, destIds.map((id) => lookup.get(id)!), input);
          const previousSource = evals.get(source.cleanerId)!;
          const previousDest = evals.get(dest.cleanerId)!;
          evals.set(source.cleanerId, nextSource);
          evals.set(dest.cleanerId, nextDest);
          const nextScore = currentScore();
          if (betterScore(nextScore, score, workload)) {
            score = nextScore;
            improved = true;
            index -= 1;
            break;
          }
          destIds.pop();
          sourceIds.splice(index, 0, taskId);
          evals.set(source.cleanerId, previousSource);
          evals.set(dest.cleanerId, previousDest);
        }
      }
    }
  }
}
