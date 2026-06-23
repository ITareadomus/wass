import { useMemo, useState } from "react";
import { ListOrdered, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SequenceSummaryGroup } from "@/lib/sequence-summary";
import { logisticsKindSequenceDotClass, LogisticsSequenceBadge } from "@/lib/logistics-task-kind-ui";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface AssignedTasksSequenceSummaryProps {
  groups: SequenceSummaryGroup[];
  searchTask?: string;
  staffLabel?: string;
}

function matchesSearch(entry: SequenceSummaryGroup["tasks"][number], query: string): boolean {
  const lowerSearch = query.toLowerCase();
  return (
    entry.taskId.toLowerCase().includes(lowerSearch) ||
    entry.logisticCode.toLowerCase().includes(lowerSearch) ||
    entry.address.toLowerCase().includes(lowerSearch)
  );
}

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
  onOpen: (note: string, logisticCode: string) => void;
}) {
  const text = String(note ?? "").trim();
  if (!text) return null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="relative inline-flex shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent p-0"
          onClick={(event) => {
            event.stopPropagation();
            onOpen(text, logisticCode);
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

export default function AssignedTasksSequenceSummary({
  groups,
  searchTask = "",
  staffLabel = "Cleaner",
}: AssignedTasksSequenceSummaryProps) {
  const [customerNoteDialog, setCustomerNoteDialog] = useState<{
    open: boolean;
    note: string;
    logisticCode: string;
  }>({ open: false, note: "", logisticCode: "" });

  const totalTasks = useMemo(
    () => groups.reduce((sum, group) => sum + group.tasks.length, 0),
    [groups]
  );

  if (groups.length === 0) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mb-4 mt-4 w-full">
        <div className="rounded-lg border-2 border-custom-blue bg-custom-blue-light p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="flex items-center font-semibold text-custom-blue">
              <ListOrdered className="mr-2 h-5 w-5" />
              Resoconto assegnazioni
            </h3>
            <div className="mt-1 text-xs text-muted-foreground">
              {totalTasks} task in sequenza · {groups.length} {staffLabel.toLowerCase()}
              {groups.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        <div className="grid min-h-[120px] grid-cols-1 gap-4 lg:grid-cols-3">
          {groups.map((group) => (
            <div
              key={group.id}
              className="flex min-h-[120px] min-w-0 flex-col overflow-x-auto rounded-lg border border-custom-blue/40 bg-background/70 p-3"
            >
              <div className="flex min-w-max flex-col">
                <div className="mb-2 border-b border-custom-blue/20 pb-2">
                  <h4 className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-custom-blue">
                    <span>{group.label}</span>
                    <span className="inline-flex items-center font-normal">
                      {group.vehiclePlate && (
                        <span className="shrink-0 rounded border border-custom-blue/40 bg-background/80 px-1.5 text-[10px] font-semibold leading-4 text-custom-blue">
                          {group.vehiclePlate}
                        </span>
                      )}
                      <span className="text-muted-foreground">
                        · {group.tasks.length} task
                      </span>
                    </span>
                  </h4>
                </div>

                <ol className="flex flex-col gap-1.5">
                  {group.tasks.map((entry) => {
                    const isHighlighted = searchTask.trim()
                      ? matchesSearch(entry, searchTask.trim())
                      : false;

                    return (
                      <li
                        key={`${group.id}-${entry.taskId}-${entry.sequence}`}
                        className={cn(
                          "rounded-md border px-2 py-1.5 text-xs",
                          isHighlighted
                            ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
                            : "border-border/70 bg-background"
                        )}
                      >
                        <div className="min-w-max">
                          <div className="flex items-center gap-1 whitespace-nowrap text-[11px]">
                            <span className={logisticsKindSequenceDotClass(entry.logisticsTaskKind)}>
                              {entry.sequence}
                            </span>
                            <span className="shrink-0 text-muted-foreground/60">|</span>
                            <span className="shrink-0 font-semibold text-foreground">
                              {entry.logisticCode || "N/D"}
                            </span>
                            {entry.address && (
                              <>
                                <span className="shrink-0 text-muted-foreground/60">|</span>
                                <span className="shrink-0 text-muted-foreground">{entry.address}</span>
                              </>
                            )}
                            <span className="shrink-0 text-muted-foreground/60">|</span>
                            <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                              <span className="font-medium text-foreground/80">LG window:</span>{" "}
                              {entry.lgWindow}
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
                          <div className="mt-1 flex items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground">
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
                              <span className="font-medium text-foreground/80">HK window:</span>{" "}
                              {entry.hkWindow}
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
                                  onOpen={(note, logisticCode) =>
                                    setCustomerNoteDialog({ open: true, note, logisticCode })
                                  }
                                />
                              </>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>

      <Dialog
        open={customerNoteDialog.open}
        onOpenChange={(open) =>
          setCustomerNoteDialog((prev) => ({ ...prev, open }))
        }
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-baseline gap-x-1">
              <span>Note del cliente</span>
              <span className="text-sm font-normal text-muted-foreground">
                del task <strong>{customerNoteDialog.logisticCode}</strong>
              </span>
            </DialogTitle>
          </DialogHeader>
          <Textarea
            readOnly
            tabIndex={-1}
            value={customerNoteDialog.note}
            className="mt-2 min-h-[120px] resize-none cursor-default whitespace-pre-wrap break-words border-slate-600 bg-slate-950 text-slate-50 focus-visible:ring-0 focus-visible:ring-offset-0 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50"
          />
          <div className="mt-4 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="border-2 border-custom-blue"
              onClick={() =>
                setCustomerNoteDialog((prev) => ({ ...prev, open: false }))
              }
            >
              Chiudi
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
