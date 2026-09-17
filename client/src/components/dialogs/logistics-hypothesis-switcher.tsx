import { Button } from "@/components/ui/button";
import { minutesToHm } from "@shared/logistics-scheduling-constraints";
import { cn } from "@/lib/utils";
import type { LogisticsHypothesisPickerItem } from "@shared/logistics-hypothesis-preview";

export function LogisticsHypothesisSwitcher({
  hypotheses,
  selectedId,
  applyingId,
  onSelect,
  onApply,
  onCancel,
}: {
  hypotheses: LogisticsHypothesisPickerItem[];
  selectedId: string | null;
  applyingId: string | null;
  onSelect: (hypothesisId: string) => void;
  onApply: (hypothesis: LogisticsHypothesisPickerItem) => void;
  onCancel: () => void;
}) {
  const selected =
    hypotheses.find((hypothesis) => hypothesis.summary.id === selectedId) ?? hypotheses[0] ?? null;
  const busy = applyingId != null;

  if (!selected) return null;

  return (
    <div
      className="rounded-lg border-2 border-custom-blue bg-custom-blue-light/40 p-3"
      data-testid="logistics-hypothesis-switcher"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Anteprima giri</p>
          <p className="text-xs text-muted-foreground">
            Cambia ipotesi per vederla in timeline. Non è ancora salvata.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="border-2 border-custom-blue"
            disabled={busy}
            onClick={onCancel}
            data-testid="button-cancel-hypothesis-preview"
          >
            Annulla
          </Button>
          <Button
            type="button"
            className="border-2 border-custom-blue"
            disabled={busy}
            onClick={() => onApply(selected)}
            data-testid="button-apply-selected-hypothesis"
          >
            {busy ? "Applico..." : "Usa questa"}
          </Button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {hypotheses.map((hypothesis) => {
          const active = hypothesis.summary.id === selected.summary.id;
          return (
            <button
              key={hypothesis.summary.id}
              type="button"
              disabled={busy}
              onClick={() => onSelect(hypothesis.summary.id)}
              data-testid={`button-preview-hypothesis-${hypothesis.summary.id}`}
              className={cn(
                "rounded-md border-2 px-3 py-1.5 text-sm font-medium transition-colors",
                active
                  ? "border-custom-blue bg-custom-blue text-black dark:text-white"
                  : "border-custom-blue/50 bg-background text-foreground hover:bg-custom-blue-light"
              )}
            >
              {hypothesis.summary.title}
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <p className="text-sm text-muted-foreground">{selected.summary.description}</p>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <div>
            <dt className="text-muted-foreground">Assegnate</dt>
            <dd className="font-medium">{selected.summary.assignedTaskCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Non assegnate</dt>
            <dd className="font-medium">{selected.summary.droppedTaskCount}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Viaggio</dt>
            <dd className="font-medium">{minutesToHm(selected.summary.totalTravelMin)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Sforamenti</dt>
            <dd className="font-medium">{selected.summary.windowViolationCount}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
