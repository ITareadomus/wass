import { useSyncExternalStore } from "react";
import type { CleanerTriadeLevel } from "@/components/triad-mark";

export type DayTriadeSnapshot = {
  levels: CleanerTriadeLevel[];
  overrides: Record<number, number>;
  ready: boolean;
};

const EMPTY: DayTriadeSnapshot = { levels: [], overrides: {}, ready: false };
const snapshots = new Map<string, DayTriadeSnapshot>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();

function emit(workDate: string) {
  if (!snapshots.has(workDate) && (listeners.get(workDate)?.size ?? 0) > 0) {
    void load(workDate);
  }
  listeners.get(workDate)?.forEach((listener) => listener());
}

function write(workDate: string, snapshot: DayTriadeSnapshot) {
  snapshots.set(workDate, snapshot);
  emit(workDate);
}

async function load(workDate: string) {
  const existing = inflight.get(workDate);
  if (existing) return existing;
  const request = (async () => {
    try {
      const response = await fetch(`/api/triade/day-overrides?date=${encodeURIComponent(workDate)}`);
      const payload = response.ok ? await response.json() : null;
      const levels = Array.isArray(payload?.levels) ? payload.levels : [];
      const overrides: Record<number, number> = {};
      for (const row of Array.isArray(payload?.overrides) ? payload.overrides : []) {
        const taskId = Number(row?.task_id);
        const weight = Number(row?.weight);
        if (!Number.isFinite(taskId) || taskId <= 0) continue;
        if (!Number.isInteger(weight) || weight < 1) continue;
        overrides[taskId] = weight;
      }
      write(workDate, { levels, overrides, ready: true });
    } catch {
      write(workDate, { levels: [], overrides: {}, ready: true });
    } finally {
      inflight.delete(workDate);
    }
  })();
  inflight.set(workDate, request);
  return request;
}

export function invalidateDayTriade(workDate?: string) {
  const dates = workDate ? [workDate] : [...snapshots.keys(), ...listeners.keys()];
  for (const date of new Set(dates)) {
    snapshots.delete(date);
    inflight.delete(date);
    emit(date);
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("refresh-assignments", () => invalidateDayTriade());
}

export function useDayTriade(workDate: string, enabled: boolean): DayTriadeSnapshot {
  const active = enabled && /^\d{4}-\d{2}-\d{2}$/.test(workDate);
  return useSyncExternalStore(
    (onStoreChange) => {
      if (!active) return () => {};
      let set = listeners.get(workDate);
      if (!set) {
        set = new Set();
        listeners.set(workDate, set);
      }
      set.add(onStoreChange);
      if (!snapshots.has(workDate)) void load(workDate);
      return () => {
        set?.delete(onStoreChange);
      };
    },
    () => (active ? snapshots.get(workDate) ?? EMPTY : EMPTY),
    () => EMPTY
  );
}

export async function saveDayTriadeOverride(
  workDate: string,
  taskId: number,
  weight: number | null
): Promise<void> {
  const response = await fetch("/api/triade/day-overrides", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: workDate, task_id: taskId, weight }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new Error(payload?.message || payload?.error || "Impossibile aggiornare il livello");
  }
  const current = snapshots.get(workDate) ?? { levels: [], overrides: {}, ready: true };
  const overrides = { ...current.overrides };
  if (weight == null) delete overrides[taskId];
  else overrides[taskId] = weight;
  write(workDate, { ...current, overrides, ready: true });
}
