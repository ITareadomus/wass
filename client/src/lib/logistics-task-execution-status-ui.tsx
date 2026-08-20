import { Pause } from "lucide-react";
import type { LogisticsTaskExecutionStatus } from "@shared/logistics-task-execution-status";
import { cn } from "@/lib/utils";

/** True when status paints a surface color (not "not started"). */
export function hasLogisticsExecutionStatusColor(
  status?: LogisticsTaskExecutionStatus | null
): boolean {
  return status === "in_progress" || status === "completed" || status === "paused";
}

/** Stesso verde di sfondo HK (resto del riempimento) e stesso grigio completato. */
export const EXECUTION_IN_PROGRESS_SURFACE_CLASS =
  "border-green-500 bg-[#116832] text-white dark:border-green-400 dark:bg-[#114f28] dark:text-white";
export const EXECUTION_COMPLETED_SURFACE_CLASS =
  "border-gray-400 bg-gray-700 text-white dark:border-gray-400 dark:bg-gray-700 dark:text-white";
export const EXECUTION_PAUSED_SURFACE_CLASS =
  "border-blue-400 bg-blue-950 text-white dark:border-blue-400 dark:bg-blue-950 dark:text-white";

/** Superfici stato esecuzione — stessi colori per timeline, summary e HK. */
export function logisticsExecutionStatusSurfaceClass(
  status?: LogisticsTaskExecutionStatus | null,
  _intensity: "soft" | "strong" = "soft"
): string | undefined {
  switch (status) {
    case "in_progress":
      return EXECUTION_IN_PROGRESS_SURFACE_CLASS;
    case "completed":
      return EXECUTION_COMPLETED_SURFACE_CLASS;
    case "paused":
      return EXECUTION_PAUSED_SURFACE_CLASS;
    default:
      return undefined;
  }
}

export function LogisticsExecutionPausedIcon({
  className,
  size = "summary",
}: {
  className?: string;
  size?: "summary" | "timeline";
}) {
  const iconClass =
    size === "timeline"
      ? "h-3 w-3 fill-white text-white"
      : "h-3.5 w-3.5 fill-white text-white";

  return (
    <span
      className={cn(
        "pointer-events-none inline-flex items-center justify-center rounded-full bg-black/25",
        size === "timeline" ? "p-0.5" : "p-1",
        className
      )}
      aria-label="In pausa"
    >
      <Pause className={iconClass} />
    </span>
  );
}
