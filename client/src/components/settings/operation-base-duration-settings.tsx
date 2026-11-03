import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type OperationRow = {
  id: number;
  name: string;
  enable_wass: boolean;
};

type BaseMinutes = Record<string, number>;

function minutesToClock(total: number | undefined): string {
  if (!total || total <= 0) return "";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function clockToMinutes(value: string): number | null {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || minutes < 0 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

export function OperationBaseDurationSettings({
  value,
  onChange,
}: {
  value: BaseMinutes;
  onChange: (next: BaseMinutes) => void;
}) {
  const [operations, setOperations] = useState<OperationRow[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/operations?for=all-active")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data?.active_operations) ? data.active_operations : [];
        const next = rows
          .map((row: any) => ({
            id: Number(row?.id),
            name: String(row?.name ?? "").trim(),
            enable_wass: row?.enable_wass === true,
          }))
          .filter((row: OperationRow) => Number.isFinite(row.id) && row.name)
          .sort((a: OperationRow, b: OperationRow) => a.name.localeCompare(b.name, "it"));
        setOperations(next);
        setDrafts(
          Object.fromEntries(
            next.map((row: OperationRow) => [row.id, minutesToClock(value[String(row.id)])]),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setOperations([]);
      });
    return () => {
      cancelled = true;
    };
    // La lista si carica all'apertura della scheda, con gli orari già salvati.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = (operationId: number, clock: string) => {
    setDrafts((prev) => ({ ...prev, [operationId]: clock }));
    const total = clockToMinutes(clock);
    const key = String(operationId);
    const next = { ...value };
    if (total == null) delete next[key];
    else next[key] = total;
    onChange(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Tipologia attività</CardTitle>
        <CardDescription>
          Orario di base usato in timeline solo se ADAM manda la tipologia a 0 ore. Non viene inviato ad ADAM.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-sky-500" />
            WASS attivo
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
            WASS disattivo
          </span>
        </div>
        <div className="divide-y rounded-md border">
          {operations.map((operation) => {
            const draft = drafts[operation.id] ?? minutesToClock(value[String(operation.id)]);
            return (
              <div key={operation.id} className="flex items-center gap-3 px-3 py-2">
                <span
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    operation.enable_wass ? "bg-sky-500" : "bg-orange-500",
                  )}
                  aria-hidden
                />
                <p className="min-w-0 flex-1 text-sm">{operation.name}</p>
                <Input
                  type="time"
                  value={draft}
                  aria-label={`Orario ${operation.name}`}
                  className="h-8 w-28"
                  onChange={(event) => commit(operation.id, event.target.value)}
                />
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
