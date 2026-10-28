import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, format, parseISO } from "date-fns";
import { it } from "date-fns/locale";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw, Search, TriangleAlert, Undo2 } from "lucide-react";
import { Link } from "wouter";
import { StructureAccessKeyButtons } from "@/components/structure-access-key-type";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StructureAccessBundle } from "@shared/structure-access-keys";
import {
  keyHandoverStatus,
  nextKeyHandoverStatus,
  priorAlertTone,
  type KeyHandoverStatus,
  type KeyPriorAlert,
} from "@shared/key-registry";
import { useToast } from "@/hooks/use-toast";
import { getStoredUserRole, isViewerRole } from "@/lib/auth-role";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type Apartment = {
  taskId: number;
  logisticCode: string;
  aptCode: string | null;
  customerName: string | null;
  interventionType: string | null;
  keyBundles?: StructureAccessBundle[];
  sequence: number;
  startTime: string | null;
  delivered: boolean;
  returned?: boolean;
  lost?: boolean;
  driverKey?: boolean;
  priorAlerts?: KeyPriorAlert[];
};

type CleanerRow = {
  cleanerId: number;
  name: string;
  lastname: string;
  matricola: string | null;
  apartments: Apartment[];
};

type RegistryPayload = {
  date: string;
  totals: { keys: number; warehouse: number; withCleaner: number; returned: number };
  cleaners: CleanerRow[];
};

function isWorkDate(value: string | null | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

function initialDate(): string {
  if (typeof window === "undefined") return format(new Date(), "yyyy-MM-dd");
  const param = new URLSearchParams(window.location.search).get("date");
  if (isWorkDate(param)) return param;
  const saved = localStorage.getItem("selected_work_date");
  if (isWorkDate(saved)) return saved;
  return format(new Date(), "yyyy-MM-dd");
}

function cleanerTitle(cleaner: CleanerRow): string {
  const fullName = [cleaner.name, cleaner.lastname].filter(Boolean).join(" ").trim();
  return fullName || `Cleaner ${cleaner.cleanerId}`;
}

/** Stesso intervallo del polling automatico con la giornata operativa avviata. */
const REGISTRY_POLL_MS = 15_000;

const STATUS_LABEL: Record<KeyHandoverStatus, string> = {
  warehouse: "In magazzino",
  with_cleaner: "Consegnata",
  returned: "Restituita",
};

const ROW_TONE: Record<KeyHandoverStatus, string> = {
  warehouse: "border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
  with_cleaner: "border-amber-500 bg-amber-400 text-amber-950",
  returned: "border-emerald-700 bg-emerald-600 text-white",
};

function SwipeKeyRow({
  disabled,
  lostBlocked,
  onCommitLost,
  onCommitDriver,
  className,
  children,
}: {
  disabled: boolean;
  lostBlocked: boolean;
  onCommitLost: () => Promise<void>;
  onCommitDriver: () => Promise<void>;
  className?: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const tracking = useRef(false);
  const draggingRef = useRef(false);
  const suppressClick = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);

  const resetGesture = () => {
    tracking.current = false;
    draggingRef.current = false;
    setDragging(false);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (disabled) return;
    const interactive = (event.target as HTMLElement).closest("button, a");
    if (interactive && interactive.getAttribute("data-testid") !== "button-key-status") return;
    tracking.current = true;
    draggingRef.current = false;
    startX.current = event.clientX;
    startY.current = event.clientY;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (!tracking.current || disabled) return;
    const dx = event.clientX - startX.current;
    const dy = event.clientY - startY.current;
    if (!draggingRef.current) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx) || (dx < 0 && lostBlocked)) {
        tracking.current = false;
        return;
      }
      draggingRef.current = true;
      suppressClick.current = true;
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Il gesto resta sulla riga anche se il puntatore non è catturabile.
      }
    }
    const width = rowRef.current?.offsetWidth ?? 320;
    const next = dx < 0 ? Math.max(-width, dx) : Math.min(width, dx);
    setOffset(next);
  };

  const onPointerUp = () => {
    if (!tracking.current && !draggingRef.current) return;
    const width = rowRef.current?.offsetWidth ?? 320;
    const threshold = Math.min(120, width * 0.34);
    const commitLost = draggingRef.current && !lostBlocked && offset < -threshold;
    const commitDriver = draggingRef.current && offset > threshold;
    resetGesture();
    setOffset(0);
    if (!commitLost && !commitDriver) {
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      return;
    }
    const commit = commitDriver ? onCommitDriver() : onCommitLost();
    void commit.finally(() => {
      suppressClick.current = false;
    });
  };

  return (
    <li
      ref={rowRef}
      className="relative overflow-hidden rounded-xl touch-pan-y"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={(event) => {
        if (!suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }}
    >
      <div
        className={cn(
          "absolute inset-0 flex items-center bg-violet-600 pl-5 text-sm font-semibold text-white",
          offset > 0 ? "justify-start" : "invisible"
        )}
      >
        Autista
      </div>
      <div
        className={cn(
          "absolute inset-0 flex items-center justify-end bg-red-600 pr-5 text-sm font-semibold text-white",
          offset < 0 ? "" : "invisible"
        )}
      >
        Smarrita
      </div>
      <div
        className={cn("relative flex min-h-[4.75rem] w-full items-center gap-2 px-3 py-3", className)}
        style={{
          transform: `translateX(${offset}px)`,
          transition: dragging ? "none" : "transform 180ms ease",
        }}
      >
        {children}
      </div>
    </li>
  );
}

function flagsFor(status: KeyHandoverStatus): { delivered: boolean; returned: boolean; lost: boolean } {
  if (status === "returned") return { delivered: true, returned: true, lost: false };
  if (status === "with_cleaner") return { delivered: true, returned: false, lost: false };
  return { delivered: false, returned: false, lost: false };
}

function patchStatus(payload: RegistryPayload, taskId: number, status: KeyHandoverStatus, lost = false): RegistryPayload {
  const flags = { ...flagsFor(status), lost };
  const cleaners = payload.cleaners.map((cleaner) => ({
    ...cleaner,
    apartments: cleaner.apartments.map((apartment) =>
      apartment.taskId === taskId ? { ...apartment, ...flags } : apartment
    ),
  }));
  const apartments = cleaners.flatMap((cleaner) => cleaner.apartments);
  return {
    ...payload,
    cleaners,
    totals: {
      keys: apartments.length,
      warehouse: apartments.filter((apartment) => keyHandoverStatus(apartment) === "warehouse").length,
      withCleaner: apartments.filter((apartment) => keyHandoverStatus(apartment) === "with_cleaner").length,
      returned: apartments.filter((apartment) => keyHandoverStatus(apartment) === "returned").length,
    },
  };
}

export default function KeyRegistry() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const viewer = isViewerRole(getStoredUserRole());
  const [date, setDate] = useState(initialDate);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [alertApartment, setAlertApartment] = useState<Apartment | null>(null);
  const [search, setSearch] = useState("");
  const queryKey = useMemo(() => [`/api/key-registry?date=${date}`] as const, [date]);

  const registryQuery = useQuery<RegistryPayload>({
    queryKey: [...queryKey],
    refetchInterval: () => (pendingIds.size > 0 ? false : REGISTRY_POLL_MS),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: pendingIds.size === 0,
  });

  const changeDate = (next: string) => {
    if (!isWorkDate(next) || next === date) return;
    localStorage.setItem("selected_work_date", next);
    const url = `/keys?date=${next}`;
    window.history.replaceState({}, "", url);
    setDate(next);
  };

  const cycleStatus = async (apartment: Apartment) => {
    if (viewer || pendingIds.has(apartment.taskId)) return;
    const status = nextKeyHandoverStatus(keyHandoverStatus(apartment));
    const previous = queryClient.getQueryData<RegistryPayload>(queryKey);
    setPendingIds((current) => new Set(current).add(apartment.taskId));
    if (previous) queryClient.setQueryData(queryKey, patchStatus(previous, apartment.taskId, status));
    try {
      await apiRequest("POST", "/api/key-registry/delivered", {
        date,
        taskId: apartment.taskId,
        status,
      });
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/key-registry"),
      });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: "Stato non salvato",
        description: error instanceof Error ? error.message : "Riprova",
        variant: "destructive",
      });
    } finally {
      setPendingIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(apartment.taskId);
        return nextIds;
      });
    }
  };

  const markLost = async (apartment: Apartment) => {
    if (viewer || pendingIds.has(apartment.taskId) || apartment.lost) return;
    const previous = queryClient.getQueryData<RegistryPayload>(queryKey);
    setPendingIds((current) => new Set(current).add(apartment.taskId));
    if (previous) {
      queryClient.setQueryData(queryKey, {
        ...previous,
        cleaners: previous.cleaners.map((cleaner) => ({
          ...cleaner,
          apartments: cleaner.apartments.map((item) =>
            item.taskId === apartment.taskId ? { ...item, lost: true, returned: false } : item
          ),
        })),
      });
    }
    try {
      await apiRequest("POST", "/api/key-registry/lost", { date, taskId: apartment.taskId });
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/key-registry"),
      });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: "Chiave non segnata come smarrita",
        description: error instanceof Error ? error.message : "Riprova",
        variant: "destructive",
      });
      throw error;
    } finally {
      setPendingIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(apartment.taskId);
        return nextIds;
      });
    }
  };

  const markDriver = async (apartment: Apartment, taken: boolean) => {
    if (viewer || pendingIds.has(apartment.taskId) || Boolean(apartment.driverKey) === taken) return;
    const previous = queryClient.getQueryData<RegistryPayload>(queryKey);
    setPendingIds((current) => new Set(current).add(apartment.taskId));
    if (previous) {
      const base = taken
        ? patchStatus(previous, apartment.taskId, "with_cleaner", Boolean(apartment.lost))
        : previous;
      queryClient.setQueryData(queryKey, {
        ...base,
        cleaners: base.cleaners.map((cleaner) => ({
          ...cleaner,
          apartments: cleaner.apartments.map((item) =>
            item.taskId === apartment.taskId ? { ...item, driverKey: taken } : item
          ),
        })),
      });
    }
    try {
      await apiRequest("POST", "/api/key-registry/driver", { date, taskId: apartment.taskId, taken });
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/key-registry"),
      });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: taken ? "Chiave autista non segnata" : "Chiave autista non tolta",
        description: error instanceof Error ? error.message : "Riprova",
        variant: "destructive",
      });
      throw error;
    } finally {
      setPendingIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(apartment.taskId);
        return nextIds;
      });
    }
  };

  const recoverLost = async (apartment: Apartment) => {
    if (viewer || pendingIds.has(apartment.taskId)) return;
    const previous = queryClient.getQueryData<RegistryPayload>(queryKey);
    setPendingIds((current) => new Set(current).add(apartment.taskId));
    if (previous) queryClient.setQueryData(queryKey, patchStatus(previous, apartment.taskId, "returned"));
    try {
      await apiRequest("POST", "/api/key-registry/recovered", { date, taskId: apartment.taskId });
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/key-registry"),
      });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: "Chiave non ripristinata",
        description: error instanceof Error ? error.message : "Riprova",
        variant: "destructive",
      });
    } finally {
      setPendingIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(apartment.taskId);
        return nextIds;
      });
    }
  };

  const payload = registryQuery.data;
  const headingDate = format(parseISO(date), "EEEE d MMMM yyyy", { locale: it });
  const searchQuery = search.trim().toLowerCase();
  const visibleCleaners = useMemo(() => {
    const cleaners = payload?.cleaners ?? [];
    if (!searchQuery) return cleaners;
    return cleaners
      .map((cleaner) => {
        const cleanerText = [cleanerTitle(cleaner), cleaner.matricola].filter(Boolean).join(" ").toLowerCase();
        if (cleanerText.includes(searchQuery)) return cleaner;
        const apartments = cleaner.apartments.filter((apartment) =>
          [apartment.logisticCode, apartment.aptCode, apartment.customerName, apartment.interventionType]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(searchQuery)
        );
        return { ...cleaner, apartments };
      })
      .filter((cleaner) => cleaner.apartments.length > 0);
  }, [payload, searchQuery]);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background text-foreground md:min-h-[calc(100dvh-3.75rem)]">
      <div className="sticky top-0 z-20 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Registro chiavi</h1>
              <p className="mt-1 text-sm capitalize text-muted-foreground">{headingDate}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <Link
                href="/chiavi-non-restituite"
                data-testid="button-unreturned-keys"
                data-viewer-allow=""
                className="inline-flex h-12 items-center rounded-md border-2 border-amber-500 px-3 text-sm font-medium text-amber-700 dark:text-amber-300"
              >
                Chiavi non restituite
              </Link>
              <Link
                href="/chiavi-smarrite"
                data-testid="button-lost-keys"
                data-viewer-allow=""
                className="inline-flex h-12 items-center rounded-md border-2 border-red-600 px-3 text-sm font-medium text-red-700 dark:text-red-300"
              >
                Chiavi smarrite
              </Link>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-12 w-12 shrink-0"
                data-viewer-allow=""
                title="Aggiorna"
                onClick={() => registryQuery.refetch()}
                disabled={registryQuery.isFetching}
              >
                <RefreshCw className={cn("h-5 w-5", registryQuery.isFetching && "animate-spin")} />
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-12 w-12 shrink-0"
              data-viewer-allow=""
              aria-label="Giorno precedente"
              onClick={() => changeDate(format(addDays(parseISO(date), -1), "yyyy-MM-dd"))}
            >
              <ChevronLeft className="h-6 w-6" />
            </Button>
            <input
              type="date"
              value={date}
              data-viewer-allow=""
              aria-label="Giorno del registro"
              className="h-12 min-w-0 flex-1 rounded-md border-2 border-custom-blue bg-background px-3 text-lg text-foreground"
              onChange={(event) => changeDate(event.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-12 w-12 shrink-0"
              data-viewer-allow=""
              aria-label="Giorno successivo"
              onClick={() => changeDate(format(addDays(parseISO(date), 1), "yyyy-MM-dd"))}
            >
              <ChevronRight className="h-6 w-6" />
            </Button>
          </div>

          <label className="relative block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={search}
              data-viewer-allow=""
              data-testid="input-key-search"
              placeholder="Cerca codice, cleaner o appartamento"
              aria-label="Cerca nel registro"
              className="h-12 w-full rounded-md border-2 border-border bg-background pl-10 pr-3 text-lg text-foreground"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          <p className="text-sm text-muted-foreground">
            Tocca il codice ADAM: la prima volta la chiave risulta consegnata, la seconda restituita.
            Un altro tocco la rimette in magazzino. Scorri a sinistra per segnarla smarrita.
            Scorri a destra se è stata presa la chiave dell'autista: risulta consegnata.
          </p>

          {payload && (
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-xl border-2 border-slate-300 bg-slate-100 px-2 py-3 dark:border-slate-600 dark:bg-slate-800">
                <p className="text-2xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {payload.totals.warehouse}
                </p>
                <p className="text-xs font-medium text-slate-700 dark:text-slate-200">In magazzino</p>
              </div>
              <div className="rounded-xl border-2 border-amber-500 bg-amber-400 px-2 py-3">
                <p className="text-2xl font-semibold tabular-nums text-amber-950">{payload.totals.withCleaner}</p>
                <p className="text-xs font-medium text-amber-950">Consegnate</p>
              </div>
              <div className="rounded-xl border-2 border-emerald-700 bg-emerald-600 px-2 py-3">
                <p className="text-2xl font-semibold tabular-nums text-white">{payload.totals.returned}</p>
                <p className="text-xs font-medium text-white">Restituite</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl px-4 py-4">
        {registryQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Caricamento registro
          </div>
        ) : registryQuery.isError ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-6 text-center">
            <p className="font-medium">Registro non disponibile</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {registryQuery.error instanceof Error ? registryQuery.error.message : "Errore di caricamento"}
            </p>
          </div>
        ) : payload && payload.cleaners.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground">
            Nessuna chiave classica assegnata in questa giornata.
          </p>
        ) : visibleCleaners.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground">
            Nessuna chiave corrisponde alla ricerca.
          </p>
        ) : (
          <div className="space-y-4 pb-8">
            {visibleCleaners.map((cleaner) => {
              const withCleaner = cleaner.apartments.filter(
                (apartment) => keyHandoverStatus(apartment) === "with_cleaner"
              ).length;
              const returned = cleaner.apartments.filter(
                (apartment) => keyHandoverStatus(apartment) === "returned"
              ).length;
              return (
                <section key={cleaner.cleanerId} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
                  <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
                    <h2 className="text-xl font-semibold">{cleanerTitle(cleaner)}</h2>
                    <p className="text-lg font-medium tabular-nums">
                      Matricola {cleaner.matricola ?? `ID ${cleaner.cleanerId}`}
                    </p>
                  </header>
                  <p className="px-4 pt-3 text-sm text-muted-foreground">
                    {withCleaner} consegnate · {returned} restituite
                  </p>
                  <ul className="space-y-2 p-3">
                    {cleaner.apartments.map((apartment) => {
                      const pending = pendingIds.has(apartment.taskId);
                      const lostToday = Boolean(apartment.lost);
                      const status = keyHandoverStatus(apartment);
                      const alertTone = lostToday ? null : priorAlertTone(apartment.priorAlerts);
                      const quiet = lostToday || status === "returned" ? "text-white/80" : "text-current/80";
                      const statusLabel = lostToday ? "Smarrita" : STATUS_LABEL[status];
                      return (
                        <SwipeKeyRow
                          key={apartment.taskId}
                          disabled={viewer || pending}
                          lostBlocked={lostToday}
                          onCommitLost={() => markLost(apartment)}
                          onCommitDriver={() => markDriver(apartment, true)}
                          className={cn(
                            "rounded-xl border-2",
                            lostToday ? "border-red-600 bg-red-600 text-white" : ROW_TONE[status]
                          )}
                        >
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                          <span className="inline-flex shrink-0 items-center gap-1.5">
                            <button
                              type="button"
                              data-testid="button-key-status"
                              aria-label={`${statusLabel}, chiave ${apartment.logisticCode}`}
                              disabled={pending || viewer || lostToday}
                              onClick={() => cycleStatus(apartment)}
                              className="text-left text-2xl font-semibold tabular-nums select-none touch-manipulation disabled:opacity-100"
                            >
                              {apartment.logisticCode}
                            </button>
                            {apartment.driverKey ? (
                              <button
                                type="button"
                                data-testid="button-driver-key"
                                title="Chiave autista"
                                aria-label={`Togli la chiave dell'autista, ${apartment.logisticCode}`}
                                disabled={pending || viewer}
                                onClick={() => markDriver(apartment, false)}
                                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 border-violet-900 bg-violet-800 text-lg font-semibold leading-none text-violet-100 disabled:opacity-100"
                              >
                                A
                              </button>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            data-testid="button-key-status"
                            aria-label={`${statusLabel}, chiave ${apartment.logisticCode}`}
                            disabled={pending || viewer || lostToday}
                            onClick={() => cycleStatus(apartment)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left select-none touch-manipulation disabled:opacity-100"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{apartment.aptCode || "—"}</span>
                              <span className={cn("block truncate text-sm", quiet)}>{apartment.customerName || "—"}</span>
                              {apartment.interventionType ? (
                                <span className={cn("block truncate text-sm", quiet)}>{apartment.interventionType}</span>
                              ) : null}
                            </span>
                            <span className="inline-flex shrink-0 items-center text-sm font-semibold">
                              {statusLabel}
                            </span>
                          </button>
                          </div>
                          {alertTone ? (
                            <button
                              type="button"
                              data-testid="button-prior-alert"
                              data-viewer-allow=""
                              aria-label={alertTone === "lost" ? "Chiave smarrita in un giorno precedente" : "Chiave non restituita in un giorno precedente"}
                              onClick={() => setAlertApartment(apartment)}
                              className={cn(
                                "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border-2 bg-white",
                                alertTone === "lost" ? "border-red-600 text-red-600" : "border-amber-500 text-amber-500"
                              )}
                            >
                              <TriangleAlert className="h-6 w-6" aria-hidden />
                            </button>
                          ) : null}
                          {lostToday && !viewer ? (
                            <button
                              type="button"
                              data-testid="button-recover-key"
                              disabled={pending}
                              onClick={() => recoverLost(apartment)}
                              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border-2 border-white/80 bg-white px-2.5 text-xs font-semibold text-red-700 disabled:opacity-60"
                            >
                              <Undo2 className="h-4 w-4" aria-hidden />
                              Ripristina
                            </button>
                          ) : null}
                          <StructureAccessKeyButtons bundles={apartment.keyBundles ?? []} size="md" layout="badge" />
                        </SwipeKeyRow>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
      <Dialog open={alertApartment !== null} onOpenChange={(open) => { if (!open) setAlertApartment(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {priorAlertTone(alertApartment?.priorAlerts) === "lost" ? "Chiave smarrita" : "Chiave non restituita"}
            </DialogTitle>
            <DialogDescription>
              Questa chiave risulta ancora aperta da un giorno precedente.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-3">
            {(alertApartment?.priorAlerts ?? []).map((alert) => (
              <li key={`${alert.kind}-${alert.workDate}-${alert.logisticCode}`} className="rounded-xl border px-4 py-3">
                <p className={cn("text-sm font-semibold", alert.kind === "lost" ? "text-red-600" : "text-amber-600")}>
                  {alert.kind === "lost" ? "Smarrita" : "Non restituita"}
                </p>
                <p className="mt-1 capitalize">
                  {format(parseISO(alert.workDate), "EEEE d MMMM yyyy", { locale: it })}
                </p>
                <p className="mt-1 text-sm">
                  {alert.cleanerName || "Cleaner"}
                  {alert.matricola ? ` · Matricola ${alert.matricola}` : ""}
                </p>
                <p className="text-sm text-muted-foreground">{alert.aptCode || "—"}</p>
                <p className="text-sm text-muted-foreground">{alert.customerName || "—"}</p>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </div>
  );
}
