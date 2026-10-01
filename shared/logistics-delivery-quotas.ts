export interface DeliveryQuotaDriver {
  driverId: number;
  driverName: string;
  /** null = lascia decidere all'algoritmo */
  quota: number | null;
}

export interface DeliveryQuotaResolution {
  total: number;
  explicitSum: number;
  remainder: number;
  forcedDriverId: number | null;
  /** null quando nessun autista ha un numero: le zone restano come sono. */
  counts: Map<number, number> | null;
  error: string | null;
}

export function splitDeliveryRemainder(total: number, parts: number): number[] {
  if (parts <= 0) return [];
  const safeTotal = Math.max(0, total);
  const base = Math.floor(safeTotal / parts);
  const extra = safeTotal % parts;
  return Array.from({ length: parts }, (_, index) => base + (index < extra ? 1 : 0));
}

export function resolveDeliveryQuotas(args: {
  drivers: DeliveryQuotaDriver[];
  total: number;
}): DeliveryQuotaResolution {
  const total = Math.max(0, Math.floor(args.total));
  const drivers = args.drivers;
  const explicit = drivers.filter((driver) => driver.quota != null);
  const free = drivers.filter((driver) => driver.quota == null);
  const explicitSum = explicit.reduce((sum, driver) => sum + (driver.quota ?? 0), 0);
  const remainder = total - explicitSum;
  const empty: DeliveryQuotaResolution = {
    total,
    explicitSum,
    remainder,
    forcedDriverId: null,
    counts: null,
    error: null,
  };

  if (explicit.length === 0) return empty;

  const invalid = explicit.find((driver) => !Number.isInteger(driver.quota) || (driver.quota ?? 0) < 0);
  if (invalid) {
    return {
      ...empty,
      error: `Il numero di consegne di ${invalid.driverName} non è valido.`,
    };
  }

  if (explicitSum > total) {
    const over = explicit.find((driver) => (driver.quota ?? 0) > total) ?? explicit[explicit.length - 1];
    return {
      ...empty,
      error: `${over.driverName}: ${over.quota} supera le ${total} consegne della giornata.`,
    };
  }

  const counts = new Map<number, number>();
  for (const driver of explicit) {
    counts.set(driver.driverId, driver.quota ?? 0);
  }

  if (free.length === 0) {
    if (remainder !== 0) {
      return {
        ...empty,
        error: `I numeri fanno ${explicitSum} su ${total}. Mancano ${remainder} consegne per chiudere la giornata.`,
      };
    }
    return { ...empty, counts, remainder: 0 };
  }

  if (free.length === 1) {
    const forced = free[0];
    counts.set(forced.driverId, remainder);
    return {
      ...empty,
      forcedDriverId: forced.driverId,
      counts,
      remainder,
    };
  }

  const shares = splitDeliveryRemainder(remainder, free.length);
  free.forEach((driver, index) => {
    counts.set(driver.driverId, shares[index] ?? 0);
  });
  return { ...empty, counts, remainder };
}

interface QuotaTask {
  taskId: number;
  lat: number | null;
  lng: number | null;
}

function centroidOf<T extends QuotaTask>(tasks: T[]): { lat: number; lng: number } {
  const located = tasks.filter((task) => task.lat != null && task.lng != null);
  if (located.length === 0) return { lat: 0, lng: 0 };
  return {
    lat: located.reduce((sum, task) => sum + (task.lat ?? 0), 0) / located.length,
    lng: located.reduce((sum, task) => sum + (task.lng ?? 0), 0) / located.length,
  };
}

function distanceTo<T extends QuotaTask>(task: T, center: { lat: number; lng: number }): number {
  if (task.lat == null || task.lng == null) return Number.POSITIVE_INFINITY;
  const dLat = task.lat - center.lat;
  const dLng = task.lng - center.lng;
  return dLat * dLat + dLng * dLng;
}

export function rebalanceTasksByDriverQuota<T extends QuotaTask>(
  drivers: { driverId: number; tasks: T[] }[],
  unassigned: T[],
  counts: Map<number, number>,
): { drivers: { driverId: number; tasks: T[] }[]; unassigned: T[] } {
  const centroids = new Map(drivers.map((driver) => [driver.driverId, centroidOf(driver.tasks)]));
  const loose: T[] = [...unassigned];
  const kept = new Map<number, T[]>();

  for (const driver of drivers) {
    const target = counts.get(driver.driverId) ?? 0;
    const center = centroids.get(driver.driverId) ?? { lat: 0, lng: 0 };
    const own = [...driver.tasks].sort((left, right) => distanceTo(left, center) - distanceTo(right, center));
    kept.set(driver.driverId, own.slice(0, target));
    loose.push(...own.slice(target));
  }

  for (const driver of drivers) {
    const target = counts.get(driver.driverId) ?? 0;
    const have = kept.get(driver.driverId) ?? [];
    const center = centroids.get(driver.driverId) ?? { lat: 0, lng: 0 };
    while (have.length < target && loose.length > 0) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < loose.length; index += 1) {
        const distance = distanceTo(loose[index], center);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      const [moved] = loose.splice(bestIndex, 1);
      if (moved) have.push(moved);
    }
    kept.set(driver.driverId, have);
  }

  return {
    drivers: drivers.map((driver) => ({
      driverId: driver.driverId,
      tasks: kept.get(driver.driverId) ?? [],
    })),
    unassigned: loose,
  };
}
