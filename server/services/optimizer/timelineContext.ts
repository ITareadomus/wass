import pool from '../../../shared/pg-db';
import { isTaskEquivalentToStraordinaria } from '../../utils/straordinaria-utils';

export interface OccupiedBlock {
  startMin: number;
  endMin: number;
  taskId: string;
}

export interface AnchorPoint {
  lat: number;
  lng: number;
  timeMin: number;
}

export interface CleanerAnchors {
  lastFixed?: AnchorPoint;
  firstFixed?: AnchorPoint;
}

export interface LastFixedTask {
  taskId: number;
  logisticCode: number;
  sequence: number | null;
  startTime: string | null;
  endTime: string;
  endMin: number;
  lat: number | null;
  lng: number | null;
  straordinaria: boolean;
  cleaningTimeMinutes: number | null;
  baseCleaningTimeMinutes: number | null;
}

export interface FixedStats {
  fixedTaskCount: number;
  fixedHasAnyOT: boolean;
  fixedHasLongOT: boolean;
  fixedWorkMinutes: number;
  fixedTravelMinutes: number;
}

export interface TimelineContext {
  alreadyOnTimelineTaskIds: Set<string>;
  occupiedBlocksByCleaner: Map<number, OccupiedBlock[]>;
  initialLoadByCleanerMin: Map<number, number>;
  anchorPointsByCleaner: Map<number, CleanerAnchors>;
  collaborationIndex: Map<string, number[]>;
  // MERGE append-only support
  lastFixedByCleaner: Map<number, LastFixedTask>;
  fixedStatsByCleaner: Map<number, FixedStats>;
}

interface TimelineRow {
  task_id: string;
  logistic_code: number | null;
  cleaner_id: number;
  sequence: number | null;
  start_time: string | null;
  end_time: string | null;
  cleaning_time: number | null;
  base_cleaning_time: number | null;
  travel_time: number | null;
  lat: number | null;
  lng: number | null;
  operation_id: number | null;
  straordinaria: boolean | null;
}

function timeToMin(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function mergeBlocks(blocks: OccupiedBlock[]): OccupiedBlock[] {
  if (blocks.length === 0) return [];
  
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin);
  const merged: OccupiedBlock[] = [sorted[0]];
  
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const curr = sorted[i];
    
    if (curr.startMin <= last.endMin) {
      last.endMin = Math.max(last.endMin, curr.endMin);
      last.taskId = `${last.taskId},${curr.taskId}`;
    } else {
      merged.push(curr);
    }
  }
  
  return merged;
}

export async function buildTimelineContext(workDate: string): Promise<TimelineContext> {
  const result = await pool.query<TimelineRow>(`
    SELECT 
      task_id::text as task_id,
      logistic_code,
      cleaner_id,
      sequence,
      start_time,
      end_time,
      cleaning_time,
      base_cleaning_time,
      travel_time,
      lat,
      lng,
      operation_id,
      COALESCE(straordinaria, false) as straordinaria
    FROM daily_assignments_current
    WHERE work_date = $1
    ORDER BY cleaner_id, start_time, end_time
  `, [workDate]);

  const rows = result.rows;

  const alreadyOnTimelineTaskIds = new Set<string>();
  const occupiedBlocksByCleaner = new Map<number, OccupiedBlock[]>();
  const initialLoadByCleanerMin = new Map<number, number>();
  const anchorPointsByCleaner = new Map<number, CleanerAnchors>();
  const collaborationIndex = new Map<string, number[]>();
  const lastFixedByCleaner = new Map<number, LastFixedTask>();
  const fixedStatsByCleaner = new Map<number, FixedStats>();

  for (const row of rows) {
    const taskId = row.task_id;
    const cleanerId = row.cleaner_id;

    alreadyOnTimelineTaskIds.add(taskId);

    if (!collaborationIndex.has(taskId)) {
      collaborationIndex.set(taskId, []);
    }
    collaborationIndex.get(taskId)!.push(cleanerId);

    if (!occupiedBlocksByCleaner.has(cleanerId)) {
      occupiedBlocksByCleaner.set(cleanerId, []);
    }
    if (!initialLoadByCleanerMin.has(cleanerId)) {
      initialLoadByCleanerMin.set(cleanerId, 0);
    }
    if (!anchorPointsByCleaner.has(cleanerId)) {
      anchorPointsByCleaner.set(cleanerId, {});
    }
    if (!fixedStatsByCleaner.has(cleanerId)) {
      fixedStatsByCleaner.set(cleanerId, {
        fixedTaskCount: 0,
        fixedHasAnyOT: false,
        fixedHasLongOT: false,
        fixedWorkMinutes: 0,
        fixedTravelMinutes: 0
      });
    }

    const stats = fixedStatsByCleaner.get(cleanerId)!;
    stats.fixedTaskCount += 1;

    const isOT = isTaskEquivalentToStraordinaria({
      straordinaria: row.straordinaria === true,
      operation_id: row.operation_id,
    });
    stats.fixedHasAnyOT = stats.fixedHasAnyOT || isOT;

    // Use base_cleaning_time when available (more stable for collaborations)
    const workMinutes = (row.base_cleaning_time ?? row.cleaning_time ?? 0) || 0;
    stats.fixedWorkMinutes += workMinutes;
    stats.fixedTravelMinutes += (row.travel_time ?? 0) || 0;

    // Long OT threshold is consistent with Phase4: >= 360 minutes
    const isLongOT = isOT && workMinutes >= 360;
    stats.fixedHasLongOT = stats.fixedHasLongOT || isLongOT;

    const startMin = row.start_time ? timeToMin(row.start_time) : null;
    const endMin = row.end_time ? timeToMin(row.end_time) : null;

    if (row.start_time && row.end_time && startMin !== null && endMin !== null) {

      occupiedBlocksByCleaner.get(cleanerId)!.push({
        startMin,
        endMin,
        taskId
      });

      const durationMin = endMin - startMin;
      const travelMin = row.travel_time ?? 0;
      initialLoadByCleanerMin.set(
        cleanerId,
        initialLoadByCleanerMin.get(cleanerId)! + durationMin + travelMin
      );

      const anchors = anchorPointsByCleaner.get(cleanerId)!;
      if (row.lat !== null && row.lng !== null) {
        if (!anchors.firstFixed || startMin < anchors.firstFixed.timeMin) {
          anchors.firstFixed = { lat: row.lat, lng: row.lng, timeMin: startMin };
        }
        if (!anchors.lastFixed || endMin > anchors.lastFixed.timeMin) {
          anchors.lastFixed = { lat: row.lat, lng: row.lng, timeMin: endMin };
        }
      }
    }

    // MERGE append-only anchor:
    // Prefer max end_time; if missing, fall back to max start_time; if missing, fall back to max sequence.
    const existing = lastFixedByCleaner.get(cleanerId);
    const logisticCode = row.logistic_code ?? 0;
    const rowSeq = row.sequence ?? null;

    const currentRank = (() => {
      if (endMin !== null) return { kind: 3, time: endMin, seq: rowSeq ?? -1 };
      if (startMin !== null) return { kind: 2, time: startMin, seq: rowSeq ?? -1 };
      return { kind: 1, time: -1, seq: rowSeq ?? -1 };
    })();

    const existingRank = (() => {
      if (!existing) return null;
      // existing.endMin exists by type, but may be derived from start_time fallback. We keep kind implicit by endTime/startTime presence.
      const hasEnd = !!existing.endTime;
      const hasStart = !!existing.startTime;
      if (hasEnd) return { kind: 3, time: existing.endMin, seq: existing.sequence ?? -1 };
      if (hasStart) return { kind: 2, time: existing.endMin, seq: existing.sequence ?? -1 };
      return { kind: 1, time: -1, seq: existing.sequence ?? -1 };
    })();

    const shouldReplace = (() => {
      if (!existingRank) return true;
      if (currentRank.kind !== existingRank.kind) return currentRank.kind > existingRank.kind;
      if (currentRank.time !== existingRank.time) return currentRank.time > existingRank.time;
      return currentRank.seq > existingRank.seq;
    })();

    if (shouldReplace) {
      // If end_time is missing, we set endTime to start_time (or empty string) so callers can still anchor travel.
      const anchorTime = row.end_time || row.start_time || '';
      const anchorMin = endMin ?? startMin ?? -1;
      lastFixedByCleaner.set(cleanerId, {
        taskId: parseInt(String(row.task_id), 10),
        logisticCode: Number(logisticCode),
        sequence: rowSeq,
        startTime: row.start_time,
        endTime: anchorTime,
        endMin: anchorMin,
        lat: row.lat,
        lng: row.lng,
        straordinaria: isTaskEquivalentToStraordinaria({
          straordinaria: row.straordinaria === true,
          operation_id: row.operation_id,
        }),
        cleaningTimeMinutes: row.cleaning_time ?? null,
        baseCleaningTimeMinutes: row.base_cleaning_time ?? null
      });
    }
  }

  Array.from(occupiedBlocksByCleaner.entries()).forEach(([cleanerId, blocks]) => {
    occupiedBlocksByCleaner.set(cleanerId, mergeBlocks(blocks));
  });

  return {
    alreadyOnTimelineTaskIds,
    occupiedBlocksByCleaner,
    initialLoadByCleanerMin,
    anchorPointsByCleaner,
    collaborationIndex,
    lastFixedByCleaner,
    fixedStatsByCleaner
  };
}

export function createEmptyTimelineContext(): TimelineContext {
  return {
    alreadyOnTimelineTaskIds: new Set<string>(),
    occupiedBlocksByCleaner: new Map<number, OccupiedBlock[]>(),
    initialLoadByCleanerMin: new Map<number, number>(),
    anchorPointsByCleaner: new Map<number, CleanerAnchors>(),
    collaborationIndex: new Map<string, number[]>(),
    lastFixedByCleaner: new Map<number, LastFixedTask>(),
    fixedStatsByCleaner: new Map<number, FixedStats>()
  };
}
