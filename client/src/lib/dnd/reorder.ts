import type { UniqueIdentifier } from "@dnd-kit/core";

export const clampIndex = (index: number, length: number) => {
  if (!Number.isFinite(index)) return length;
  return Math.max(0, Math.min(index, length));
};

export const reorderItems = <T>(
  items: readonly T[],
  fromIndex: number,
  toIndex: number,
) => {
  const next = [...items];
  const sourceIndex = clampIndex(fromIndex, next.length - 1);
  const [item] = next.splice(sourceIndex, 1);
  if (item === undefined) return next;

  const destinationIndex = clampIndex(toIndex, next.length);
  next.splice(destinationIndex, 0, item);
  return next;
};

export const insertItemsAt = <T>(
  items: readonly T[],
  insertItems: readonly T[],
  index: number,
) => {
  const next = [...items];
  next.splice(clampIndex(index, next.length), 0, ...insertItems);
  return next;
};

export const moveItems = <T>(
  sourceItems: readonly T[],
  destinationItems: readonly T[],
  selectedIndexes: readonly number[],
  destinationIndex: number,
) => {
  const selectedIndexSet = new Set(selectedIndexes);
  const movedItems = sourceItems.filter((_, index) => selectedIndexSet.has(index));
  const remainingSourceItems = sourceItems.filter(
    (_, index) => !selectedIndexSet.has(index),
  );

  return {
    sourceItems: remainingSourceItems,
    destinationItems: insertItemsAt(
      destinationItems,
      movedItems,
      destinationIndex,
    ),
    movedItems,
  };
};

export const uniqueOrderedIds = (
  ids: readonly UniqueIdentifier[],
): UniqueIdentifier[] => {
  const seen = new Set<UniqueIdentifier>();
  const result: UniqueIdentifier[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }

  return result;
};

export const normalizeDestinationIndexAfterRemoval = (
  fromIndex: number,
  toIndex: number,
) => {
  return fromIndex < toIndex ? toIndex - 1 : toIndex;
};
