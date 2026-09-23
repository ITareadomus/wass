type LatLng = { lat: number; lng: number };
type Pt = { x: number; y: number };

const METERS_PER_DEG_LAT = 110540;

function metersPerDegLng(lat: number): number {
  return 111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
}

function toXY(origin: LatLng, point: LatLng): Pt {
  return {
    x: (point.lng - origin.lng) * metersPerDegLng(origin.lat),
    y: (point.lat - origin.lat) * METERS_PER_DEG_LAT,
  };
}

function fromXY(origin: LatLng, point: Pt): LatLng {
  return {
    lat: origin.lat + point.y / METERS_PER_DEG_LAT,
    lng: origin.lng + point.x / metersPerDegLng(origin.lat),
  };
}

function centroidOf(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  const sum = points.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

function uniquePoints(points: LatLng[]): LatLng[] {
  const seen = new Map<string, LatLng>();
  for (const point of points) {
    seen.set(`${point.lat.toFixed(6)},${point.lng.toFixed(6)}`, point);
  }
  return [...seen.values()];
}

function convexHull(points: Pt[]): Pt[] {
  const sorted = [...points].sort((left, right) => left.x - right.x || left.y - right.y);
  if (sorted.length <= 2) return sorted;

  const cross = (origin: Pt, a: Pt, b: Pt) =>
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);

  const lower: Pt[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Pt[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

function normalize(point: Pt): Pt {
  const length = Math.hypot(point.x, point.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: point.x / length, y: point.y / length };
}

function circlePolygon(center: Pt, radius: number, steps = 20): Pt[] {
  const points: Pt[] = [];
  for (let step = 0; step < steps; step += 1) {
    const angle = (step / steps) * Math.PI * 2;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }
  return points;
}

function offsetConvex(hull: Pt[], distance: number): Pt[] {
  if (hull.length === 0) return [];
  if (hull.length === 1) return circlePolygon(hull[0], Math.max(Math.abs(distance), 180));
  if (hull.length === 2) {
    const dir = normalize({ x: hull[1].x - hull[0].x, y: hull[1].y - hull[0].y });
    const normal = { x: -dir.y, y: dir.x };
    const pad = Math.max(Math.abs(distance), 160);
    return [
      { x: hull[0].x - dir.x * pad + normal.x * pad, y: hull[0].y - dir.y * pad + normal.y * pad },
      { x: hull[1].x + dir.x * pad + normal.x * pad, y: hull[1].y + dir.y * pad + normal.y * pad },
      { x: hull[1].x + dir.x * pad - normal.x * pad, y: hull[1].y + dir.y * pad - normal.y * pad },
      { x: hull[0].x - dir.x * pad - normal.x * pad, y: hull[0].y - dir.y * pad - normal.y * pad },
    ];
  }

  const count = hull.length;
  const offset: Pt[] = [];
  for (let index = 0; index < count; index += 1) {
    const prev = hull[(index + count - 1) % count];
    const cur = hull[index];
    const next = hull[(index + 1) % count];
    const edge1 = normalize({ x: cur.x - prev.x, y: cur.y - prev.y });
    const edge2 = normalize({ x: next.x - cur.x, y: next.y - cur.y });
    const n1 = { x: edge1.y, y: -edge1.x };
    const n2 = { x: edge2.y, y: -edge2.x };
    const combined = normalize({ x: n1.x + n2.x, y: n1.y + n2.y });
    if (combined.x === 0 && combined.y === 0) {
      offset.push({ x: cur.x + n1.x * distance, y: cur.y + n1.y * distance });
      continue;
    }
    const miter = combined.x * n1.x + combined.y * n1.y;
    const scale = Math.abs(miter) > 0.25 ? distance / miter : distance;
    offset.push({ x: cur.x + combined.x * scale, y: cur.y + combined.y * scale });
  }
  return offset;
}

function clipByBisector(polygon: Pt[], site: Pt, other: Pt): Pt[] {
  if (polygon.length === 0) return [];
  const mid = { x: (site.x + other.x) / 2, y: (site.y + other.y) / 2 };
  const dx = other.x - site.x;
  const dy = other.y - site.y;
  if (Math.hypot(dx, dy) < 1e-6) return polygon;

  const inside = (point: Pt) => (point.x - mid.x) * dx + (point.y - mid.y) * dy <= 1e-6;
  const intersect = (a: Pt, b: Pt): Pt => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const denom = abx * dx + aby * dy;
    if (Math.abs(denom) < 1e-12) return a;
    const t = ((mid.x - a.x) * dx + (mid.y - a.y) * dy) / denom;
    return { x: a.x + t * abx, y: a.y + t * aby };
  };

  const output: Pt[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const previous = polygon[(index + polygon.length - 1) % polygon.length];
    const currentIn = inside(current);
    const previousIn = inside(previous);
    if (currentIn) {
      if (!previousIn) output.push(intersect(previous, current));
      output.push(current);
    } else if (previousIn) {
      output.push(intersect(previous, current));
    }
  }
  return output;
}

function signedArea(polygon: Pt[]): number {
  let area = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const next = polygon[(index + 1) % polygon.length];
    area += polygon[index].x * next.y - next.x * polygon[index].y;
  }
  return area / 2;
}

function ensureCcw(polygon: Pt[]): Pt[] {
  return signedArea(polygon) < 0 ? [...polygon].reverse() : polygon;
}

function ensureCw(polygon: Pt[]): Pt[] {
  return signedArea(polygon) > 0 ? [...polygon].reverse() : polygon;
}

function snapPt(point: Pt): Pt {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function pointKey(point: Pt): string {
  const snapped = snapPt(point);
  return `${snapped.x},${snapped.y}`;
}

function pointInRing(point: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let index = 0, prev = ring.length - 1; index < ring.length; prev = index, index += 1) {
    const a = ring[index];
    const b = ring[prev];
    const intersects =
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y + 1e-12) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function boundaryEdges(cells: Pt[][]): Map<string, [Pt, Pt]> {
  const counts = new Map<string, number>();
  const geom = new Map<string, [Pt, Pt]>();
  for (const cell of cells) {
    const snapped = cell.map(snapPt);
    for (let index = 0; index < snapped.length; index += 1) {
      const a = snapped[index];
      const b = snapped[(index + 1) % snapped.length];
      const aKey = pointKey(a);
      const bKey = pointKey(b);
      if (aKey === bKey) continue;
      const key = aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!geom.has(key)) geom.set(key, [a, b]);
    }
  }
  const leftover = new Map<string, [Pt, Pt]>();
  for (const [key, count] of counts) {
    if (count === 1) leftover.set(key, geom.get(key)!);
  }
  return leftover;
}

function walkRings(edges: Map<string, [Pt, Pt]>): Pt[][] {
  const adj = new Map<string, Array<{ toKey: string; to: Pt; edgeKey: string }>>();
  for (const [edgeKey, [a, b]] of edges) {
    const aKey = pointKey(a);
    const bKey = pointKey(b);
    if (!adj.has(aKey)) adj.set(aKey, []);
    if (!adj.has(bKey)) adj.set(bKey, []);
    adj.get(aKey)!.push({ toKey: bKey, to: b, edgeKey });
    adj.get(bKey)!.push({ toKey: aKey, to: a, edgeKey });
  }

  const remaining = new Set(edges.keys());
  const rings: Pt[][] = [];

  while (remaining.size > 0) {
    const startEdge = remaining.values().next().value as string;
    const [start, first] = edges.get(startEdge)!;
    remaining.delete(startEdge);
    const ring: Pt[] = [start];
    let current = first;
    let previousKey = pointKey(start);
    const startKey = pointKey(start);
    let guard = 0;
    while (pointKey(current) !== startKey && guard < 8000) {
      guard += 1;
      ring.push(current);
      const currentKey = pointKey(current);
      const options = (adj.get(currentKey) ?? []).filter(
        (neighbor) => remaining.has(neighbor.edgeKey) && neighbor.toKey !== previousKey,
      );
      let next = options[0];
      if (options.length > 1) {
        const incoming = { x: current.x - (ring[ring.length - 2]?.x ?? start.x), y: current.y - (ring[ring.length - 2]?.y ?? start.y) };
        next = options.reduce((best, candidate) => {
          const bestVec = { x: best.to.x - current.x, y: best.to.y - current.y };
          const candVec = { x: candidate.to.x - current.x, y: candidate.to.y - current.y };
          const bestTurn = incoming.x * bestVec.y - incoming.y * bestVec.x;
          const candTurn = incoming.x * candVec.y - incoming.y * candVec.x;
          return candTurn > bestTurn ? candidate : best;
        });
      }
      if (!next) break;
      remaining.delete(next.edgeKey);
      previousKey = currentKey;
      current = next.to;
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

function classifyRings(rings: Pt[][]): Array<{ outer: Pt[]; holes: Pt[][] }> {
  const ranked = rings
    .map((ring) => ({ ring: ensureCcw(ring), area: Math.abs(signedArea(ring)) }))
    .filter((entry) => entry.area > 4)
    .sort((left, right) => right.area - left.area);

  const used = new Set<number>();
  const polygons: Array<{ outer: Pt[]; holes: Pt[][] }> = [];
  for (let index = 0; index < ranked.length; index += 1) {
    if (used.has(index)) continue;
    const outer = ranked[index].ring;
    const holes: Pt[][] = [];
    for (let other = index + 1; other < ranked.length; other += 1) {
      if (used.has(other)) continue;
      const candidate = ranked[other].ring[0];
      if (candidate && pointInRing(candidate, outer)) {
        holes.push(ensureCw(ranked[other].ring));
        used.add(other);
      }
    }
    polygons.push({ outer, holes });
  }
  return polygons;
}

function mergeZoneCells(cells: Pt[][]): Array<{ outer: Pt[]; holes: Pt[][] }> {
  if (cells.length === 0) return [];
  if (cells.length === 1) return [{ outer: ensureCcw(cells[0].map(snapPt)), holes: [] }];
  const rings = walkRings(boundaryEdges(cells));
  const classified = classifyRings(rings);
  if (classified.length > 0) return classified;
  return cells.filter((cell) => cell.length >= 3).map((cell) => ({ outer: ensureCcw(cell), holes: [] }));
}

function voronoiCell(site: Pt, others: Pt[], clip: Pt[]): Pt[] {
  let cell = clip;
  for (const other of others) {
    cell = clipByBisector(cell, site, other);
    if (cell.length < 3) return [];
  }
  return ensureCcw(cell);
}

export function buildNonOverlappingZonePolygons(
  zones: Array<{ id: string; points: LatLng[] }>,
): Array<{ id: string; path: LatLng[]; holes: LatLng[][] }> {
  const located = zones
    .map((zone) => ({ id: zone.id, points: uniquePoints(zone.points) }))
    .filter((zone) => zone.points.length > 0);
  if (located.length === 0) return [];

  const allPoints = located.flatMap((zone) => zone.points);
  const origin = centroidOf(allPoints);
  if (!origin) return [];

  const sites: Array<{ id: string; xy: Pt }> = [];
  const seen = new Set<string>();
  for (const zone of located) {
    for (const point of zone.points) {
      const key = `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sites.push({ id: zone.id, xy: toXY(origin, point) });
    }
  }
  if (sites.length === 0) return [];

  const clip = ensureCcw(offsetConvex(convexHull(sites.map((site) => site.xy)), 160));
  if (clip.length < 3) return [];

  if (located.length === 1) {
    return [{ id: located[0].id, path: clip.map((point) => fromXY(origin, point)), holes: [] }];
  }

  const cellsByZone = new Map<string, Pt[][]>();
  for (let index = 0; index < sites.length; index += 1) {
    const site = sites[index];
    const others = sites.filter((_, otherIndex) => otherIndex !== index).map((other) => other.xy);
    const cell = voronoiCell(site.xy, others, clip);
    if (cell.length < 3) continue;
    const current = cellsByZone.get(site.id) ?? [];
    current.push(cell);
    cellsByZone.set(site.id, current);
  }

  const polygons: Array<{ id: string; path: LatLng[]; holes: LatLng[][] }> = [];
  for (const [id, cells] of cellsByZone) {
    for (const piece of mergeZoneCells(cells)) {
      polygons.push({
        id,
        path: piece.outer.map((point) => fromXY(origin, point)),
        holes: piece.holes.map((hole) => hole.map((point) => fromXY(origin, point))),
      });
    }
  }
  return polygons;
}
