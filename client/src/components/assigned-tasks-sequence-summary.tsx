import { Fragment, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ListOrdered, Loader2, Maximize2 } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { SequenceSummaryGroup } from "@/lib/sequence-summary";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SequenceSummaryGroupHeading } from "@/components/sequence-summary-group-heading";
import {
  getSequenceSummaryTaskRowClassName,
  SequenceSummaryTaskContent,
} from "@/components/sequence-summary-task-row";
import {
  appDndDraggableAttributes,
  appDndHandleAttributes,
  DND_SORTABLE_ID_ATTRIBUTE,
  DndDroppableSortableContainer,
  taskDndId,
  type AppDndItem,
} from "@/lib/dnd";

/** Altezza spacer di insert cross-driver (riga summary ~ py-1.5 + testo). */
const SUMMARY_CROSS_INSERT_HEIGHT_PX = 40;

interface AssignedTasksSequenceSummaryProps {
  groups: SequenceSummaryGroup[];
  searchTask?: string;
  staffLabel?: string;
  isDragDisabled?: boolean;
  loadingDriverIds?: number[];
  workDate?: string;
  draggingOverDriverId?: number | null;
  activeDragDriverId?: number | null;
  lastValidDragIndex?: number | null;
}

function DndSummaryTaskItem({
  id,
  data,
  disabled,
  className,
  collapsePullPx = 0,
  onClick,
  onKeyDown,
  role,
  tabIndex,
  ariaLabel,
  children,
}: {
  id: string;
  data: AppDndItem;
  disabled: boolean;
  className: string;
  /** Chiude il buco sulla riga sorgente in drag cross-driver (marginBottom negativo). */
  collapsePullPx?: number;
  onClick: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLLIElement>) => void;
  role?: string;
  tabIndex?: number;
  ariaLabel?: string;
  children: (state: { isDragging: boolean }) => ReactNode;
}) {
  const nodeRef = useRef<HTMLLIElement | null>(null);
  const dataWithOverlayRect = useMemo(
    () => ({
      ...data,
      getDragOverlayRect: () => {
        const rect = nodeRef.current?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height } : null;
      },
    }),
    [data],
  );
  const sortable = useSortable({
    id,
    data: dataWithOverlayRect,
    disabled,
    transition: {
      duration: 180,
      easing: "cubic-bezier(0.25, 1, 0.5, 1)",
    },
  });

  const shouldPullSiblings = collapsePullPx > 0 && sortable.isDragging;

  const style: CSSProperties = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    opacity: sortable.isDragging ? 0 : undefined,
    visibility: sortable.isDragging ? "hidden" : undefined,
    // Mantieni l'altezza per active.rect; il margin negativo chiude il buco.
    ...(shouldPullSiblings ? { marginBottom: -collapsePullPx } : null),
  };

  return (
    <li
      ref={(node) => {
        nodeRef.current = node;
        sortable.setNodeRef(node);
      }}
      {...sortable.attributes}
      {...sortable.listeners}
      {...appDndDraggableAttributes}
      {...appDndHandleAttributes}
      {...{ [DND_SORTABLE_ID_ATTRIBUTE]: String(id) }}
      style={style}
      className={className}
      role={role}
      tabIndex={tabIndex}
      aria-label={ariaLabel}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children({ isDragging: sortable.isDragging })}
    </li>
  );
}

function matchesSearch(entry: SequenceSummaryGroup["tasks"][number], query: string): boolean {
  const lowerSearch = query.toLowerCase();
  return (
    entry.taskId.toLowerCase().includes(lowerSearch) ||
    entry.logisticCode.toLowerCase().includes(lowerSearch) ||
    String(entry.customerAlias ?? "").toLowerCase().includes(lowerSearch) ||
    entry.address.toLowerCase().includes(lowerSearch)
  );
}

export default function AssignedTasksSequenceSummary({
  groups,
  searchTask = "",
  staffLabel = "Cleaner",
  isDragDisabled = false,
  loadingDriverIds = [],
  workDate = "",
  draggingOverDriverId = null,
  activeDragDriverId = null,
  lastValidDragIndex = null,
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
  const isSummaryDragging =
    activeDragDriverId != null || draggingOverDriverId != null;

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
            const itemIds = displayedTasks.map((entry) =>
              taskDndId("logistics", entry.taskId, group.id, "summary")
            );

            const isCrossDriverTargetCol =
              isSummaryDragging &&
              draggingOverDriverId === group.id &&
              activeDragDriverId != null &&
              activeDragDriverId !== group.id &&
              lastValidDragIndex != null;
            const isCrossDriverSourceCol =
              isSummaryDragging &&
              activeDragDriverId === group.id &&
              draggingOverDriverId != null &&
              draggingOverDriverId !== group.id;

            const renderCrossDriverInsertSlot = (atIndex: number) =>
              isCrossDriverTargetCol && lastValidDragIndex === atIndex ? (
                <li
                  key={`cross-insert-${group.id}-${atIndex}`}
                  className="list-none flex-shrink-0 rounded-md border border-dashed border-custom-blue/40 bg-custom-blue/5"
                  style={{ height: `${SUMMARY_CROSS_INSERT_HEIGHT_PX}px` }}
                  aria-hidden
                />
              ) : null;

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
                <div className="min-w-0">
                  <SequenceSummaryGroupHeading group={group} />
                </div>
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
                      {isLoadOrder ? "Ordine di giro" : "Ordine di carico"}
                    </Button>
                  </div>
                </div>
              </div>

              <DndDroppableSortableContainer
                scope="logistics"
                type="summary"
                staffId={group.id}
                itemIds={itemIds}
                insertIndex={displayedTasks.length}
                disabled={isGroupDragDisabled}
                orientation="vertical"
                className={({ isOver }) =>
                  cn(
                    "sequence-summary-driver-scroll flex min-h-0 min-w-0 flex-1 flex-col rounded-md bg-background/70 pb-0.5",
                    isOver && "ring-1 ring-custom-blue/30",
                  )
                }
              >
                {({ isOver }) => (
                    <ol
                      className={cn(
                        "sequence-summary-task-list flex min-w-max flex-col gap-1.5",
                        isOver && "rounded-md bg-custom-blue/5"
                      )}
                    >
                      {displayedTasks.map((entry, index) => {
                        const isHighlighted = searchTask.trim()
                          ? matchesSearch(entry, searchTask.trim())
                          : false;
                        const isTimelineViolated = entry.timelineViolated === true;
                        const violationMessages = entry.violationMessages ?? [];

                        return (
                          <Fragment key={`${group.id}-${entry.taskId}`}>
                            {renderCrossDriverInsertSlot(index)}
                            <DndSummaryTaskItem
                              id={taskDndId("logistics", entry.taskId, group.id, "summary")}
                              data={{
                                kind: "task",
                                scope: "logistics",
                                taskId: String(entry.taskId),
                                index,
                                initialIndex: index,
                                from: {
                                  type: "summary",
                                  staffId: group.id,
                                },
                                getTask: () => entry,
                              }}
                              disabled={isGroupDragDisabled}
                              collapsePullPx={
                                isCrossDriverSourceCol
                                  ? SUMMARY_CROSS_INSERT_HEIGHT_PX
                                  : 0
                              }
                              className={cn(
                                getSequenceSummaryTaskRowClassName({
                                  isTimelineViolated,
                                  isHighlighted,
                                  executionStatus: entry.executionStatus,
                                }),
                                !isGroupDragDisabled &&
                                  !isTimelineViolated &&
                                  "cursor-grab active:cursor-grabbing",
                              )}
                              role={isTimelineViolated ? "button" : undefined}
                              tabIndex={isTimelineViolated ? 0 : undefined}
                              ariaLabel={
                                isTimelineViolated
                                  ? `Mostra violazione timeline per task ${entry.logisticCode || "N/D"}`
                                  : undefined
                              }
                              onClick={() => {
                                if (!isTimelineViolated) return;
                                setViolationDialog({
                                  open: true,
                                  messages: violationMessages,
                                  logisticCode: entry.logisticCode || "N/D",
                                });
                              }}
                              onKeyDown={(event) => {
                                if (!isTimelineViolated) return;
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  setViolationDialog({
                                    open: true,
                                    messages: violationMessages,
                                    logisticCode: entry.logisticCode || "N/D",
                                  });
                                }
                              }}
                            >
                              {() => (
                                <SequenceSummaryTaskContent
                                  entry={entry}
                                  onCustomerNoteOpen={(note, logisticCode) =>
                                    setCustomerNoteDialog({ open: true, note, logisticCode })
                                  }
                                />
                              )}
                            </DndSummaryTaskItem>
                          </Fragment>
                        );
                      })}
                      {renderCrossDriverInsertSlot(displayedTasks.length)}
                    </ol>
                )}
              </DndDroppableSortableContainer>
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
