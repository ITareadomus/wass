import pool from '../../../shared/pg-db';

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

export interface TimelineContext {
  alreadyOnTimelineTaskIds: Set<string>;
  occupiedBlocksByCleaner: Map<number, OccupiedBlock[]>;
  initialLoadByCleanerMin: Map<number, number>;
  anchorPointsByCleaner: Map<number, CleanerAnchors>;
  collaborationIndex: Map<string, number[]>;
}

interface TimelineRow {
  task_id: string;
  cleaner_id: number;
  start_time: string | null;
  end_time: string | null;
  cleaning_time: number | null;
  travel_time: number | null;
  lat: number | null;
  lng: number | null;
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
      cleaner_id,
      start_time,
      end_time,
      cleaning_time,
      travel_time,
      lat,
      lng
    FROM daily_assignments_current
    WHERE work_date = $1
    ORDER BY cleaner_id, start_time
  `, [workDate]);

  const rows = result.rows;

  const alreadyOnTimelineTaskIds = new Set<string>();
  const occupiedBlocksByCleaner = new Map<number, OccupiedBlock[]>();
  const initialLoadByCleanerMin = new Map<number, number>();
  const anchorPointsByCleaner = new Map<number, CleanerAnchors>();
  const collaborationIndex = new Map<string, number[]>();

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

    if (row.start_time && row.end_time) {
      const startMin = timeToMin(row.start_time);
      const endMin = timeToMin(row.end_time);

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
  }

  Array.from(occupiedBlocksByCleaner.entries()).forEach(([cleanerId, blocks]) => {
    occupiedBlocksByCleaner.set(cleanerId, mergeBlocks(blocks));
  });

  return {
    alreadyOnTimelineTaskIds,
    occupiedBlocksByCleaner,
    initialLoadByCleanerMin,
    anchorPointsByCleaner,
    collaborationIndex
  };
}

export function createEmptyTimelineContext(): TimelineContext {
  return {
    alreadyOnTimelineTaskIds: new Set<string>(),
    occupiedBlocksByCleaner: new Map<number, OccupiedBlock[]>(),
    initialLoadByCleanerMin: new Map<number, number>(),
    anchorPointsByCleaner: new Map<number, CleanerAnchors>(),
    collaborationIndex: new Map<string, number[]>()
  };
}
