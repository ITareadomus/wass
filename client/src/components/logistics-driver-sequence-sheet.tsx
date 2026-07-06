import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Loader2, MessageCircle, Printer } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SequenceSummaryEntry, SequenceSummaryGroup } from "@/lib/sequence-summary";
import { logisticsKindSequenceDotClass, LogisticsSequenceBadge } from "@/lib/logistics-task-kind-ui";
import { SequenceSummaryViolationIndicator } from "@/components/sequence-summary-violation-indicator";
import { SequenceSummaryGroupHeading } from "@/components/sequence-summary-group-heading";
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
    <span className="sheet-cleaner-cell inline-flex items-center gap-1 whitespace-nowrap">
      {label && <span className="font-medium">{label}</span>}
      {sequence != null && (
        <LogisticsSequenceBadge
          sequence={sequence}
          size="inline"
          className="cleaner-sequence-badge text-foreground/90 print:border print:border-black print:bg-white print:text-black print:shadow-none"
        />
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
    <>
      <button
        type="button"
        className="group inline-flex max-w-[220px] items-start gap-1 text-left hover:text-custom-blue print:hidden"
        onClick={(event) => {
          event.stopPropagation();
          onOpen(text, logisticCode);
        }}
      >
        <MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-custom-blue" />
        <span className="line-clamp-2 whitespace-pre-wrap break-words text-xs">{text}</span>
      </button>
      <span className="hidden whitespace-pre-wrap break-words text-xs print:inline">{text}</span>
    </>
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
    <div
      data-print-driver-sheet
      className={cn(
        "logistics-driver-sheet-page flex w-full min-w-0 max-w-full flex-col overflow-x-hidden bg-background",
        PAGE_BELOW_HEADER_MIN_H,
        "print:min-h-0 print:max-w-none print:overflow-visible"
      )}
    >
      <header className="relative shrink-0 print:bg-white">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-0 h-full w-screen -translate-x-1/2 border-b border-custom-blue/30 bg-custom-blue-light print:hidden"
        />
        <div className="relative mx-auto flex w-full max-w-[1600px] items-center justify-between gap-3 px-4 py-3 print:max-w-none print:px-1 print:py-1">
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
            <div className="min-w-0 print:w-full">
              <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <SequenceSummaryGroupHeading
                    group={group}
                    as="h1"
                    className="print:text-base print:text-black"
                    vehicleNameClassName="print:text-black/70"
                    plateClassName="print:border-black print:bg-white print:text-[11px] print:text-black"
                    taskCountClassName="print:text-black"
                  />
                </div>
                {(group.warehouseDepartureTime || group.warehouseReturnTime) && (
                  <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground print:hidden">
                    {group.warehouseDepartureTime && (
                      <span className="whitespace-nowrap">
                        Partenza dal magazzino: {group.warehouseDepartureTime}
                      </span>
                    )}
                    {group.warehouseReturnTime && (
                      <span className="whitespace-nowrap">
                        Ritorno al magazzino: {group.warehouseReturnTime}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <p className="mt-0.5 hidden text-[11px] text-muted-foreground print:block print:text-black/70">
                {workDate} · {isLoadOrder ? "Ordine di carico" : "Ordine di sequenza"}
              </p>
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {(group.warehouseDepartureTime || group.warehouseReturnTime) && (
              <div className="hidden flex-col items-end gap-0.5 text-right print:flex">
                {group.warehouseDepartureTime && (
                  <p className="whitespace-nowrap text-[11px] text-black">
                    <span className="font-semibold">Partenza magazzino stimata:</span>{" "}
                    {group.warehouseDepartureTime}
                  </p>
                )}
                {group.warehouseReturnTime && (
                  <p className="whitespace-nowrap text-[11px] text-black">
                    <span className="font-semibold">Ritorno magazzino stimato:</span>{" "}
                    {group.warehouseReturnTime}
                  </p>
                )}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex h-7 shrink-0 items-center gap-1 border-2 border-custom-blue px-2 text-[10px] font-semibold print:hidden"
              onClick={() => window.print()}
              title="Stampa scheda"
              aria-label="Stampa scheda"
            >
              <Printer className="h-3 w-3 shrink-0" aria-hidden />
              Stampa
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex h-7 shrink-0 items-center gap-1 border-2 border-custom-blue px-2 text-[10px] font-semibold print:hidden"
              onClick={() => setIsLoadOrder((prev) => !prev)}
            >
              {isLoadOrder ? "Ordine di sequenza" : "Ordine di carico"}
            </Button>
          </div>
        </div>
      </header>

      <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden print:overflow-visible">
        {isLoading && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-background/60 print:hidden">
            <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
          </div>
        )}

        <div className="mx-auto w-full min-w-0 max-w-[1600px] px-4 py-4 print:max-w-none print:px-1 print:py-0">
          <div className="driver-sheet-print-table min-w-0 overflow-x-auto overflow-y-visible rounded-lg border border-custom-blue/40 bg-background shadow-sm print:overflow-visible print:rounded-none print:border-0 print:p-0 print:shadow-none">
          <table className="w-full border-collapse text-xs print:table-fixed print:text-[8px]">
            <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur-sm print:static print:bg-[#eee]">
              <tr className="border-b border-custom-blue/30 print:border-black/40">
                <th className="h-9 w-[52px] min-w-[52px] max-w-[52px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  Seq.
                </th>
                <th className="h-9 min-w-[88px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  <span className="print:hidden">Codice adam</span>
                  <span className="hidden print:inline">Codice</span>
                </th>
                <th className="h-9 min-w-[100px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  Cliente
                </th>
                <th className="h-9 min-w-[140px] border-r border-border/60 px-2 py-2 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  Indirizzo
                </th>
                <th className="h-9 min-w-[140px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  <span className="print:hidden">Finestra di lavoro driver</span>
                  <span className="hidden print:inline">Fin. driver</span>
                </th>
                <th className="h-9 min-w-[140px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  <span className="print:hidden">Finestra di lavoro cleaner</span>
                  <span className="hidden print:inline">Fin. cleaner</span>
                </th>
                <th className="h-9 min-w-[120px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  <span className="print:hidden">Check-out / Check-in</span>
                  <span className="hidden print:inline">Out/In</span>
                </th>
                <th className="h-9 min-w-[120px] border-r border-border/60 px-2 py-2 text-center align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  Cleaner
                </th>
                <th className="h-9 min-w-[100px] border-r border-border/60 px-2 py-2 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  Divani
                </th>
                <th className="h-9 min-w-[160px] px-2 py-2 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-muted-foreground print:min-w-0 print:px-1 print:py-1 print:text-[7px] print:text-black">
                  Note
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
                      "border-b border-border/60 transition-colors",
                      !isTimelineViolated && "hover:bg-muted/50",
                      rowIndex % 2 === 1 && "bg-muted/20",
                      isTimelineViolated && "driver-sheet-row--violated"
                    )}
                    role={isTimelineViolated ? "button" : undefined}
                    tabIndex={isTimelineViolated ? 0 : undefined}
                    aria-label={
                      isTimelineViolated
                        ? `Mostra violazione timeline per task ${entry.logisticCode || "N/D"}`
                        : undefined
                    }
                    onClick={() => {
                      if (!isTimelineViolated) return;
                      setViolationDialog({
                        open: true,
                        logisticCode: entry.logisticCode || "N/D",
                        messages: violationMessages,
                      });
                    }}
                    onKeyDown={(event) => {
                      if (!isTimelineViolated) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setViolationDialog({
                          open: true,
                          logisticCode: entry.logisticCode || "N/D",
                          messages: violationMessages,
                        });
                      }
                    }}
                    >
                    <td className="relative w-[52px] min-w-[52px] max-w-[52px] overflow-visible border-r border-border/40 px-2 py-2 text-center align-middle print:static print:overflow-hidden">
                      {isTimelineViolated && (
                        <span className="print:hidden">
                          <SequenceSummaryViolationIndicator />
                        </span>
                      )}
                      <div className="flex items-center justify-center">
                        <span className={logisticsKindSequenceDotClass(entry.logisticsTaskKind)}>
                          {entry.sequence}
                        </span>
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
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle whitespace-nowrap print:min-w-0 print:whitespace-normal print:px-1 print:py-1">
                      {entry.lgWindow}
                    </td>
                    <td className="border-r border-border/40 px-2 py-2 text-center align-middle whitespace-nowrap print:min-w-0 print:whitespace-normal print:px-1 print:py-1">
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
                    <td className="border-r border-border/40 px-2 py-2 align-top whitespace-nowrap print:min-w-0 print:whitespace-normal print:px-1 print:py-1">
                      {entry.sofabedLabel || "—"}
                    </td>
                    <td className="px-2 py-2 align-top print:min-w-0 print:whitespace-pre-wrap print:break-words print:px-1 print:py-1">
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
