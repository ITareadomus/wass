import {
  closestCenter,
  pointerWithin,
  rectIntersection,
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

const findContainerCollision = (
  args: CollisionArgs,
  collisions: Collision[],
  type: AppDndContainer["type"],
) => {
  return collisions.find((collision) => {
    const data = getContainerData(args, collision.id);
    return data?.type === type;
  });
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
  const point = args.pointerCoordinates;
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
  const point = args.pointerCoordinates;
  if (!point) return null;

  for (const droppableContainer of args.droppableContainers) {
    const data = droppableContainer.data.current;
    if (!isAppDndContainer(data)) continue;
    if (data.type !== "timeline" && data.type !== "summary") continue;

    const rect = args.droppableRects.get(droppableContainer.id);
    if (!rect) continue;

    if (rectContainsPoint(rect, point)) {
      return {
        id: droppableContainer.id,
        container: data,
        droppableContainer,
      };
    }
  }

  return null;
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

export const timelineFirstCollisionDetection: CollisionDetection = (args) => {
  const removeZoneUnderPointer = findContainerUnderPointer(
    args,
    "remove-zone",
  );

  if (removeZoneUnderPointer) {
    return [removeZoneUnderPointer];
  }

  const pointerCollisions = pointerWithin(args);
  const removeZoneCollision = findContainerCollision(
    args,
    pointerCollisions,
    "remove-zone",
  );

  if (removeZoneCollision) {
    return [removeZoneCollision];
  }

  // Riordino (same-cleaner) e inserimento cross-cleaner usano entrambi
  // closestCenter: l'inserimento segue il centro dell'elemento trascinato.
  const sortContainer = findSortContainerUnderPointer(args);
  if (sortContainer) {
    const itemContainers = args.droppableContainers.filter((container) =>
      itemBelongsToSortContainer(container.data.current, sortContainer.container),
    );

    if (itemContainers.length > 0) {
      const itemCollisions = closestCenter({
        ...args,
        droppableContainers: itemContainers,
      });

      if (itemCollisions.length > 0) {
        return itemCollisions;
      }
    }

    return [
      {
        id: sortContainer.id,
        data: {
          droppableContainer: sortContainer.droppableContainer,
          value: 1,
        },
      },
    ];
  }

  const itemCollision = pointerCollisions.find((collision) => {
    const droppableContainer = args.droppableContainers.find(
      (container) => container.id === collision.id,
    );
    return isAppDndItem(droppableContainer?.data.current);
  });

  if (itemCollision) {
    return [itemCollision];
  }

  const timelineCollision = findContainerCollision(
    args,
    pointerCollisions,
    "timeline",
  );

  if (timelineCollision) {
    return [timelineCollision];
  }

  if (pointerCollisions.length > 0) {
    return pointerCollisions;
  }

  const intersectingCollisions = rectIntersection(args);
  if (intersectingCollisions.length > 0) {
    return intersectingCollisions;
  }

  return closestCenter(args);
};
