import { useEffect, useState } from "react";
import { Keyboard, KeyRound, Lock } from "lucide-react";
import {
  resolveStructureAccessBundlePresentation,
  type StructureAccessBundle,
} from "@shared/structure-access-keys";
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

function BundleTypeIcon({
  kind,
  className,
}: {
  kind: "smart" | "kbox" | "classico";
  className?: string;
}) {
  if (kind === "smart") {
    return <Keyboard className={cn("h-4 w-4 text-red-600", className)} aria-hidden />;
  }
  if (kind === "kbox") {
    return <Lock className={cn("h-4 w-4 text-yellow-500", className)} aria-hidden />;
  }
  return <KeyRound className={cn("h-4 w-4 text-slate-500", className)} aria-hidden />;
}

function bundleButtonClass(kind: "smart" | "kbox" | "classico"): string {
  if (kind === "smart") {
    return "border-red-200 bg-red-50 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/40";
  }
  if (kind === "kbox") {
    return "border-yellow-300 bg-yellow-50 hover:bg-yellow-100 dark:border-yellow-900 dark:bg-yellow-950/40";
  }
  return "border-slate-300 bg-slate-100 hover:bg-slate-200 dark:border-slate-600 dark:bg-slate-800";
}

export function StructureAccessKeyTypeField({ logisticCode }: { logisticCode: string }) {
  const [bundles, setBundles] = useState<StructureAccessBundle[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const code = logisticCode.trim();

  useEffect(() => {
    setOpenIndex(null);
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

  const openBundle = openIndex != null ? bundles[openIndex] ?? null : null;
  const openPresentation = resolveStructureAccessBundlePresentation(openBundle?.keysTypeLabel);

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
        <div className="mt-1 flex flex-wrap gap-2">
          {bundles.map((bundle, index) => {
            const presentation = resolveStructureAccessBundlePresentation(bundle.keysTypeLabel);
            const numberLabel = bundle.keysNumber ? `mazzo ${bundle.keysNumber}` : `mazzo ${index + 1}`;
            return (
              <button
                key={`${bundle.keysId ?? "bundle"}-${bundle.keysNumber ?? index}-${index}`}
                type="button"
                className={cn(
                  "inline-flex h-9 w-9 items-center justify-center rounded-full border transition-colors",
                  bundleButtonClass(presentation.kind)
                )}
                aria-label={`Apri ${numberLabel}, ${presentation.label}`}
                onClick={() => setOpenIndex(index)}
              >
                <BundleTypeIcon kind={presentation.kind} />
              </button>
            );
          })}
        </div>
      )}

      <Dialog open={openBundle != null} onOpenChange={(open) => !open && setOpenIndex(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Tipologia chiave</DialogTitle>
          </DialogHeader>
          {openBundle && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-semibold text-muted-foreground">Numero mazzo</p>
                <p>{openBundle.keysNumber || "—"}</p>
              </div>
              <div>
                <p className="font-semibold text-muted-foreground">Etichetta</p>
                <p>{openBundle.keysLabel || "—"}</p>
              </div>
              <div>
                <p className="font-semibold text-muted-foreground">Tipo</p>
                <p className="flex items-center gap-2">
                  <BundleTypeIcon kind={openPresentation.kind} />
                  <span>{openPresentation.label}</span>
                </p>
              </div>
              {openBundle.choices.length > 0 && (
                <div>
                  <p className="font-semibold text-muted-foreground">Chiavi</p>
                  <ul className="mt-1 space-y-1">
                    {openBundle.choices.map((choice, choiceIndex) => (
                      <li key={`${choice.name}-${choiceIndex}`}>
                        {choice.name}
                        {choice.typeLabel ? ` — ${choice.typeLabel}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
