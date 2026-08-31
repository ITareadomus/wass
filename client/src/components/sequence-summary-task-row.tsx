import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SequenceSummaryEntry } from "@/lib/sequence-summary";
import type { LogisticsTaskExecutionStatus } from "@shared/logistics-task-execution-status";
import {
  hasLogisticsExecutionStatusColor,
  LogisticsExecutionPausedIcon,
  logisticsExecutionStatusSurfaceClass,
} from "@/lib/logistics-task-execution-status-ui";
import { logisticsKindSequenceDotClass, LogisticsSequenceBadge } from "@/lib/logistics-task-kind-ui";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SequenceSummaryViolationIndicator } from "@/components/sequence-summary-violation-indicator";

function SequenceSummaryCheckInOut({
  checkoutTime,
  checkinTime,
}: {
  checkoutTime?: string | null;
  checkinTime?: string | null;
}) {
  const checkout = String(checkoutTime ?? "").trim();
  const checkin = String(checkinTime ?? "").trim();
  if (!checkout && !checkin) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
      {checkout && (
        <span className="inline-flex items-center gap-0.5 leading-none">
          <span className="font-black text-[11px] leading-none text-[#257537]">↑</span>
          <span className="text-[11px] font-bold leading-none text-[#137537]">{checkout}</span>
        </span>
      )}
      {checkin && (
        <span className="inline-flex items-center gap-0.5 leading-none">
          <span className="font-black text-[11px] leading-none text-red-600">↓</span>
          <span className="text-[11px] font-bold leading-none text-red-600">{checkin}</span>
        </span>
      )}
    </span>
  );
}

function SequenceSummaryCleanerAssignment({
  cleanerLabel,
  cleanerSequence,
  lightOnColor,
}: {
  cleanerLabel?: string | null;
  cleanerSequence?: number | null;
  lightOnColor?: boolean;
}) {
  const label = String(cleanerLabel ?? "").trim();
  const sequence =
    cleanerSequence != null && Number.isFinite(cleanerSequence) && cleanerSequence > 0
      ? cleanerSequence
      : null;

  if (!label && sequence == null) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
      {label && (
        <span className={cn("font-medium", lightOnColor ? "text-white" : "text-foreground/90")}>
          {label}
        </span>
      )}
      {sequence != null && (
        <LogisticsSequenceBadge
          sequence={sequence}
          size="inline"
          className="text-foreground/90"
        />
      )}
    </span>
  );
}

function SequenceSummaryCustomerNoteIndicator({
  note,
  logisticCode,
  onOpen,
  lightOnColor,
}: {
  note: string;
  logisticCode: string;
  onOpen?: (note: string, logisticCode: string) => void;
  lightOnColor?: boolean;
}) {
  const text = String(note ?? "").trim();
  if (!text) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="relative inline-flex shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent p-0 focus:outline-none"
          onClick={(event) => {
            event.stopPropagation();
            onOpen?.(text, logisticCode);
          }}
          aria-label="Note del cliente da leggere"
        >
          <MessageCircle
            className={cn("h-[11px] w-[11px]", lightOnColor ? "text-white" : "text-muted-foreground")}
            aria-hidden
          />
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-500 ring-1 ring-background" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Note del cliente da leggere
      </TooltipContent>
    </Tooltip>
  );
}

export function getSequenceSummaryTaskRowClassName({
  isTimelineViolated,
  isHighlighted,
  isMapFiltered,
  isDragging,
  executionStatus,
}: {
  isTimelineViolated?: boolean;
  isHighlighted?: boolean;
  isMapFiltered?: boolean;
  isDragging?: boolean;
  executionStatus?: LogisticsTaskExecutionStatus | null;
} = {}) {
  const statusClass = logisticsExecutionStatusSurfaceClass(executionStatus);
  const statusWinsOverViolation = hasLogisticsExecutionStatusColor(executionStatus);
  // Violazione lampeggia solo se non c'è colore status; l'icona resta comunque (--violated).
  const showViolationBlink = isTimelineViolated === true && !statusWinsOverViolation;

  return cn(
    "sequence-summary-task relative rounded-md border px-2 py-1.5 text-xs",
    isTimelineViolated && "sequence-summary-task--violated",
    isMapFiltered && "sequence-summary-task--map-filtered task-border-map-filtered",
    showViolationBlink
      ? "animate-blink-inset border-red-500 bg-red-50 dark:bg-red-950/30"
      : !isMapFiltered && isHighlighted
        ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
        : statusClass
          ? cn(
              statusClass,
              executionStatus === "in_progress" && "sequence-summary-task--in-progress",
              executionStatus === "completed" && "sequence-summary-task--completed",
              executionStatus === "paused" && "sequence-summary-task--paused",
            )
          : "border-border/70 bg-background",
    isDragging && "cursor-grabbing shadow-md ring-1 ring-custom-blue/40",
  );
}

export function SequenceSummaryPausedOverlay() {
  return (
    <span className="pointer-events-none absolute inset-y-0 right-1.5 z-[3] flex items-center">
      <LogisticsExecutionPausedIcon size="summary" />
    </span>
  );
}

export function SequenceSummaryTaskContent({
  entry,
  onCustomerNoteOpen,
}: {
  entry: SequenceSummaryEntry;
  onCustomerNoteOpen?: (note: string, logisticCode: string) => void;
}) {
  const isTimelineViolated = entry.timelineViolated === true;
  const isPaused = entry.executionStatus === "paused";
  const lightOnColor = hasLogisticsExecutionStatusColor(entry.executionStatus);
  const primary = lightOnColor ? "text-white" : "text-foreground";
  const muted = lightOnColor ? "text-white/85" : "text-muted-foreground";
  const divider = lightOnColor ? "text-white/50" : "text-muted-foreground/60";
  const hkLabel = lightOnColor ? "text-white" : "text-foreground/80";

  return (
    <>
      {isTimelineViolated && <SequenceSummaryViolationIndicator />}
      {isPaused && <SequenceSummaryPausedOverlay />}
      <div className={cn("relative z-[1] min-w-max", lightOnColor && "isolate")}>
        <div className="flex flex-nowrap items-center gap-x-1 whitespace-nowrap text-[11px]">
          <span className={logisticsKindSequenceDotClass(entry.logisticsTaskKind)}>
            {entry.sequence}
          </span>
          <span className={cn("shrink-0", divider)}>|</span>
          <span className={cn("shrink-0 font-semibold", primary)}>
            {entry.logisticCode || "N/D"}
          </span>
          {entry.customerAlias && (
            <>
              <span className={cn("shrink-0", divider)}>|</span>
              <span className={cn("shrink-0", muted)}>{entry.customerAlias}</span>
            </>
          )}
          {entry.address && (
            <>
              <span className={cn("shrink-0", divider)}>|</span>
              <span className={cn("shrink-0", muted)}>{entry.address}</span>
            </>
          )}
          {entry.sofabedLabel && (
            <>
              <span className={cn("shrink-0", divider)}>|</span>
              <span className={cn("shrink-0 whitespace-nowrap", muted)}>
                {entry.sofabedLabel}
              </span>
            </>
          )}
        </div>
        <div className={cn("mt-1 flex flex-nowrap items-center gap-x-1 whitespace-nowrap text-[11px]", muted)}>
          {(entry.cleanerLabel || entry.cleanerSequence) && (
            <>
              <SequenceSummaryCleanerAssignment
                cleanerLabel={entry.cleanerLabel}
                cleanerSequence={entry.cleanerSequence}
                lightOnColor={lightOnColor}
              />
              <span className={cn("shrink-0", divider)}>|</span>
            </>
          )}
          <span className="shrink-0 whitespace-nowrap">
            <span className={cn("font-medium", hkLabel)}>HK window:</span> {entry.hkWindow}
          </span>
          {(entry.checkoutTime || entry.checkinTime) && (
            <>
              <span className={cn("shrink-0", divider)}>|</span>
              <SequenceSummaryCheckInOut
                checkoutTime={entry.checkoutTime}
                checkinTime={entry.checkinTime}
              />
            </>
          )}
          {entry.customerNote && (
            <>
              <span className={cn("shrink-0", divider)}>|</span>
              <SequenceSummaryCustomerNoteIndicator
                note={entry.customerNote}
                logisticCode={entry.logisticCode || "N/D"}
                onOpen={onCustomerNoteOpen}
                lightOnColor={lightOnColor}
              />
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function SequenceSummaryTaskRow({
  entry,
  className,
  isHighlighted = false,
  isMapFiltered = false,
  isDragging = false,
  onCustomerNoteOpen,
}: {
  entry: SequenceSummaryEntry;
  className?: string;
  isHighlighted?: boolean;
  isMapFiltered?: boolean;
  isDragging?: boolean;
  onCustomerNoteOpen?: (note: string, logisticCode: string) => void;
}) {
  const isTimelineViolated = entry.timelineViolated === true;

  return (
    <div
      className={cn(
        getSequenceSummaryTaskRowClassName({
          isTimelineViolated,
          isHighlighted,
          isMapFiltered,
          isDragging,
          executionStatus: entry.executionStatus,
        }),
        className,
      )}
    >
      <SequenceSummaryTaskContent
        entry={entry}
        onCustomerNoteOpen={onCustomerNoteOpen}
      />
    </div>
  );
}
