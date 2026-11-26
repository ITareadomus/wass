import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, IdCard, Loader2, Plus, Search, X } from "lucide-react";
import { Link } from "wouter";
import { CleanerRoleBadge } from "@/components/cleaner-role-mark";
import { CleanerTriadMark, type CleanerTriadeLevel } from "@/components/triad-mark";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getStoredUserRole, isReadOnlySession } from "@/lib/auth-role";
import { invalidateDayCleanerTriade } from "@/lib/day-cleaner-triade";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type TemporaryTriade = {
  weight: number;
  startDate: string;
  days: number;
  until: string;
  daysLeft?: number;
};

type CleanerAnagraficaRow = {
  id: number;
  name: string;
  lastname: string;
  role: string;
  contractType: string;
  alias: string;
  defaultStartTime: string | null;
  defaultEndTime: string | null;
  preferredCustomerIds: number[];
  preferredCustomersCustom: boolean;
  triade?: CleanerTriadeLevel | null;
  temporaryTriade?: TemporaryTriade | null;
};

type CustomerOption = {
  id: number;
  name: string;
};

type AnagraficaPayload = {
  cleaners: CleanerAnagraficaRow[];
  customers: CustomerOption[];
  triadeLevels?: CleanerTriadeLevel[];
};

type Draft = {
  alias: string;
  defaultStartTime: string;
  defaultEndTime: string;
  preferredCustomerIds: number[];
};

type TriadeFilter = "tutti" | "formatore" | number;

function sameIds(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.every((value, index) => value === b[index]);
}

function toDraft(row: CleanerAnagraficaRow): Draft {
  return {
    alias: row.alias || "",
    defaultStartTime: row.defaultStartTime || "",
    defaultEndTime: row.defaultEndTime || "",
    preferredCustomerIds: [...row.preferredCustomerIds],
  };
}

function rowDirty(row: CleanerAnagraficaRow, draft: Draft | undefined): boolean {
  if (!draft) return false;
  return (
    (row.alias || "") !== draft.alias.trim() ||
    (row.defaultStartTime || "") !== draft.defaultStartTime ||
    (row.defaultEndTime || "") !== draft.defaultEndTime ||
    !sameIds(row.preferredCustomerIds, draft.preferredCustomerIds)
  );
}

function personName(row: CleanerAnagraficaRow): string {
  return `${row.lastname} ${row.name}`.trim();
}

function byPerson(left: CleanerAnagraficaRow, right: CleanerAnagraficaRow): number {
  const last = left.lastname.localeCompare(right.lastname, "it", { sensitivity: "base" });
  if (last !== 0) return last;
  return left.name.localeCompare(right.name, "it", { sensitivity: "base" });
}

function initials(name: string, lastname: string): string {
  return `${name.trim().charAt(0)}${lastname.trim().charAt(0)}`.toUpperCase() || "—";
}

function isFormatore(row: CleanerAnagraficaRow): boolean {
  return row.role === "Formatore";
}

function matchesTriade(row: CleanerAnagraficaRow, filter: TriadeFilter): boolean {
  if (filter === "tutti") return true;
  if (filter === "formatore") return isFormatore(row);
  if (isFormatore(row)) return false;
  return Number(row.triade?.level_id) === filter;
}

function formatShortDate(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  if (!year || !month || !day) return ymd;
  return new Intl.DateTimeFormat("it-IT", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

function daysUntil(until: string): number {
  const [year, month, day] = until.split("-").map(Number);
  if (!year || !month || !day) return 0;
  const today = new Date();
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  const end = Date.UTC(year, month - 1, day);
  return Math.round((end - start) / 86400000);
}

function remainingText(promotion: TemporaryTriade): string {
  const left = Number.isInteger(promotion.daysLeft) ? Number(promotion.daysLeft) : daysUntil(promotion.until);
  if (left <= 0) return "Scade oggi";
  if (left === 1) return "Manca 1 giorno";
  return `Mancano ${left} giorni`;
}

function trialGreen(level: CleanerTriadeLevel): CleanerTriadeLevel {
  return { ...level, color: "#15803D", color_bg: "#DCFCE7" };
}

function trialEligible(row: CleanerAnagraficaRow): boolean {
  const name = (row.triade?.name || "").trim().toLowerCase();
  return name === "essential" || name === "plus";
}

function shiftClock(value: string, deltaMinutes: number): string {
  const [hours, minutes] = value.split(":").map(Number);
  const base = (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
  const total = ((base + deltaMinutes) % (24 * 60) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function TimeStepper({
  label,
  value,
  fallback,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (next: string) => void;
}) {
  const shown = value || fallback;
  return (
    <div className="min-w-0 flex-1">
      <span className="mb-2 block text-sm font-semibold text-muted-foreground">{label}</span>
      <div className="flex items-center justify-center gap-1 rounded-lg border-2 border-custom-blue bg-background px-2 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
          disabled={disabled}
          onClick={() => onChange(shiftClock(shown, -30))}
          aria-label={`Diminuisci ${label}`}
        >
          <span className="text-lg font-bold">−</span>
        </Button>
        <button
          type="button"
          className="min-w-[4.5rem] text-center font-mono text-lg font-bold tabular-nums"
          disabled={disabled || value === shown}
          onClick={() => onChange(shown)}
          aria-label={`Usa ${shown} come ${label}`}
        >
          {shown}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
          disabled={disabled}
          onClick={() => onChange(shiftClock(shown, 30))}
          aria-label={`Aumenta ${label}`}
        >
          <span className="text-lg font-bold">+</span>
        </Button>
      </div>
    </div>
  );
}

function TrialLevelBody({
  row,
  levels,
  months,
  setMonths,
  busy,
  readOnly,
  onApply,
  onRevoke,
}: {
  row: CleanerAnagraficaRow;
  levels: CleanerTriadeLevel[];
  months: number;
  setMonths: (value: number | ((current: number) => number)) => void;
  busy: boolean;
  readOnly: boolean;
  onApply: (months: number) => void;
  onRevoke: () => void;
}) {
  const active = row.temporaryTriade;
  const clockLevel = active ? levels.find((level) => Number(level.weight) === active.weight) ?? null : null;
  const nextLevel = levels.find((level) => Number(level.weight) > Number(row.triade?.weight)) ?? null;
  const eligible = trialEligible(row) && !active;
  return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{personName(row)}</p>
      <div className="space-y-1.5">
        <p className="text-sm font-semibold">Livello attuale</p>
        <CleanerTriadMark triade={row.triade} size="md" className="gap-1.5 [&_svg]:h-8 [&_svg]:w-7" />
      </div>
      {active && clockLevel ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-sm font-semibold">Livello di prova</p>
            <CleanerTriadMark triade={trialGreen(clockLevel)} size="md" className="gap-1.5 [&_svg]:h-8 [&_svg]:w-7" />
          </div>
          <p className="text-sm">{remainingText(active)}</p>
          <p className="text-sm text-muted-foreground">a {formatShortDate(active.until)}</p>
          <Button type="button" variant="outline" className="border-2 border-custom-blue" disabled={readOnly || busy} onClick={onRevoke}>
            Revoca
          </Button>
        </div>
      ) : eligible && nextLevel ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <p className="text-sm font-semibold">Livello di prova</p>
            <CleanerTriadMark triade={trialGreen(nextLevel)} size="md" className="gap-1.5 [&_svg]:h-8 [&_svg]:w-7" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border-2 border-custom-blue bg-background px-2 py-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                disabled={readOnly || busy || months <= 1}
                onClick={() => setMonths((current) => Math.max(1, current - 1))}
                aria-label="Un mese in meno"
              >
                <span className="text-lg font-bold">−</span>
              </Button>
              <span className="min-w-[1.5rem] text-center font-mono text-lg font-bold tabular-nums" aria-label="Mesi di prova">
                {months}
              </span>
              <span className="text-sm text-muted-foreground">{months === 1 ? "mese" : "mesi"}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                disabled={readOnly || busy || months >= 3}
                onClick={() => setMonths((current) => Math.min(3, current + 1))}
                aria-label="Un mese in più"
              >
                <span className="text-lg font-bold">+</span>
              </Button>
            </div>
            <Button
              type="button"
              disabled={readOnly || busy}
              className="h-11 bg-[hsl(199,89%,48%)] px-4 text-white hover:bg-[hsl(199,89%,42%)]"
              onClick={() => onApply(months)}
            >
              Imposta
            </Button>
          </div>
        </div>
      ) : eligible ? (
        <p className="text-sm text-muted-foreground">Non c&apos;è un livello superiore.</p>
      ) : (
        <p className="text-sm text-muted-foreground">Il livello di prova è disponibile solo per Essential e Plus.</p>
      )}
    </div>
  );
}

function FilterChip({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-viewer-allow=""
      onClick={onClick}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors",
        active
          ? "border-[hsl(199,89%,48%)] bg-[hsl(199,89%,48%)] text-white"
          : "border-border bg-background text-foreground hover:border-custom-blue"
      )}
    >
      {children}
      <span className={cn("tabular-nums text-xs", active ? "text-white/80" : "text-muted-foreground")}>{count}</span>
    </button>
  );
}

export default function CleanerAnagrafica() {
  const readOnly = isReadOnlySession(getStoredUserRole(), "/anagrafica-dipendenti", "");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [triadeFilter, setTriadeFilter] = useState<TriadeFilter>("tutti");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [saving, setSaving] = useState(false);
  const [customerCleanerId, setCustomerCleanerId] = useState<number | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [promotionMonths, setPromotionMonths] = useState(1);
  const [trialCleanerId, setTrialCleanerId] = useState<number | null>(null);
  const aliasSaveTimer = useRef<number | null>(null);

  const anagraficaQuery = useQuery<AnagraficaPayload>({
    queryKey: ["/api/cleaner-anagrafica"],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const response = await apiRequest("GET", "/api/cleaner-anagrafica");
      return response.json();
    },
  });

  useEffect(() => {
    const rows = anagraficaQuery.data?.cleaners;
    if (!rows) return;
    setDrafts((current) => {
      const next = { ...current };
      for (const row of rows) {
        const draft = current[row.id];
        if (draft && rowDirty(row, draft)) continue;
        next[row.id] = toDraft(row);
      }
      return next;
    });
  }, [anagraficaQuery.data]);

  useEffect(() => {
    setPromotionMonths(1);
  }, [selectedId]);

  const customerNames = useMemo(() => {
    const names = new Map<number, string>();
    for (const customer of anagraficaQuery.data?.customers || []) names.set(customer.id, customer.name);
    return names;
  }, [anagraficaQuery.data?.customers]);

  const rows = anagraficaQuery.data?.cleaners || [];
  const triadeLevels = useMemo(
    () =>
      [...(anagraficaQuery.data?.triadeLevels || [])].sort(
        (left, right) => Number(left.weight) - Number(right.weight)
      ),
    [anagraficaQuery.data?.triadeLevels]
  );
  const levelCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const row of rows) {
      if (isFormatore(row)) continue;
      const levelId = Number(row.triade?.level_id);
      if (!Number.isInteger(levelId) || levelId <= 0) continue;
      counts.set(levelId, (counts.get(levelId) || 0) + 1);
    }
    return counts;
  }, [rows]);
  const formatoreCount = useMemo(() => rows.filter(isFormatore).length, [rows]);
  const visibleRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (!matchesTriade(row, triadeFilter)) return false;
      if (!needle) return true;
      const draft = drafts[row.id];
      return [row.name, row.lastname, row.role, row.triade?.name, draft?.alias]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    }).sort(byPerson);
  }, [rows, drafts, search, triadeFilter]);

  const dirtyRows = rows.filter((row) => rowDirty(row, drafts[row.id]));
  const selectedRow = rows.find((row) => row.id === selectedId) || null;
  const trialRow = rows.find((row) => row.id === trialCleanerId) || null;
  const selectedDraft = selectedRow ? drafts[selectedRow.id] || toDraft(selectedRow) : null;
  const selectedDirty = selectedRow ? rowDirty(selectedRow, selectedDraft || undefined) : false;
  const customerRow = rows.find((row) => row.id === customerCleanerId) || null;
  const customerDraft = customerRow ? drafts[customerRow.id] : null;
  const selectedCustomers = useMemo(() => {
    const ids = customerDraft?.preferredCustomerIds || [];
    return ids.map((id) => ({ id, name: customerNames.get(id) || `Cliente #${id}` }));
  }, [customerDraft?.preferredCustomerIds, customerNames]);

  const customerMatches = useMemo(() => {
    const needle = customerSearch.trim().toLowerCase();
    const customers = anagraficaQuery.data?.customers || [];
    const selected = new Set(customerDraft?.preferredCustomerIds || []);
    const matched = needle
      ? customers.filter((customer) => customer.name.toLowerCase().includes(needle) || String(customer.id).includes(needle))
      : customers;
    const selectedRows = customers.filter((customer) => selected.has(customer.id));
    const merged = [...selectedRows, ...matched.filter((customer) => !selected.has(customer.id))];
    return needle ? matched.slice(0, 80) : merged.slice(0, 80);
  }, [anagraficaQuery.data?.customers, customerSearch, customerDraft?.preferredCustomerIds]);

  const updateDraft = (id: number, patch: Partial<Draft>) => {
    setDrafts((current) => {
      const row = rows.find((item) => item.id === id);
      const base = current[id] || (row ? toDraft(row) : { alias: "", defaultStartTime: "", defaultEndTime: "", preferredCustomerIds: [] });
      return { ...current, [id]: { ...base, ...patch } };
    });
  };

  const persistCleaner = async (row: CleanerAnagraficaRow, draft: Draft) => {
    const preferredChanged = !sameIds(row.preferredCustomerIds, draft.preferredCustomerIds);
    const saved = {
      alias: draft.alias.trim(),
      defaultStartTime: draft.defaultStartTime || row.defaultStartTime || null,
      defaultEndTime: draft.defaultEndTime || row.defaultEndTime || null,
      preferredCustomerIds: draft.preferredCustomerIds,
      preferredCustomersCustom: preferredChanged ? true : row.preferredCustomersCustom,
    };
    await apiRequest("POST", "/api/cleaner-anagrafica", {
      cleaners: [{
        id: row.id,
        name: row.name,
        lastname: row.lastname,
        ...saved,
      }],
    });
    queryClient.setQueryData<AnagraficaPayload>(["/api/cleaner-anagrafica"], (current) => {
      if (!current) return current;
      return {
        ...current,
        cleaners: current.cleaners.map((cleaner) =>
          cleaner.id === row.id ? { ...cleaner, ...saved } : cleaner
        ),
      };
    });
  };

  const commitDraft = (id: number, patch: Partial<Draft>) => {
    const row = rows.find((item) => item.id === id);
    if (!row || readOnly) return;
    const base = drafts[id] || toDraft(row);
    const next = { ...base, ...patch };
    setDrafts((current) => ({ ...current, [id]: next }));
    void persistCleaner(row, next).catch((error) => {
      toast({
        title: "Salvataggio non riuscito",
        description: error instanceof Error ? error.message : "Impossibile scrivere l'anagrafica sul database",
        variant: "destructive",
      });
    });
  };

  const toggleCustomer = (cleanerId: number, customerId: number) => {
    const row = rows.find((item) => item.id === cleanerId);
    const draft = drafts[cleanerId] || (row ? toDraft(row) : null);
    if (!draft) return;
    const selected = new Set(draft.preferredCustomerIds);
    if (selected.has(customerId)) selected.delete(customerId);
    else selected.add(customerId);
    commitDraft(cleanerId, { preferredCustomerIds: [...selected].sort((a, b) => a - b) });
  };

  const raiseLevel = async (cleanerId: number, months: number) => {
    if (readOnly || promoting) return;
    setPromoting(true);
    try {
      await apiRequest("POST", "/api/cleaner-triade-promotion", { cleanerId, months });
      invalidateDayCleanerTriade();
      await queryClient.invalidateQueries({ queryKey: ["/api/cleaner-anagrafica"] });
      toast({
        title: "Livello di prova",
        description: `Sale di un livello per ${months === 1 ? "1 mese" : `${months} mesi`}, a partire da oggi.`,
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Livello di prova non impostato",
        description: error instanceof Error ? error.message : "Impossibile salire di livello",
        variant: "destructive",
      });
    } finally {
      setPromoting(false);
    }
  };

  const clearTemporaryLevel = async (cleanerId: number) => {
    if (readOnly || promoting) return;
    setPromoting(true);
    try {
      await apiRequest("DELETE", `/api/cleaner-triade-promotion/${cleanerId}`);
      invalidateDayCleanerTriade();
      await queryClient.invalidateQueries({ queryKey: ["/api/cleaner-anagrafica"] });
      toast({
        title: "Prova revocata",
        description: "Il cleaner torna al suo livello triade.",
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Revoca non riuscita",
        description: error instanceof Error ? error.message : "Impossibile revocare il livello di prova",
        variant: "destructive",
      });
    } finally {
      setPromoting(false);
    }
  };

  const save = async () => {
    if (readOnly || dirtyRows.length === 0) return;
    setSaving(true);
    try {
      await apiRequest("POST", "/api/cleaner-anagrafica", {
        cleaners: dirtyRows.map((row) => {
          const draft = drafts[row.id];
          const preferredChanged = !sameIds(row.preferredCustomerIds, draft.preferredCustomerIds);
          return {
            id: row.id,
            name: row.name,
            lastname: row.lastname,
            alias: draft.alias.trim(),
            defaultStartTime: draft.defaultStartTime || null,
            defaultEndTime: draft.defaultEndTime || null,
            preferredCustomerIds: draft.preferredCustomerIds,
            preferredCustomersCustom: preferredChanged ? true : row.preferredCustomersCustom,
          };
        }),
      });
      await queryClient.invalidateQueries({ queryKey: ["/api/cleaner-anagrafica"] });
      toast({
        title: "Anagrafica salvata",
        description: `${dirtyRows.length} cleaner aggiornati. Inizio e fine predefiniti compaiono nelle convocazioni dei giorni non ancora modificati.`,
        variant: "success",
      });
    } catch (error) {
      toast({
        title: "Salvataggio non riuscito",
        description: error instanceof Error ? error.message : "Impossibile salvare l'anagrafica",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const selectedLabels = (selectedDraft?.preferredCustomerIds || []).map((id) => ({
    id,
    name: customerNames.get(id) || `Cliente #${id}`,
  }));

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col bg-background text-foreground md:h-[calc(100dvh-3.75rem)]">
      <div className="shrink-0 border-b border-border/60 bg-background">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
                <IdCard className="h-6 w-6 text-custom-blue" aria-hidden />
                Anagrafica dipendenti
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Scegli un cleaner. Inizio e fine sono gli orari di base delle convocazioni.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Link
                href="/generate-assignments"
                data-viewer-allow=""
                className="inline-flex h-11 items-center gap-2 rounded-md border-2 border-custom-blue px-3 text-sm font-medium text-custom-blue"
              >
                <ChevronLeft className="h-5 w-5" />
                Housekeeping
              </Link>
              <Button
                type="button"
                onClick={save}
                disabled={readOnly || saving || dirtyRows.length === 0}
                className="h-11 bg-[hsl(199,89%,48%)] px-4 text-white hover:bg-[hsl(199,89%,42%)]"
              >
                {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {dirtyRows.length > 0 ? `Salva ${dirtyRows.length}` : "Salva"}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-custom-blue" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Cerca per nome o alias..."
                className="h-11 border-2 border-custom-blue pl-10"
                data-viewer-allow=""
              />
            </div>
            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filtra per livello triade">
              <FilterChip
                active={triadeFilter === "tutti"}
                count={rows.length}
                onClick={() => setTriadeFilter("tutti")}
              >
                Tutti
              </FilterChip>
              {triadeLevels.map((level) => {
                const levelId = Number(level.level_id);
                return (
                  <FilterChip
                    key={levelId}
                    active={triadeFilter === levelId}
                    count={levelCounts.get(levelId) || 0}
                    onClick={() => setTriadeFilter(levelId)}
                  >
                    <CleanerTriadMark triade={level} size="sm" />
                    <span>{level.name}</span>
                  </FilterChip>
                );
              })}
              <FilterChip
                active={triadeFilter === "formatore"}
                count={formatoreCount}
                onClick={() => setTriadeFilter("formatore")}
              >
                Formatori
              </FilterChip>
            </div>
          </div>
        </div>
      </div>

      {anagraficaQuery.isLoading ? (
        <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Caricamento anagrafica
        </div>
      ) : anagraficaQuery.isError ? (
        <div className="mx-auto w-full max-w-6xl px-4 py-8">
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-6 text-center">
            <p className="font-medium">Anagrafica non disponibile</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {anagraficaQuery.error instanceof Error ? anagraficaQuery.error.message : "Errore di caricamento"}
            </p>
          </div>
        </div>
      ) : (
        <div className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <aside className={cn("flex min-h-0 flex-col border-border/60 lg:border-r", selectedRow && "hidden lg:flex")}>
            {visibleRows.length === 0 ? (
              <p className="px-4 py-10 text-sm text-muted-foreground">Nessun cleaner trovato.</p>
            ) : (
              <ul className="min-h-0 flex-1 overflow-y-auto">
                {visibleRows.map((row) => {
                  const draft = drafts[row.id] || toDraft(row);
                  const active = row.id === selectedId;
                  const dirty = rowDirty(row, draft);
                  const alias = draft.alias.trim();
                  const hours = [draft.defaultStartTime, draft.defaultEndTime].filter(Boolean).join("–");
                  return (
                    <li key={row.id}>
                      <div
                        className={cn(
                          "flex w-full min-w-0 items-center gap-2 overflow-hidden border-b px-3 py-2.5 transition-colors hover:bg-muted/50",
                          active && "bg-custom-blue-light"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => setSelectedId(row.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate text-sm font-medium">{personName(row)}</span>
                            {dirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(199,89%,48%)]" /> : null}
                          </span>
                          {alias ? (
                            <span className="block truncate text-xs text-muted-foreground">{alias}</span>
                          ) : null}
                        </button>
                        {hours ? (
                          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{hours}</span>
                        ) : null}
                        {isFormatore(row) ? (
                          <CleanerRoleBadge role="Formatore" />
                        ) : row.triade ? (
                          <button
                            type="button"
                            className="shrink-0 rounded-md px-1 py-0.5 hover:bg-muted"
                            aria-label={`Livello triade di ${personName(row)}`}
                            onClick={() => setTrialCleanerId(row.id)}
                          >
                            <CleanerTriadMark
                              triade={row.triade}
                              clockLevel={
                                row.temporaryTriade
                                  ? triadeLevels.find((level) => Number(level.weight) === row.temporaryTriade?.weight) ?? null
                                  : null
                              }
                              size="md"
                              className="gap-1 [&_svg]:h-6 [&_svg]:w-5"
                            />
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>

          <section className={cn("min-h-0 overflow-y-auto", !selectedRow && "hidden lg:block")}>
            {!selectedRow || !selectedDraft ? (
              <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                Seleziona un cleaner dall&apos;elenco per aprire la sua anagrafica.
              </div>
            ) : (
              <div key={selectedRow.id} className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-5 lg:px-8">
                <button
                  type="button"
                  className="inline-flex w-fit items-center gap-1 text-sm font-medium text-custom-blue lg:hidden"
                  onClick={() => setSelectedId(null)}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Elenco
                </button>
                <header className="flex items-start gap-4 border-b pb-5">
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-custom-blue-light text-base font-semibold text-custom-blue">
                    {initials(selectedRow.name, selectedRow.lastname)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-2xl font-semibold uppercase" title={personName(selectedRow)}>
                      {personName(selectedRow)}
                    </h2>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {isFormatore(selectedRow) ? (
                        <CleanerRoleBadge role="Formatore" />
                      ) : selectedRow.triade ? (
                        <button
                          type="button"
                          className="rounded-md px-1 py-0.5 hover:bg-muted"
                          aria-label="Apri il livello di prova"
                          onClick={() => setTrialCleanerId(selectedRow.id)}
                        >
                          <CleanerTriadMark
                            triade={selectedRow.triade}
                            clockLevel={
                              selectedRow.temporaryTriade
                                ? triadeLevels.find((level) => Number(level.weight) === selectedRow.temporaryTriade?.weight) ?? null
                                : null
                            }
                            size="md"
                            className="gap-1 [&_svg]:h-7 [&_svg]:w-6"
                          />
                        </button>
                      ) : (
                        <span className="text-sm text-muted-foreground">Senza livello triade</span>
                      )}
                      <span className="text-sm text-muted-foreground">Contratto {selectedRow.contractType || "—"}</span>
                      {selectedDirty ? <span className="text-xs font-medium text-custom-blue">Modificato</span> : null}
                    </div>
                  </div>
                </header>

                <div>
                  <span className="mb-1.5 block text-sm font-semibold">Livello triade</span>
                  {isFormatore(selectedRow) ? (
                    <CleanerRoleBadge role="Formatore" />
                  ) : selectedRow.triade ? (
                    <button
                      type="button"
                      className="rounded-md px-1 py-0.5 hover:bg-muted"
                      aria-label="Apri il livello di prova"
                      onClick={() => setTrialCleanerId(selectedRow.id)}
                    >
                      <CleanerTriadMark
                        triade={selectedRow.triade}
                        clockLevel={
                          selectedRow.temporaryTriade
                            ? triadeLevels.find((level) => Number(level.weight) === selectedRow.temporaryTriade?.weight) ?? null
                            : null
                        }
                        size="md"
                        className="gap-1.5 [&_svg]:h-8 [&_svg]:w-7"
                      />
                    </button>
                  ) : (
                    <p className="text-sm text-muted-foreground">Senza livello</p>
                  )}
                </div>

                <label className="block">
                  <span className="mb-1.5 block text-sm font-semibold">Alias</span>
                  <Input
                    value={selectedDraft.alias}
                    disabled={readOnly}
                    placeholder={personName(selectedRow)}
                    onChange={(event) => {
                      const alias = event.target.value;
                      updateDraft(selectedRow.id, { alias });
                      if (aliasSaveTimer.current != null) window.clearTimeout(aliasSaveTimer.current);
                      const cleanerId = selectedRow.id;
                      aliasSaveTimer.current = window.setTimeout(() => {
                        commitDraft(cleanerId, { alias });
                      }, 400);
                    }}
                    onBlur={() => {
                      if (aliasSaveTimer.current != null) window.clearTimeout(aliasSaveTimer.current);
                      const draft = drafts[selectedRow.id] || toDraft(selectedRow);
                      if (rowDirty(selectedRow, { ...draft, alias: draft.alias })) commitDraft(selectedRow.id, {});
                    }}
                    className="h-11 border-2 border-border focus-visible:border-custom-blue"
                    aria-label={`Alias di ${personName(selectedRow)}`}
                  />
                </label>

                <div>
                  <div className="flex flex-col gap-3 sm:flex-row">
                    <TimeStepper
                      label="Orario di inizio"
                      value={selectedDraft.defaultStartTime}
                      fallback="10:00"
                      disabled={readOnly}
                      onChange={(defaultStartTime) => commitDraft(selectedRow.id, { defaultStartTime })}
                    />
                    <TimeStepper
                      label="Orario di fine"
                      value={selectedDraft.defaultEndTime}
                      fallback="20:00"
                      disabled={readOnly}
                      onChange={(defaultEndTime) => commitDraft(selectedRow.id, { defaultEndTime })}
                    />
                  </div>
                </div>

                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold">
                      Clienti preferiti
                      <span className="ml-2 tabular-nums text-muted-foreground">{selectedLabels.length}</span>
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 border-custom-blue text-custom-blue hover:bg-[hsl(199,89%,48%)] hover:text-white"
                      disabled={readOnly}
                      onClick={() => {
                        setCustomerCleanerId(selectedRow.id);
                        setCustomerSearch("");
                      }}
                    >
                      <Plus className="mr-1 h-3.5 w-3.5" />
                      Aggiungi
                    </Button>
                  </div>
                  {selectedLabels.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
                      Nessun cliente preferito
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedLabels.map((customer) => (
                        <span
                          key={customer.id}
                          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/60 py-1 pl-2.5 pr-1 text-sm"
                        >
                          <span className="truncate">{customer.name}</span>
                          <button
                            type="button"
                            disabled={readOnly}
                            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50"
                            aria-label={`Togli ${customer.name}`}
                            onClick={() => toggleCustomer(selectedRow.id, customer.id)}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      <Dialog open={trialRow != null} onOpenChange={(open) => { if (!open) setTrialCleanerId(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Livello di prova</DialogTitle>
          </DialogHeader>
          {trialRow?.triade ? (
            <TrialLevelBody
              row={trialRow}
              levels={triadeLevels}
              months={promotionMonths}
              setMonths={setPromotionMonths}
              busy={promoting}
              readOnly={readOnly}
              onApply={(months) => void raiseLevel(trialRow.id, months)}
              onRevoke={() => void clearTemporaryLevel(trialRow.id)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={customerCleanerId != null}
        onOpenChange={(open) => {
          if (!open) setCustomerCleanerId(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Clienti preferiti</DialogTitle>
            {customerRow ? (
              <p className="text-sm text-muted-foreground">{personName(customerRow)}</p>
            ) : null}
          </DialogHeader>
          {selectedCustomers.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {selectedCustomers.map((customer) => (
                <span
                  key={customer.id}
                  className="inline-flex max-w-full items-center gap-1 rounded-full border border-custom-blue/40 bg-custom-blue-light py-1 pl-2.5 pr-1 text-xs text-custom-blue"
                >
                  <span className="truncate">{customer.name}</span>
                  <button
                    type="button"
                    disabled={readOnly}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full hover:bg-background"
                    aria-label={`Togli ${customer.name}`}
                    onClick={() => {
                      if (customerCleanerId != null) toggleCustomer(customerCleanerId, customer.id);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nessun cliente selezionato.</p>
          )}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-custom-blue" />
            <Input
              value={customerSearch}
              onChange={(event) => setCustomerSearch(event.target.value)}
              placeholder="Cerca cliente..."
              className="border-2 border-custom-blue pl-9"
              data-viewer-allow=""
            />
          </div>
          <div className="max-h-80 space-y-1 overflow-y-auto pr-1">
            {customerMatches.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nessun cliente trovato.</p>
            ) : (
              customerMatches.map((customer) => {
                const checked = customerDraft?.preferredCustomerIds.includes(customer.id) ?? false;
                return (
                  <label
                    key={customer.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2",
                      checked ? "border-custom-blue/50 bg-custom-blue-light" : "border-transparent hover:bg-muted"
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={readOnly || customerCleanerId == null}
                      onCheckedChange={() => {
                        if (customerCleanerId != null) toggleCustomer(customerCleanerId, customer.id);
                      }}
                    />
                    <span className="text-sm">{customer.name}</span>
                  </label>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
