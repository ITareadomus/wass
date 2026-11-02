import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { addDays, format, parseISO } from "date-fns";
import { it } from "date-fns/locale";
import { Calendar, ChevronLeft, ChevronRight, KeyRound, Loader2, RefreshCw, Search, TriangleAlert, Truck, Undo2 } from "lucide-react";
import { Link } from "wouter";
import { StructureAccessKeyButtons } from "@/components/structure-access-key-type";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { StructureAccessBundle } from "@shared/structure-access-keys";
import {
  calendarDateInRome,
  cleanersWithPhysicalKeys,
  keyHandoverStatus,
  sortKeyRegistryCleaners,
  type KeyRegistryOrder,
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
  keyStatesLocked?: boolean;
  interventionType: string | null;
  keyBundles?: StructureAccessBundle[];
  sequence: number;
  startTime: string | null;
  physicalKey?: boolean;
  prepared?: boolean;
  delivered: boolean;
  returned?: boolean;
  lost?: boolean;
  driverKey?: boolean;
  bigKey?: boolean;
  internalNote?: string | null;
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
  totals: { keys: number; warehouse: number; prepared: number; withCleaner: number; returned: number };
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
  prepared: "Preparata",
  with_cleaner: "Consegnata",
  returned: "Restituita",
};

const ROW_TONE: Record<KeyHandoverStatus, string> = {
  warehouse: "border-slate-300 bg-slate-100 text-slate-800 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100",
  prepared: "border-sky-600 bg-sky-400 text-sky-950",
  with_cleaner: "border-amber-500 bg-amber-400 text-amber-950",
  returned: "border-emerald-700 bg-emerald-600 text-white",
};

const MARKS_REVEAL = 148;

function DriverMark({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <Truck className="h-full w-full" strokeWidth={1.5} aria-hidden />
      <svg viewBox="0 0 24 24" className="absolute inset-0 h-full w-full" aria-hidden>
        <text
          x="8"
          y="12"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="currentColor"
          fontSize="7.5"
          fontWeight="700"
        >
          A
        </text>
      </svg>
    </span>
  );
}

function BigMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 48" className={className} aria-hidden>
      <path
        d="M22 12v-2a10 10 0 0 1 20 0v2"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <rect
        x="6"
        y="12"
        width="52"
        height="30"
        rx="10"
        fill="currentColor"
        fillOpacity="0.2"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <path d="M6 22h52" stroke="currentColor" strokeWidth="2.5" />
      <text
        x="32"
        y="33"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="currentColor"
        fontSize="20"
        fontWeight="700"
      >
        B
      </text>
    </svg>
  );
}

function SwipeKeyRow({
  disabled,
  lostBlocked,
  driverMarked,
  bigMarked,
  onCommitLost,
  onToggleDriver,
  onToggleBig,
  className,
  children,
}: {
  disabled: boolean;
  lostBlocked: boolean;
  driverMarked: boolean;
  bigMarked: boolean;
  onCommitLost: () => Promise<void>;
  onToggleDriver: () => Promise<void>;
  onToggleBig: () => Promise<void>;
  className?: string;
  children: ReactNode;
}) {
  const rowRef = useRef<HTMLLIElement>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const origin = useRef(0);
  const tracking = useRef(false);
  const draggingRef = useRef(false);
  const suppressClick = useRef(false);
  const revealedRef = useRef(false);
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [revealed, setRevealed] = useState(false);
  revealedRef.current = revealed;

  const resetGesture = () => {
    tracking.current = false;
    draggingRef.current = false;
    setDragging(false);
  };

  const park = (next: number) => {
    revealedRef.current = next > 0;
    setRevealed(next > 0);
    setOffset(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (disabled) return;
    const interactive = (event.target as HTMLElement).closest("button, a");
    if (interactive && interactive.getAttribute("data-testid") !== "button-key-status") return;
    tracking.current = true;
    draggingRef.current = false;
    origin.current = revealedRef.current ? MARKS_REVEAL : 0;
    startX.current = event.clientX;
    startY.current = event.clientY;
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLLIElement>) => {
    if (!tracking.current || disabled) return;
    const dx = event.clientX - startX.current;
    const dy = event.clientY - startY.current;
    if (!draggingRef.current) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx) || (dx < 0 && lostBlocked && origin.current === 0)) {
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
    const next = Math.max(-width, Math.min(width, origin.current + dx));
    setOffset(next);
  };

  const onPointerUp = () => {
    if (!tracking.current && !draggingRef.current) return;
    const width = rowRef.current?.offsetWidth ?? 320;
    const threshold = Math.min(120, width * 0.34);
    const wasRevealed = revealedRef.current;
    const moved = draggingRef.current;
    const commitLost = moved && !lostBlocked && !wasRevealed && offset < -threshold;
    const openMarks = moved && offset > threshold;
    resetGesture();
    if (!moved && wasRevealed) {
      suppressClick.current = true;
      park(0);
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      return;
    }
    if (commitLost) {
      park(0);
      void onCommitLost().finally(() => {
        suppressClick.current = false;
      });
      return;
    }
    if (openMarks || (wasRevealed && offset > threshold * 0.45)) {
      park(MARKS_REVEAL);
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      return;
    }
    park(0);
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  const markButton = (kind: "driver" | "big") => {
    const active = kind === "driver" ? driverMarked : bigMarked;
    const label = kind === "driver" ? "Autista" : "Big";
    return (
      <button
        type="button"
        data-testid={kind === "driver" ? "button-toggle-driver" : "button-toggle-big"}
        data-viewer-allow=""
        aria-pressed={active}
        aria-label={active ? `Togli ${label}` : label}
        title={active ? `Togli ${label}` : label}
        onClick={() => {
          park(0);
          void (kind === "driver" ? onToggleDriver() : onToggleBig());
        }}
        className="flex h-full w-full items-center justify-center text-white"
      >
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-2xl px-1",
            active ? "bg-white/25 ring-1 ring-white" : "opacity-80"
          )}
        >
          {kind === "driver" ? <DriverMark className="h-14 w-14" /> : <BigMark className="h-14 w-16" />}
        </span>
      </button>
    );
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
      <div className={cn("absolute inset-0 flex", offset > 0 ? "" : "invisible")}>
        <div className="h-full shrink-0 bg-violet-700" style={{ width: offset / 2 }}>
          {markButton("driver")}
        </div>
        <div className="flex h-full min-w-0 flex-1 bg-emerald-600">
          <div className="h-full shrink-0" style={{ width: offset / 2 }}>
            {markButton("big")}
          </div>
        </div>
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
        className={cn(
          "relative flex min-h-[4.75rem] w-full items-center gap-2 px-3 py-3",
          offset > 0 && "rounded-l-none border-l-0 [&_[data-mark-key]]:invisible",
          className
        )}
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

function flagsFor(status: KeyHandoverStatus): { prepared: boolean; delivered: boolean; returned: boolean; lost: boolean } {
  if (status === "returned") return { prepared: true, delivered: true, returned: true, lost: false };
  if (status === "with_cleaner") return { prepared: true, delivered: true, returned: false, lost: false };
  if (status === "prepared") return { prepared: true, delivered: false, returned: false, lost: false };
  return { prepared: false, delivered: false, returned: false, lost: false };
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
      prepared: apartments.filter((apartment) => keyHandoverStatus(apartment) === "prepared").length,
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
  const [physicalOnly, setPhysicalOnly] = useState(false);
  const [sortOrder, setSortOrder] = useState<KeyRegistryOrder>("matricola");
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
    if (viewer || apartment.physicalKey === false || apartment.keyStatesLocked || pendingIds.has(apartment.taskId)) return;
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
    if (viewer || apartment.physicalKey === false || apartment.keyStatesLocked || pendingIds.has(apartment.taskId) || apartment.lost) return;
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
    if (viewer || apartment.physicalKey === false || apartment.keyStatesLocked || pendingIds.has(apartment.taskId) || Boolean(apartment.driverKey) === taken) return;
    const previous = queryClient.getQueryData<RegistryPayload>(queryKey);
    setPendingIds((current) => new Set(current).add(apartment.taskId));
    if (previous) {
      queryClient.setQueryData(queryKey, {
        ...previous,
        cleaners: previous.cleaners.map((cleaner) => ({
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

  const markBig = async (apartment: Apartment, taken: boolean) => {
    if (viewer || apartment.physicalKey === false || apartment.keyStatesLocked || pendingIds.has(apartment.taskId) || Boolean(apartment.bigKey) === taken) return;
    const previous = queryClient.getQueryData<RegistryPayload>(queryKey);
    setPendingIds((current) => new Set(current).add(apartment.taskId));
    if (previous) {
      queryClient.setQueryData(queryKey, {
        ...previous,
        cleaners: previous.cleaners.map((cleaner) => ({
          ...cleaner,
          apartments: cleaner.apartments.map((item) =>
            item.taskId === apartment.taskId ? { ...item, bigKey: taken } : item
          ),
        })),
      });
    }
    try {
      await apiRequest("POST", "/api/key-registry/big", { date, taskId: apartment.taskId, taken });
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/key-registry"),
      });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: taken ? "Chiave Big non segnata" : "Chiave Big non tolta",
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

  const saveNote = async (apartment: Apartment, draft: string) => {
    if (viewer) return;
    const taskId = apartment.taskId;
    const note = draft.trim();
    const previous = queryClient.getQueryData<RegistryPayload>(queryKey);
    if (previous) {
      queryClient.setQueryData(queryKey, {
        ...previous,
        cleaners: previous.cleaners.map((cleaner) => ({
          ...cleaner,
          apartments: cleaner.apartments.map((item) =>
            item.taskId === taskId ? { ...item, internalNote: note || null } : item
          ),
        })),
      });
    }
    try {
      await apiRequest("POST", "/api/key-registry/note", { date, taskId, note });
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/key-registry"),
      });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: "Nota non salvata",
        description: error instanceof Error ? error.message : "Riprova",
        variant: "destructive",
      });
      throw error;
    }
  };

  const recoverLost = async (apartment: Apartment) => {
    if (viewer || apartment.physicalKey === false || pendingIds.has(apartment.taskId)) return;
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
  const today = calendarDateInRome();
  const searchQuery = search.trim().toLowerCase();
  const roster = useMemo(() => {
    const cleaners = payload?.cleaners ?? [];
    if (!physicalOnly) return cleaners;
    return cleanersWithPhysicalKeys(cleaners);
  }, [payload, physicalOnly]);
  const displayTotals = useMemo(() => {
    const apartments = roster
      .flatMap((cleaner) => cleaner.apartments)
      .filter((apartment) => apartment.physicalKey !== false && !apartment.keyStatesLocked);
    return {
      warehouse: apartments.filter((apartment) => keyHandoverStatus(apartment) === "warehouse").length,
      prepared: apartments.filter((apartment) => keyHandoverStatus(apartment) === "prepared").length,
      withCleaner: apartments.filter((apartment) => keyHandoverStatus(apartment) === "with_cleaner").length,
      returned: apartments.filter((apartment) => keyHandoverStatus(apartment) === "returned").length,
    };
  }, [roster]);
  const visibleCleaners = useMemo(() => {
    const cleaners = searchQuery
      ? roster
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
          .filter((cleaner) => cleaner.apartments.length > 0)
      : roster;
    return sortKeyRegistryCleaners(cleaners, sortOrder);
  }, [roster, searchQuery, sortOrder]);

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
                href="/generate-logistics-assignments"
                data-testid="button-logistics"
                data-viewer-allow=""
                onClick={() => localStorage.setItem("selected_work_date", date)}
                className="inline-flex h-12 items-center rounded-md border-2 border-custom-blue px-3 text-sm font-medium text-custom-blue"
              >
                Logistica
              </Link>
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
              data-viewer-allow=""
              data-testid="button-physical-keys"
              aria-pressed={physicalOnly}
              title={physicalOnly ? "Mostra tutti i tipi di chiave" : "Solo chiavi fisiche"}
              aria-label={physicalOnly ? "Mostra tutti i tipi di chiave" : "Solo chiavi fisiche"}
              onClick={() => setPhysicalOnly((current) => !current)}
              className={cn("h-12 w-12 shrink-0", physicalOnly && "border-slate-700 bg-slate-800 text-white hover:bg-slate-700 hover:text-white")}
            >
              <KeyRound className="h-5 w-5" />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              data-viewer-allow=""
              data-testid="button-today"
              title="Oggi"
              aria-label="Vai alla giornata di oggi"
              disabled={date === today}
              onClick={() => changeDate(today)}
              className="h-12 w-12 shrink-0"
            >
              <Calendar className="h-5 w-5" />
            </Button>
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

          <label className="block">
            <span className="mb-1 block text-sm font-medium text-muted-foreground">Ordine</span>
            <select
              value={sortOrder}
              data-viewer-allow=""
              data-testid="select-key-order"
              aria-label="Ordine del registro"
              className="h-12 w-full rounded-md border-2 border-custom-blue bg-background px-3 text-lg text-foreground"
              onChange={(event) => setSortOrder(event.target.value as KeyRegistryOrder)}
            >
              <option value="matricola">Matricola</option>
              <option value="arrival">Orario di arrivo</option>
            </select>
          </label>

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

          {payload && (
            <div className="grid grid-cols-4 gap-2 text-center">
              <div className="rounded-xl border-2 border-slate-300 bg-slate-100 px-1 py-3 dark:border-slate-600 dark:bg-slate-800">
                <p className="text-2xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                  {displayTotals.warehouse}
                </p>
                <p className="text-xs font-medium text-slate-700 dark:text-slate-200">In magazzino</p>
              </div>
              <div className="rounded-xl border-2 border-sky-600 bg-sky-400 px-1 py-3">
                <p className="text-2xl font-semibold tabular-nums text-sky-950">{displayTotals.prepared}</p>
                <p className="text-xs font-medium text-sky-950">Preparate</p>
              </div>
              <div className="rounded-xl border-2 border-amber-500 bg-amber-400 px-1 py-3">
                <p className="text-2xl font-semibold tabular-nums text-amber-950">{displayTotals.withCleaner}</p>
                <p className="text-xs font-medium text-amber-950">Consegnate</p>
              </div>
              <div className="rounded-xl border-2 border-emerald-700 bg-emerald-600 px-1 py-3">
                <p className="text-2xl font-semibold tabular-nums text-white">{displayTotals.returned}</p>
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
        ) : visibleCleaners.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground">
            {searchQuery
              ? "Nessuna chiave corrisponde alla ricerca."
              : physicalOnly
                ? "Nessuna chiave fisica assegnata in questa giornata."
                : "Nessuna chiave assegnata in questa giornata."}
          </p>
        ) : (
          <div className="space-y-4 pb-8">
            {visibleCleaners.map((cleaner) => {
              const tracked = cleaner.apartments.filter(
                (apartment) => apartment.physicalKey !== false && !apartment.keyStatesLocked
              );
              const prepared = tracked.filter(
                (apartment) => keyHandoverStatus(apartment) === "prepared"
              ).length;
              const withCleaner = tracked.filter(
                (apartment) => keyHandoverStatus(apartment) === "with_cleaner"
              ).length;
              const returned = tracked.filter(
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
                    {prepared} preparate · {withCleaner} consegnate · {returned} restituite
                  </p>
                  <ul className="space-y-2 p-3">
                    {cleaner.apartments.map((apartment) => {
                      const pending = pendingIds.has(apartment.taskId);
                      const handover = apartment.physicalKey !== false && !apartment.keyStatesLocked;
                      if (!handover) {
                        return (
                          <li
                            key={apartment.taskId}
                            className="flex min-h-[4.75rem] items-center gap-3 rounded-xl border-2 border-border bg-card px-3 py-3"
                          >
                            <span className="shrink-0 text-2xl font-semibold tabular-nums">{apartment.logisticCode}</span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{apartment.aptCode || "—"}</span>
                              <span className="block truncate text-sm text-muted-foreground">{apartment.customerName || "—"}</span>
                              {apartment.interventionType ? (
                                <span className="block truncate text-sm text-muted-foreground">{apartment.interventionType}</span>
                              ) : null}
                              {apartment.internalNote ? (
                                <span className="block truncate text-sm text-amber-700 dark:text-amber-300">{apartment.internalNote}</span>
                              ) : null}
                            </span>
                            <StructureAccessKeyButtons
                              bundles={apartment.keyBundles ?? []}
                              size="md"
                              layout="badge"
                              physicalKey={apartment.physicalKey !== false}
                              showInternalNote
                              internalNote={apartment.internalNote}
                              internalNoteReadOnly={viewer}
                              onSaveInternalNote={(note) => saveNote(apartment, note)}
                            />
                          </li>
                        );
                      }
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
                          driverMarked={Boolean(apartment.driverKey)}
                          bigMarked={Boolean(apartment.bigKey)}
                          onCommitLost={() => markLost(apartment)}
                          onToggleDriver={() => markDriver(apartment, !apartment.driverKey)}
                          onToggleBig={() => markBig(apartment, !apartment.bigKey)}
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
                                data-mark-key=""
                                disabled={pending || viewer}
                                title="Togli autista. Puoi anche scorrere a destra e toccare il furgone."
                                aria-label={`Togli chiave dell'autista, ${apartment.logisticCode}`}
                                onClick={() => markDriver(apartment, false)}
                                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white bg-violet-700 text-white disabled:opacity-100"
                              >
                                <DriverMark className="h-8 w-8" />
                              </button>
                            ) : null}
                            {apartment.bigKey ? (
                              <button
                                type="button"
                                data-testid="button-big-key"
                                data-mark-key=""
                                disabled={pending || viewer}
                                title="Togli Big. Puoi anche scorrere a destra e toccare il borsone."
                                aria-label={`Togli chiave Big, ${apartment.logisticCode}`}
                                onClick={() => markBig(apartment, false)}
                                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white bg-emerald-600 text-white disabled:opacity-100"
                              >
                                <BigMark className="h-8 w-8" />
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
                              {apartment.internalNote ? (
                                <span className={cn("block truncate text-sm", quiet)}>{apartment.internalNote}</span>
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
                          <StructureAccessKeyButtons
                            bundles={apartment.keyBundles ?? []}
                            size="md"
                            layout="badge"
                            physicalKey
                            showInternalNote
                            internalNote={apartment.internalNote}
                            internalNoteReadOnly={viewer}
                            onSaveInternalNote={(note) => saveNote(apartment, note)}
                          />
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
