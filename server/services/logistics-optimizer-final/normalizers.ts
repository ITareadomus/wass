import { parseHmToMinutes } from "../../../shared/logistics-scheduling-constraints";
import { mapPriorityType, type Priority } from "../optimizer/priorityWindows";

export const DEFAULT_DRIVER_START_TIME = "10:00";
export const DEFAULT_DRIVER_END_MIN = 23 * 60 + 59;

export function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function normalizeStartTime(value: unknown): {
  time: string;
  source: "driver_row" | "default";
} {
  const raw = String(value ?? "").trim();
  if (!raw) return { time: DEFAULT_DRIVER_START_TIME, source: "default" };
  return {
    time: raw.length >= 5 ? raw.slice(0, 5) : DEFAULT_DRIVER_START_TIME,
    source: raw.length >= 5 ? "driver_row" : "default",
  };
}

export function parseTimeToMinutes(value: unknown, fallback: number | null = null): number | null {
  return parseHmToMinutes(value, fallback);
}

export function normalizePriority(priority: string | null | undefined): Priority | null {
  return mapPriorityType(priority);
}

export function isValidCoordinatePair(lat: unknown, lng: unknown): lat is number {
  const latNum = toFiniteNumber(lat);
  const lngNum = toFiniteNumber(lng);
  return latNum !== null && lngNum !== null;
}
