import type { DriverNode, RoutingProblemInput, TaskId, TaskNode } from "./input-contract";
import type { SubZoneAssignment } from "./route-polishing";

const DEPOT_NODE_INDEX = 0;

/** Bitmask dedupe needs one bit per task; longer routes fall back to the caller's own candidates. */
const MAX_SEQUENCER_TASKS = 30;

export const ROUTE_SEQUENCER_CONFIG = {
  beamWidth: 220,
  /** Keeps the beam from collapsing onto a single bucket ordering too early. */
  maxExpansionsPerState: 12,
} as const;

interface BeamState {
  visitedMask: number;
  lastTaskId: TaskId | null;
  lastNodeIndex: number;
  endMin: number;
  travelMin: number;
  order: TaskId[];
  blockCount: number;
  revisitCount: number;
  reversalCount: number;
  lastBucketKey: string | null;
  lastTerritoryIndex: number | null;
  lastBucketIndex: number | null;
  lastStepSign: number;
  seenBucketKeys: Set<string>;
}

export interface SequencedRoute {
  order: TaskId[];
  travelMin: number;
  endMin: number;
  blockCount: number;
  revisitCount: number;
  reversalCount: number;
}

function bucketKeyOf(subZone: SubZoneAssignment | undefined): string | null {
  if (!subZone) return null;
  return `${subZone.territoryIndex}:${subZone.bucketLabel}`;
}

/**
 * `travel-first` optimises the kilometres actually driven and uses the geographic
 * block count only to break ties. `shape-first` does the opposite. Fuel cost is the
 * business goal, so travel-first is the default; block count stays in the comparison
 * because two orders of equal length are not equally pleasant to drive.
 */
export type SequenceRanking = "travel-first" | "shape-first";

function compareStates(
  left: BeamState,
  right: BeamState,
  ranking: SequenceRanking
): number {
  if (ranking === "travel-first") {
    if (left.travelMin !== right.travelMin) return left.travelMin - right.travelMin;
    if (left.revisitCount !== right.revisitCount) return left.revisitCount - right.revisitCount;
    if (left.blockCount !== right.blockCount) return left.blockCount - right.blockCount;
    if (left.reversalCount !== right.reversalCount) return left.reversalCount - right.reversalCount;
    return left.endMin - right.endMin;
  }

  if (left.blockCount !== right.blockCount) return left.blockCount - right.blockCount;
  if (left.revisitCount !== right.revisitCount) return left.revisitCount - right.revisitCount;
  if (left.reversalCount !== right.reversalCount) return left.reversalCount - right.reversalCount;
  if (left.endMin !== right.endMin) return left.endMin - right.endMin;
  return left.travelMin - right.travelMin;
}

/** Share of the beam reserved for the states that are furthest ahead of the clock. */
const SCHEDULE_RESERVE_RATIO = 0.25;

/**
 * Trimming purely by the objective wipes out every state that is merely on time,
 * and on a tight day those are the only ones that can still be completed. Reserving
 * part of the beam for the earliest finishers keeps a feasible path alive while the
 * rest of the beam chases the objective.
 */
function trimBeam(
  states: BeamState[],
  beamWidth: number,
  ranking: SequenceRanking
): BeamState[] {
  const byObjective = [...states].sort((left, right) => compareStates(left, right, ranking));
  if (byObjective.length <= beamWidth) return byObjective;

  const reserved = Math.floor(beamWidth * SCHEDULE_RESERVE_RATIO);
  const kept = byObjective.slice(0, beamWidth - reserved);
  const keptSet = new Set(kept);

  const bySchedule = byObjective
    .filter((state) => !keptSet.has(state))
    .sort((left, right) => left.endMin - right.endMin)
    .slice(0, reserved);

  return [...kept, ...bySchedule];
}

/**
 * Global order search over one route, expanding only sequences that keep every hard
 * window satisfiable, so it minimises driving subject to the deadlines instead of
 * forcing a rigid sweep that no feasible order can satisfy.
 *
 * Local moves cannot reach these orders: on tight days almost every intermediate
 * permutation is infeasible, so the search has to build feasible prefixes instead.
 */
export function findBestFeasibleSequence(args: {
  input: RoutingProblemInput;
  driver: DriverNode;
  taskIds: TaskId[];
  taskById: Map<TaskId, TaskNode>;
  subZoneByTaskId: Map<TaskId, SubZoneAssignment>;
  beamWidth?: number;
  ranking?: SequenceRanking;
}): SequencedRoute | null {
  const { input, driver, taskIds, taskById, subZoneByTaskId } = args;
  const beamWidth = args.beamWidth ?? ROUTE_SEQUENCER_CONFIG.beamWidth;
  const ranking = args.ranking ?? "travel-first";
  const taskCount = taskIds.length;

  if (taskCount === 0 || taskCount > MAX_SEQUENCER_TASKS) return null;

  const tasks = taskIds.map((taskId) => taskById.get(taskId));
  if (tasks.some((task) => task === undefined)) return null;
  const orderedTasks = tasks as TaskNode[];

  const travelBetween = (fromNodeIndex: number, toNodeIndex: number): number | null => {
    const travel = input.travelMatrixMin[fromNodeIndex]?.[toNodeIndex];
    return Number.isFinite(travel) ? travel : null;
  };

  const fullMask = taskCount === 32 ? -1 : (1 << taskCount) - 1;

  let beam: BeamState[] = [
    {
      visitedMask: 0,
      lastTaskId: null,
      lastNodeIndex: DEPOT_NODE_INDEX,
      endMin: driver.workWindow.startMin,
      travelMin: 0,
      order: [],
      blockCount: 0,
      revisitCount: 0,
      reversalCount: 0,
      lastBucketKey: null,
      lastTerritoryIndex: null,
      lastBucketIndex: null,
      lastStepSign: 0,
      seenBucketKeys: new Set<string>(),
    },
  ];

  for (let level = 0; level < taskCount; level += 1) {
    const nextByKey = new Map<string, BeamState>();

    for (const state of beam) {
      const expansions: Array<{ state: BeamState; rank: number }> = [];

      for (let index = 0; index < taskCount; index += 1) {
        if ((state.visitedMask & (1 << index)) !== 0) continue;
        const task = orderedTasks[index];

        const travel = travelBetween(state.lastNodeIndex, task.nodeIndex);
        if (travel === null) continue;

        const arrivalMin = state.endMin + travel;
        const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
        const endMin = startMin + task.serviceDurationMin;
        if (startMin > task.hardWindow.latestStartMin) continue;
        if (endMin > task.hardWindow.latestEndMin) continue;
        if (endMin > driver.workWindow.endMin) continue;

        // Necessary condition: every remaining task must still be directly reachable,
        // otherwise this prefix is a dead end however it continues.
        let strandsRemaining = false;
        for (let other = 0; other < taskCount; other += 1) {
          if (other === index) continue;
          if ((state.visitedMask & (1 << other)) !== 0) continue;
          const remainingTask = orderedTasks[other];
          const remainingTravel = travelBetween(task.nodeIndex, remainingTask.nodeIndex);
          if (remainingTravel === null) {
            strandsRemaining = true;
            break;
          }
          if (endMin + remainingTravel > remainingTask.hardWindow.latestStartMin) {
            strandsRemaining = true;
            break;
          }
        }
        if (strandsRemaining) continue;

        const subZone = subZoneByTaskId.get(task.taskId);
        const bucketKey = bucketKeyOf(subZone);
        let blockCount = state.blockCount;
        let revisitCount = state.revisitCount;
        let reversalCount = state.reversalCount;
        let lastStepSign = state.lastStepSign;
        const seenBucketKeys = state.seenBucketKeys;
        let nextSeenBucketKeys = seenBucketKeys;

        if (bucketKey !== null && bucketKey !== state.lastBucketKey) {
          blockCount += 1;
          if (seenBucketKeys.has(bucketKey)) {
            revisitCount += 1;
            nextSeenBucketKeys = seenBucketKeys;
          } else {
            nextSeenBucketKeys = new Set(seenBucketKeys);
            nextSeenBucketKeys.add(bucketKey);
          }

          if (
            subZone &&
            state.lastTerritoryIndex === subZone.territoryIndex &&
            state.lastBucketIndex !== null
          ) {
            const delta = subZone.bucketIndex - state.lastBucketIndex;
            if (delta !== 0) {
              const stepSign = delta > 0 ? 1 : -1;
              if (state.lastStepSign !== 0 && stepSign !== state.lastStepSign) {
                reversalCount += 1;
              }
              lastStepSign = stepSign;
            }
          } else if (subZone && state.lastTerritoryIndex !== subZone.territoryIndex) {
            lastStepSign = 0;
          }
        }

        const candidate: BeamState = {
          visitedMask: state.visitedMask | (1 << index),
          lastTaskId: task.taskId,
          lastNodeIndex: task.nodeIndex,
          endMin,
          travelMin: state.travelMin + travel,
          order: [...state.order, task.taskId],
          blockCount,
          revisitCount,
          reversalCount,
          lastBucketKey: bucketKey ?? state.lastBucketKey,
          lastTerritoryIndex: subZone?.territoryIndex ?? state.lastTerritoryIndex,
          lastBucketIndex: subZone?.bucketIndex ?? state.lastBucketIndex,
          lastStepSign,
          seenBucketKeys: nextSeenBucketKeys,
        };

        // Which children to expand is a feasibility question, not an objective one:
        // ranking them by travel alone starves the urgent tasks and every completion
        // dead-ends. Earliest finish keeps the deadlines reachable; the objective is
        // applied later, when the beam is trimmed.
        expansions.push({
          state: candidate,
          rank: endMin * 1000 + revisitCount * 100 + blockCount,
        });
      }

      expansions.sort((left, right) => left.rank - right.rank);
      const kept = expansions.slice(0, ROUTE_SEQUENCER_CONFIG.maxExpansionsPerState);

      for (const expansion of kept) {
        const key = `${expansion.state.visitedMask}:${expansion.state.lastTaskId}`;
        const existing = nextByKey.get(key);
        if (!existing || compareStates(expansion.state, existing, ranking) < 0) {
          nextByKey.set(key, expansion.state);
        }
      }
    }

    if (nextByKey.size === 0) return null;

    beam = trimBeam([...nextByKey.values()], beamWidth, ranking);
  }

  const complete = beam.filter((state) => state.visitedMask === fullMask);
  if (complete.length === 0) return null;

  const best = complete.sort((left, right) => compareStates(left, right, ranking))[0];
  return {
    order: best.order,
    travelMin: best.travelMin,
    endMin: best.endMin,
    blockCount: best.blockCount,
    revisitCount: best.revisitCount,
    reversalCount: best.reversalCount,
  };
}
