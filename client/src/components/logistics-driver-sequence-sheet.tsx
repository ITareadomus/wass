import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Loader2, MessageCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SequenceSummaryEntry, SequenceSummaryGroup } from "@/lib/sequence-summary";
import { logisticsKindSequenceDotClass, LogisticsSequenceBadge } from "@/lib/logistics-task-kind-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { PAGE_BELOW_HEADER_MIN_H } from "@/components/page-viewport-centered";

function SheetCheckInOut({
  checkoutTime,
  checkinTime,
}: {
  checkoutTime?: string | null;
  checkinTime?: string | null;
}) {
  const checkout = String(checkoutTime ?? "").trim();
  const checkin = String(checkinTime ?? "").trim();
  if (!checkout && !checkin) return <span className="text-muted-foreground">—</span>;

  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      {checkout && (
        <span className="inline-flex items-center gap-0.5">
          <span className="font-black text-[#257537]">↑</span>
          <span className="font-semibold text-[#137537]">{checkout}</span>
        </span>
      )}
      {checkin && (
        <span className="inline-flex items-center gap-0.5">
          <span className="font-black text-red-600">↓</span>
          <span className="font-semibold text-red-600">{checkin}</span>
        </span>
      )}
    </span>
  );
}

function SheetCleanerCell({
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

  if (!label && sequence == null) return <span className="text-muted-foreground">—</span>;

  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {label && <span className="font-medium">{label}</span>}
      {sequence != null && (
        <LogisticsSequenceBadge sequence={sequence} size="inline" className="text-foreground/90" />
      )}
    </span>
  );
}

function SheetCustomerNoteCell({
  note,
  logisticCode,
  onOpen,
}: {
  note: string;
  logisticCode: string;
  onOpen: (note: string, logisticCode: string) => void;
}) {
  const text = String(note ?? "").trim();
  if (!text) return <span className="text-muted-foreground">—</span>;

  return (
    <button
      type="button"
      className="group inline-flex max-w-[220px] items-start gap-1 text-left hover:text-custom-blue"
      onClick={() => onOpen(text, logisticCode)}
    >
      <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-custom-blue" />
      <span className="line-clamp-2 whitespace-pre-wrap break-words text-xs">{text}</span>
    </button>
  );
}

interface LogisticsDriverSequenceSheetProps {
  group: SequenceSummaryGroup;
  workDate: string;
  backHref: string;
  isLoading?: boolean;
}

export default function LogisticsDriverSequenceSheet({
  group,
  workDate,
  backHref,
  isLoading = false,
}: LogisticsDriverSequenceSheetProps) {
  const [isLoadOrder, setIsLoadOrder] = useState(false);
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

  const displayedTasks = useMemo(
    () => (isLoadOrder ? [...group.tasks].reverse() : group.tasks),
    [group.tasks, isLoadOrder]
  );

  return (
    <div className={cn("logistics-driver-sheet-page flex w-full min-w-0 max-w-full flex-col overflow-x-hidden bg-background", PAGE_BELOW_HEADER_MIN_H)}>
      <header className="relative shrink-0 print:bg-white">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-full w-screen -translate-x-1/2 border-b border-custom-blue/30 bg-custom-blue-light print:border-black/20 print:bg-white"
        />
        <div className="relative mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link href={backHref}>
              <Button
                variant="outline"
                size="sm"
                className="flex h-7 w-7 shrink-0 items-center justify-center border-2 border-custom-blue p-0 print:hidden"
                title="Torna al resoconto"
                aria-label="Torna al resoconto"
              >
                <ArrowLeft className="h-3 w-3 shrink-0" aria-hidden />
              </Button>
            </Link>
            <div className="min-w-0">
              <h1 className="flex min-w-0 flex-nowrap items-center gap-x-2 whitespace-nowrap text-sm font-semibold text-foreground">
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
              </h1>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto flex h-7 shrink-0 items-center gap-1 border-2 border-custom-blue px-2 text-[10px] font-semibold print:hidden"
            onClick={() => setIsLoadOrder((prev) => !prev)}
          >
            {isLoadOrder ? "Ordine di sequenza" : "Ordine di carico"}
          </Button>
        </div>
      </header>

      <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60">
            <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
          </div>
        )}

        <div className="mx-auto w-full min-w-0 max-w-[1600px] px-4 py-4">
          <div className="min-w-0 overflow-x-auto rounded-lg border border-custom-blue/40 bg-background shadow-sm">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur-sm print:bg-gray-100">
              <tr className="border-b border-custom-blue/30">
                <th className="h-9 w-[52px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Seq.
                </th>
                <th className="h-9 min-w-[88px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Codice adam
                </th>
                <th className="h-9 min-w-[100px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Alias cliente
                </th>
                <th className="h-9 min-w-[140px] border-r border-border/60 px-2 py-2 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Indirizzo
                </th>
                <th className="h-9 min-w-[140px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Finestra di lavoro driver
                </th>
                <th className="h-9 min-w-[140px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Finestra di lavoro cleaner
                </th>
                <th className="h-9 min-w-[120px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Check-out / Check-in
                </th>
                <th className="h-9 min-w-[120px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Cleaner / Sequenza
                </th>
                <th className="h-9 min-w-[100px] border-r border-border/60 px-2 py-2 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Divani letto
                </th>
                <th className="h-9 min-w-[160px] px-2 py-2 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Note cliente
                </th>
              </tr>
            </thead>
            <tbody>
              {displayedTasks.map((entry: SequenceSummaryEntry, rowIndex) => {
                const isTimelineViolated = entry.timelineViolated === true;
                const violationMessages = entry.violationMessages ?? [];

                return (
                  <tr
                    key={`${group.id}-${entry.taskId}`}
                    className={cn(
                      "border-b border-border/60 transition-colors hover:bg-muted/50",
                      rowIndex % 2 === 1 && !isTimelineViolated && "bg-muted/20",
                      isTimelineViolated && "bg-red-50 dark:bg-red-950/30"
                    )}
                  >
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle">
                      <div className="flex items-center justify-center gap-1">
                        <span className={logisticsKindSequenceDotClass(entry.logisticsTaskKind)}>
                          {entry.sequence}
                        </span>
                        {isTimelineViolated && (
                          <button
                            type="button"
                            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white hover:bg-red-700"
                            onClick={() =>
                              setViolationDialog({
                                open: true,
                                logisticCode: entry.logisticCode || "N/D",
                                messages: violationMessages,
                              })
                            }
                            aria-label="Mostra violazione timeline"
                          >
                            !
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle font-semibold">
                      {entry.logisticCode || "N/D"}
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle">
                      {entry.customerAlias || "—"}
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 align-top">
                      {entry.address || "—"}
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle whitespace-nowrap">
                      {entry.lgWindow}
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle whitespace-nowrap">
                      {entry.hkWindow}
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle">
                      <div className="flex justify-center">
                        <SheetCheckInOut
                          checkoutTime={entry.checkoutTime}
                          checkinTime={entry.checkinTime}
                        />
                      </div>
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle">
                      <div className="flex justify-center">
                        <SheetCleanerCell
                          cleanerLabel={entry.cleanerLabel}
                          cleanerSequence={entry.cleanerSequence}
                        />
                      </div>
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 align-top whitespace-nowrap">
                      {entry.sofabedLabel || "—"}
                    </td>
                    <td className="px-2 py-2 align-top">
                      <SheetCustomerNoteCell
                        note={entry.customerNote ?? ""}
                        logisticCode={entry.logisticCode || "N/D"}
                        onOpen={(note, logisticCode) =>
                          setCustomerNoteDialog({ open: true, note, logisticCode })
                        }
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      <Dialog
        open={customerNoteDialog.open}
        onOpenChange={(open) => setCustomerNoteDialog((prev) => ({ ...prev, open }))}
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
              onClick={() => setCustomerNoteDialog((prev) => ({ ...prev, open: false }))}
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
    </div>
  );
}
