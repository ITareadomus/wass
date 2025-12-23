import { query } from '../../../shared/pg-db';
import { insertDecisionsBatch } from './db';

export type Priority = 'EO' | 'HP' | 'LP';

export interface PriorityWindow {
  startMin: number;
  endMin: number | null;
  graceMin: number;
}

export type PriorityWindows = Record<Priority, PriorityWindow>;

function timeToMinutes(timeStr: string): number {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

const DEFAULT_WINDOWS: PriorityWindows = {
  EO: { startMin: 600, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 }
};

export async function loadPriorityStartWindows(runId?: string): Promise<PriorityWindows> {
  const windows: PriorityWindows = { ...DEFAULT_WINDOWS };
  const fallbackKeys: string[] = [];

  try {
    const result = await query("SELECT value FROM app_settings WHERE key = 'app_settings'");
    const settings = result.rows[0]?.value;

    if (!settings) {
      fallbackKeys.push('all');
      if (runId) {
        await insertDecisionsBatch([{
          runId,
          phase: 3,
          eventType: 'PHASE3_SETTINGS_FALLBACK_USED',
          payload: {
            reason: 'app_settings not found',
            fallback_keys: fallbackKeys,
            using_defaults: DEFAULT_WINDOWS
          }
        }]);
      }
      return windows;
    }

    const eo = settings['early-out'];
    if (eo?.eo_start_time && eo?.eo_end_time) {
      windows.EO = {
        startMin: timeToMinutes(eo.eo_start_time),
        endMin: timeToMinutes(eo.eo_end_time),
        graceMin: 0
      };
    } else {
      fallbackKeys.push('early-out.eo_start_time', 'early-out.eo_end_time');
    }

    const hp = settings['high-priority'];
    if (hp?.hp_start_time && hp?.hp_end_time) {
      windows.HP = {
        startMin: timeToMinutes(hp.hp_start_time),
        endMin: timeToMinutes(hp.hp_end_time),
        graceMin: 0
      };
    } else {
      fallbackKeys.push('high-priority.hp_start_time', 'high-priority.hp_end_time');
    }

    const lp = settings['low-priority'];
    if (lp?.lp_start_time) {
      windows.LP = {
        startMin: timeToMinutes(lp.lp_start_time),
        endMin: null,
        graceMin: 0
      };
    } else {
      fallbackKeys.push('low-priority.lp_start_time');
    }

    if (fallbackKeys.length > 0 && runId) {
      await insertDecisionsBatch([{
        runId,
        phase: 3,
        eventType: 'PHASE3_SETTINGS_FALLBACK_USED',
        payload: {
          reason: 'some priority window keys missing',
          fallback_keys: fallbackKeys,
          loaded_windows: windows
        }
      }]);
    }

  } catch (error) {
    console.error('Error loading priority windows:', error);
    if (runId) {
      await insertDecisionsBatch([{
        runId,
        phase: 3,
        eventType: 'PHASE3_SETTINGS_FALLBACK_USED',
        payload: {
          reason: 'database error',
          error: String(error),
          using_defaults: DEFAULT_WINDOWS
        }
      }]);
    }
  }

  return windows;
}

export interface PriorityPenaltyResult {
  penalty: number;
  reasons: string[];
  violation: {
    priority: Priority;
    startTimeMin: number;
    windowStart: number;
    windowEnd: number | null;
    distanceMin: number;
  } | null;
}

const PENALTY_CONFIG: Record<Priority, { k: number; max: number }> = {
  EO: { k: 2, max: 120 },
  HP: { k: 1, max: 90 },
  LP: { k: 1, max: 60 }
};

export function priorityPenalty(
  priority: Priority | null,
  startTimeMin: number,
  windows: PriorityWindows
): PriorityPenaltyResult {
  if (!priority) {
    return { penalty: 0, reasons: [], violation: null };
  }

  const window = windows[priority];
  if (!window) {
    return { penalty: 0, reasons: [], violation: null };
  }

  const { startMin, endMin, graceMin } = window;
  const effectiveStart = startMin - graceMin;
  const effectiveEnd = endMin !== null ? endMin + graceMin : null;

  let distance = 0;
  let isViolation = false;

  if (priority === 'LP') {
    if (startTimeMin < effectiveStart) {
      distance = effectiveStart - startTimeMin;
      isViolation = true;
    }
  } else {
    if (startTimeMin < effectiveStart) {
      distance = effectiveStart - startTimeMin;
      isViolation = true;
    } else if (effectiveEnd !== null && startTimeMin > effectiveEnd) {
      distance = startTimeMin - effectiveEnd;
      isViolation = true;
    }
  }

  if (!isViolation) {
    return { penalty: 0, reasons: [], violation: null };
  }

  const config = PENALTY_CONFIG[priority];
  const penalty = Math.min(config.max, distance * config.k);

  const reasonCode = priority === 'LP' 
    ? 'LP_BEFORE_MIN_START'
    : `${priority}_OUT_OF_PREFERRED_START_WINDOW`;

  return {
    penalty,
    reasons: [reasonCode],
    violation: {
      priority,
      startTimeMin,
      windowStart: startMin,
      windowEnd: endMin,
      distanceMin: distance
    }
  };
}

export function mapPriorityType(priority: string | null | undefined): Priority | null {
  if (!priority) return null;
  
  const normalized = priority.toLowerCase().replace(/[_-]/g, '');
  
  if (normalized === 'earlyout' || normalized === 'eo') return 'EO';
  if (normalized === 'highpriority' || normalized === 'hp') return 'HP';
  if (normalized === 'lowpriority' || normalized === 'lp') return 'LP';
  
  return null;
}
