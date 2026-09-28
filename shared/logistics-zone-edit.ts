export type ZoneLatLng = { lat: number; lng: number };

export type ZoneEditableShape = {
  zoneIndex: number;
  path: readonly ZoneLatLng[];
};

function parseValidLatLng(
  lat: number | null | undefined,
  lng: number | null | undefined
): ZoneLatLng | null {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  if (parsedLat === 0 && parsedLng === 0) return null;
  if (parsedLat < -90 || parsedLat > 90 || parsedLng < -180 || parsedLng > 180) return null;
  return { lat: parsedLat, lng: parsedLng };
}

/** Ray-casting point-in-polygon on WGS84 vertices. */
export function pointInLatLngPolygon(point: ZoneLatLng, path: readonly ZoneLatLng[]): boolean {
  if (path.length < 3) return false;
  let inside = false;
  for (let index = 0, prev = path.length - 1; index < path.length; prev = index, index += 1) {
    const a = path[index];
    const b = path[prev];
    const intersects =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat + 1e-12) + a.lng;
    if (intersects) inside = !inside;
  }
  return inside;
}

/**
 * Assigns each task to a zone from the drawn polygons.
 * Last-edited zone wins on overlap; points outside every polygon are unassigned (null).
 * Tasks without coordinates keep the previous zone because they cannot be drawn.
 */
export function assignTasksToZonePolygons<
  T extends { taskId: number; lat: number | null; lng: number | null },
>(
  tasks: readonly T[],
  previousZoneByTaskId: ReadonlyMap<number, number>,
  shapes: readonly ZoneEditableShape[],
  preferredZoneIndex?: number
): Map<number, number | null> {
  const assigned = new Map<number, number | null>();
  const usableShapes = shapes.filter((shape) => shape.path.length >= 3);

  for (const task of tasks) {
    const previous = previousZoneByTaskId.get(task.taskId);
    const fallback = previous ?? usableShapes[0]?.zoneIndex ?? 0;
    const point = parseValidLatLng(task.lat, task.lng);
    if (!point) {
      assigned.set(task.taskId, fallback);
      continue;
    }

    const containing = usableShapes
      .filter((shape) => pointInLatLngPolygon(point, shape.path))
      .map((shape) => shape.zoneIndex);

    if (preferredZoneIndex != null && containing.includes(preferredZoneIndex)) {
      assigned.set(task.taskId, preferredZoneIndex);
      continue;
    }
    if (previous != null && containing.includes(previous)) {
      assigned.set(task.taskId, previous);
      continue;
    }
    if (containing.length === 1) {
      assigned.set(task.taskId, containing[0]);
      continue;
    }
    if (containing.length > 1) {
      assigned.set(task.taskId, containing[0]);
      continue;
    }
    assigned.set(task.taskId, null);
  }

  return assigned;
}
