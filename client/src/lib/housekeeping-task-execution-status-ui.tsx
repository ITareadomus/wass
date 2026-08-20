import type {
  HousekeepingTaskExecutionStatus,
  HousekeepingWorkProgress,
} from "@shared/housekeeping-task-execution-status";
import {
  EXECUTION_IN_PROGRESS_SURFACE_CLASS,
  logisticsExecutionStatusSurfaceClass,
} from "@/lib/logistics-task-execution-status-ui";
import { cn } from "@/lib/utils";

export function hasHousekeepingExecutionStatusColor(
  status?: HousekeepingTaskExecutionStatus | null
): boolean {
  return status === "in_progress" || status === "completed";
}

export function housekeepingExecutionStatusSurfaceClass(
  status?: HousekeepingTaskExecutionStatus | null,
  intensity: "soft" | "strong" = "soft"
): string | undefined {
  if (status !== "in_progress" && status !== "completed") return undefined;
  return logisticsExecutionStatusSurfaceClass(status, intensity);
}

/** Rimanente (più scuro) vs avanzato (verde più chiaro, stesso tono). */
export const HOUSEKEEPING_PROGRESS_REMAINDER_CLASS =
  "bg-[#116832] dark:bg-[#114f28]";
export const HOUSEKEEPING_PROGRESS_ADVANCED_CLASS =
  "bg-[#1bb054] dark:bg-[#178a45]";

export const HOUSEKEEPING_PROGRESS_SURFACE_CLASS = EXECUTION_IN_PROGRESS_SURFACE_CLASS;

export function HousekeepingWorkProgressLine({
  progress,
}: {
  progress: HousekeepingWorkProgress;
}) {
  const percentLabel = `${Math.round(progress.percent)}%`;
  const remainingLabel = progress.overdue
    ? "Tempo scaduto"
    : progress.remainingMinutes === 1
      ? "Resta 1 min"
      : `Restano ${progress.remainingMinutes} min`;

  return (
    <div className="space-y-1.5" data-testid="housekeeping-work-progress">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-muted-foreground">
          Avanzamento stimato
        </p>
        <p className="text-sm font-semibold tabular-nums text-foreground">
          {percentLabel}
        </p>
      </div>
        <div
          className={cn(
            "h-2.5 w-full overflow-hidden rounded-full",
            HOUSEKEEPING_PROGRESS_REMAINDER_CLASS
          )}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress.percent)}
          aria-label="Percentuale di completamento stimata"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-1000 ease-linear",
              HOUSEKEEPING_PROGRESS_ADVANCED_CLASS,
              progress.overdue && "animate-pulse"
            )}
            style={{ width: `${progress.percent}%` }}
          />
        </div>
        <p
          className={cn(
            "text-sm tabular-nums",
            progress.overdue ? "font-semibold text-green-700 dark:text-green-300" : "text-muted-foreground"
          )}
        >
        {remainingLabel}
      </p>
    </div>
  );
}
