const EARTH_RADIUS_M = 6371000;

export function haversineMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
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

export function calculateCentroid(
  points: Array<{ lat: number; lng: number }>
): { lat: number; lng: number } {
  const sum = points.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

export function maxDistanceFromCentroid(
  points: Array<{ lat: number; lng: number }>,
  centroid: { lat: number; lng: number }
): number {
  return Math.max(
    ...points.map((point) => haversineMeters(point.lat, point.lng, centroid.lat, centroid.lng))
  );
}

export function unionFindGroups<T>(
  items: T[],
  shouldUnion: (a: T, b: T) => boolean
): T[][] {
  const parent = items.map((_, index) => index);

  function find(index: number): number {
    let root = index;
    while (parent[root] !== root) {
      parent[root] = parent[parent[root]];
      root = parent[root];
    }
    return root;
  }

  function union(left: number, right: number): void {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[leftRoot] = rightRoot;
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (shouldUnion(items[i], items[j])) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, T[]>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const group = groups.get(root) ?? [];
    group.push(items[i]);
    groups.set(root, group);
  }

  return [...groups.values()];
}
