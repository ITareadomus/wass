import type { Modifier, UniqueIdentifier } from "@dnd-kit/core";
import { parseDndId } from "./ids";
import { DND_CONTAINER_ID_ATTRIBUTE } from "./sensors";
import { isAppDndItem, type DndScope } from "./types";

type RowGeom = {
  staffId: number;
  top: number;
  bottom: number;
  centerY: number;
};

type SnapState = {
  activeId: UniqueIdentifier;
  staffId: number;
};

let snapState: SnapState | null = null;

/** Soglia soft per considerare “entrato” in una riga (solo logica collision, non vincola Y). */
const HOP_THRESHOLD = 0.4;

/** Staff id della riga sotto la card (per collision / insert index). */
export const getAssignedTimelineDragSnapStaffId = (): number | null =>
  snapState?.staffId ?? null;

const measureStaffRows = (
  scope: DndScope,
  type: "timeline" | "summary",
): RowGeom[] => {
  if (typeof document === "undefined") return [];

  const nodes = document.querySelectorAll<HTMLElement>(
    `[${DND_CONTAINER_ID_ATTRIBUTE}]`,
  );
  const rows: RowGeom[] = [];

  nodes.forEach((node) => {
    const id = node.getAttribute(DND_CONTAINER_ID_ATTRIBUTE);
    if (!id) return;
    const parsed = parseDndId(id);
    if (!parsed || parsed.kind !== "container") return;
    if (parsed.scope !== scope) return;
    if (parsed.type !== type) return;
    if (typeof parsed.staffId !== "number") return;

    const rect = node.getBoundingClientRect();
    if (rect.height <= 0) return;

    rows.push({
      staffId: parsed.staffId,
      top: rect.top,
      bottom: rect.bottom,
      centerY: rect.top + rect.height / 2,
    });
  });

  rows.sort((a, b) => a.top - b.top);

  const unique: RowGeom[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.staffId)) continue;
    seen.add(row.staffId);
    unique.push(row);
  }
  return unique;
};

const resolveSnappedStaffId = (
  rows: RowGeom[],
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

  const rows = measureStaffRows(data.scope, data.from.type);
  if (rows.length === 0) return transform;

  if (!snapState || snapState.activeId !== active.id) {
    snapState = {
      activeId: active.id,
      staffId: data.from.staffId,
    };
  }

  const originCenterY = activeNodeRect.top + activeNodeRect.height / 2;
  const rawCenterY = originCenterY + transform.y;

  snapState.staffId = resolveSnappedStaffId(
    rows,
    snapState.staffId,
    rawCenterY,
  );

  // Movimento libero su X e Y
  return transform;
};
