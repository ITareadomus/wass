import { format } from "date-fns";
import { isWorkDateHistoricallyLocked } from "@shared/work-date-access";
import type { LogisticsAssignedSyncNotice } from "@shared/logistics-assigned-sync-diff";

export type LogisticsProgramFingerprint = {
  count: number;
  max_updated_at_unix: number | null;
  signature_xor: number | null;
  signature_sum: string | number | null;
};

type LogisticsProgramPollBinding = {
  getWorkDate: () => string;
  isBlocked: () => boolean;
  onSynced: (workDate: string, notice: LogisticsAssignedSyncNotice | null) => void | Promise<void>;
  onError: (message: string) => void;
};

let getBinding: (() => LogisticsProgramPollBinding) | null = null;
let baseline: LogisticsProgramFingerprint | null = null;
let baselineDate: string | null = null;
let pending = false;
let syncing = false;
let inFlight = false;
let catchupDoneForDate: string | null = null;

function fingerprintsDiffer(a: LogisticsProgramFingerprint, b: LogisticsProgramFingerprint): boolean {
  return (
    a.count !== b.count ||
    a.max_updated_at_unix !== b.max_updated_at_unix ||
    a.signature_xor !== b.signature_xor ||
    String(a.signature_sum ?? "") !== String(b.signature_sum ?? "")
  );
}

function currentUsername(): string {
  try {
    const raw = localStorage.getItem("user");
    if (raw) {
      const user = JSON.parse(raw);
      return user.username || "unknown";
    }
  } catch {
    /* ignore */
  }
  return "unknown";
}

function parseWorkDate(workDate: string): Date {
  const [year, month, day] = workDate.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function currentBinding(): LogisticsProgramPollBinding | null {
  return getBinding?.() ?? null;
}

function resolveWorkDate(): string | null {
  const fromPage = currentBinding()?.getWorkDate();
  if (fromPage) return fromPage;
  const stored = localStorage.getItem("selected_logistics_work_date");
  if (stored) return stored;
  return format(new Date(), "yyyy-MM-dd");
}

export function bindLogisticsProgramPoll(
  next: () => LogisticsProgramPollBinding
): () => void {
  getBinding = next;
  return () => {
    if (getBinding === next) getBinding = null;
  };
}

export function markLogisticsProgramCatchupDone(workDate: string) {
  catchupDoneForDate = workDate;
}

async function fetchFingerprint(workDate: string): Promise<LogisticsProgramFingerprint | null> {
  try {
    const response = await fetch(
      `/api/adam/logistics/fingerprint?date=${encodeURIComponent(workDate)}`,
      {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.success) return null;
    return {
      count: Number(data.count ?? 0),
      max_updated_at_unix:
        data.max_updated_at_unix !== null && data.max_updated_at_unix !== undefined
          ? Number(data.max_updated_at_unix)
          : null,
      signature_xor:
        data.signature_xor !== null && data.signature_xor !== undefined
          ? Number(data.signature_xor)
          : null,
      signature_sum: data.signature_sum ?? null,
    };
  } catch {
    return null;
  }
}

function readAssignedNotice(result: unknown): LogisticsAssignedSyncNotice | null {
  const raw = (result as { assignedChanges?: LogisticsAssignedSyncNotice })?.assignedChanges;
  if (!raw || !Array.isArray(raw.tasks)) return null;
  const tasks = raw.tasks.filter(
    (task) =>
      task &&
      Number.isFinite(Number(task.taskId)) &&
      Array.isArray(task.changes) &&
      task.changes.length > 0
  );
  if (tasks.length === 0) return null;
  return {
    syncedAt: typeof raw.syncedAt === "string" ? raw.syncedAt : new Date().toISOString(),
    tasks,
  };
}

async function runLogisticsProgramSync(workDate: string) {
  if (syncing) return;
  if (currentBinding()?.isBlocked()) return;
  syncing = true;
  try {
    const response = await fetch("/api/logistics-containers/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: workDate, modified_by: currentUsername() }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error((result as { error?: string }).error || "Sync programma logistica non riuscita");
    }
    const notice = readAssignedNotice(result);
    const fingerprint = await fetchFingerprint(workDate);
    if (fingerprint) {
      baseline = fingerprint;
      baselineDate = workDate;
    }
    pending = false;
    catchupDoneForDate = workDate;
    await currentBinding()?.onSynced(workDate, notice);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Errore durante l'aggiornamento da ADAM";
    currentBinding()?.onError(message);
  } finally {
    syncing = false;
  }
}

/** Stesso giro del polling housekeeping: non ha un timer proprio. */
export function runLogisticsProgramPoll() {
  if (inFlight || syncing) return;
  const workDate = resolveWorkDate();
  if (!workDate || isWorkDateHistoricallyLocked(parseWorkDate(workDate))) return;
  if (document.visibilityState !== "visible") return;

  inFlight = true;
  void (async () => {
    try {
      if (baselineDate !== workDate) {
        baseline = null;
        baselineDate = workDate;
        pending = false;
      }
      const fingerprint = await fetchFingerprint(workDate);
      if (!fingerprint) return;
      if (baselineDate !== workDate) return;

      if (!baseline) {
        baseline = fingerprint;
        if (catchupDoneForDate !== workDate) pending = true;
      } else if (fingerprintsDiffer(fingerprint, baseline)) {
        pending = true;
      }

      if (pending && !currentBinding()?.isBlocked()) {
        await runLogisticsProgramSync(workDate);
      }
    } finally {
      inFlight = false;
    }
  })();
}

export function nudgeLogisticsProgramPoll() {
  const workDate = resolveWorkDate();
  if (!workDate || !pending || syncing || currentBinding()?.isBlocked()) return;
  void runLogisticsProgramSync(workDate);
}
