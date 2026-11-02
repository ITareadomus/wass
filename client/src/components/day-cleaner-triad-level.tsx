import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DayTriadMark, TriadDiamondRow, parseCleanerTriade, type CleanerTriadeLevel } from "@/components/triad-mark";
import { saveDayCleanerTriadeOverride, useDayCleanerTriade } from "@/lib/day-cleaner-triade";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

export function DayCleanerTriadLevel({
  workDate,
  cleanerId,
  original,
  enabled,
  editable = false,
  size = "sm",
  unknown = "question",
  appearance = "real",
  className,
}: {
  workDate: string;
  cleanerId: number;
  original?: CleanerTriadeLevel | null;
  enabled: boolean;
  editable?: boolean;
  size?: "sm" | "md" | "lg";
  unknown?: "question" | "text";
  appearance?: "day" | "real";
  className?: string;
}) {
  const day = useDayCleanerTriade(workDate, enabled);
  const overrideWeight = Number.isFinite(cleanerId) ? day.overrides[cleanerId] ?? null : null;
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [hoverWeight, setHoverWeight] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const mark = (
    <DayTriadMark
      original={original}
      overrideWeight={overrideWeight}
      levels={day.levels}
      size={size}
      unknown={unknown}
      appearance={appearance}
      className={className}
    />
  );

  if (!editable || !Number.isFinite(cleanerId) || cleanerId <= 0 || original === undefined) {
    return mark;
  }

  const originalWeight = parseCleanerTriade(original)?.weight ?? 0;
  const committed = overrideWeight ?? originalWeight;
  const preview = hoverWeight ?? committed;
  const catalog = day.levels
    .map((level) => parseCleanerTriade(level))
    .filter((level): level is NonNullable<typeof level> => level != null)
    .sort((left, right) => left.weight - right.weight);
  const previewLevel = catalog.find((level) => level.weight === preview) ?? null;

  const commit = async (weight: number | null) => {
    if (saving) return;
    if (weight === overrideWeight) {
      setOpen(false);
      return;
    }
    setSaving(true);
    try {
      await saveDayCleanerTriadeOverride(workDate, cleanerId, weight);
      setOpen(false);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Livello Triade",
        description: error?.message || "Impossibile aggiornare il livello di questa giornata",
      });
    } finally {
      setSaving(false);
    }
  };

  const choose = (weight: number) => {
    const next = originalWeight > 0 && weight === originalWeight ? null : weight;
    void commit(next);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setHoverWeight(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center rounded-md px-1 py-0.5 hover:bg-muted/60"
          aria-label="Modifica il livello Triade di questa giornata"
          onClick={(event) => event.stopPropagation()}
        >
          {mark}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[80] w-auto p-3"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="mb-2 text-sm font-semibold text-foreground">Livello di questa giornata</p>
        <div className="flex items-center gap-1" onMouseLeave={() => setHoverWeight(null)}>
          {catalog.map((level) => {
            const weight = level.weight;
            return (
              <button
                key={`${level.name}-${weight}`}
                type="button"
                disabled={saving}
                className="rounded-sm p-0.5 hover:bg-muted/50 disabled:cursor-default"
                aria-label={level.name}
                onMouseEnter={() => setHoverWeight(weight)}
                onFocus={() => setHoverWeight(weight)}
                onClick={() => choose(weight)}
              >
                <TriadDiamondRow
                  level={preview > 0 && weight <= preview ? previewLevel : null}
                  filled={preview > 0 && weight <= preview ? 1 : 0}
                  total={1}
                  size="lg"
                />
              </button>
            );
          })}
        </div>
        <p className={cn("mt-2 min-h-5 text-xs text-muted-foreground")}>
          {previewLevel?.name ?? "Scegli un livello"}
        </p>
        {overrideWeight != null && (
          <button
            type="button"
            className="mt-1 text-xs font-medium text-foreground underline-offset-2 hover:underline"
            disabled={saving}
            onClick={() => void commit(null)}
          >
            Ripristina il livello originale
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
