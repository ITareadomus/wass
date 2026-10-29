import { useEffect, useState } from "react";
import { Keyboard, KeyRound, Lock } from "lucide-react";
import {
  resolveStructureAccessBundlePresentation,
  type StructureAccessBundle,
} from "@shared/structure-access-keys";
import { registryKeyIcon } from "@shared/key-registry";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const EMPTY_INPUT_CLASS =
  "h-9 border-transparent bg-transparent shadow-none focus-visible:ring-0 px-0 pointer-events-none select-none";

type BundleIconKind = "smart" | "kbox" | "classico" | "unknown";

function BundleTypeIcon({
  kind,
  className,
}: {
  kind: BundleIconKind;
  className?: string;
}) {
  if (kind === "unknown") {
    return (
      <span className="text-lg font-bold leading-none text-slate-500" aria-hidden>
        ?
      </span>
    );
  }
  if (kind === "smart") {
    return <Keyboard className={cn("h-4 w-4 text-red-600", className)} aria-hidden />;
  }
  if (kind === "kbox") {
    return <Lock className={cn("h-4 w-4 text-yellow-500", className)} aria-hidden />;
  }
  return <KeyRound className={cn("h-4 w-4 text-slate-500", className)} aria-hidden />;
}

function bundleButtonClass(kind: BundleIconKind): string {
  if (kind === "smart") {
    return "border-red-200 bg-red-50 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40";
  }
  if (kind === "kbox") {
    return "border-yellow-300 bg-yellow-50 hover:bg-yellow-100 dark:border-yellow-900 dark:bg-yellow-950/40";
  }
  return "border-slate-300 bg-slate-100 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-800";
}

/** Pallino del numero: grigino se sono solo Classico, rosso scuro se c'è Smart, ocra se c'è KBox, rosa se ci sono entrambe. */
function countBadgeClass(tone: BundleIconKind | "both"): string {
  if (tone === "smart") return "bg-red-800 text-white";
  if (tone === "kbox") return "bg-yellow-700 text-yellow-50";
  if (tone === "both") return "bg-pink-500 text-white";
  return "bg-slate-400 text-slate-950";
}

function badgeTone(bundles: StructureAccessBundle[]): BundleIconKind | "both" {
  const kinds = new Set(bundles.map((bundle) => presentBundle(bundle).kind));
  const hasSmart = kinds.has("smart");
  const hasKbox = kinds.has("kbox");
  if (hasSmart && hasKbox) return "both";
  if (hasSmart) return "smart";
  if (hasKbox) return "kbox";
  return "classico";
}

function presentBundle(bundle: StructureAccessBundle): { kind: BundleIconKind; label: string } {
  if (bundle.keysType == null) return { kind: "unknown", label: "Non impostato" };
  return resolveStructureAccessBundlePresentation(bundle.keysTypeLabel);
}

function bundleCaption(bundle: StructureAccessBundle): string {
  const number = bundle.keysNumber?.trim();
  const label = bundle.keysLabel?.trim();
  const mazzo = number ? `Mazzo ${number}` : "Mazzo";
  return label ? `${mazzo} · ${label}` : mazzo;
}

function BundleCard({ bundle }: { bundle: StructureAccessBundle }) {
  const presentation = presentBundle(bundle);
  return (
    <div className="flex gap-3 rounded-xl border bg-muted/30 px-3 py-3">
      <span
        className={cn(
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border",
          bundleButtonClass(presentation.kind)
        )}
      >
        <BundleTypeIcon kind={presentation.kind} />
      </span>
      <div className="min-w-0">
        <p className="font-semibold leading-tight">{presentation.label}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{bundleCaption(bundle)}</p>
        {bundle.choices.length > 0 ? (
          <ul className="mt-1.5 space-y-0.5 text-sm">
            {bundle.choices.map((choice, choiceIndex) => (
              <li key={`${choice.name}-${choiceIndex}`}>
                {choice.name}
                {choice.typeLabel ? ` — ${choice.typeLabel}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function StructureAccessKeyButtons({
  bundles,
  size = "sm",
  layout = "separate",
  physicalKey = false,
}: {
  bundles: StructureAccessBundle[];
  size?: "sm" | "md";
  /** Nel registro chiavi un solo simbolo, con il numero dei mazzi. Nei dialog dei task resta un'icona per mazzo. */
  layout?: "separate" | "badge";
  /** Nel registro, una chiave classica usa sempre il simbolo classico anche se il mazzo visibile è un altro. */
  physicalKey?: boolean;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [badgeOpen, setBadgeOpen] = useState(false);
  const openBundle = openIndex != null ? bundles[openIndex] ?? null : null;

  if (bundles.length === 0 && !physicalKey) return null;

  const buttonSize = size === "md" ? "h-11 w-11" : "h-9 w-9";
  const iconSize = size === "md" ? "h-5 w-5" : "h-4 w-4";

  if (layout === "badge") {
    const countLabel = bundles.length === 1 ? "1 mazzo" : `${bundles.length} mazzi`;
    const tone = badgeTone(bundles);
    const icon = physicalKey ? "classico" : registryKeyIcon(bundles);
    const badgeIcon =
      icon === "smart" ? (
        <Keyboard className={cn(iconSize, "text-red-600")} aria-hidden />
      ) : icon === "kbox" ? (
        <Lock className={cn(iconSize, "text-yellow-500")} aria-hidden />
      ) : icon === "smart-kbox" ? (
        <Lock className={cn(iconSize, "text-pink-500")} aria-hidden />
      ) : icon === "unknown" ? (
        <span className="text-lg font-bold leading-none text-slate-500" aria-hidden>
          ?
        </span>
      ) : (
        <KeyRound className={cn(iconSize, "text-slate-500")} aria-hidden />
      );
    const badgeClass =
      icon === "smart"
        ? bundleButtonClass("smart")
        : icon === "kbox"
          ? bundleButtonClass("kbox")
          : icon === "smart-kbox"
            ? "border-pink-300 bg-pink-50 hover:bg-pink-100 dark:border-pink-800 dark:bg-pink-950/40"
            : bundleButtonClass("classico");
    return (
      <>
        <button
          type="button"
          data-testid="button-key-specs"
          data-viewer-allow=""
          className={cn(
            "relative inline-flex items-center justify-center rounded-full border transition-colors",
            buttonSize,
            badgeClass
          )}
          aria-label={`Apri specifiche chiavi, ${countLabel}`}
          onClick={() => setBadgeOpen(true)}
        >
          {badgeIcon}
          {icon === "classico" && bundles.length > 1 ? (
            <span
              className={cn(
                "absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold leading-none",
                countBadgeClass(tone)
              )}
            >
              {bundles.length}
            </span>
          ) : null}
        </button>
        <Dialog open={badgeOpen} onOpenChange={setBadgeOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Tipologia chiave</DialogTitle>
            </DialogHeader>
            <div className="space-y-2">
              {bundles.map((bundle, index) => (
                <BundleCard
                  key={`${bundle.keysId ?? "bundle"}-${bundle.keysNumber ?? index}-${index}`}
                  bundle={bundle}
                />
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5">
        {bundles.map((bundle, index) => {
          const presentation = presentBundle(bundle);
          const numberLabel = bundle.keysNumber ? `mazzo ${bundle.keysNumber}` : `mazzo ${index + 1}`;
          return (
            <button
              key={`${bundle.keysId ?? "bundle"}-${bundle.keysNumber ?? index}-${index}`}
              type="button"
              data-testid="button-key-specs"
              data-viewer-allow=""
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-sm font-medium transition-colors",
                bundleButtonClass(presentation.kind)
              )}
              aria-label={`Apri ${numberLabel}, ${presentation.label}`}
              onClick={() => setOpenIndex(index)}
            >
              <BundleTypeIcon kind={presentation.kind} className="h-4 w-4" />
              <span>{presentation.label}</span>
            </button>
          );
        })}
      </div>
      <Dialog open={openBundle != null} onOpenChange={(open) => !open && setOpenIndex(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tipologia chiave</DialogTitle>
          </DialogHeader>
          {openBundle ? <BundleCard bundle={openBundle} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function StructureAccessKeyTypeField({ logisticCode }: { logisticCode: string }) {
  const [bundles, setBundles] = useState<StructureAccessBundle[]>([]);
  const [loaded, setLoaded] = useState(false);
  const code = logisticCode.trim();

  useEffect(() => {
    if (!code || code === "N/A") {
      setBundles([]);
      setLoaded(true);
      return;
    }

    let cancelled = false;
    setLoaded(false);
    fetch(`/api/structure-access-bundles?logisticCode=${encodeURIComponent(code)}`, {
      cache: "no-store",
    })
      .then((response) => (response.ok ? response.json() : { bundles: [] }))
      .then((data) => {
        if (cancelled) return;
        setBundles(Array.isArray(data?.bundles) ? data.bundles : []);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setBundles([]);
        setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div>
      <p className="text-sm font-semibold text-muted-foreground">Tipologia chiave</p>
      {!loaded ? (
        <p className="mt-1 text-sm text-muted-foreground">Caricamento...</p>
      ) : bundles.length === 0 ? (
        <Input
          value="NON MIGRATO"
          readOnly
          className={EMPTY_INPUT_CLASS}
          tabIndex={-1}
          onFocus={(event) => event.currentTarget.blur()}
        />
      ) : (
        <div className="mt-1">
          <StructureAccessKeyButtons bundles={bundles} />
        </div>
      )}
    </div>
  );
}
