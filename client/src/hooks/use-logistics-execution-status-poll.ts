import { useEffect, useRef } from "react";
import type { LogisticsTaskExecutionStatusFields } from "@shared/logistics-task-execution-status";

const POLL_INTERVAL_MS = 8_000;

type ExecutionStatusMap = Record<string, LogisticsTaskExecutionStatusFields>;

async function fetchLogisticsTimelineExecutionStatus(
  workDate: string
): Promise<ExecutionStatusMap | null> {
  try {
    const response = await fetch(
      `/api/logistics-timeline/execution-status?date=${encodeURIComponent(workDate)}`,
      {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      }
    );
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
 * Poll ADAM execution status for logistics timeline colors (start / pause / complete)
 * without reloading the full timeline.
 */
export function useLogisticsExecutionStatusPoll(options: {
  workDate: string;
  enabled?: boolean;
  isPaused?: () => boolean;
  onStatuses: (statuses: ExecutionStatusMap) => void;
}) {
  const { workDate, enabled = true, isPaused, onStatuses } = options;
  const onStatusesRef = useRef(onStatuses);
  const isPausedRef = useRef(isPaused);
  onStatusesRef.current = onStatuses;
  isPausedRef.current = isPaused;

  useEffect(() => {
    if (!enabled || !workDate) return;

    let stopped = false;
    let inFlight = false;

    const poll = async () => {
      if (stopped || inFlight) return;
      if (document.visibilityState !== "visible") return;
      if (isPausedRef.current?.()) return;

      inFlight = true;
      try {
        const statuses = await fetchLogisticsTimelineExecutionStatus(workDate);
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
