import { useEffect, useRef } from "react";
import type { HousekeepingTaskExecutionStatusFields } from "@shared/housekeeping-task-execution-status";

const POLL_INTERVAL_MS = 8_000;

type ExecutionStatusMap = Record<string, HousekeepingTaskExecutionStatusFields>;

async function fetchHousekeepingTimelineExecutionStatus(
  url: string
): Promise<ExecutionStatusMap | null> {
  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.success || !data.statuses || typeof data.statuses !== "object") {
      return null;
    }
    return data.statuses as ExecutionStatusMap;
  } catch {
    return null;
  }
}

/**
 * Poll ADAM startwork/cleaned for housekeeping timeline colors
 * without reloading the full timeline.
 */
export function useHousekeepingExecutionStatusPoll(options: {
  workDate: string;
  enabled?: boolean;
  isPaused?: () => boolean;
  buildUrl?: (workDate: string) => string;
  onStatuses: (statuses: ExecutionStatusMap) => void;
}) {
  const { workDate, enabled = true, isPaused, buildUrl, onStatuses } = options;
  const onStatusesRef = useRef(onStatuses);
  const isPausedRef = useRef(isPaused);
  const buildUrlRef = useRef(buildUrl);
  onStatusesRef.current = onStatuses;
  isPausedRef.current = isPaused;
  buildUrlRef.current = buildUrl;

  useEffect(() => {
    if (!enabled || !workDate) return;

    let stopped = false;
    let inFlight = false;

    const poll = async () => {
      if (stopped || inFlight) return;
      if (document.visibilityState !== "visible") return;
      if (isPausedRef.current?.()) return;

      const url =
        buildUrlRef.current?.(workDate) ??
        `/api/timeline/execution-status?date=${encodeURIComponent(workDate)}`;

      inFlight = true;
      try {
        const statuses = await fetchHousekeepingTimelineExecutionStatus(url);
        if (stopped || !statuses) return;
        if (isPausedRef.current?.()) return;
        onStatusesRef.current(statuses);
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => {
      void poll();
    }, POLL_INTERVAL_MS);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibility);
    void poll();

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workDate, enabled]);
}
