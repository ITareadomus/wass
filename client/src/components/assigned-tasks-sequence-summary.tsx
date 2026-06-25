import { useMemo, useState } from "react";
import { Draggable, Droppable } from "react-beautiful-dnd";
import { ListOrdered, Loader2, Maximize2, MessageCircle } from "lucide-react";
import { Link } from "wouter";
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
  isDragDisabled?: boolean;
  loadingDriverIds?: number[];
  workDate?: string;
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
          className="relative inline-flex shrink-0 cursor-pointer items-center rounded-sm border-0 bg-transparent p-0 focus:outline-none"
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

function SequenceSummaryViolationIndicator({
  messages,
  logisticCode,
  onOpen,
}: {
  messages: string[];
  logisticCode: string;
  onOpen: (messages: string[], logisticCode: string) => void;
}) {
  if (messages.length === 0) return null;

  return (
    <button
      type="button"
      className="absolute right-1 top-1 z-10 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold leading-none text-white shadow-sm ring-1 ring-background hover:bg-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-1"
      onClick={(event) => {
        event.stopPropagation();
        onOpen(messages, logisticCode);
      }}
      aria-label="Mostra spiegazione violazione"
      title="Violazione timeline"
    >
      !
    </button>
  );
}

export default function AssignedTasksSequenceSummary({
  groups,
  searchTask = "",
  staffLabel = "Cleaner",
  isDragDisabled = false,
  loadingDriverIds = [],
  workDate = "",
}: AssignedTasksSequenceSummaryProps) {
  const [customerNoteDialog, setCustomerNoteDialog] = useState<{
    open: boolean;
    note: string;
    logisticCode: string;
  }>({ open: false, note: "", logisticCode: "" });
  const [violationDialog, setViolationDialog] = useState<{
    open: boolean;
    logisticCode: string;
    messages: string[];
  }>({ open: false, logisticCode: "", messages: [] });
  const [loadOrderDriverIds, setLoadOrderDriverIds] = useState<Set<number>>(() => new Set());

  const toggleDriverLoadOrder = (driverId: number) => {
    setLoadOrderDriverIds((prev) => {
      const next = new Set(prev);
      if (next.has(driverId)) {
        next.delete(driverId);
      } else {
        next.add(driverId);
      }
      return next;
    });
  };

  const loadingDriverIdSet = useMemo(() => new Set(loadingDriverIds), [loadingDriverIds]);

  if (groups.length === 0) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mb-4 mt-4 w-full min-w-0 overflow-hidden">
        <div className="rounded-lg border-2 border-custom-blue bg-custom-blue-light p-4">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="flex items-center text-xl font-bold text-foreground">
            <ListOrdered className="mr-2 h-5 w-5 text-custom-blue" />
            Resoconto assegnazioni
          </h3>
        </div>

        <div className="grid min-h-[120px] min-w-0 grid-cols-1 items-stretch gap-4 lg:grid-cols-3">
          {groups.map((group) => {
            const isLoadOrder = loadOrderDriverIds.has(group.id);
            const displayedTasks = isLoadOrder ? [...group.tasks].reverse() : group.tasks;
            const isGroupDragDisabled = isDragDisabled || isLoadOrder;

            return (
            <div
              key={group.id}
              className="relative flex h-full min-h-[120px] min-w-0 flex-col overflow-hidden rounded-lg border border-custom-blue/40 p-3"
            >
              {loadingDriverIdSet.has(group.id) && (
                <div className="absolute inset-0 z-40 flex items-center justify-center rounded-lg bg-black/20 backdrop-blur-sm pointer-events-none dark:bg-black/40">
                  <div className="flex flex-col items-center gap-3">
                    <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
                    <p className="text-sm font-medium text-foreground">Aggiornamento…</p>
                  </div>
                </div>
              )}
              <div className="mb-2 flex shrink-0 items-start justify-between gap-2 border-b border-border pb-2">
                <h4 className="flex min-w-0 flex-nowrap items-center gap-x-2 whitespace-nowrap text-sm font-semibold text-foreground">
                  <span>{group.label}</span>
                  <span className="inline-flex items-center gap-x-1 font-normal text-foreground">
                    {group.vehiclePlate && (
                      <span className="shrink-0 rounded border border-custom-blue/40 bg-background/80 px-1.5 text-[10px] font-semibold leading-4 text-custom-blue">
                        {group.vehiclePlate}
                      </span>
                    )}
                    <span className="shrink-0 text-foreground">-</span>
                    <span className="text-foreground">{group.tasks.length} task</span>
                  </span>
                </h4>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {workDate && (
                      <Link
                        href={`/generate-logistics-assignments/driver/${group.id}?date=${encodeURIComponent(workDate)}`}
                      >
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="flex h-7 shrink-0 items-center gap-1 border-2 border-custom-blue px-2 text-[10px] font-semibold"
                          title="Apri scheda a tutto schermo"
                          aria-label="Apri scheda a tutto schermo"
                        >
                          <Maximize2 className="h-3 w-3 shrink-0" aria-hidden />
                        </Button>
                      </Link>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="flex h-7 shrink-0 items-center gap-1 border-2 border-custom-blue px-2 text-[10px] font-semibold"
                      onClick={() => toggleDriverLoadOrder(group.id)}
                    >
                      {isLoadOrder ? "Ordine di sequenza" : "Ordine di carico"}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="sequence-summary-driver-scroll flex min-h-0 min-w-0 flex-1 flex-col rounded-md bg-background/70 pb-0.5">
                <div className="flex min-w-max flex-col">
                <Droppable
                  droppableId={`summary-${group.id}`}
                  direction="vertical"
                  isDropDisabled={isGroupDragDisabled}
                >
                  {(provided, snapshot) => (
                    <ol
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={cn(
                        "flex flex-col gap-1.5",
                        snapshot.isDraggingOver && "rounded-md bg-custom-blue/5 ring-1 ring-custom-blue/30"
                      )}
                    >
                      {displayedTasks.map((entry, index) => {
                        const isHighlighted = searchTask.trim()
                          ? matchesSearch(entry, searchTask.trim())
                          : false;
                        const isTimelineViolated = entry.timelineViolated === true;
                        const violationMessages = entry.violationMessages ?? [];

                        return (
                          <Draggable
                            key={`${group.id}-${entry.taskId}`}
                            draggableId={String(entry.taskId)}
                            index={index}
                            isDragDisabled={isGroupDragDisabled}
                          >
                            {(dragProvided, dragSnapshot) => (
                              <li
                                ref={dragProvided.innerRef}
                                {...dragProvided.draggableProps}
                                {...dragProvided.dragHandleProps}
                                style={dragProvided.draggableProps.style}
                                className={cn(
                                  "sequence-summary-task relative rounded-md border px-2 py-1.5 text-xs",
                                  "pr-6",
                                  isTimelineViolated
                                    ? "animate-blink-inset border-red-500 bg-red-50 dark:bg-red-950/30"
                                    : isHighlighted
                                    ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
                                    : "border-border/70 bg-background",
                                  dragSnapshot.isDragging && "shadow-lg ring-2 ring-custom-blue/40",
                                  !isGroupDragDisabled && "cursor-grab active:cursor-grabbing"
                                )}
                              >
                                {isTimelineViolated && (
                                  <SequenceSummaryViolationIndicator
                                    messages={violationMessages}
                                    logisticCode={entry.logisticCode || "N/D"}
                                    onOpen={(messages, logisticCode) =>
                                      setViolationDialog({ open: true, messages, logisticCode })
                                    }
                                  />
                                )}
                                <div className="min-w-max">
                                  <div className="flex flex-nowrap items-center gap-x-1 whitespace-nowrap text-[11px]">
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
                            )}
                          </Draggable>
                        );
                      })}
                      {provided.placeholder}
                    </ol>
                  )}
                </Droppable>
                </div>
              </div>
            </div>
          );
          })}
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
            className="mt-2 min-h-[120px] resize-none cursor-default whitespace-pre-wrap break-words border-slate-300 bg-white text-foreground focus-visible:ring-0 focus-visible:ring-offset-0 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-50"
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

      <Dialog
        open={violationDialog.open}
        onOpenChange={(open) => setViolationDialog((prev) => ({ ...prev, open }))}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-baseline gap-x-1">
              <span>Violazione timeline</span>
              <span className="text-sm font-normal text-muted-foreground">
                task <strong>{violationDialog.logisticCode}</strong>
              </span>
            </DialogTitle>
          </DialogHeader>
          <ul className="mt-2 space-y-2 text-sm text-foreground">
            {violationDialog.messages.map((message, index) => (
              <li
                key={`${violationDialog.logisticCode}-violation-${index}`}
                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-900 dark:bg-red-950/40"
              >
                {message}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="border-2 border-custom-blue"
              onClick={() => setViolationDialog((prev) => ({ ...prev, open: false }))}
            >
              Chiudi
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}
