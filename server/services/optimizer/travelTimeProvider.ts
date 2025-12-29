import pool from '../../../shared/pg-db';

export interface TravelLocation {
  lat: number;
  lng: number;
}

export interface TravelTimeProviderConfig {
  runId: string;
  staleDays?: number;
  roundingDecimals?: number;
}

const AVG_SPEED_KMH = 18;
const NON_LINEAR_PATH_FACTOR = 1.5;
const EARTH_RADIUS_M = 6_371_000;

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateTravelMinutesLegacy(from: TravelLocation, to: TravelLocation): number {
  const meters = haversineMeters(from.lat, from.lng, to.lat, to.lng);
  const km = (meters / 1000) * NON_LINEAR_PATH_FACTOR;
  const hours = km / AVG_SPEED_KMH;
  return Math.max(1, Math.round(hours * 60));
}

export class TravelTimeProvider {
  private localCache: Map<string, number> = new Map();
  private loggedFallbackKeys: Set<string> = new Set();
  private runId: string;
  private staleDays: number;
  private roundingDecimals: number;

  constructor(config: TravelTimeProviderConfig) {
    this.runId = config.runId;
    this.staleDays = config.staleDays ?? 30;
    this.roundingDecimals = config.roundingDecimals ?? 4;
  }

  private round(val: number): number {
    const factor = Math.pow(10, this.roundingDecimals);
    return Math.round(val * factor) / factor;
  }

  private makeCacheKey(from: TravelLocation, to: TravelLocation): string {
    const fromLat = this.round(from.lat);
    const fromLng = this.round(from.lng);
    const toLat = this.round(to.lat);
    const toLng = this.round(to.lng);
    return `${fromLat}:${fromLng}->${toLat}:${toLng}`;
  }

  async getMinutes(from: TravelLocation, to: TravelLocation, options?: { phase?: string }): Promise<number> {
    const cacheKey = this.makeCacheKey(from, to);
    const phase = options?.phase ?? 'UNKNOWN';

    if (this.localCache.has(cacheKey)) {
      return this.localCache.get(cacheKey)!;
    }

    try {
      const result = await pool.query(
        `SELECT minutes, updated_at FROM optimizer.optimizer_travel_time_cache WHERE cache_key = $1`,
        [cacheKey]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const updatedAt = new Date(row.updated_at);
        const staleThreshold = new Date();
        staleThreshold.setDate(staleThreshold.getDate() - this.staleDays);

        if (updatedAt >= staleThreshold) {
          const minutes = row.minutes;
          this.localCache.set(cacheKey, minutes);
          return minutes;
        }
      }

      const minutes = estimateTravelMinutesLegacy(from, to);
      
      await pool.query(
        `INSERT INTO optimizer.optimizer_travel_time_cache(cache_key, minutes, source, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (cache_key) DO UPDATE
         SET minutes = EXCLUDED.minutes,
             source = EXCLUDED.source,
             updated_at = now()`,
        [cacheKey, minutes, 'estimated']
      );

      if (!this.loggedFallbackKeys.has(cacheKey)) {
        this.loggedFallbackKeys.add(cacheKey);
        
        await pool.query(
          `INSERT INTO optimizer.optimizer_decision (run_id, phase, event_type, payload)
           VALUES ($1, $2, $3, $4)`,
          [
            this.runId,
            phase === 'PHASE1' ? 1 : phase === 'PHASE2' ? 2 : phase === 'PHASE3' ? 3 : phase === 'PHASE4' ? 4 : 0,
            'ESTIMATED_TRAVEL_USED',
            JSON.stringify({
              cacheKey,
              minutes,
              from: { lat: this.round(from.lat), lng: this.round(from.lng) },
              to: { lat: this.round(to.lat), lng: this.round(to.lng) },
              phase
            })
          ]
        );
      }

      this.localCache.set(cacheKey, minutes);
      return minutes;

    } catch (error) {
      console.error(`TravelTimeProvider error for ${cacheKey}:`, error);
      const minutes = estimateTravelMinutesLegacy(from, to);
      this.localCache.set(cacheKey, minutes);
      return minutes;
    }
  }

  async prefetchPairs(pairs: Array<{ from: TravelLocation; to: TravelLocation }>): Promise<void> {
    const keysToFetch: string[] = [];
    const keyToLocation: Map<string, { from: TravelLocation; to: TravelLocation }> = new Map();

    for (const pair of pairs) {
      const cacheKey = this.makeCacheKey(pair.from, pair.to);
      if (!this.localCache.has(cacheKey)) {
        keysToFetch.push(cacheKey);
        keyToLocation.set(cacheKey, pair);
      }
    }

    if (keysToFetch.length === 0) return;

    try {
      const result = await pool.query(
        `SELECT cache_key, minutes, updated_at 
         FROM optimizer.optimizer_travel_time_cache 
         WHERE cache_key = ANY($1)`,
        [keysToFetch]
      );

      const staleThreshold = new Date();
      staleThreshold.setDate(staleThreshold.getDate() - this.staleDays);

      const foundKeys = new Set<string>();
      for (const row of result.rows) {
        const updatedAt = new Date(row.updated_at);
        if (updatedAt >= staleThreshold) {
          this.localCache.set(row.cache_key, row.minutes);
          foundKeys.add(row.cache_key);
        }
      }

      for (const cacheKey of keysToFetch) {
        if (!foundKeys.has(cacheKey)) {
          const loc = keyToLocation.get(cacheKey)!;
          const minutes = estimateTravelMinutesLegacy(loc.from, loc.to);
          this.localCache.set(cacheKey, minutes);
        }
      }
    } catch (error) {
      console.error('TravelTimeProvider prefetch error:', error);
      for (const cacheKey of keysToFetch) {
        if (!this.localCache.has(cacheKey)) {
          const loc = keyToLocation.get(cacheKey)!;
          const minutes = estimateTravelMinutesLegacy(loc.from, loc.to);
          this.localCache.set(cacheKey, minutes);
        }
      }
    }
  }

  getLocalCacheSize(): number {
    return this.localCache.size;
  }

  getFallbackCount(): number {
    return this.loggedFallbackKeys.size;
  }
}

export { estimateTravelMinutesLegacy };
