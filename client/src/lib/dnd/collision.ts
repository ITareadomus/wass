import {
  closestCenter,
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

export const findTimelineContainerUnderPointer = (
  args: CollisionArgs,
  scope?: DndScope,
) => {
  const point = args.pointerCoordinates;
  if (!point) return null;

  for (const container of args.droppableContainers) {
    const data = container.data.current;
    if (!isAppDndContainer(data)) continue;
    if (data.type !== "timeline") continue;
    if (scope && data.scope !== scope) continue;

    const rect = args.droppableRects.get(container.id);
    if (!rect) continue;

    if (rectContainsPoint(rect, point)) {
      return {
        id: container.id,
        container: data,
        rect,
      };
    }
  }

  return null;
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
  const point = args.pointerCoordinates;
  if (!point) return null;

  const itemRects = buildSortableRects(options.itemIds, args.droppableRects);
  return {
    containerId: options.containerId,
    container: options.container,
    index: calculateHorizontalInsertIndex({
      pointerX: point.x,
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

const TIMELINE_ROW_HIT_BLEED_Y = 10;

const getCollisionPointer = (args: CollisionArgs) => {
  if (args.pointerCoordinates) {
    return args.pointerCoordinates;
  }

  const translated = args.active.rect.current.translated;
  if (translated) {
    return {
      x: translated.left + translated.width / 2,
      y: translated.top + translated.height / 2,
    };
  }

  const initial = args.active.rect.current.initial;
  if (initial) {
    return {
      x: initial.left + initial.width / 2,
      y: initial.top + initial.height / 2,
    };
  }

  return null;
};

const findContainerUnderPointer = (
  args: CollisionArgs,
  type: AppDndContainer["type"],
): Collision | null => {
  const point = getCollisionPointer(args);
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

const findSortContainerUnderPointer = (
  args: CollisionArgs,
): SortContainerHit | null => {
  const point = getCollisionPointer(args);
  if (!point) return null;

  let bestTimelineHit: SortContainerHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

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

    if (data.type === "summary") {
      if (rectContainsPoint(rect, point)) {
        return hit;
      }
      continue;
    }

    const pointerInsideHorizontalBounds =
      point.x >= rect.left && point.x <= rect.right;

    if (!pointerInsideHorizontalBounds) continue;

    const distanceY =
      point.y < rect.top
        ? rect.top - point.y
        : point.y > rect.bottom
          ? point.y - rect.bottom
          : 0;

    if (distanceY > TIMELINE_ROW_HIT_BLEED_Y) continue;

    const centerDistance = Math.abs(
      point.y - (rect.top + rect.height / 2),
    );

    if (centerDistance < bestDistance) {
      bestDistance = centerDistance;
      bestTimelineHit = hit;
    }
  }

  return bestTimelineHit;
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
    const itemContainers = args.droppableContainers.filter((container) => {
      if (container.id === args.active.id) return false;

      return itemBelongsToSortContainer(
        container.data.current,
        sortContainer.container,
      );
    });

    if (itemContainers.length > 0) {
      const itemCollisions = closestCenter({
        ...args,
        droppableContainers: itemContainers,
      }).filter((collision) => collision.id !== args.active.id);

      if (itemCollisions.length > 0) {
        return itemCollisions;
      }
    }

    return [sortContainerCollision(sortContainer)];
  }

  return [];
};
