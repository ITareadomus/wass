/**
 * Car-only travel estimates (road-style heuristic).
 * Not mixed with housekeeping pedestrian/vehicle blend in optimizer/phase1.ts.
 */

const EARTH_RADIUS_M = 6371000;
/** Effective road speed km/h (urban / mixed) — skeleton default */
const DEFAULT_AVG_SPEED_KMH = 28;
const BASE_MINUTES = 3;
const MIN_LEG_MIN = 2;
const MAX_LEG_MIN = 180;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r1 = (lat1 * Math.PI) / 180;
  const r2 = (lat2 * Math.PI) / 180;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(r1) * Math.cos(r2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

/**
 * Driving minutes between two points (straight-line distance + average speed).
 */
export function estimateCarTravelMinutes(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
  avgSpeedKmh: number = DEFAULT_AVG_SPEED_KMH
): number {
  const meters = haversineMeters(a.lat, a.lng, b.lat, b.lng);
  const km = meters / 1000;
  const hours = km / avgSpeedKmh;
  const minutes = BASE_MINUTES + hours * 60;
  return Math.round(Math.max(MIN_LEG_MIN, Math.min(MAX_LEG_MIN, minutes)));
}

export function buildTravelMatrixMinutes(
  points: { lat: number; lng: number }[],
  avgSpeedKmh?: number
): number[][] {
  const n = points.length;
  const m: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) m[i][j] = 0;
      else m[i][j] = estimateCarTravelMinutes(points[i], points[j], avgSpeedKmh);
    }
  }
  return m;
}
