import { query } from '../../../shared/pg-db';
import {
  buildSchedulingWindows,
  parsePrioritySettings,
  PrioritySettingsError,
  type Priority,
  type PriorityWindows,
} from '../../../shared/taskPriorityClassification';
import { insertDecisionsBatch } from './db';

export type { Priority, PriorityWindow, PriorityWindows } from '../../../shared/taskPriorityClassification';

export async function loadPriorityStartWindows(runId?: string): Promise<PriorityWindows> {
  try {
    const result = await query("SELECT value FROM app_settings WHERE key = 'app_settings'");
    const settings = result.rows[0]?.value;

    if (!settings) {
      throw new PrioritySettingsError('app_settings not found');
    }

    return buildSchedulingWindows(parsePrioritySettings(settings));
  } catch (error) {
    console.error('Error loading priority settings:', error);
    if (runId) {
      await insertDecisionsBatch([{
        runId,
        phase: 3,
        eventType: 'PRIORITY_SETTINGS_INVALID',
        payload: {
          reason: error instanceof Error ? error.message : String(error)
        }
      }]);
    }
    throw error;
  }
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

const EO_EARLY_BONUS_PER_MIN = 0.5;
const EO_EARLY_BONUS_MAX = 30;
const HP_IN_WINDOW_BONUS_PER_MIN = 0.25;
const HP_IN_WINDOW_BONUS_MAX = 20;

export function priorityPenalty(
  priority: Priority | null,
  startTimeMin: number,
  endTimeMin: number | null,
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

  // EO policy:
  // - No penalty when the task starts after hp_start_time.
  // - Reward earlier starts (before/inside EO preferred window).
  if (priority === 'EO') {
    if (effectiveEnd !== null && startTimeMin <= effectiveEnd) {
      const minutesEarly = Math.max(0, effectiveEnd - startTimeMin + 1);
      const bonus = Math.min(EO_EARLY_BONUS_MAX, Math.round(minutesEarly * EO_EARLY_BONUS_PER_MIN));
      if (bonus > 0) {
        return {
          penalty: -bonus,
          reasons: ['EO_EARLY_START_BONUS'],
          violation: null
        };
      }
    }

    return { penalty: 0, reasons: [], violation: null };
  }

  if (priority === 'HP') {
    // Hard lower bound (start >= hp_start_time) is already enforced in scheduling.
    // Here we score quality:
    // - reward when HP is fully inside the preferred window
    // - penalize if it spills after hp_end_time
    if (effectiveEnd !== null && endTimeMin !== null && endTimeMin > effectiveEnd) {
      const distance = endTimeMin - effectiveEnd;
      const penalty = Math.min(PENALTY_CONFIG.HP.max, distance * PENALTY_CONFIG.HP.k);
      return {
        penalty,
        reasons: ['HP_END_AFTER_PREFERRED_WINDOW'],
        violation: {
          priority,
          startTimeMin,
          windowStart: startMin,
          windowEnd: endMin,
          distanceMin: distance
        }
      };
    }

    if (startTimeMin >= effectiveStart) {
      const minutesInside = Math.max(0, (effectiveEnd ?? startTimeMin) - startTimeMin + 1);
      const bonus = Math.min(HP_IN_WINDOW_BONUS_MAX, Math.round(minutesInside * HP_IN_WINDOW_BONUS_PER_MIN));
      if (bonus > 0) {
        return {
          penalty: -bonus,
          reasons: ['HP_IN_WINDOW_BONUS'],
          violation: null
        };
      }
    }

    return { penalty: 0, reasons: [], violation: null };
  }

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

export function priorityToDbFormat(priority: Priority | string | null | undefined): string | null {
  if (!priority) return null;
  
  const normalized = priority.toUpperCase();
  
  if (normalized === 'EO') return 'early_out';
  if (normalized === 'HP') return 'high_priority';
  if (normalized === 'LP') return 'low_priority';
  
  return priority as string;
}
