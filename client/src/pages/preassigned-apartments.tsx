import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2, Plus, Save, Settings, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  durationLabelFromWindow,
  parseHkPreassignedSchedules,
  type HkPreassignedSchedule,
} from "@shared/hk-preassigned-schedules";

type Row = HkPreassignedSchedule & { key: string };

function newKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function PreassignedApartments() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const user = localStorage.getItem("user");
    if (!user) {
      setLocation("/login");
      return;
    }
    try {
      const userData = JSON.parse(user) as { role?: string };
      if (userData.role !== "admin") {
        toast({
          title: "Accesso negato",
          description: "Solo gli amministratori possono aprire questa pagina",
          variant: "destructive",
        });
        setLocation("/");
        return;
      }
    } catch {
      setLocation("/login");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/hk-preassigned-schedules", { cache: "no-store" });
        const data = response.ok ? await response.json() : { entries: [] };
        if (cancelled) return;
        setRows(
          parseHkPreassignedSchedules(data).map((entry) => ({ ...entry, key: newKey() })),
        );
      } catch {
        if (!cancelled) {
          toast({
            title: "Errore",
            description: "Impossibile caricare gli appartamenti pre-assegnati",
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setLocation, toast]);

  const updateRow = (key: string, patch: Partial<HkPreassignedSchedule>) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const save = async () => {
    const seen = new Set<string>();
    for (const row of rows) {
      const code = row.logisticCode.trim();
      if (!/^\d+$/.test(code)) {
        toast({
          title: "Codice non valido",
          description: "Il codice ADAM è fatto di sole cifre",
          variant: "destructive",
        });
        return;
      }
      if (seen.has(code)) {
        toast({
          title: "Codice duplicato",
          description: `Il codice ${code} è presente due volte`,
          variant: "destructive",
        });
        return;
      }
      seen.add(code);
      if (!durationLabelFromWindow(row.startTime, row.endTime)) {
        toast({
          title: "Orario non valido",
          description: `Per il codice ${code} la fine deve essere dopo l'inizio`,
          variant: "destructive",
        });
        return;
      }
    }

    setIsSaving(true);
    try {
      const response = await fetch("/api/hk-preassigned-schedules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entries: rows.map((row) => ({
            logisticCode: row.logisticCode.trim(),
            startTime: row.startTime,
            endTime: row.endTime,
          })),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Salvataggio non riuscito");
      }
      toast({
        title: "Salvato",
        description: "La timeline housekeeping userà questi orari al prossimo caricamento",
      });
    } catch (error) {
      toast({
        title: "Errore",
        description: error instanceof Error ? error.message : "Salvataggio non riuscito",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Appartamenti Pre-Assegnati</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Per ogni codice ADAM indichi l&apos;orario di base in timeline housekeeping.
            Vale in tutti i giorni. Il task resta quello di ADAM e non diventa spostabile.
          </p>
        </div>
        <Button variant="outline" onClick={() => setLocation("/settings")}>
          <Settings className="mr-2 h-4 w-4" />
          Impostazioni
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Caricamento
        </div>
      ) : (
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nessun codice. Aggiungine uno e indica inizio e fine.
            </p>
          )}
          {rows.map((row) => (
            <div key={row.key} className="grid grid-cols-[1fr_auto_auto_auto] items-end gap-2">
              <div>
                <Label htmlFor={`code-${row.key}`}>Codice ADAM</Label>
                <Input
                  id={`code-${row.key}`}
                  inputMode="numeric"
                  value={row.logisticCode}
                  placeholder="Codice ADAM"
                  onChange={(event) => updateRow(row.key, { logisticCode: event.target.value.trim() })}
                />
              </div>
              <div>
                <Label htmlFor={`start-${row.key}`}>Inizio</Label>
                <Input
                  id={`start-${row.key}`}
                  type="time"
                  value={row.startTime}
                  onChange={(event) => updateRow(row.key, { startTime: event.target.value })}
                />
              </div>
              <div>
                <Label htmlFor={`end-${row.key}`}>Fine</Label>
                <Input
                  id={`end-${row.key}`}
                  type="time"
                  value={row.endTime}
                  onChange={(event) => updateRow(row.key, { endTime: event.target.value })}
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Rimuovi ${row.logisticCode || "riga"}`}
                onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}

          <div className="flex gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() =>
                setRows((current) => [
                  ...current,
                  { key: newKey(), logisticCode: "", startTime: "08:00", endTime: "10:00" },
                ])
              }
            >
              <Plus className="mr-2 h-4 w-4" />
              Aggiungi
            </Button>
            <Button onClick={save} disabled={isSaving}>
              {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Salva
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
