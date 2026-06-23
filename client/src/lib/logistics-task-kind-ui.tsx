import type { LogisticsTaskKind } from "@shared/logistics-task-kind";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Plus } from "lucide-react";

/** Base condivisa badge logistica (allineata a PREMIUM / PICK-UP nel modale). */
export const LOGISTICS_KIND_BADGE_BASE_CLASS =
  "text-xs shrink-0 px-2 py-0.5 rounded border font-medium";

/** Stesso sfondo azzurro del badge PICK-UP. */
export const LOGISTICS_PICKUP_BADGE_SKY_BG = "bg-sky-100 dark:bg-sky-950";

/** Striscia task: metà viola (sopra) e metà azzurro (sotto). */
export const LOGISTICS_DP_STRIPE_CLASS =
  "bg-[linear-gradient(to_bottom,#a855f7_50%,#0ea5e9_50%)]";

export const LOGISTICS_DELIVERY_BADGE_COLORS =
  "bg-purple-100 text-purple-900 border-purple-600 dark:bg-purple-950 dark:text-purple-200 dark:border-purple-400";

/** Classi colore badge (senza layout base). */
export const LOGISTICS_KIND_BADGE_CLASSES: Record<
  Exclude<LogisticsTaskKind, "delivery/pick-up">,
  string
> = {
  "pick-up": cn(
    LOGISTICS_PICKUP_BADGE_SKY_BG,
    "text-sky-800 border-sky-600 dark:text-sky-200 dark:border-sky-400"
  ),
  delivery: LOGISTICS_DELIVERY_BADGE_COLORS,
};

/** Wrapper angolo sezione: copre il bordo del box sottostante (come le tab Dettagli *). */
export const DIALOG_SECTION_CORNER_BADGE_WRAP_CLASS =
  "absolute -top-3 right-3 z-10 inline-flex items-center rounded-t-md rounded-b-sm bg-background px-0.5 py-px shadow-sm";

export const LOGISTICS_KIND_BADGE_LABEL: Record<LogisticsTaskKind, string> = {
  delivery: "DELIVERY",
  "delivery/pick-up": "D&P",
  "pick-up": "PICK-UP",
};

export const LOGISTICS_KIND_PICKER_OPTIONS: Array<{
  kind: LogisticsTaskKind;
  title: string;
  description: string;
}> = [
  {
    kind: "pick-up",
    title: "PICK-UP",
    description: "Il cleaner ha già il borsone — solo ritiro dello sporco al checkout.",
  },
  {
    kind: "delivery",
    title: "DELIVERY",
    description: "Consegna dotazione, macchinario o materiale al cleaner (solo manuale).",
  },
  {
    kind: "delivery/pick-up",
    title: "D&P",
    description: "Il driver consegna il borsone e ritira lo sporco al checkout.",
  },
];

/** Striscia verticale card timeline logistica. */
export const LOGISTICS_KIND_STRIPE_CLASS: Record<
  Exclude<LogisticsTaskKind, "delivery/pick-up">,
  string
> = {
  "pick-up": "bg-sky-500",
  delivery: "bg-purple-500",
};

export const LOGISTICS_KIND_STRIPE_UNKNOWN_CLASS = "bg-gray-400";

export function logisticsKindStripeClass(kind: LogisticsTaskKind | null): string {
  if (kind === "delivery/pick-up") return LOGISTICS_DP_STRIPE_CLASS;
  if (kind === "pick-up") return LOGISTICS_KIND_STRIPE_CLASS["pick-up"];
  if (kind === "delivery") return LOGISTICS_KIND_STRIPE_CLASS.delivery;
  return LOGISTICS_KIND_STRIPE_UNKNOWN_CLASS;
}

export function logisticsKindSequenceDotClass(kind: LogisticsTaskKind | null): string {
  return cn(
    "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white shadow-sm",
    logisticsKindStripeClass(kind)
  );
}

/** Badge sequenza su card timeline logistica (angolo in alto a destra). */
export function logisticsSequenceBadgeClass(
  label: string | number,
  size: "card" | "inline" = "card"
): string {
  const text = String(label);
  const multi = text.length > 1;

  if (size === "inline") {
    return cn(
      "inline-flex shrink-0 items-center justify-center box-border rounded-full border border-border/80 bg-background/95 p-0 font-extrabold leading-none text-foreground shadow-sm",
      multi ? "h-[15px] min-w-[15px] max-h-[15px] px-0.5 text-[8px]" : "size-[15px] text-[9px]"
    );
  }

  return cn(
    "flex shrink-0 items-center justify-center box-border rounded-full border border-border/80 bg-background/95 p-0 font-extrabold leading-none text-foreground shadow-sm",
    multi ? "h-4 min-w-4 max-h-4 px-0.5 text-[9px]" : "size-4 max-h-4 text-[10px]"
  );
}

export function LogisticsSequenceBadge({
  sequence,
  size = "card",
  className,
}: {
  sequence: string | number;
  size?: "card" | "inline";
  className?: string;
}) {
  const label = String(sequence);
  return (
    <span
      className={cn(logisticsSequenceBadgeClass(label, size), className)}
      title={`Sequenza ${label}`}
    >
      {label}
    </span>
  );
}

export function logisticsKindBadgeClass(kind: LogisticsTaskKind): string {
  if (kind === "delivery/pick-up") {
    return "border-purple-600 dark:border-purple-400 text-purple-900 dark:text-purple-200";
  }
  return LOGISTICS_KIND_BADGE_CLASSES[kind];
}

export function LogisticsKindBadge({ kind }: { kind: LogisticsTaskKind }) {
  if (kind === "delivery/pick-up") {
    return (
      <Badge
        variant="outline"
        className={cn(
          LOGISTICS_KIND_BADGE_BASE_CLASS,
          "relative overflow-hidden",
          LOGISTICS_PICKUP_BADGE_SKY_BG,
          logisticsKindBadgeClass(kind)
        )}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-purple-100 dark:bg-purple-950 [clip-path:polygon(0_0,100%_0,0_100%)]"
        />
        <span className="relative z-[1]">{LOGISTICS_KIND_BADGE_LABEL[kind]}</span>
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn(LOGISTICS_KIND_BADGE_BASE_CLASS, logisticsKindBadgeClass(kind))}
    >
      {LOGISTICS_KIND_BADGE_LABEL[kind]}
    </Badge>
  );
}

export function LogisticsKindAddBadge({
  onClick,
  disabled = false,
}: {
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label="Imposta tipologia task logistico"
      className={cn(
        "inline-flex items-center justify-center transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
        LOGISTICS_KIND_BADGE_BASE_CLASS,
        "min-w-[2rem] border-dashed border-muted-foreground/45 text-muted-foreground",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:border-sky-600 hover:text-sky-700 dark:hover:border-sky-400 dark:hover:text-sky-200"
      )}
    >
      <Plus className="h-3.5 w-3.5" aria-hidden />
    </button>
  );
}

export function LogisticsKindPickerDialog({
  open,
  onOpenChange,
  taskLabel,
  onSelect,
  isSaving = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskLabel: string;
  onSelect: (kind: LogisticsTaskKind) => void;
  isSaving?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !isSaving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Tipologia task logistico</DialogTitle>
          <DialogDescription>
            Task <strong>{taskLabel}</strong> — seleziona la tipologia del task logistico.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-2 space-y-2">
          {LOGISTICS_KIND_PICKER_OPTIONS.map((option) => (
            <button
              key={option.kind}
              type="button"
              disabled={isSaving}
              onClick={() => onSelect(option.kind)}
              className={cn(
                "flex w-full items-center gap-3 rounded-md border border-border bg-background p-3 text-left transition-colors",
                isSaving
                  ? "cursor-not-allowed opacity-60"
                  : "cursor-pointer hover:border-sky-600 hover:bg-muted/40"
              )}
            >
              <div className="flex w-[5.5rem] shrink-0 items-center justify-start">
                <LogisticsKindBadge kind={option.kind} />
              </div>
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-sm font-semibold leading-tight text-foreground">{option.title}</p>
                <p className="text-xs leading-snug text-muted-foreground">{option.description}</p>
              </div>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
