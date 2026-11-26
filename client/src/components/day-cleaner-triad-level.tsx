import { DayTriadMark, type CleanerTriadeLevel } from "@/components/triad-mark";
import { useDayCleanerTriade } from "@/lib/day-cleaner-triade";

/** Il livello del cleaner si cambia solo dall'anagrafica. Qui si vede, non si modifica per la giornata. */
export function DayCleanerTriadLevel({
  workDate,
  cleanerId,
  original,
  enabled,
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

  return (
    <DayTriadMark
      original={original}
      overrideWeight={overrideWeight}
      levels={day.levels}
      trial={Number.isFinite(cleanerId) ? day.trials?.[cleanerId] === true : false}
      cleanerTemporary
      size={size}
      unknown={unknown}
      appearance={appearance}
      className={className}
    />
  );
}
