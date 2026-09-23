import { runLogisticsProgramPoll } from "@/lib/logistics-program-poll";

const PROGRAM_POLL_INTERVAL_MS = 15000;

const listeners = new Set<() => void>();
let timer: number | null = null;
let visibilityBound = false;

function tick() {
  if (document.visibilityState !== "visible") return;
  // Prima parte housekeeping, e nello stesso giro parte subito la logistica.
  for (const listener of [...listeners]) listener();
  runLogisticsProgramPoll();
}

function onVisibility() {
  if (document.visibilityState === "visible") tick();
}

/** Un solo orologio per la sessione. Il primo avvio restituisce true. */
export function ensureProgramPollClock(): boolean {
  if (timer != null) return false;
  timer = window.setInterval(tick, PROGRAM_POLL_INTERVAL_MS);
  if (!visibilityBound) {
    visibilityBound = true;
    document.addEventListener("visibilitychange", onVisibility);
  }
  return true;
}

export function subscribeProgramPoll(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fa partire subito housekeeping e logistica nello stesso giro. */
export function flushProgramPollTick() {
  tick();
}
