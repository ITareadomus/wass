import {
  type Collision,
  type CollisionDetection,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import type {
  AppDndContainer,
  DndInsertTarget,
  DndScope,
  DndSortableRect,
} from "./types";
import { isAppDndContainer, isAppDndItem } from "./types";
import { summaryContainerDndId, timelineContainerDndId } from "./ids";
import { getAssignedTimelineDragSnapStaffId } from "./modifiers";

type CollisionArgs = Parameters<CollisionDetection>[0];

export type TimelineInsertIndexOptions = {
  pointerX: number;
  itemRects: readonly DndSortableRect[];
};

export type VerticalInsertIndexOptions = {
  pointerY: number;
  itemRects: readonly DndSortableRect[];
};

export const calculateHorizontalInsertIndex = ({
  pointerX,
  itemRects,
}: TimelineInsertIndexOptions) => {
  const orderedRects = [...itemRects].sort((a, b) => a.index - b.index);

  for (let position = 0; position < orderedRects.length; position += 1) {
    const rect = orderedRects[position];
    const midpoint = rect.left + rect.width / 2;
    if (pointerX < midpoint) return position;
  }

  return orderedRects.length;
};

export const calculateVerticalInsertIndex = ({
  pointerY,
  itemRects,
}: VerticalInsertIndexOptions) => {
  const orderedRects = [...itemRects].sort((a, b) => a.index - b.index);

  for (let position = 0; position < orderedRects.length; position += 1) {
    const rect = orderedRects[position];
    const midpoint = rect.top + rect.height / 2;
    if (pointerY < midpoint) return position;
  }

  return orderedRects.length;
};

export const rectContainsPoint = (
  rect: Pick<DndSortableRect, "left" | "right" | "top" | "bottom">,
  point: { x: number; y: number },
) => {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
};

export const buildSortableRects = (
  itemIds: readonly UniqueIdentifier[],
  droppableRects: CollisionArgs["droppableRects"],
) => {
  return itemIds.flatMap((id, index): DndSortableRect[] => {
    const rect = droppableRects.get(id);
    if (!rect) return [];

    return [
      {
        id,
        index,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    ];
  });
};

export const getContainerData = (
  args: CollisionArgs,
  id: UniqueIdentifier,
): AppDndContainer | null => {
  const container = args.droppableContainers.find(
    (droppableContainer) => droppableContainer.id === id,
  );
  const data = container?.data.current;
  return isAppDndContainer(data) ? data : null;
};

const COMPACT_TIMELINE_TASK_MIN_WIDTH_PX = 56;

const getCompactTimelineTaskWidthPx = () => {
  if (typeof window === "undefined") return COMPACT_TIMELINE_TASK_MIN_WIDTH_PX;
  const ppm = Number((window as { timelinePxPerMinute?: number }).timelinePxPerMinute);
  if (Number.isFinite(ppm) && ppm > 0) {
    return Math.max(15 * ppm, COMPACT_TIMELINE_TASK_MIN_WIDTH_PX);
  }
  return COMPACT_TIMELINE_TASK_MIN_WIDTH_PX;
};

type ActiveCardRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
};

/**
 * Rect della card trascinata (non il cursore).
 * In HK timeline l'overlay è 15' allineato a sinistra del rect misurato.
 * Se c'è uno snap riga (saltello), la Y segue la riga snappata — così dopo un
 * hop puoi riordinare in X sulla nuova riga nella stessa gesture.
 */
const getActiveCardRect = (args: CollisionArgs): ActiveCardRect | null => {
  const translated = args.active.rect.current.translated;
  const initial = args.active.rect.current.initial;
  const base = translated ?? initial;
  if (!base) return null;

  const activeData = args.active.data.current;
  const isHkTimelineDrag =
    isAppDndItem(activeData) &&
    activeData.scope === "housekeeping" &&
    activeData.from.type === "timeline";

  // Se il node sorgente è stato alterato, preferisci la larghezza iniziale.
  const measuredWidth =
    base.width > 1 ? base.width : (initial?.width ?? base.width);
  const width = isHkTimelineDrag
    ? Math.min(measuredWidth, getCompactTimelineTaskWidthPx())
    : measuredWidth;
  const height =
    base.height > 1 ? base.height : (initial?.height ?? 40);

  let top = base.top;
  let centerY = base.top + height / 2;

  const snapStaffId = getAssignedTimelineDragSnapStaffId();
  if (
    snapStaffId != null &&
    isAppDndItem(activeData) &&
    (activeData.from.type === "timeline" || activeData.from.type === "summary")
  ) {
    const containerId =
      activeData.from.type === "timeline"
        ? timelineContainerDndId(activeData.scope, snapStaffId)
        : summaryContainerDndId(activeData.scope, snapStaffId);
    const rowRect = args.droppableRects.get(containerId);
    if (rowRect) {
      centerY = rowRect.top + rowRect.height / 2;
      top = centerY - height / 2;
    }
  }

  return {
    left: base.left,
    right: base.left + width,
    top,
    bottom: top + height,
    width,
    height,
    centerX: base.left + width / 2,
    centerY,
  };
};

/**
 * Punto per insert index: in cross-cleaner usa la X del pointer
 * (allineata all'overlay), non active.rect che può essere stale.
 */
const getInsertPoint = (
  args: CollisionArgs,
  sortContainer: SortContainerHit,
) => {
  const card = getActiveCardRect(args);
  const pointer = args.pointerCoordinates;
  const activeData = args.active.data.current;
  const snapStaffId = getAssignedTimelineDragSnapStaffId();

  const isCrossCleaner =
    isAppDndItem(activeData) &&
    (activeData.from.type === "timeline" ||
      activeData.from.type === "summary") &&
    snapStaffId != null &&
    sortContainer.container.type !== "priority" &&
    "staffId" in sortContainer.container &&
    snapStaffId !== activeData.from.staffId;

  if (isCrossCleaner && pointer) {
    return {
      x: pointer.x,
      y: card?.centerY ?? pointer.y,
    };
  }

  if (!card) return pointer ?? null;
  return { x: card.centerX, y: card.centerY };
};

const getActiveCardCenter = (args: CollisionArgs) => {
  const card = getActiveCardRect(args);
  if (!card) return args.pointerCoordinates ?? null;
  return { x: card.centerX, y: card.centerY };
};

const verticalOverlapPx = (
  a: Pick<ActiveCardRect, "top" | "bottom">,
  b: Pick<ActiveCardRect, "top" | "bottom">,
) => Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));

const horizontalOverlapPx = (
  a: Pick<ActiveCardRect, "left" | "right">,
  b: Pick<ActiveCardRect, "left" | "right">,
) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));

/** Cursore (con fallback sulla card): solo remove-zone / priority. */
const getPointerCoordinates = (args: CollisionArgs) =>
  args.pointerCoordinates ?? getActiveCardCenter(args);

export const findTimelineContainerUnderPointer = (
  args: CollisionArgs,
  scope?: DndScope,
) => {
  const card = getActiveCardRect(args);
  if (!card) return null;

  const assignedSource = getAssignedDragSource(args);

  let best: {
    id: UniqueIdentifier;
    container: Extract<AppDndContainer, { type: "timeline" }>;
    rect: NonNullable<ReturnType<CollisionArgs["droppableRects"]["get"]>>;
    score: number;
  } | null = null;

  for (const container of args.droppableContainers) {
    const data = container.data.current;
    if (!isAppDndContainer(data)) continue;
    if (data.type !== "timeline") continue;
    if (scope && data.scope !== scope) continue;

    if (
      assignedSource &&
      !canDropAssignedOnStaff(
        args,
        assignedSource.staffId,
        data.staffId,
        "timeline",
      )
    ) {
      continue;
    }

    const rect = args.droppableRects.get(container.id);
    if (!rect) continue;
    if (horizontalOverlapPx(card, rect) <= 0) continue;

    const overlapY = verticalOverlapPx(card, rect);
    const rowCenterY = rect.top + rect.height / 2;
    const centerDistanceY = Math.abs(card.centerY - rowCenterY);
    if (overlapY <= 0 && centerDistanceY > Math.max(rect.height, card.height)) {
      continue;
    }

    const score = overlapY > 0 ? -overlapY : centerDistanceY;

    if (!best || score < best.score) {
      best = { id: container.id, container: data, rect, score };
    }
  }

  return best
    ? { id: best.id, container: best.container, rect: best.rect }
    : null;
};

export const buildTimelineInsertTarget = (
  args: CollisionArgs,
  options: {
    containerId: UniqueIdentifier;
    container: Extract<AppDndContainer, { type: "timeline" }>;
    itemIds: readonly UniqueIdentifier[];
    isValid?: boolean;
    reason?: string;
  },
): DndInsertTarget | null => {
  const card = getActiveCardRect(args);
  if (!card) return null;

  const itemRects = buildSortableRects(options.itemIds, args.droppableRects);
  return {
    containerId: options.containerId,
    container: options.container,
    index: calculateHorizontalInsertIndex({
      pointerX: card.centerX,
      itemRects,
    }),
    isValid: options.isValid ?? true,
    reason: options.reason,
  };
};

type SortContainerHit = {
  id: UniqueIdentifier;
  container: Extract<AppDndContainer, { type: "timeline" | "summary" }>;
  droppableContainer: CollisionArgs["droppableContainers"][number];
};

const findContainerUnderPointer = (
  args: CollisionArgs,
  type: AppDndContainer["type"],
): Collision | null => {
  const point = getPointerCoordinates(args);
  if (!point) return null;

  for (const container of args.droppableContainers) {
    const data = container.data.current;
    if (!isAppDndContainer(data) || data.type !== type) continue;

    const rect = args.droppableRects.get(container.id);
    if (!rect) continue;

    if (rectContainsPoint(rect, point)) {
      return {
        id: container.id,
        data: {
          droppableContainer: container,
          value: 1,
        },
      };
    }
  }

  return null;
};

/** Ordine verticale delle righe staff (timeline o summary). */
const getOrderedStaffIdsByRow = (
  args: CollisionArgs,
  type: "timeline" | "summary",
): number[] => {
  const rows: { staffId: number; top: number }[] = [];

  for (const droppableContainer of args.droppableContainers) {
    const data = droppableContainer.data.current;
    if (!isAppDndContainer(data) || data.type !== type) continue;
    const rect = args.droppableRects.get(droppableContainer.id);
    if (!rect) continue;
    rows.push({ staffId: data.staffId, top: rect.top });
  }

  rows.sort((a, b) => a.top - b.top);

  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.staffId)) continue;
    seen.add(row.staffId);
    ordered.push(row.staffId);
  }
  return ordered;
};

/**
 * Con saltelli riga-per-riga si può raggiungere qualsiasi cleaner della lista
 * (il modifier limita il passaggio a un hop alla volta).
 */
const canDropAssignedOnStaff = (
  args: CollisionArgs,
  _sourceStaffId: number,
  targetStaffId: number,
  type: "timeline" | "summary",
) => {
  const ordered = getOrderedStaffIdsByRow(args, type);
  return ordered.includes(targetStaffId);
};

const getAssignedDragSource = (
  args: CollisionArgs,
): { staffId: number; type: "timeline" | "summary" } | null => {
  const data = args.active.data.current;
  if (!isAppDndItem(data)) return null;
  if (data.from.type !== "timeline" && data.from.type !== "summary") return null;
  return { staffId: data.from.staffId, type: data.from.type };
};

const findSortContainerUnderPointer = (
  args: CollisionArgs,
): SortContainerHit | null => {
  const card = getActiveCardRect(args);
  if (!card) return null;

  const assignedSource = getAssignedDragSource(args);
  const snapStaffId = getAssignedTimelineDragSnapStaffId();

  // Dopo un saltello: forza la riga snappata così l'insert index X
  // lavora sulla giornata del nuovo cleaner nella stessa gesture.
  if (snapStaffId != null && assignedSource) {
    for (const droppableContainer of args.droppableContainers) {
      const data = droppableContainer.data.current;
      if (!isAppDndContainer(data)) continue;
      if (data.type !== assignedSource.type) continue;
      if (data.staffId !== snapStaffId) continue;
      return {
        id: droppableContainer.id,
        container: data,
        droppableContainer,
      };
    }
  }

  const candidates: { hit: SortContainerHit; score: number }[] = [];

  for (const droppableContainer of args.droppableContainers) {
    const data = droppableContainer.data.current;
    if (!isAppDndContainer(data)) continue;
    if (data.type !== "timeline" && data.type !== "summary") continue;

    const rect = args.droppableRects.get(droppableContainer.id);
    if (!rect) continue;

    const hit: SortContainerHit = {
      id: droppableContainer.id,
      container: data,
      droppableContainer,
    };

    if (
      assignedSource &&
      !canDropAssignedOnStaff(
        args,
        assignedSource.staffId,
        data.staffId,
        data.type,
      )
    ) {
      continue;
    }

    if (data.type === "summary") {
      const hitsSummary =
        rectContainsPoint(rect, { x: card.centerX, y: card.centerY }) ||
        (horizontalOverlapPx(card, rect) > 0 &&
          verticalOverlapPx(card, rect) > 0);
      if (hitsSummary) {
        candidates.push({ hit, score: -1000 });
      }
      continue;
    }

    if (horizontalOverlapPx(card, rect) <= 0) continue;

    const overlapY = verticalOverlapPx(card, rect);
    const rowCenterY = rect.top + rect.height / 2;
    const centerDistanceY = Math.abs(card.centerY - rowCenterY);
    if (overlapY <= 0 && centerDistanceY > Math.max(rect.height, card.height)) {
      continue;
    }

    candidates.push({
      hit,
      score: overlapY > 0 ? -overlapY : centerDistanceY,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.hit ?? null;
};

const itemBelongsToSortContainer = (
  itemData: unknown,
  container: Extract<AppDndContainer, { type: "timeline" | "summary" }>,
) => {
  if (!isAppDndItem(itemData)) return false;
  if (itemData.scope !== container.scope) return false;
  const from = itemData.from;
  if (from.type === "priority") return false;
  if (from.type !== container.type) return false;
  return from.staffId === container.staffId;
};

const sortContainerCollision = (sortContainer: SortContainerHit): Collision => ({
  id: sortContainer.id,
  data: {
    droppableContainer: sortContainer.droppableContainer,
    value: 1,
  },
});

const sortDroppablesByItemIndex = (
  containers: CollisionArgs["droppableContainers"],
) =>
  [...containers].sort((a, b) => {
    const aIndex = isAppDndItem(a.data.current) ? a.data.current.index : 0;
    const bIndex = isAppDndItem(b.data.current) ? b.data.current.index : 0;
    return aIndex - bIndex;
  });

/**
 * Pick the sortable `over` item from pointer vs item midpoints.
 * Crossing an item's center moves the insert slot (and sortable transforms)
 * left or right — unlike closestCenter, which sticks until the next center.
 */
const findMidpointSortableCollision = (
  args: CollisionArgs,
  sortContainer: SortContainerHit,
): Collision | null => {
  const point = getInsertPoint(args, sortContainer);
  if (!point) return null;

  const allItems = sortDroppablesByItemIndex(
    args.droppableContainers.filter((container) =>
      itemBelongsToSortContainer(
        container.data.current,
        sortContainer.container,
      ),
    ),
  );

  // Riga vuota (es. cleaner senza task): insert a 0 sul container.
  if (allItems.length === 0) {
    return {
      id: sortContainer.id,
      data: {
        droppableContainer: sortContainer.droppableContainer,
        value: 1,
        insertIndex: 0,
        target: {
          containerId: sortContainer.id,
          container: sortContainer.container,
          index: 0,
          isValid: true,
        } satisfies DndInsertTarget,
      },
    };
  }

  const otherItems = allItems.filter(
    (container) => container.id !== args.active.id,
  );
  const midpointItems = otherItems.length > 0 ? otherItems : allItems;
  const itemRects = buildSortableRects(
    midpointItems.map((container) => container.id),
    args.droppableRects,
  );

  if (itemRects.length === 0) {
    return {
      id: sortContainer.id,
      data: {
        droppableContainer: sortContainer.droppableContainer,
        value: 1,
        insertIndex: 0,
        target: {
          containerId: sortContainer.id,
          container: sortContainer.container,
          index: 0,
          isValid: true,
        } satisfies DndInsertTarget,
      },
    };
  }

  const insertIndex =
    sortContainer.container.type === "summary"
      ? calculateVerticalInsertIndex({
          pointerY: point.y,
          itemRects,
        })
      : calculateHorizontalInsertIndex({
          pointerX: point.x,
          itemRects,
        });

  // Sortable `over` uses an item id; appending maps to the last item.
  // Su riga diversa dalla sorgente l'active non è nel SortableContext locale:
  // restituiamo comunque target.insertIndex per il drop + UI spacer.
  const overIndex = Math.min(insertIndex, allItems.length - 1);
  const overContainer = allItems[overIndex];
  if (!overContainer || overContainer.id === args.active.id) {
    return {
      id: sortContainer.id,
      data: {
        droppableContainer: sortContainer.droppableContainer,
        value: 1,
        insertIndex,
        target: {
          containerId: sortContainer.id,
          container: sortContainer.container,
          index: insertIndex,
          isValid: true,
        } satisfies DndInsertTarget,
      },
    };
  }

  return {
    id: overContainer.id,
    data: {
      droppableContainer: overContainer,
      value: 1,
      // Final slot among the list with the active item removed (0..n).
      insertIndex,
      target: {
        containerId: sortContainer.id,
        container: sortContainer.container,
        index: insertIndex,
        isValid: true,
      } satisfies DndInsertTarget,
    },
  };
};

export const timelineFirstCollisionDetection: CollisionDetection = (args) => {
  const removeZone = findContainerUnderPointer(args, "remove-zone");
  if (removeZone) {
    return [removeZone];
  }

  const priorityContainer = findContainerUnderPointer(args, "priority");
  if (priorityContainer) {
    return [priorityContainer];
  }

  const sortContainer = findSortContainerUnderPointer(args);

  if (sortContainer) {
    const midpointCollision = findMidpointSortableCollision(
      args,
      sortContainer,
    );
    if (midpointCollision) {
      return [midpointCollision];
    }

    return [sortContainerCollision(sortContainer)];
  }

  return [];
};
