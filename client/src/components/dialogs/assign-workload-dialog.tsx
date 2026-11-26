import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { WorkloadBalanceChoice } from "@shared/workload-balance-choice";

type CleanerRow = {
  id: number;
  name: string;
  minutes: number;
};

const MIN_WORK_MINUTES = 30;
const MAX_WORK_MINUTES = 14 * 60;

function formatWorkHours(minutes: number): string {
  const safe = Math.max(0, minutes);
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${hours}:${String(rest).padStart(2, "0")}`;
}

function taskCleaningMinutes(task: any): number {
  const minutes = Number(task?.cleaning_time ?? task?.cleaningTime);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

function addTaskMinutes(tasks: unknown, into: Map<number, number>) {
  if (!Array.isArray(tasks)) return;
  for (const task of tasks) {
    const id = Number(task?.task_id ?? task?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (!into.has(id)) into.set(id, taskCleaningMinutes(task));
  }
}

/** Media di pulizia per cleaner, arrotondata alla mezz'ora. */
function averageWorkMinutes(totalMinutes: number, cleanerCount: number): number {
  if (cleanerCount <= 0 || totalMinutes <= 0) return MIN_WORK_MINUTES;
  const rounded = Math.round(totalMinutes / cleanerCount / 30) * 30;
  return Math.min(MAX_WORK_MINUTES, Math.max(MIN_WORK_MINUTES, rounded));
}

/** Le ore toccate restano. Le altre si dividono il resto e scendono a mezz'ore intere. */
function rebalanceHours(rows: CleanerRow[], pinnedIds: Set<number>, budgetMinutes: number): CleanerRow[] {
  const free = rows.filter((row) => !pinnedIds.has(row.id));
  if (free.length === 0) return rows;
  const used = rows.filter((row) => pinnedIds.has(row.id)).reduce((sum, row) => sum + row.minutes, 0);
  const share = (budgetMinutes - used) / free.length;
  const stepped = Math.min(MAX_WORK_MINUTES, Math.max(MIN_WORK_MINUTES, Math.round(share / 30) * 30));
  return rows.map((row) => (pinnedIds.has(row.id) ? row : { ...row, minutes: stepped }));
}

export function AssignWorkloadDialog({
  open,
  onOpenChange,
  date,
  scope,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  scope: string;
  onConfirm: (choice: WorkloadBalanceChoice) => void;
}) {
  const [mode, setMode] = useState<"average" | "custom">("average");
  const [cleaners, setCleaners] = useState<CleanerRow[]>([]);
  const [budgetMinutes, setBudgetMinutes] = useState(0);
  const [pinnedIds, setPinnedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ date, scope });
    const query = params.toString();
    Promise.all([
      fetch(`/api/selected-cleaners?${query}`, { cache: "no-store" }).then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error(payload?.error || "Cleaner non caricati");
        return payload;
      }),
      fetch(`/api/containers?${query}`, { cache: "no-store" }).then((response) => response.json().catch(() => null)),
      fetch(`/api/timeline?${query}`, { cache: "no-store" }).then((response) => response.json().catch(() => null)),
    ])
      .then(([selected, containers, timeline]) => {
        if (cancelled) return;
        const rows = Array.isArray(selected?.cleaners) ? selected.cleaners : [];
        const people = rows
          .map((row: any) => {
            const id = Number(row?.id);
            if (!Number.isFinite(id) || id <= 0) return null;
            const name = [row?.name, row?.lastname].filter(Boolean).join(" ").trim() || `Cleaner ${id}`;
            return { id, name };
          })
          .filter((row: { id: number; name: string } | null): row is { id: number; name: string } => row != null)
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "it"));
        const minutes = new Map<number, number>();
        const buckets = containers?.containers ?? {};
        addTaskMinutes(buckets.early_out?.tasks, minutes);
        addTaskMinutes(buckets.high_priority?.tasks, minutes);
        addTaskMinutes(buckets.low_priority?.tasks, minutes);
        for (const entry of timeline?.cleaners_assignments ?? []) {
          addTaskMinutes(entry?.tasks, minutes);
        }
        const total = [...minutes.values()].reduce((sum, value) => sum + value, 0);
        const minutesEach = averageWorkMinutes(total, people.length);
        setPinnedIds([]);
        setBudgetMinutes(minutesEach * people.length);
        setCleaners(people.map((person: { id: number; name: string }) => ({ ...person, minutes: minutesEach })));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setCleaners([]);
        setError(reason instanceof Error ? reason.message : "Cleaner non caricati");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, date, scope]);

  const confirm = () => {
    if (mode === "average") {
      onConfirm({ mode: "average", targets: [] });
      return;
    }
    const targets: WorkloadBalanceChoice["targets"] = [];
    for (const cleaner of cleaners) {
      targets.push({ cleanerId: cleaner.id, minutes: cleaner.minutes });
    }
    if (targets.length === 0) {
      setError("Nessun cleaner su cui impostare le ore");
      return;
    }
    setError("");
    onConfirm({ mode: "custom", targets });
  };

  const stepCleaner = (cleanerId: number, delta: number) => {
    const nextPinned = pinnedIds.includes(cleanerId) ? pinnedIds : [...pinnedIds, cleanerId];
    setPinnedIds(nextPinned);
    setCleaners((current) => {
      const edited = current.map((row) =>
        row.id === cleanerId
          ? {
              ...row,
              minutes: Math.min(MAX_WORK_MINUTES, Math.max(MIN_WORK_MINUTES, row.minutes + delta)),
            }
          : row
      );
      return rebalanceHours(edited, new Set(nextPinned), budgetMinutes);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bilanciamento delle ore</DialogTitle>
          <DialogDescription>
            Scegli se tutti i cleaner devono avvicinarsi alla stessa media, oppure indica le ore di pulizia preferite per ciascuno.
          </DialogDescription>
        </DialogHeader>
        <RadioGroup
          value={mode}
          onValueChange={(value) => setMode(value === "custom" ? "custom" : "average")}
          className="gap-3"
        >
          <div className="flex items-start gap-2">
            <RadioGroupItem id="workload-average" value="average" className="mt-1" />
            <Label htmlFor="workload-average" className="font-normal leading-snug">
              Stessa media per tutti
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem id="workload-custom" value="custom" className="mt-1" />
            <Label htmlFor="workload-custom" className="font-normal leading-snug">
              Ore preferite cleaner per cleaner
            </Label>
          </div>
        </RadioGroup>
        {mode === "custom" && (
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {loading && <p className="text-sm text-muted-foreground">Caricamento cleaner...</p>}
            {!loading && cleaners.length === 0 && (
              <p className="text-sm text-muted-foreground">Nessun cleaner convocato per questa giornata.</p>
            )}
            {cleaners.map((cleaner) => (
              <div key={cleaner.id} className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{cleaner.name}</span>
                <div className="flex items-center gap-1 rounded-lg border-2 border-custom-blue bg-background px-2 py-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                    type="button"
                    aria-label={`Diminuisci le ore di ${cleaner.name}`}
                    disabled={cleaner.minutes <= MIN_WORK_MINUTES}
                    onClick={() => stepCleaner(cleaner.id, -30)}
                  >
                    <span className="text-lg font-bold">−</span>
                  </Button>
                  <span className="min-w-[60px] text-center font-mono text-lg font-bold">
                    {formatWorkHours(cleaner.minutes)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                    type="button"
                    aria-label={`Aumenta le ore di ${cleaner.name}`}
                    disabled={cleaner.minutes >= MAX_WORK_MINUTES}
                    onClick={() => stepCleaner(cleaner.id, 30)}
                  >
                    <span className="text-lg font-bold">+</span>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Annulla
          </Button>
          <Button type="button" onClick={confirm} disabled={mode === "custom" && (loading || cleaners.length === 0)}>
            Assegna
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
