import { MessageCircle, Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SequenceSummaryEntry } from "@/lib/sequence-summary";
import type { LogisticsTaskExecutionStatus } from "@shared/logistics-task-execution-status";
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
}: {
  cleanerLabel?: string | null;
  cleanerSequence?: number | null;
}) {
  const label = String(cleanerLabel ?? "").trim();
  const sequence =
    cleanerSequence != null && Number.isFinite(cleanerSequence) && cleanerSequence > 0
      ? cleanerSequence
      : null;

  if (!label && sequence == null) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
      {label && <span className="font-medium text-foreground/90">{label}</span>}
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
}: {
  note: string;
  logisticCode: string;
  onOpen?: (note: string, logisticCode: string) => void;
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
          <MessageCircle className="h-[11px] w-[11px] text-muted-foreground" aria-hidden />
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-500 ring-1 ring-background" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        Note del cliente da leggere
      </TooltipContent>
    </Tooltip>
  );
}

function executionStatusRowClass(
  executionStatus?: LogisticsTaskExecutionStatus | null
): string | undefined {
  switch (executionStatus) {
    case "in_progress":
      return "sequence-summary-task--in-progress border-blue-500 bg-blue-50 dark:bg-blue-950/35";
    case "completed":
      return "sequence-summary-task--completed border-green-500 bg-green-50 dark:bg-green-950/35";
    case "paused":
      return "sequence-summary-task--paused border-gray-400 bg-gray-200/90 dark:bg-gray-800/60";
    default:
      return undefined;
  }
}

export function getSequenceSummaryTaskRowClassName({
  isTimelineViolated,
  isHighlighted,
  isDragging,
  executionStatus,
}: {
  isTimelineViolated?: boolean;
  isHighlighted?: boolean;
  isDragging?: boolean;
  executionStatus?: LogisticsTaskExecutionStatus | null;
} = {}) {
  return cn(
    "sequence-summary-task relative rounded-md border px-2 py-1.5 text-xs",
    isTimelineViolated
      ? "sequence-summary-task--violated animate-blink-inset border-red-500 bg-red-50 dark:bg-red-950/30"
      : isHighlighted
        ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
        : executionStatusRowClass(executionStatus) ?? "border-border/70 bg-background",
    isDragging && "cursor-grabbing shadow-md ring-1 ring-custom-blue/40",
  );
}

export function SequenceSummaryPausedOverlay() {
  return (
    <span
      className="pointer-events-none absolute inset-y-0 right-1.5 z-[3] flex items-center"
      aria-label="In pausa"
    >
      <span className="inline-flex items-center justify-center rounded-full bg-gray-500/25 p-1 dark:bg-gray-200/15">
        <Pause className="h-3.5 w-3.5 fill-gray-700 text-gray-700 dark:fill-gray-200 dark:text-gray-200" />
      </span>
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
  const isPaused = !isTimelineViolated && entry.executionStatus === "paused";

  return (
    <>
      {isTimelineViolated && <SequenceSummaryViolationIndicator />}
      {isPaused && <SequenceSummaryPausedOverlay />}
      <div className="min-w-max">
        <div className="flex flex-nowrap items-center gap-x-1 whitespace-nowrap text-[11px]">
          <span className={logisticsKindSequenceDotClass(entry.logisticsTaskKind)}>
            {entry.sequence}
          </span>
          <span className="shrink-0 text-muted-foreground/60">|</span>
          <span className="shrink-0 font-semibold text-foreground">
            {entry.logisticCode || "N/D"}
          </span>
          {entry.customerAlias && (
            <>
              <span className="shrink-0 text-muted-foreground/60">|</span>
              <span className="shrink-0 text-muted-foreground">{entry.customerAlias}</span>
            </>
          )}
          {entry.address && (
            <>
              <span className="shrink-0 text-muted-foreground/60">|</span>
              <span className="shrink-0 text-muted-foreground">{entry.address}</span>
            </>
          )}
          {entry.sofabedLabel && (
            <>
              <span className="shrink-0 text-muted-foreground/60">|</span>
              <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                {entry.sofabedLabel}
              </span>
            </>
          )}
        </div>
        <div className="mt-1 flex flex-nowrap items-center gap-x-1 whitespace-nowrap text-[11px] text-muted-foreground">
          {(entry.cleanerLabel || entry.cleanerSequence) && (
            <>
              <SequenceSummaryCleanerAssignment
                cleanerLabel={entry.cleanerLabel}
                cleanerSequence={entry.cleanerSequence}
              />
              <span className="shrink-0 text-muted-foreground/60">|</span>
            </>
          )}
          <span className="shrink-0 whitespace-nowrap">
            <span className="font-medium text-foreground/80">HK window:</span> {entry.hkWindow}
          </span>
          {(entry.checkoutTime || entry.checkinTime) && (
            <>
              <span className="shrink-0 text-muted-foreground/60">|</span>
              <SequenceSummaryCheckInOut
                checkoutTime={entry.checkoutTime}
                checkinTime={entry.checkinTime}
              />
            </>
          )}
          {entry.customerNote && (
            <>
              <span className="shrink-0 text-muted-foreground/60">|</span>
              <SequenceSummaryCustomerNoteIndicator
                note={entry.customerNote}
                logisticCode={entry.logisticCode || "N/D"}
                onOpen={onCustomerNoteOpen}
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
  isDragging = false,
  onCustomerNoteOpen,
}: {
  entry: SequenceSummaryEntry;
  className?: string;
  isHighlighted?: boolean;
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
