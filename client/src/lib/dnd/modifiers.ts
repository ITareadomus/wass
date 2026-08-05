import type { Modifier, UniqueIdentifier } from "@dnd-kit/core";
import { parseDndId } from "./ids";
import { DND_CONTAINER_ID_ATTRIBUTE } from "./sensors";
import { isAppDndItem, type DndScope } from "./types";

type ContainerGeom = {
  staffId: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
  centerX: number;
  centerY: number;
};

type SnapState = {
  activeId: UniqueIdentifier;
  staffId: number;
};

let snapState: SnapState | null = null;

/** Soglia soft per considerare “entrato” in un container vicino. */
const HOP_THRESHOLD = 0.4;

/** Staff id della riga/colonna sotto la card (per collision / insert index). */
export const getAssignedTimelineDragSnapStaffId = (): number | null =>
  snapState?.staffId ?? null;

const measureStaffContainers = (
  scope: DndScope,
  type: "timeline" | "summary",
): ContainerGeom[] => {
  if (typeof document === "undefined") return [];

  const nodes = document.querySelectorAll<HTMLElement>(
    `[${DND_CONTAINER_ID_ATTRIBUTE}]`,
  );
  const containers: ContainerGeom[] = [];

  nodes.forEach((node) => {
    const id = node.getAttribute(DND_CONTAINER_ID_ATTRIBUTE);
    if (!id) return;
    const parsed = parseDndId(id);
    if (!parsed || parsed.kind !== "container") return;
    if (parsed.scope !== scope) return;
    if (parsed.type !== type) return;
    if (typeof parsed.staffId !== "number") return;

    const rect = node.getBoundingClientRect();
    if (rect.height <= 0 || rect.width <= 0) return;

    containers.push({
      staffId: parsed.staffId,
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
    });
  });

  containers.sort((a, b) => a.top - b.top || a.left - b.left);

  const unique: ContainerGeom[] = [];
  const seen = new Set<number>();
  for (const container of containers) {
    if (seen.has(container.staffId)) continue;
    seen.add(container.staffId);
    unique.push(container);
  }
  return unique;
};

/** Timeline: hop solo sull'asse Y tra righe orizzontali. */
const resolveSnappedStaffIdByY = (
  rows: ContainerGeom[],
  currentStaffId: number,
  rawCenterY: number,
): number => {
  let idx = rows.findIndex((row) => row.staffId === currentStaffId);
  if (idx < 0) idx = 0;

  let guard = 0;
  while (guard < rows.length) {
    guard += 1;
    const current = rows[idx];
    if (!current) break;

    const next = rows[idx + 1];
    const prev = rows[idx - 1];

    if (next) {
      const span = next.centerY - current.centerY;
      if (span > 0) {
        const t = (rawCenterY - current.centerY) / span;
        if (t >= HOP_THRESHOLD) {
          idx += 1;
          continue;
        }
      }
    }

    if (prev) {
      const span = current.centerY - prev.centerY;
      if (span > 0) {
        const t = (current.centerY - rawCenterY) / span;
        if (t >= HOP_THRESHOLD) {
          idx -= 1;
          continue;
        }
      }
    }

    break;
  }

  return rows[idx]?.staffId ?? currentStaffId;
};

/**
 * Summary: griglia 3 colonne — hop 2D verso il vicino la cui direzione
 * proietta oltre la soglia (stesso schema della timeline, in piano XY).
 */
const resolveSnappedStaffIdByNearest2D = (
  containers: ContainerGeom[],
  currentStaffId: number,
  rawCenterX: number,
  rawCenterY: number,
): number => {
  if (containers.length === 0) return currentStaffId;

  let currentId = containers.some((c) => c.staffId === currentStaffId)
    ? currentStaffId
    : containers[0].staffId;

  let guard = 0;
  while (guard < containers.length) {
    guard += 1;
    const current = containers.find((c) => c.staffId === currentId);
    if (!current) break;

    // Preferisci il container che contiene il punto (cambio colonna immediato).
    const containing = containers.find(
      (c) =>
        rawCenterX >= c.left &&
        rawCenterX <= c.right &&
        rawCenterY >= c.top &&
        rawCenterY <= c.bottom,
    );
    if (containing && containing.staffId !== currentId) {
      currentId = containing.staffId;
      continue;
    }
    if (containing) break;

    let bestHop: { staffId: number; t: number } | null = null;
    for (const candidate of containers) {
      if (candidate.staffId === currentId) continue;
      const dx = candidate.centerX - current.centerX;
      const dy = candidate.centerY - current.centerY;
      const distSq = dx * dx + dy * dy;
      if (distSq <= 0) continue;

      const px = rawCenterX - current.centerX;
      const py = rawCenterY - current.centerY;
      const t = (px * dx + py * dy) / distSq;
      if (t < HOP_THRESHOLD) continue;
      if (!bestHop || t > bestHop.t) {
        bestHop = { staffId: candidate.staffId, t };
      }
    }

    if (!bestHop) break;
    currentId = bestHop.staffId;
  }

  return currentId;
};

/**
 * DnD per task già assegnati (timeline / summary):
 * - X e Y libere (nessun lock di asse sul transform)
 * - aggiorna solo lo “snap staff” logico per collision / sequenza
 *
 * Non applica vincoli a drag da priority.
 */
export const constrainAssignedTimelineDragModifier: Modifier = ({
  transform,
  active,
  activeNodeRect,
}) => {
  if (!active) {
    snapState = null;
    return transform;
  }

  const data = active.data.current;
  if (!isAppDndItem(data)) return transform;
  if (data.from.type !== "timeline" && data.from.type !== "summary") {
    return transform;
  }
  if (!activeNodeRect) return transform;

  const containers = measureStaffContainers(data.scope, data.from.type);
  if (containers.length === 0) return transform;

  if (!snapState || snapState.activeId !== active.id) {
    snapState = {
      activeId: active.id,
      staffId: data.from.staffId,
    };
  }

  const originCenterX = activeNodeRect.left + activeNodeRect.width / 2;
  const originCenterY = activeNodeRect.top + activeNodeRect.height / 2;
  const rawCenterX = originCenterX + transform.x;
  const rawCenterY = originCenterY + transform.y;

  snapState.staffId =
    data.from.type === "summary"
      ? resolveSnappedStaffIdByNearest2D(
          containers,
          snapState.staffId,
          rawCenterX,
          rawCenterY,
        )
      : resolveSnappedStaffIdByY(containers, snapState.staffId, rawCenterY);

  // Movimento libero su X e Y
  return transform;
};
