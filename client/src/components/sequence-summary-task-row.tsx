import { MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SequenceSummaryEntry } from "@/lib/sequence-summary";
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

export function getSequenceSummaryTaskRowClassName({
  isTimelineViolated,
  isHighlighted,
  isDragging,
}: {
  isTimelineViolated?: boolean;
  isHighlighted?: boolean;
  isDragging?: boolean;
} = {}) {
  return cn(
    "sequence-summary-task relative rounded-md border px-2 py-1.5 text-xs",
    isTimelineViolated
      ? "sequence-summary-task--violated animate-blink-inset border-red-500 bg-red-50 dark:bg-red-950/30"
      : isHighlighted
        ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
        : "border-border/70 bg-background",
    isDragging && "cursor-grabbing shadow-md ring-1 ring-custom-blue/40",
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

  return (
    <>
      {isTimelineViolated && <SequenceSummaryViolationIndicator />}
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
          <span className="shrink-0 text-muted-foreground/60">|</span>
          <span className="shrink-0 whitespace-nowrap text-muted-foreground">
            <span className="font-medium text-foreground/80">LG window:</span> {entry.lgWindow}
          </span>
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
        getSequenceSummaryTaskRowClassName({ isTimelineViolated, isHighlighted, isDragging }),
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
