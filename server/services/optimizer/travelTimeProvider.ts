import pool from '../../../shared/pg-db';

const AVG_SPEED_KMH = 18;
const NON_LINEAR_PATH_FACTOR = 1.5;
const CACHE_TTL_DAYS = 30;

export interface TravelLocation {
  lat: number;
  lng: number;
}

export interface TravelTimeResult {
  minutes: number;
  source: 'cache' | 'estimated';
  cacheKey: string;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (deg: number) => deg * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function roundCoord(coord: number, decimals: number = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round(coord * factor) / factor;
}

function generateCacheKey(from: TravelLocation, to: TravelLocation): string {
  const fromLat = roundCoord(from.lat);
  const fromLng = roundCoord(from.lng);
  const toLat = roundCoord(to.lat);
  const toLng = roundCoord(to.lng);
  return `${fromLat}_${fromLng}_${toLat}_${toLng}`;
}

function estimateTravelMinutesLegacy(from: TravelLocation, to: TravelLocation): number {
  const meters = haversineMeters(from.lat, from.lng, to.lat, to.lng);
  const km = (meters / 1000) * NON_LINEAR_PATH_FACTOR;
  const hours = km / AVG_SPEED_KMH;
  return Math.max(1, Math.round(hours * 60));
}

export class TravelTimeProvider {
  private runId: string;
  private loggedEstimatedKeys: Set<string> = new Set();
  private localCache: Map<string, number> = new Map();
  private pendingLogs: Array<{ cacheKey: string; minutes: number }> = [];

  constructor(runId: string) {
    this.runId = runId;
  }

  async getTravelMinutes(from: TravelLocation, to: TravelLocation): Promise<TravelTimeResult> {
    const cacheKey = generateCacheKey(from, to);

    const localCached = this.localCache.get(cacheKey);
    if (localCached !== undefined) {
      return { minutes: localCached, source: 'cache', cacheKey };
    }

    const cached = await this.lookupCache(cacheKey);
    if (cached !== null) {
      this.localCache.set(cacheKey, cached);
      return { minutes: cached, source: 'cache', cacheKey };
    }

    const estimated = estimateTravelMinutesLegacy(from, to);

    this.localCache.set(cacheKey, estimated);

    await this.upsertCache(cacheKey, estimated, 'estimated');

    if (!this.loggedEstimatedKeys.has(cacheKey)) {
      this.pendingLogs.push({ cacheKey, minutes: estimated });
      this.loggedEstimatedKeys.add(cacheKey);
    }

    return { minutes: estimated, source: 'estimated', cacheKey };
  }

  getTravelMinutesSync(from: TravelLocation, to: TravelLocation): number {
    const cacheKey = generateCacheKey(from, to);
    
    const localCached = this.localCache.get(cacheKey);
    if (localCached !== undefined) {
      return localCached;
    }

    const estimated = estimateTravelMinutesLegacy(from, to);
    this.localCache.set(cacheKey, estimated);
    
    return estimated;
  }

  async prefetchBatch(pairs: Array<{ from: TravelLocation; to: TravelLocation }>): Promise<void> {
    if (pairs.length === 0) return;

    const cacheKeys = pairs.map(p => generateCacheKey(p.from, p.to));
    const uniqueKeys = [...new Set(cacheKeys)];
    
    const keysToFetch = uniqueKeys.filter(k => !this.localCache.has(k));
    if (keysToFetch.length === 0) return;

    try {
      const result = await pool.query(`
        SELECT cache_key, minutes
        FROM optimizer.optimizer_travel_time_cache
        WHERE cache_key = ANY($1::text[])
      `, [keysToFetch]);

      for (const row of result.rows) {
        this.localCache.set(row.cache_key, row.minutes);
      }
    } catch (error) {
      console.error('[TravelTimeProvider] Prefetch error:', error);
    }

    for (let i = 0; i < pairs.length; i++) {
      const key = cacheKeys[i];
      if (!this.localCache.has(key)) {
        const estimated = estimateTravelMinutesLegacy(pairs[i].from, pairs[i].to);
        this.localCache.set(key, estimated);
      }
    }
  }

  private async lookupCache(cacheKey: string): Promise<number | null> {
    try {
      const result = await pool.query(`
        SELECT minutes, updated_at, expires_at
        FROM optimizer.optimizer_travel_time_cache
        WHERE cache_key = $1
      `, [cacheKey]);

      if (result.rows.length === 0) {
        return null;
      }

      const row = result.rows[0];

      return row.minutes;
    } catch (error) {
      console.error('[TravelTimeProvider] Cache lookup error:', error);
      return null;
    }
  }

  private async upsertCache(cacheKey: string, minutes: number, source: string): Promise<void> {
    try {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + CACHE_TTL_DAYS);

      await pool.query(`
        INSERT INTO optimizer.optimizer_travel_time_cache (cache_key, minutes, source, updated_at, expires_at)
        VALUES ($1, $2, $3, NOW(), $4)
        ON CONFLICT (cache_key) 
        DO UPDATE SET minutes = $2, source = $3, updated_at = NOW(), expires_at = $4
      `, [cacheKey, minutes, source, expiresAt]);
    } catch (error) {
      console.error('[TravelTimeProvider] Cache upsert error:', error);
    }
  }

  async flushEstimatedLogs(): Promise<number> {
    if (this.pendingLogs.length === 0) return 0;

    const logsToInsert = [...this.pendingLogs];
    this.pendingLogs = [];

    try {
      const BATCH_SIZE = 100;
      let inserted = 0;

      for (let i = 0; i < logsToInsert.length; i += BATCH_SIZE) {
        const batch = logsToInsert.slice(i, i + BATCH_SIZE);
        
        const values: any[] = [];
        const placeholders: string[] = [];
        
        batch.forEach((log, idx) => {
          const offset = idx * 4;
          placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`);
          values.push(
            this.runId,
            0,
            'ESTIMATED_TRAVEL_USED',
            JSON.stringify({ cache_key: log.cacheKey, minutes: log.minutes })
          );
        });

        await pool.query(`
          INSERT INTO optimizer.optimizer_decision (run_id, phase, event_type, payload)
          VALUES ${placeholders.join(', ')}
        `, values);

        inserted += batch.length;
      }

      return inserted;
    } catch (error) {
      console.error('[TravelTimeProvider] Flush logs error:', error);
      return 0;
    }
  }

  getLocalCacheSize(): number {
    return this.localCache.size;
  }

  getPendingLogsCount(): number {
    return this.pendingLogs.length;
  }

  clearLocalCache(): void {
    this.localCache.clear();
    this.loggedEstimatedKeys.clear();
  }
}

export function createTravelTimeProvider(runId: string): TravelTimeProvider {
  return new TravelTimeProvider(runId);
}
