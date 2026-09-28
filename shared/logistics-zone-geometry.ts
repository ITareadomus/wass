import { pointInLatLngPolygon, type ZoneLatLng } from "./logistics-zone-edit";

type Pt = { x: number; y: number };

const METERS_PER_DEG_LAT = 110540;
const MAX_DRAWABLE_VERTICES = 20;
const MIN_PIECE_AREA = 4;

function metersPerDegLng(lat: number): number {
  return 111320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
}

function toXY(origin: ZoneLatLng, point: ZoneLatLng): Pt {
  return {
    x: (point.lng - origin.lng) * metersPerDegLng(origin.lat),
    y: (point.lat - origin.lat) * METERS_PER_DEG_LAT,
  };
}

function fromXY(origin: ZoneLatLng, point: Pt): ZoneLatLng {
  return {
    lat: origin.lat + point.y / METERS_PER_DEG_LAT,
    lng: origin.lng + point.x / metersPerDegLng(origin.lat),
  };
}

function centroidOf(points: readonly ZoneLatLng[]): ZoneLatLng | null {
  if (points.length === 0) return null;
  const sum = points.reduce(
    (acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

function uniquePoints(points: readonly ZoneLatLng[]): ZoneLatLng[] {
  const seen = new Map<string, ZoneLatLng>();
  for (const point of points) {
    seen.set(`${point.lat.toFixed(6)},${point.lng.toFixed(6)}`, point);
  }
  return [...seen.values()];
}

function signedArea(polygon: readonly Pt[]): number {
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

function pointInRing(point: Pt, ring: readonly Pt[]): boolean {
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

function pointOnSegment(point: Pt, start: Pt, end: Pt): boolean {
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > 1) return false;
  const dot = (point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y);
  if (dot < -1) return false;
  const lenSq = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  return dot <= lenSq + 1;
}

function pointInRingStrict(point: Pt, ring: readonly Pt[]): boolean {
  for (let index = 0; index < ring.length; index += 1) {
    if (pointOnSegment(point, ring[index], ring[(index + 1) % ring.length])) return false;
  }
  return pointInRing(point, ring);
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

function distPointToSeg(point: Pt, start: Pt, end: Pt): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-6) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function removeFlattestVertex(ring: Pt[]): Pt[] {
  if (ring.length <= 3) return ring;
  let bestIndex = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ring.length; index += 1) {
    const prev = ring[(index + ring.length - 1) % ring.length];
    const next = ring[(index + 1) % ring.length];
    const score = distPointToSeg(ring[index], prev, next);
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return ring.filter((_, index) => index !== bestIndex);
}

function clipByHalfPlane(polygon: Pt[], start: Pt, end: Pt, keepLeft: boolean): Pt[] {
  if (polygon.length === 0) return [];
  const inside = (point: Pt) => {
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    return keepLeft ? cross >= -1e-6 : cross <= 1e-6;
  };
  const intersect = (a: Pt, b: Pt): Pt => {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const denom = abx * (end.y - start.y) - aby * (end.x - start.x);
    if (Math.abs(denom) < 1e-12) return a;
    const t = ((start.x - a.x) * (end.y - start.y) - (start.y - a.y) * (end.x - start.x)) / denom;
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

function segmentIntersection(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt | null {
  const ax = a2.x - a1.x;
  const ay = a2.y - a1.y;
  const bx = b2.x - b1.x;
  const by = b2.y - b1.y;
  const denom = ax * by - ay * bx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b1.x - a1.x) * by - (b1.y - a1.y) * bx) / denom;
  const u = ((b1.x - a1.x) * ay - (b1.y - a1.y) * ax) / denom;
  if (t < -1e-6 || t > 1 + 1e-6 || u < -1e-6 || u > 1 + 1e-6) return null;
  return { x: a1.x + t * ax, y: a1.y + t * ay };
}

function cleanRing(ring: readonly Pt[]): Pt[] {
  const cleaned: Pt[] = [];
  for (const point of ring) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.08) continue;
    cleaned.push(point);
  }
  if (
    cleaned.length >= 2 &&
    Math.hypot(cleaned[0].x - cleaned[cleaned.length - 1].x, cleaned[0].y - cleaned[cleaned.length - 1].y) < 0.08
  ) {
    cleaned.pop();
  }
  return cleaned;
}

function ringArea(ring: readonly Pt[]): number {
  return Math.abs(signedArea(ring));
}

function isConvexRing(ring: readonly Pt[]): boolean {
  if (ring.length < 3) return false;
  let sign = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const previous = ring[(index + ring.length - 1) % ring.length];
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];
    const cross =
      (current.x - previous.x) * (next.y - current.y) - (current.y - previous.y) * (next.x - current.x);
    if (Math.abs(cross) < 1e-6) continue;
    const nextSign = cross > 0 ? 1 : -1;
    if (sign === 0) sign = nextSign;
    else if (nextSign !== sign) return false;
  }
  return sign !== 0;
}

function orientCross(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointInTriangleStrict(point: Pt, a: Pt, b: Pt, c: Pt): boolean {
  const c1 = orientCross(a, b, point);
  const c2 = orientCross(b, c, point);
  const c3 = orientCross(c, a, point);
  const hasNeg = c1 < -1e-6 || c2 < -1e-6 || c3 < -1e-6;
  const hasPos = c1 > 1e-6 || c2 > 1e-6 || c3 > 1e-6;
  return !(hasNeg && hasPos) && Math.abs(c1) > 1e-6 && Math.abs(c2) > 1e-6 && Math.abs(c3) > 1e-6;
}

function triangulateRing(ring: readonly Pt[]): Pt[][] {
  const remaining = cleanRing(ensureCcw([...ring]));
  if (remaining.length < 3) return [];
  if (remaining.length === 3) return [remaining];
  if (isConvexRing(remaining)) {
    const triangles: Pt[][] = [];
    for (let index = 1; index < remaining.length - 1; index += 1) {
      triangles.push([remaining[0], remaining[index], remaining[index + 1]]);
    }
    return triangles;
  }

  const triangles: Pt[][] = [];
  let guard = 0;
  while (remaining.length > 3 && guard < 4000) {
    guard += 1;
    let ear = -1;
    for (let index = 0; index < remaining.length; index += 1) {
      const previous = remaining[(index + remaining.length - 1) % remaining.length];
      const current = remaining[index];
      const next = remaining[(index + 1) % remaining.length];
      if (orientCross(previous, current, next) <= 1e-6) continue;
      let blocked = false;
      for (let other = 0; other < remaining.length; other += 1) {
        if (other === index || other === (index + remaining.length - 1) % remaining.length) continue;
        if (other === (index + 1) % remaining.length) continue;
        if (pointInTriangleStrict(remaining[other], previous, current, next)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        ear = index;
        break;
      }
    }
    if (ear < 0) break;
    const previous = remaining[(ear + remaining.length - 1) % remaining.length];
    const current = remaining[ear];
    const next = remaining[(ear + 1) % remaining.length];
    triangles.push([previous, current, next]);
    remaining.splice(ear, 1);
  }
  if (remaining.length === 3) triangles.push([...remaining]);
  return triangles;
}

function snapPt(point: Pt): Pt {
  return { x: Math.round(point.x * 20) / 20, y: Math.round(point.y * 20) / 20 };
}

function pointKey(point: Pt): string {
  const snapped = snapPt(point);
  return `${snapped.x},${snapped.y}`;
}

function boundaryEdges(cells: Pt[][]): Map<string, [Pt, Pt]> {
  const counts = new Map<string, number>();
  const geom = new Map<string, [Pt, Pt]>();
  for (const cell of cells) {
    const snapped = cleanRing(cell).map(snapPt);
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
        (neighbor) => remaining.has(neighbor.edgeKey) && neighbor.toKey !== previousKey
      );
      let next = options[0];
      if (options.length > 1) {
        const incoming = {
          x: current.x - (ring[ring.length - 2]?.x ?? start.x),
          y: current.y - (ring[ring.length - 2]?.y ?? start.y),
        };
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
    if (ring.length >= 3) rings.push(cleanRing(ring));
  }
  return rings;
}

function makeKeyhole(outer: Pt[], hole: Pt[]): Pt[] {
  const holeCw = [...ensureCcw(hole)].reverse();
  const out = ensureCcw(outer);
  let bestOuter = 0;
  let bestHole = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < out.length; i += 1) {
    for (let j = 0; j < holeCw.length; j += 1) {
      const dist = (out[i].x - holeCw[j].x) ** 2 + (out[i].y - holeCw[j].y) ** 2;
      if (dist < best) {
        best = dist;
        bestOuter = i;
        bestHole = j;
      }
    }
  }
  const result: Pt[] = [];
  for (let i = 0; i <= bestOuter; i += 1) result.push(out[i]);
  for (let k = 0; k <= holeCw.length; k += 1) {
    result.push(holeCw[(bestHole + k) % holeCw.length]);
  }
  for (let i = bestOuter; i < out.length; i += 1) result.push(out[i]);
  return cleanRing(result);
}

function joinByBridge(left: Pt[], right: Pt[]): Pt[] {
  const a = ensureCcw(left);
  const b = ensureCcw(right);
  let bestA = 0;
  let bestB = 0;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      const dist = (a[i].x - b[j].x) ** 2 + (a[i].y - b[j].y) ** 2;
      if (dist < best) {
        best = dist;
        bestA = i;
        bestB = j;
      }
    }
  }
  const result: Pt[] = [];
  for (let i = 0; i <= bestA; i += 1) result.push(a[i]);
  for (let k = 0; k <= b.length; k += 1) {
    result.push(b[(bestB + k) % b.length]);
  }
  for (let i = bestA; i < a.length; i += 1) result.push(a[i]);
  return cleanRing(result);
}

function pointOnOpenSegment(point: Pt, start: Pt, end: Pt): boolean {
  const cross = (point.x - start.x) * (end.y - start.y) - (point.y - start.y) * (end.x - start.x);
  if (Math.abs(cross) > 0.2) return false;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-6) return false;
  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
  return t > 0.02 && t < 0.98;
}

function splitRingAtVertices(ring: Pt[], vertices: Pt[]): Pt[] {
  const split: Pt[] = [];
  for (let index = 0; index < ring.length; index += 1) {
    const start = ring[index];
    const end = ring[(index + 1) % ring.length];
    split.push(start);
    const mids = vertices
      .filter((point) => pointOnOpenSegment(point, start, end))
      .map((point) => {
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq < 1e-12 ? 0 : ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq;
        return { point, t };
      })
      .sort((left, right) => left.t - right.t);
    for (const mid of mids) split.push(mid.point);
  }
  return cleanRing(split);
}

function mergeDifferencePieces(pieces: Pt[][]): Pt[] {
  const usable = pieces
    .map((piece) => cleanRing(ensureCcw(piece.map(snapPt))))
    .filter((piece) => piece.length >= 3 && ringArea(piece) >= MIN_PIECE_AREA);
  if (usable.length === 0) return [];
  if (usable.length === 1) return usable[0];

  const vertices = usable.flat();
  const split = usable.map((piece) => splitRingAtVertices(piece, vertices));

  const rings = walkRings(boundaryEdges(split))
    .map((ring) => cleanRing(ensureCcw(ring)))
    .filter((ring) => ring.length >= 3 && ringArea(ring) >= MIN_PIECE_AREA)
    .sort((left, right) => ringArea(right) - ringArea(left));
  if (rings.length === 1) return rings[0];
  if (rings.length === 0) {
    let joined = usable[0];
    for (let index = 1; index < usable.length; index += 1) {
      joined = joinByBridge(joined, usable[index]);
    }
    return joined;
  }

  const outer = rings[0];
  const holes = rings.slice(1).filter((ring) => ring.every((point) => pointInRing(point, outer)));
  const leftovers = rings.slice(1).filter((ring) => !ring.every((point) => pointInRing(point, outer)));
  let merged = outer;
  for (const hole of holes) merged = makeKeyhole(merged, hole);
  for (const leftover of leftovers) merged = joinByBridge(merged, leftover);
  return merged;
}

/** Subject minus a convex clipper: keep every fragment that lies outside the clipper. */
function subtractConvex(subject: Pt[], convex: Pt[]): Pt[][] {
  const clip = ensureCcw(cleanRing(convex));
  if (clip.length < 3) return [subject];
  let pending = [ensureCcw(cleanRing(subject))].filter((ring) => ring.length >= 3);
  const outside: Pt[][] = [];
  for (let index = 0; index < clip.length; index += 1) {
    const start = clip[index];
    const end = clip[(index + 1) % clip.length];
    const nextPending: Pt[][] = [];
    for (const piece of pending) {
      const inner = cleanRing(clipByHalfPlane(piece, start, end, true));
      const outer = cleanRing(clipByHalfPlane(piece, start, end, false));
      if (outer.length >= 3 && ringArea(outer) >= MIN_PIECE_AREA) outside.push(ensureCcw(outer));
      if (inner.length >= 3 && ringArea(inner) >= MIN_PIECE_AREA) nextPending.push(ensureCcw(inner));
    }
    pending = nextPending;
  }
  return outside;
}

/** Loser minus winner: keeps the uncovered part, no stacked fills. */
function differenceRings(subject: Pt[], clipper: Pt[]): Pt[][] {
  const subjectCcw = ensureCcw(cleanRing(subject));
  const clipCcw = ensureCcw(cleanRing(clipper));
  if (subjectCcw.length < 3 || clipCcw.length < 3) return [subjectCcw];

  const subjectCovered = subjectCcw.every((point) => pointInRing(point, clipCcw));
  const clipCovered = clipCcw.every((point) => pointInRing(point, subjectCcw));
  if (subjectCovered && !clipCcw.some((point) => pointInRingStrict(point, subjectCcw))) {
    return [];
  }
  if (clipCovered && !subjectCovered) {
    return [makeKeyhole(subjectCcw, clipCcw)];
  }

  const convexParts = isConvexRing(clipCcw) ? [clipCcw] : triangulateRing(clipCcw);
  const parts = convexParts.length > 0 ? convexParts : [ensureCcw(convexHull(clipCcw))];
  let pieces = [subjectCcw];
  for (const part of parts) {
    pieces = pieces.flatMap((piece) => subtractConvex(piece, part));
  }
  return pieces;
}

function collectIntersections(left: readonly Pt[], right: readonly Pt[]): Pt[] {
  const hits: Pt[] = [];
  for (let i = 0; i < left.length; i += 1) {
    const a1 = left[i];
    const a2 = left[(i + 1) % left.length];
    for (let j = 0; j < right.length; j += 1) {
      const hit = segmentIntersection(a1, a2, right[j], right[(j + 1) % right.length]);
      if (hit) hits.push(hit);
    }
  }
  return hits;
}

function ringsOverlap(left: readonly Pt[], right: readonly Pt[]): boolean {
  if (left.some((point) => pointInRingStrict(point, right))) return true;
  if (right.some((point) => pointInRingStrict(point, left))) return true;
  return collectIntersections(left, right).length > 0;
}

function projectToRing(origin: ZoneLatLng, ring: readonly Pt[]): ZoneLatLng[] {
  return ring.map((point) => fromXY(origin, point));
}

/** Simplifies a zone outline without turning it into a 5-point hull. */
export function toDrawableZonePath(
  path: readonly ZoneLatLng[],
  maxVertices = MAX_DRAWABLE_VERTICES
): ZoneLatLng[] {
  const unique = uniquePoints(path);
  if (unique.length < 3) return [...path];
  const origin = centroidOf(unique);
  if (!origin) return [...path];
  let ring = ensureCcw(unique.map((point) => toXY(origin, point)));
  if (ring.length < 3) return [...path];
  const limit = Math.max(3, maxVertices);
  while (ring.length > limit) {
    ring = removeFlattestVertex(ring);
  }
  return projectToRing(origin, ring);
}

export function toAngularZonePath(
  path: readonly ZoneLatLng[],
  maxVertices = MAX_DRAWABLE_VERTICES
): ZoneLatLng[] {
  return toDrawableZonePath(path, maxVertices);
}

function normalizePt(point: Pt): Pt {
  const length = Math.hypot(point.x, point.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: point.x / length, y: point.y / length };
}

/** Pushes a CCW ring slightly outward so the loser recedes without a shared interior. */
function offsetOutward(ring: Pt[], distance: number): Pt[] {
  const poly = ensureCcw(cleanRing(ring));
  if (poly.length < 3) return poly;
  const offset: Pt[] = [];
  for (let index = 0; index < poly.length; index += 1) {
    const previous = poly[(index + poly.length - 1) % poly.length];
    const current = poly[index];
    const next = poly[(index + 1) % poly.length];
    const edge1 = normalizePt({ x: current.x - previous.x, y: current.y - previous.y });
    const edge2 = normalizePt({ x: next.x - current.x, y: next.y - current.y });
    const n1 = { x: edge1.y, y: -edge1.x };
    const n2 = { x: edge2.y, y: -edge2.x };
    const combined = normalizePt({ x: n1.x + n2.x, y: n1.y + n2.y });
    if (combined.x === 0 && combined.y === 0) {
      offset.push({ x: current.x + n1.x * distance, y: current.y + n1.y * distance });
      continue;
    }
    const miter = combined.x * n1.x + combined.y * n1.y;
    const scale = Math.abs(miter) > 0.25 ? distance / miter : distance;
    offset.push({ x: current.x + combined.x * scale, y: current.y + combined.y * scale });
  }
  return offset;
}

function shrinkLoserXY(winner: Pt[], loser: Pt[]): Pt[] {
  const A = ensureCcw(winner);
  const B = ensureCcw(loser);
  if (!ringsOverlap(A, B)) return loser;
  return mergeDifferencePieces(differenceRings(B, offsetOutward(A, 1.5)));
}

/** Loser keeps only the part outside the winner, so the two zones no longer overlap. */
export function shrinkZoneOutsideWinner(
  winner: readonly ZoneLatLng[],
  loser: readonly ZoneLatLng[]
): ZoneLatLng[] {
  if (winner.length < 3 || loser.length < 3) return [...loser];
  const origin = centroidOf([...winner, ...loser]);
  if (!origin) return [...loser];
  const shrunk = shrinkLoserXY(
    winner.map((point) => toXY(origin, point)),
    loser.map((point) => toXY(origin, point))
  );
  if (shrunk.length < 3) return [];
  let reduced = ensureCcw(cleanRing(shrunk));
  while (reduced.length > MAX_DRAWABLE_VERTICES) {
    reduced = removeFlattestVertex(reduced);
  }
  return projectToRing(origin, reduced);
}

function pointStrictlyInside(point: ZoneLatLng, path: readonly ZoneLatLng[]): boolean {
  if (!pointInLatLngPolygon(point, path)) return false;
  for (let index = 0; index < path.length; index += 1) {
    const start = path[index];
    const end = path[(index + 1) % path.length];
    const origin = start;
    if (
      pointOnSegment(toXY(origin, point), toXY(origin, start), toXY(origin, end))
    ) {
      return false;
    }
  }
  return true;
}

export function zonePolygonsOverlap(
  left: readonly ZoneLatLng[],
  right: readonly ZoneLatLng[]
): boolean {
  if (left.length < 3 || right.length < 3) return false;
  if (left.some((point) => pointStrictlyInside(point, right))) return true;
  if (right.some((point) => pointStrictlyInside(point, left))) return true;
  const origin = centroidOf([...left, ...right]);
  if (!origin) return false;
  const leftXY = left.map((point) => toXY(origin, point));
  const rightXY = right.map((point) => toXY(origin, point));
  return (
    leftXY.some((point) => pointInRingStrict(point, rightXY)) ||
    rightXY.some((point) => pointInRingStrict(point, leftXY))
  );
}

function lerpLatLng(start: ZoneLatLng, end: ZoneLatLng, t: number): ZoneLatLng {
  return {
    lat: start.lat + (end.lat - start.lat) * t,
    lng: start.lng + (end.lng - start.lng) * t,
  };
}

function isCoveredByAny(point: ZoneLatLng, covering: readonly (readonly ZoneLatLng[])[]): boolean {
  return covering.some((path) => path.length >= 3 && pointInLatLngPolygon(point, path));
}

/**
 * Outline of a zone with the parts covered by higher zones removed,
 * so the lower border does not show through the zone on top.
 */
export function visibleZoneOutline(
  path: readonly ZoneLatLng[],
  covering: readonly (readonly ZoneLatLng[])[],
  stepsPerEdge = 24
): ZoneLatLng[][] {
  if (path.length < 3) return [];
  const usableCovering = covering.filter((cover) => cover.length >= 3);
  if (usableCovering.length === 0) {
    return [[...path, path[0]]];
  }

  const lines: ZoneLatLng[][] = [];
  const steps = Math.max(4, stepsPerEdge);
  for (let index = 0; index < path.length; index += 1) {
    const start = path[index];
    const end = path[(index + 1) % path.length];
    let bucket: ZoneLatLng[] = [];
    for (let step = 0; step <= steps; step += 1) {
      const point = lerpLatLng(start, end, step / steps);
      if (!isCoveredByAny(point, usableCovering)) {
        const last = bucket[bucket.length - 1];
        if (!last || last.lat !== point.lat || last.lng !== point.lng) bucket.push(point);
        continue;
      }
      if (bucket.length >= 2) lines.push(bucket);
      bucket = [];
    }
    if (bucket.length >= 2) lines.push(bucket);
  }
  return lines;
}

/** Winner stays put; every overlapping zone shrinks away from it. */
export function resolveZoneShapeOverlaps(
  shapes: Record<number, ZoneLatLng[]>,
  winnerZoneIndex: number
): Record<number, ZoneLatLng[]> {
  const winner = shapes[winnerZoneIndex];
  if (!winner || winner.length < 3) return shapes;
  const next: Record<number, ZoneLatLng[]> = { ...shapes, [winnerZoneIndex]: winner };
  for (const [key, path] of Object.entries(shapes)) {
    const zoneIndex = Number(key);
    if (zoneIndex === winnerZoneIndex || path.length < 3) continue;
    if (!zonePolygonsOverlap(winner, path)) {
      next[zoneIndex] = path;
      continue;
    }
    const shrunk = shrinkZoneOutsideWinner(winner, path);
    next[zoneIndex] = shrunk.length >= 3 ? shrunk : [];
  }
  return next;
}

export function prepareDrawableZoneShapes(
  shapes: Record<number, ZoneLatLng[]>
): Record<number, ZoneLatLng[]> {
  const drawable: Record<number, ZoneLatLng[]> = {};
  for (const [key, path] of Object.entries(shapes)) {
    drawable[Number(key)] = toDrawableZonePath(path);
  }
  return drawable;
}

export function angularizeZoneShapes(
  shapes: Record<number, ZoneLatLng[]>
): Record<number, ZoneLatLng[]> {
  return prepareDrawableZoneShapes(shapes);
}
