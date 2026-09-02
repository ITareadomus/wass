import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Coerce cleaner/driver ids from API payloads so `"42"` and `42` compare equal. */
export function toEntityId(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function sameEntityId(a: unknown, b: unknown): boolean {
  const left = toEntityId(a);
  const right = toEntityId(b);
  return left !== null && left === right;
}

export function entityIdSet(values: Iterable<unknown>): Set<number> {
  const ids = new Set<number>();
  for (const value of values) {
    const id = toEntityId(value);
    if (id !== null) ids.add(id);
  }
  return ids;
}

export function entityIdSetHas(set: Set<number>, value: unknown): boolean {
  const id = toEntityId(value);
  return id !== null && set.has(id);
}
