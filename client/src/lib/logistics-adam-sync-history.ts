import type { LogisticsAssignedSyncNotice } from "@shared/logistics-assigned-sync-diff";

const STORAGE_PREFIX = "wass.logisticsAdamSyncHistory.";
const MAX_NOTICES = 40;

function isNotice(value: unknown): value is LogisticsAssignedSyncNotice {
  if (!value || typeof value !== "object") return false;
  const notice = value as LogisticsAssignedSyncNotice;
  return (
    typeof notice.syncedAt === "string" &&
    Array.isArray(notice.tasks) &&
    notice.tasks.some((task) => Array.isArray(task?.changes) && task.changes.length > 0)
  );
}

export function readLogisticsAdamSyncHistory(workDate: string): LogisticsAssignedSyncNotice[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${workDate}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isNotice).slice(-MAX_NOTICES);
  } catch {
    return [];
  }
}

export function writeLogisticsAdamSyncHistory(
  workDate: string,
  history: LogisticsAssignedSyncNotice[]
): void {
  try {
    localStorage.setItem(
      `${STORAGE_PREFIX}${workDate}`,
      JSON.stringify(history.slice(-MAX_NOTICES))
    );
  } catch {
    /* ignore quota errors */
  }
}

export function appendLogisticsAdamSyncNotice(
  history: LogisticsAssignedSyncNotice[],
  notice: LogisticsAssignedSyncNotice | null
): LogisticsAssignedSyncNotice[] {
  if (!notice || !isNotice(notice)) return history;
  if (history.some((item) => item.syncedAt === notice.syncedAt)) return history;
  return [...history, notice].slice(-MAX_NOTICES);
}
