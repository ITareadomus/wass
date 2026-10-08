import { useState } from "react";
import { History } from "lucide-react";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type TaskTier = "premium" | "standard" | "straordinaria";

type AssignmentChange = {
  kind: "added" | "removed" | "moved" | "reordered";
  task: string;
  tier?: TaskTier;
  from?: string;
  to?: string;
  fromSequence?: number;
  toSequence?: number;
};

type RevisionRow = {
  revision: number;
  created_at: string;
  created_by: string | null;
  modification_type: string | null;
  changes?: AssignmentChange[];
  detail?: string | null;
  detailTier?: TaskTier | null;
};

const ACTION_LABELS: Record<string, string> = {
  task_moved: "Task spostato",
  task_reordered_same_cleaner: "Task riordinato sullo stesso cleaner",
  task_reordered_same_driver: "Task riordinato sullo stesso autista",
  dnd_reorder_same_cleaner: "Task riordinato sullo stesso cleaner",
  dnd_between_cleaners: "Task spostato tra cleaner",
  dnd_between_drivers: "Task spostato tra autisti",
  dnd_from_early_out: "Task preso da Early out",
  dnd_from_high_priority: "Task preso da High priority",
  dnd_from_low_priority: "Task preso da Low priority",
  task_assigned_manually: "Task assegnato",
  task_removed_from_timeline: "Task rimosso dalla timeline",
  task_edit: "Task modificato",
  swap_cleaners_tasks: "Task scambiati tra cleaner",
  swap_drivers_tasks: "Task scambiati tra autisti",
  cleaner_added_to_timeline: "Cleaner aggiunto",
  cleaner_removed_from_selection: "Cleaner rimosso",
  cleaner_replaced: "Cleaner sostituito",
  timeline_reset: "Assegnazioni azzerate",
  reset: "Assegnazioni azzerate",
  sync_from_adam: "Sync da ADAM",
  transfer_to_adam: "Invio ad ADAM",
  api_save_timeline: "Salvataggio timeline",
  api_save_logistics_timeline: "Salvataggio timeline",
  manual: "Modifica manuale",
  optimizer_auto_assign: "Assegnazione automatica",
  first_task_reschedule: "Orario del primo task spostato",
  first_task_start_reset: "Orario del primo task ricalcolato",
  schedule_absorption_recalc: "Orari ricalcolati",
  timeline_rehydrate_preassigned: "Task preassegnati riallineati",
  timeline_synced_assignments_from_adam: "Assegnazioni allineate da ADAM",
  prune_empty_operational_day: "Task rimossi a fine giornata",
  auto_assign_early_out: "Assegnazione automatica Early out",
  auto_assign_high_priority: "Assegnazione automatica High priority",
  auto_assign_low_priority: "Assegnazione automatica Low priority",
};

function hidesAssignmentList(type: string | null): boolean {
  const key = String(type || "").trim();
  if (key === "timeline_reset" || key === "reset") return true;
  if (key.startsWith("auto_assign_")) return true;
  if (key.startsWith("optimizer") || key.startsWith("wave-")) return true;
  return false;
}

function actionLabel(type: string | null): string {
  const key = String(type || "").trim();
  if (!key) return "Modifica";
  if (ACTION_LABELS[key]) return ACTION_LABELS[key];
  if (key.startsWith("optimizer") || key.startsWith("wave-")) return "Assegnazione automatica";
  if (key.startsWith("dnd_from_")) return "Task preso da un container";
  return "Modifica";
}

function actorLabel(actor: string | null): string {
  const value = String(actor || "").trim();
  if (!value || value === "unknown" || value === "system" || value === "python_script") return "Sistema";
  if (value.startsWith("optimizer")) return "Ottimizzatore";
  return value;
}

function changeRest(change: AssignmentChange): string {
  if (change.kind === "added") return `assegnato a ${change.to}`;
  if (change.kind === "removed") return `rimosso da ${change.from}`;
  if (change.kind === "moved") return `da ${change.from} a ${change.to}`;
  return `da posizione ${change.fromSequence} a ${change.toSequence}`;
}

function splitTaskLine(text: string): { task: string; rest: string } | null {
  const match = /^(\d+)\s+(.+)$/.exec(text.trim());
  if (!match) return null;
  return { task: match[1], rest: match[2] };
}

const TASK_TIER_CLASS: Record<TaskTier, string> = {
  straordinaria: "border-red-500 bg-red-100 text-red-800 dark:border-red-400 dark:bg-red-950 dark:text-red-200",
  premium: "border-yellow-600 bg-yellow-100 text-yellow-900 dark:border-yellow-400 dark:bg-yellow-950 dark:text-yellow-200",
  standard: "border-green-600 bg-green-100 text-green-900 dark:border-green-400 dark:bg-green-950 dark:text-green-200",
};

function HistoryTaskLine({ task, rest, tier }: { task: string; rest: string; tier?: TaskTier | null }) {
  return (
    <li className="flex items-baseline gap-2">
      <span
        className={`inline-flex min-w-[3.25rem] shrink-0 justify-center rounded border px-1.5 py-0.5 text-[12px] font-extrabold tabular-nums leading-none ${TASK_TIER_CLASS[tier ?? "standard"]}`}
      >
        {task}
      </span>
      <span className="text-xs leading-snug text-foreground">{rest}</span>
    </li>
  );
}

function whenLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "dd/MM HH:mm", { locale: it });
}

export function TimelineActionHistoryButton({
  workDate,
  variant,
  scope,
}: {
  workDate: string;
  variant: "housekeeping" | "logistics";
  scope?: string;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<RevisionRow[]>([]);
  const [expandedRevisions, setExpandedRevisions] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = async () => {
    setLoading(true);
    setFailed(false);
    try {
      const params = new URLSearchParams({ date: workDate });
      if (variant === "housekeeping" && scope) params.set("scope", scope);
      const path =
        variant === "logistics"
          ? "/api/logistics-timeline-action-history"
          : "/api/timeline-action-history";
      const response = await fetch(`${path}?${params.toString()}`);
      if (!response.ok) throw new Error("cronologia");
      const data = await response.json();
      setRows(Array.isArray(data.revisions) ? data.revisions.slice(0, 5) : []);
    } catch {
      setFailed(true);
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="border-2 border-custom-blue px-2"
        title="Cronologia"
        aria-label="Apri cronologia azioni"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <History className="h-4 w-4" />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setExpandedRevisions([]);
        }}
      >
        <DialogContent className="flex max-h-[80vh] max-w-lg flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <DialogTitle>Cronologia</DialogTitle>
            <DialogDescription>
              Ultime cinque azioni su questa giornata. Solo lettura.
            </DialogDescription>
          </DialogHeader>
          {loading ? (
            <p className="text-sm text-muted-foreground">Caricamento...</p>
          ) : failed ? (
            <p className="text-sm text-muted-foreground">Cronologia non disponibile.</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nessuna azione registrata per questa data.</p>
          ) : (
            <ol className="min-h-0 space-y-2 overflow-y-auto pr-1">
              {rows.map((row) => {
                const omitTasks = hidesAssignmentList(row.modification_type);
                const detail = omitTasks ? null : row.detail;
                const detailLine = detail ? splitTaskLine(detail) : null;
                const changes = omitTasks ? [] : (row.changes ?? []);
                const expanded = expandedRevisions.includes(row.revision);
                const visibleChanges = expanded ? changes : changes.slice(0, 4);
                const hiddenCount = changes.length - 4;
                return (
                  <li
                    key={row.revision}
                    className="rounded-md border border-border border-l-2 border-l-custom-blue bg-muted/40 px-3 py-2.5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-semibold leading-snug text-foreground">
                        {actionLabel(row.modification_type)}
                      </p>
                      <span className="shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground">
                        {whenLabel(row.created_at)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">{actorLabel(row.created_by)}</p>
                    {(detail || changes.length > 0) && (
                      <ul className="mt-2 space-y-1.5">
                        {detailLine && (
                          <HistoryTaskLine task={detailLine.task} rest={detailLine.rest} tier={row.detailTier} />
                        )}
                        {!detailLine && detail && (
                          <li className="text-xs leading-snug text-foreground">{detail}</li>
                        )}
                        {visibleChanges.map((change, index) => (
                          <HistoryTaskLine
                            key={`${row.revision}-${change.kind}-${change.task}-${index}`}
                            task={change.task}
                            rest={changeRest(change)}
                            tier={change.tier}
                          />
                        ))}
                        {hiddenCount > 0 && (
                          <li>
                            <button
                              type="button"
                              className="pl-1 text-xs text-custom-blue underline-offset-2 hover:underline"
                              onClick={() =>
                                setExpandedRevisions((current) =>
                                  expanded
                                    ? current.filter((revision) => revision !== row.revision)
                                    : [...current, row.revision],
                                )
                              }
                            >
                              {expanded
                                ? "Mostra meno"
                                : hiddenCount === 1
                                  ? "e un altro task"
                                  : `e altri ${hiddenCount} task`}
                            </button>
                          </li>
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
