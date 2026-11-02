import { useSyncExternalStore } from "react";
import type { CleanerTriadeLevel } from "@/components/triad-mark";

type RequestItem = {
  id: number;
  operationId: number | null;
};

type CacheValue = CleanerTriadeLevel | null;

type TaskTriadeSnapshot = {
  triade: CacheValue;
  customerTriade: CacheValue;
};

const cache = new Map<string, TaskTriadeSnapshot>();
const listeners = new Map<string, Set<() => void>>();
const pending = new Map<string, RequestItem>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function cacheKey(id: number, operationId: number | null) {
  return `${id}:${operationId ?? ""}`;
}

function emit(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

async function flush() {
  const batch = [...pending.values()];
  pending.clear();
  if (batch.length === 0) return;

  const apply = (
    rows: Array<{
      id?: number;
      operation_id?: number | null;
      triade?: CacheValue;
      customer_triade?: CacheValue;
    }>
  ) => {
    const byKey = new Map<string, TaskTriadeSnapshot>();
    for (const row of rows) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      const operationId = row.operation_id == null || row.operation_id === undefined
        ? null
        : Number(row.operation_id);
      byKey.set(cacheKey(id, Number.isFinite(operationId as number) ? (operationId as number) : null), {
        triade: row.triade ?? null,
        customerTriade: row.customer_triade ?? null,
      });
    }
    for (const item of batch) {
      const key = cacheKey(item.id, item.operationId);
      cache.set(
        key,
        byKey.get(key) ?? { triade: null, customerTriade: null }
      );
      emit(key);
    }
  };

  try {
    const response = await fetch("/api/triade/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tasks: batch.map((item) => ({
          id: item.id,
          operation_id: item.operationId,
        })),
      }),
    });
    const payload = response.ok ? await response.json() : { results: [] };
    apply(Array.isArray(payload?.results) ? payload.results : []);
  } catch {
    apply([]);
  }
}

/** Svuota la cache e fa rileggere i livelli al prossimo render, come un ricalcolo travel time. */
export function invalidateTaskTriade() {
  const keys = new Set<string>([...cache.keys(), ...listeners.keys()]);
  cache.clear();
  pending.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  for (const key of keys) emit(key);
}

if (typeof window !== "undefined") {
  window.addEventListener("refresh-assignments", () => invalidateTaskTriade());
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 40);
}

function readOperationId(task: any): number | null {
  const raw = task?.operation_id;
  if (raw == null || raw === "") return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

/** undefined finché ADAM non ha risposto. Con enabled=false non legge e non mostra nulla. */
export function useTaskTriade(task: any, enabled = true): TaskTriadeSnapshot | undefined {
  const id = Number(task?.task_id ?? task?.id);
  const operationId = readOperationId(task);
  const valid = enabled && Number.isFinite(id) && id > 0;
  const key = valid ? cacheKey(id, operationId) : "";

  return useSyncExternalStore(
    (onStoreChange) => {
      if (!valid) return () => {};
      let set = listeners.get(key);
      if (!set) {
        set = new Set();
        listeners.set(key, set);
      }
      set.add(onStoreChange);
      if (!cache.has(key) && !pending.has(key)) {
        pending.set(key, { id, operationId });
        scheduleFlush();
      }
      return () => {
        set?.delete(onStoreChange);
      };
    },
    () => {
      if (!valid || !cache.has(key)) return undefined;
      return cache.get(key);
    },
    () => undefined
  );
}
