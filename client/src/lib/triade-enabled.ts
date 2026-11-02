import { useSyncExternalStore } from "react";

let enabled = true;
let loaded = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

async function load() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await fetch("/api/settings", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      });
      const data = response.ok ? await response.json() : null;
      enabled = data?.triade_enabled !== false;
    } catch {
      enabled = true;
    } finally {
      loaded = true;
      inflight = null;
      emit();
    }
  })();
  return inflight;
}

export function setTriadeEnabledCache(value: boolean) {
  enabled = value;
  loaded = true;
  emit();
}

export function useTriadeEnabled(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      if (!loaded) void load();
      return () => listeners.delete(onChange);
    },
    () => enabled,
    () => true
  );
}
