import { Pause } from "lucide-react";
import type { LogisticsTaskExecutionStatus } from "@shared/logistics-task-execution-status";
import { cn } from "@/lib/utils";

/** True when status paints a surface color (not "not started"). */
export function hasLogisticsExecutionStatusColor(
  status?: LogisticsTaskExecutionStatus | null
): boolean {
  return status === "in_progress" || status === "completed" || status === "paused";
}

/** Pastel surface colors — keep card text readable. Timeline uses a stronger tint. */
export function logisticsExecutionStatusSurfaceClass(
  status?: LogisticsTaskExecutionStatus | null,
  intensity: "soft" | "strong" = "soft"
): string | undefined {
  if (intensity === "strong") {
    switch (status) {
      case "in_progress":
        return "border-blue-500 bg-blue-300/85 dark:border-blue-400 dark:bg-blue-800/70";
      case "completed":
        return "border-green-600 bg-green-300/85 dark:border-green-400 dark:bg-green-800/65";
      case "paused":
        return "border-gray-500 bg-gray-300 dark:border-gray-400 dark:bg-gray-700/85";
      default:
        return undefined;
    }
  }

  switch (status) {
    case "in_progress":
      return "border-blue-400 bg-blue-100/90 dark:border-blue-500 dark:bg-blue-950/50";
    case "completed":
      return "border-green-500 bg-green-100/90 dark:border-green-500 dark:bg-green-950/45";
    case "paused":
      return "border-gray-400 bg-gray-200/95 dark:border-gray-500 dark:bg-gray-800/70";
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
      ? "h-3 w-3 fill-gray-700 text-gray-700 dark:fill-gray-200 dark:text-gray-200"
      : "h-3.5 w-3.5 fill-gray-700 text-gray-700 dark:fill-gray-200 dark:text-gray-200";

  return (
    <span
      className={cn(
        "pointer-events-none inline-flex items-center justify-center rounded-full bg-gray-500/25 dark:bg-gray-200/15",
        size === "timeline" ? "p-0.5" : "p-1",
        className
      )}
      aria-label="In pausa"
    >
      <Pause className={iconClass} />
    </span>
  );
}
