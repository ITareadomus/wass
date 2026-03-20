import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { DragDropContext, type DropResult } from "react-beautiful-dnd";
import { ThemeToggle } from "@/components/theme-toggle";
import { HousekeepingLogisticsSwitch } from "@/components/housekeeping-logistics-switch";
import { WassSiteHeader } from "@/components/wass-site-header";
import { useToast } from "@/hooks/use-toast";
import PriorityColumn from "@/components/drag-drop/priority-column";
import LogisticsTimelineView from "@/components/timeline/logistics-timeline-view";
import type { TaskType } from "@shared/schema";
import {
  CalendarIcon,
  RefreshCw,
  HelpCircle,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Link } from "wouter";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function getCurrentUsername(): string {
  try {
    const raw = localStorage.getItem("user");
    if (raw) {
      const u = JSON.parse(raw);
      return u.username || "unknown";
    }
  } catch {
    /* ignore */
  }
  return "unknown";
}

interface LogisticsSummaryState {
  early_out: number;
  high_priority: number;
  low_priority: number;
  total: number;
  premium: number;
  standard: number;
  straordinarie: number;
}

/** Task logistics da API / PostgreSQL (snake_case) */
interface LogisticsTask {
  task_id?: number | string;
  logistic_code?: string | null;
  client_id?: number | null;
  address?: string | null;
  alias?: string | null;
  customer_name?: string | null;
  customer_reference?: string | null;
  /** Minuti da DB — usati solo per larghezza card (come duration nei TaskCard housekeeping) */
  cleaning_time?: number | null;
  type_apt?: string | null;
  confirmed_operation?: boolean | number | null;
  locked?: boolean | null;
  locked_reason?: string | null;
  checkout_date?: string | null;
  checkout_time?: string | null;
  checkin_date?: string | null;
  checkin_time?: string | null;
  pax_in?: number | null;
  pax_out?: number | null;
  operation_id?: number | null;
  premium?: boolean | null;
  straordinaria?: boolean | null;
  lat?: string | null;
  lng?: string | null;
}

interface LogisticsTaskLists {
  early_out: LogisticsTask[];
  high_priority: LogisticsTask[];
  low_priority: LogisticsTask[];
}

const EMPTY_LOGISTICS_TASK_LISTS: LogisticsTaskLists = {
  early_out: [],
  high_priority: [],
  low_priority: [],
};

function parseLogisticsTaskLists(data: any): LogisticsTaskLists {
  return {
    early_out: containerTasks(data?.containers?.early_out) as LogisticsTask[],
    high_priority: containerTasks(data?.containers?.high_priority) as LogisticsTask[],
    low_priority: containerTasks(data?.containers?.low_priority) as LogisticsTask[],
  };
}

/** Come `formatDuration` in generate-assignments.tsx */
function formatDurationMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}.${mins.toString().padStart(2, "0")}`;
}

/** Converte riga API logistics → TaskType per PriorityColumn / TaskCard (housekeeping) */
function convertLogisticsRawToTask(
  raw: LogisticsTask,
  priority: "early_out" | "high_priority" | "low_priority"
): TaskType {
  const cleaning =
    typeof raw.cleaning_time === "number" && Number.isFinite(raw.cleaning_time)
      ? raw.cleaning_time
      : 0;
  const duration = formatDurationMinutes(cleaning);
  const name = String(raw.logistic_code ?? raw.task_id ?? "N/A");
  const id = String(raw.task_id ?? name);
  const priorityUi: "early-out" | "high" | "low" =
    priority === "early_out" ? "early-out" : priority === "high_priority" ? "high" : "low";

  const co = raw.confirmed_operation;
  const confirmed_operation =
    typeof co === "boolean" ? co : typeof co === "number" ? co !== 0 : undefined;

  return {
    id,
    name,
    alias: raw.alias ?? undefined,
    type: String(raw.customer_name || `Client ${raw.client_id ?? ""}`),
    duration,
    priority: priorityUi,
    assignedTo: null,
    status: "pending",
    scheduledTime: null,
    address: raw.address != null ? String(raw.address) : undefined,
    lat: raw.lat != null ? String(raw.lat) : undefined,
    lng: raw.lng != null ? String(raw.lng) : undefined,
    premium: Boolean(raw.premium),
    straordinaria: Boolean(raw.straordinaria),
    confirmed_operation,
    checkout_date: raw.checkout_date != null ? String(raw.checkout_date) : undefined,
    checkout_time: raw.checkout_time != null ? String(raw.checkout_time) : undefined,
    checkin_date: raw.checkin_date != null ? String(raw.checkin_date) : undefined,
    checkin_time: raw.checkin_time != null ? String(raw.checkin_time) : undefined,
    pax_in: typeof raw.pax_in === "number" ? raw.pax_in : undefined,
    pax_out: typeof raw.pax_out === "number" ? raw.pax_out : undefined,
    operation_id: typeof raw.operation_id === "number" ? raw.operation_id : undefined,
    customer_name: raw.customer_name != null ? String(raw.customer_name) : undefined,
    customer_reference:
      raw.customer_reference != null ? String(raw.customer_reference) : undefined,
    type_apt: raw.type_apt != null ? String(raw.type_apt) : undefined,
    locked: Boolean(raw.locked),
    locked_reason: raw.locked_reason != null ? String(raw.locked_reason) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** Stessa logica di evidenziazione ricerca usata in generate-assignments (PriorityColumn + TaskCard). */
function highlightedIdsForSearch(tasks: TaskType[], searchTask: string): Set<string> {
  const result = new Set<string>();
  const q = searchTask.trim();
  if (!q) return result;
  const lowerSearch = q.toLowerCase();
  for (const task of tasks) {
    const taskId = String(task.id);
    const logisticCode = String(task.name || "");
    const address = String(task.address || "");
    const customerName = String(task.customer_name || "");
    const alias = String(task.alias || "");
    const customerReference = String(task.customer_reference || "");
    if (
      taskId.toLowerCase().includes(lowerSearch) ||
      logisticCode.toLowerCase().includes(lowerSearch) ||
      address.toLowerCase().includes(lowerSearch) ||
      customerName.toLowerCase().includes(lowerSearch) ||
      alias.toLowerCase().includes(lowerSearch) ||
      customerReference.toLowerCase().includes(lowerSearch)
    ) {
      result.add(taskId);
    }
  }
  return result;
}

function containerTasks(container: any): any[] {
  if (!container) return [];
  if (Array.isArray(container)) return container;
  if (Array.isArray(container.tasks)) return container.tasks;
  return [];
}

/** Evita SyntaxError su `response.json()` quando il body è HTML (es. SPA fallback / porta sbagliata). */
async function parseFetchJsonOrFallback<T>(res: Response, fallback: T): Promise<T> {
  const raw = await res.text();
  if (!res.ok) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function parseFetchJsonStrictWhenOk(res: Response, notOkMessage: string): Promise<unknown> {
  const raw = await res.text();
  if (!res.ok) throw new Error(notOkMessage);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(
      raw.trimStart().startsWith("<")
        ? "Risposta HTML al posto di JSON: apri l'app con npm run dev (Express + Vite sulla stessa porta, es. 5000), non solo il dev server Vite su un'altra porta."
        : "Risposta non valida dal server (non JSON)."
    );
  }
}

function parseLogisticsSummary(data: any): LogisticsSummaryState {
  const eo = containerTasks(data?.containers?.early_out);
  const hp = containerTasks(data?.containers?.high_priority);
  const lp = containerTasks(data?.containers?.low_priority);
  const all = [...eo, ...hp, ...lp];
  let premium = 0;
  let standard = 0;
  let straordinarie = 0;
  for (const t of all) {
    if (t?.straordinaria) straordinarie += 1;
    else if (t?.premium) premium += 1;
    else standard += 1;
  }
  const total = data?.summary?.total_tasks ?? all.length;
  return {
    early_out: data?.summary?.early_out ?? data?.containers?.early_out?.count ?? eo.length,
    high_priority:
      data?.summary?.high_priority ?? data?.containers?.high_priority?.count ?? hp.length,
    low_priority: data?.summary?.low_priority ?? data?.containers?.low_priority?.count ?? lp.length,
    total,
    premium,
    standard,
    straordinarie,
  };
}

const isDateInPast = (date: Date): boolean => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  return target < today;
};

/** Task timeline → TaskType per ricerca / drag */
function timelineRowToTaskType(t: any, fallbackPriority: TaskType["priority"]): TaskType {
  const cleaning = Number(t.cleaning_time) || 0;
  const hours = Math.floor(cleaning / 60);
  const mins = cleaning % 60;
  const pr = String(t.priority || "").toLowerCase();
  let priorityUi: TaskType["priority"] = fallbackPriority;
  if (pr === "early_out" || pr === "early-out") priorityUi = "early-out";
  else if (pr === "high_priority" || pr === "high") priorityUi = "high";
  else if (pr === "low_priority" || pr === "low") priorityUi = "low";
  return {
    id: String(t.task_id),
    name: String(t.logistic_code ?? t.task_id),
    type: String(t.customer_name || ""),
    duration: `${hours}.${String(mins).padStart(2, "0")}`,
    priority: priorityUi,
    assignedTo: null,
    status: "pending",
    scheduledTime: t.start_time ?? null,
    address: t.address != null ? String(t.address) : undefined,
    premium: Boolean(t.premium),
    straordinaria: Boolean(t.straordinaria),
    locked: Boolean(t.locked),
    locked_reason: t.locked_reason != null ? String(t.locked_reason) : undefined,
    customer_name: t.customer_name != null ? String(t.customer_name) : undefined,
    customer_reference: t.customer_reference != null ? String(t.customer_reference) : undefined,
    alias: t.alias != null ? String(t.alias) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

type AdamFingerprint = {
  count: number;
  max_updated_at_unix: number | null;
  signature_xor: number | null;
  signature_sum: string | number | null;
};

export default function GenerateLogisticsAssignments() {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const saved = localStorage.getItem("selected_work_date");
    if (saved) {
      try {
        const [y, m, d] = saved.split("-").map(Number);
        return new Date(y, m - 1, d);
      } catch {
        /* fallthrough */
      }
    }
    return new Date();
  });
  const [searchTask, setSearchTask] = useState("");
  /** Solo sul pulsante refresh (come generate-assignments), nessun overlay pagina */
  const [isRefreshingContainers, setIsRefreshingContainers] = useState(false);
  const [logisticsSummary, setLogisticsSummary] = useState<LogisticsSummaryState | null>(null);
  const [logisticsTaskLists, setLogisticsTaskLists] = useState<LogisticsTaskLists>(EMPTY_LOGISTICS_TASK_LISTS);
  const [logisticsDrivers, setLogisticsDrivers] = useState<
    Array<{ id: number; name?: string; lastname?: string; role?: string; premium?: boolean; start_time?: string | null }>
  >([]);
  const [logisticsDriversAssignments, setLogisticsDriversAssignments] = useState<
    Array<{ driver: { id: number; name?: string; lastname?: string; role?: string; premium?: boolean; start_time?: string | null }; tasks: any[] }>
  >([]);
  const [isLoadingDragDrop, setIsLoadingDragDrop] = useState(false);
  /** Estrazione / refresh da ADAM al cambio data (come checkAndAutoLoadSavedAssignments + extractData su HK) */
  const [isExtractingLogistics, setIsExtractingLogistics] = useState(false);
  const [extractionStep, setExtractionStep] = useState("Inizializzazione...");
  /** Allinea titolo e riga "Step x/2" al loader housekeeping */
  const [logisticsLoaderKind, setLogisticsLoaderKind] = useState<
    "extract" | "load-tasks" | "general"
  >("general");
  const lastValidDragIndexRef = useRef<number | null>(null);
  const isDraggingRef = useRef(false);
  const dragTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const adamBaselineRef = useRef<AdamFingerprint | null>(null);
  const [hasAdamUpdates, setHasAdamUpdates] = useState(false);

  const isTimelineReadOnly = isDateInPast(selectedDate);

  useEffect(() => {
    localStorage.setItem("selected_work_date", format(selectedDate, "yyyy-MM-dd"));
  }, [selectedDate]);

  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      setSelectedDate(date);
    }
  };

  const fetchAdamLogisticsFingerprint = useCallback(async (workDate: string): Promise<AdamFingerprint | null> => {
    try {
      const r = await fetch(`/api/adam/logistics/fingerprint?date=${encodeURIComponent(workDate)}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data?.success) return null;
      return {
        count: Number(data.count ?? 0),
        max_updated_at_unix:
          data.max_updated_at_unix !== null && data.max_updated_at_unix !== undefined
            ? Number(data.max_updated_at_unix)
            : null,
        signature_xor:
          data.signature_xor !== null && data.signature_xor !== undefined ? Number(data.signature_xor) : null,
        signature_sum: data.signature_sum ?? null,
      };
    } catch {
      return null;
    }
  }, []);

  // Polling fingerprint ADAM logistics (come housekeeping: 15s, pausa tab nascosta)
  useEffect(() => {
    adamBaselineRef.current = null;
    setHasAdamUpdates(false);

    let stopped = false;
    const workDate = format(selectedDate, "yyyy-MM-dd");

    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") return;

      const fp = await fetchAdamLogisticsFingerprint(workDate);
      if (!fp) return;

      if (!adamBaselineRef.current) {
        adamBaselineRef.current = fp;
        setHasAdamUpdates(false);
        return;
      }

      const base = adamBaselineRef.current;
      const changed =
        fp.count !== base.count ||
        fp.max_updated_at_unix !== base.max_updated_at_unix ||
        fp.signature_xor !== base.signature_xor ||
        String(fp.signature_sum ?? "") !== String(base.signature_sum ?? "");

      if (changed) setHasAdamUpdates(true);
    };

    const timer = setInterval(poll, 15_000);
    poll();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selectedDate, fetchAdamLogisticsFingerprint]);

  /** Carica solo da PostgreSQL (GET), senza rigenerare da ADAM — come loadTasks dopo mount su HK */
  const loadLogisticsContainers = useCallback(async (date: Date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    try {
      const getRes = await fetch(`/api/logistics-containers?date=${dateStr}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
      const data = await parseFetchJsonStrictWhenOk(
        getRes,
        "Impossibile caricare i containers logistics"
      );
      setLogisticsSummary(parseLogisticsSummary(data));
      setLogisticsTaskLists(parseLogisticsTaskLists(data));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Errore sconosciuto";
      toast({
        variant: "destructive",
        title: "Errore caricamento",
        description: msg,
      });
    }
  }, [toast]);

  const loadLogisticsTimelineState = useCallback(async (date: Date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    try {
      const [selRes, tlRes] = await Promise.all([
        fetch(`/api/selected-logistics-drivers?date=${dateStr}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        }),
        fetch(`/api/logistics-timeline?date=${dateStr}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        }),
      ]);
      const sel = await parseFetchJsonOrFallback(selRes, { drivers: [] as unknown[] });
      const tl = await parseFetchJsonOrFallback(tlRes, { drivers_assignments: [] as unknown[] });
      const selDrivers = sel.drivers || [];
      const fromTl = tl.drivers_assignments || [];
      const selectedIds = new Set(selDrivers.map((d: { id: number }) => d.id));

      const mergedSelected = selDrivers.map((d: { id: number; name?: string; lastname?: string }) => {
        const hit = fromTl.find((x: { driver?: { id: number } }) => x.driver?.id === d.id);
        return hit ? { ...hit, driver: { ...hit.driver, ...d } } : { driver: d, tasks: [] };
      });

      const orphanRows = fromTl.filter(
        (x: { driver?: { id: number }; tasks?: unknown[] }) =>
          x.driver?.id != null &&
          !selectedIds.has(x.driver.id) &&
          (x.tasks?.length || 0) > 0
      );

      const assignments = [
        ...mergedSelected,
        ...orphanRows.map((row: { driver: { id: number }; tasks: unknown[] }) => ({
          ...row,
          driver: { ...row.driver, isRemoved: true as const },
        })),
      ];

      setLogisticsDrivers(assignments.map((row: { driver: (typeof selDrivers)[number] & { isRemoved?: boolean } }) => row.driver));
      setLogisticsDriversAssignments(assignments);
    } catch (e) {
      console.error("loadLogisticsTimelineState", e);
      setLogisticsDrivers([]);
      setLogisticsDriversAssignments([]);
    }
  }, []);

  const reloadLogisticsPage = useCallback(async () => {
    await loadLogisticsContainers(selectedDate);
    await loadLogisticsTimelineState(selectedDate);
  }, [selectedDate, loadLogisticsContainers, loadLogisticsTimelineState]);

  /**
   * Allineato a generate-assignments: data passata → solo PG; data oggi/futura → se la timeline ha già task
   * per quella data si ricarica senza script; altrimenti extract driver + create_containers logistics (ADAM).
   */
  useEffect(() => {
    let cancelled = false;
    const date = selectedDate;
    const dateStr = format(date, "yyyy-MM-dd");

    const run = async () => {
      if (isDateInPast(date)) {
        await loadLogisticsContainers(date);
        await loadLogisticsTimelineState(date);
        return;
      }

      setIsExtractingLogistics(true);
      setLogisticsLoaderKind("general");
      setExtractionStep("Caricamento dati...");

      try {
        const tlRes = await fetch(`/api/logistics-timeline?date=${encodeURIComponent(dateStr)}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });

        if (cancelled) return;

        const timeline = await parseFetchJsonOrFallback(tlRes, {} as Record<string, unknown>);
        const hasTimelineWork = (timeline.drivers_assignments || []).some(
          (da: { tasks?: unknown[] }) => Array.isArray(da.tasks) && da.tasks.length > 0
        );
        const metadataOk = timeline.metadata?.date === dateStr;

        if (hasTimelineWork && metadataOk) {
          setLogisticsLoaderKind("load-tasks");
          setExtractionStep("Caricamento task nei contenitori...");
          await loadLogisticsContainers(date);
          await loadLogisticsTimelineState(date);
          setExtractionStep("Dati caricati!");
          await new Promise((resolve) => setTimeout(resolve, 100));
          return;
        }

        setLogisticsLoaderKind("extract");
        setExtractionStep("Estrazione dati dal database...");
        const exRes = await fetch("/api/extract-logistics-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: dateStr }),
        });
        const exJson = await exRes.json().catch(() => ({}));
        if (!exJson?.success) {
          console.warn("extract-logistics-drivers:", exJson?.message || exRes.status);
        }

        if (cancelled) return;

        const refreshRes = await fetch("/api/logistics-containers/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: dateStr, modified_by: getCurrentUsername() }),
        });
        if (!refreshRes.ok) {
          const j = await refreshRes.json().catch(() => ({}));
          throw new Error((j as { error?: string }).error || "Refresh containers fallito");
        }

        if (cancelled) return;

        const fp = await fetchAdamLogisticsFingerprint(dateStr);
        if (fp) {
          adamBaselineRef.current = fp;
          setHasAdamUpdates(false);
        }

        setLogisticsLoaderKind("load-tasks");
        setExtractionStep("Caricamento task nei contenitori...");
        await loadLogisticsContainers(date);
        await loadLogisticsTimelineState(date);
        setExtractionStep("Task caricati!");
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch (e: unknown) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Errore sconosciuto";
        setExtractionStep("Errore durante l'estrazione. Caricamento task esistenti...");
        setLogisticsLoaderKind("load-tasks");
        toast({
          variant: "destructive",
          title: "Caricamento logistica",
          description: msg,
        });
        await loadLogisticsContainers(date);
        await loadLogisticsTimelineState(date);
      } finally {
        if (!cancelled) {
          setIsExtractingLogistics(false);
          setExtractionStep("Inizializzazione...");
          setLogisticsLoaderKind("general");
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [
    selectedDate,
    loadLogisticsContainers,
    loadLogisticsTimelineState,
    fetchAdamLogisticsFingerprint,
    toast,
  ]);

  /** Refresh pesante da ADAM (script create_containers logistics) + reload — come pulsante su generate-assignments */
  const refreshLogisticsContainersFromAdam = useCallback(async () => {
    const dateStr = format(selectedDate, "yyyy-MM-dd");
    setIsRefreshingContainers(true);
    try {
      const refreshRes = await fetch("/api/logistics-containers/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, modified_by: getCurrentUsername() }),
      });
      if (!refreshRes.ok) {
        const j = await refreshRes.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error || "Errore durante il refresh");
      }

      const fp = await fetchAdamLogisticsFingerprint(dateStr);
      if (fp) {
        adamBaselineRef.current = fp;
        setHasAdamUpdates(false);
      }

      toast({
        variant: "success",
        title: "Containers aggiornati",
        description: "I dati dei task sono stati aggiornati da ADAM",
      });
      await reloadLogisticsPage();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Errore sconosciuto";
      toast({
        variant: "destructive",
        title: "Errore",
        description: msg.includes("refresh") ? msg : "Errore durante il refresh dei containers",
      });
    } finally {
      setIsRefreshingContainers(false);
    }
  }, [selectedDate, toast, fetchAdamLogisticsFingerprint, reloadLogisticsPage]);

  const s = logisticsSummary;

  const earlyOutTasks = useMemo(
    () => logisticsTaskLists.early_out.map((t) => convertLogisticsRawToTask(t, "early_out")),
    [logisticsTaskLists.early_out]
  );
  const highPriorityTasks = useMemo(
    () => logisticsTaskLists.high_priority.map((t) => convertLogisticsRawToTask(t, "high_priority")),
    [logisticsTaskLists.high_priority]
  );
  const lowPriorityTasks = useMemo(
    () => logisticsTaskLists.low_priority.map((t) => convertLogisticsRawToTask(t, "low_priority")),
    [logisticsTaskLists.low_priority]
  );

  const highlightedEarlyOut = useMemo(
    () => highlightedIdsForSearch(earlyOutTasks, searchTask),
    [earlyOutTasks, searchTask]
  );
  const highlightedHighPriority = useMemo(
    () => highlightedIdsForSearch(highPriorityTasks, searchTask),
    [highPriorityTasks, searchTask]
  );
  const highlightedLowPriority = useMemo(
    () => highlightedIdsForSearch(lowPriorityTasks, searchTask),
    [lowPriorityTasks, searchTask]
  );

  const allTasksWithAssignments = useMemo(() => {
    const timelineTasks: TaskType[] = [];
    for (const row of logisticsDriversAssignments) {
      for (const t of row.tasks || []) {
        timelineTasks.push(timelineRowToTaskType(t, "low"));
      }
    }
    return [...earlyOutTasks, ...highPriorityTasks, ...lowPriorityTasks, ...timelineTasks];
  }, [earlyOutTasks, highPriorityTasks, lowPriorityTasks, logisticsDriversAssignments]);

  const parseDriverId = (droppableId: string | undefined | null) => {
    if (!droppableId?.startsWith("timeline-")) return null;
    const n = Number(droppableId.slice("timeline-".length));
    return Number.isFinite(n) ? n : null;
  };

  const parseContainerKey = (
    droppableId: string | undefined | null
  ): "early_out" | "high_priority" | "low_priority" | null => {
    if (!droppableId) return null;
    if (droppableId === "early-out") return "early_out";
    if (droppableId === "high") return "high_priority";
    if (droppableId === "low") return "low_priority";
    return null;
  };

  const saveLogisticsAssignment = async (
    taskId: string,
    driverId: number,
    logisticCode: string | undefined,
    insertAt?: number
  ) => {
    const dateStr = format(selectedDate, "yyyy-MM-dd");
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    const res = await fetch("/api/save-logistics-timeline-assignment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId,
        driverId,
        logisticCode,
        date: dateStr,
        insertAt,
        modified_by: user.username || "unknown",
      }),
    });
    if (!res.ok) {
      if (res.status === 423) throw new Error("Task bloccata");
      throw new Error("Assegnazione fallita");
    }
  };

  const removeLogisticsTimelineAssignment = async (taskId: string, logisticCode?: string) => {
    const dateStr = format(selectedDate, "yyyy-MM-dd");
    const res = await fetch("/api/remove-logistics-timeline-assignment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, logisticCode, date: dateStr }),
    });
    if (!res.ok) throw new Error("Rimozione fallita");
  };

  const reorderLogisticsTimeline = async (
    taskId: string,
    logisticCode: string | undefined,
    driverId: number,
    fromIndex: number,
    toIndex: number
  ) => {
    const dateStr = format(selectedDate, "yyyy-MM-dd");
    const user = JSON.parse(localStorage.getItem("user") || "{}");
    const res = await fetch("/api/reorder-logistics-timeline", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: dateStr,
        driverId,
        taskId,
        logisticCode,
        fromIndex,
        toIndex,
        modified_by: user.username || "unknown",
      }),
    });
    if (!res.ok) throw new Error("Riordino fallito");
  };

  const onDragUpdate = (update: { destination?: { droppableId: string; index: number } | null }) => {
    const { destination } = update;
    if (!destination) {
      lastValidDragIndexRef.current = null;
      return;
    }
    if (parseDriverId(destination.droppableId) !== null) {
      lastValidDragIndexRef.current = destination.index;
    } else {
      lastValidDragIndexRef.current = null;
    }
  };

  const onDragEnd = async (result: DropResult) => {
    const dropIndexSnapshot = lastValidDragIndexRef.current;
    lastValidDragIndexRef.current = null;
    const { destination, source, draggableId } = result;
    if (!destination) return;
    if (destination.droppableId === source.droppableId && destination.index === source.index) {
      return;
    }

    const toContainer = parseContainerKey(destination.droppableId);
    const toDriverId = parseDriverId(destination.droppableId);
    const fromContainer = parseContainerKey(source.droppableId);
    const fromDriverId = parseDriverId(source.droppableId);

    const taskId = draggableId.includes("-cleaner-") ? draggableId.split("-cleaner-")[0] : draggableId;
    const task = allTasksWithAssignments.find((t) => String(t.id) === String(taskId));
    const logisticCode = task?.name;

    if (isTimelineReadOnly) {
      toast({ title: "Sola lettura", description: "Data nel passato", variant: "destructive" });
      return;
    }

    if (task && (task as TaskType & { locked?: boolean }).locked && fromDriverId === null) {
      toast({ title: "Task bloccata", variant: "destructive" });
      return;
    }

    setIsLoadingDragDrop(true);
    isDraggingRef.current = true;
    if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
    dragTimeoutRef.current = setTimeout(() => {
      isDraggingRef.current = false;
      setIsLoadingDragDrop(false);
    }, 10000);

    try {
      if (fromContainer != null && toDriverId !== null && fromDriverId === null) {
        const idx = dropIndexSnapshot !== null ? dropIndexSnapshot : destination.index;
        await saveLogisticsAssignment(taskId, toDriverId, logisticCode, idx);
        await reloadLogisticsPage();
        toast({ title: "Task assegnata", variant: "success" });
        return;
      }

      if (fromDriverId !== null && toDriverId !== null && fromDriverId === toDriverId) {
        await reorderLogisticsTimeline(taskId, logisticCode, fromDriverId, source.index, destination.index);
        await reloadLogisticsPage();
        toast({ title: "Riordinata", variant: "success" });
        return;
      }

      if (fromDriverId !== null && toDriverId !== null && fromDriverId !== toDriverId) {
        const idx = dropIndexSnapshot !== null ? dropIndexSnapshot : destination.index;
        const user = JSON.parse(localStorage.getItem("user") || "{}");
        const res = await fetch("/api/move-task-between-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taskId,
            logisticCode,
            sourceDriverId: fromDriverId,
            destDriverId: toDriverId,
            destIndex: idx,
            date: format(selectedDate, "yyyy-MM-dd"),
            modified_by: user.username || "unknown",
          }),
        });
        if (!res.ok) throw new Error("Spostamento fallito");
        await reloadLogisticsPage();
        toast({ title: "Task spostata", variant: "success" });
        return;
      }

      if (fromDriverId !== null && toContainer != null && toDriverId === null) {
        await removeLogisticsTimelineAssignment(taskId, logisticCode);
        await reloadLogisticsPage();
        toast({ title: "Task rimossa dalla timeline", variant: "success" });
        return;
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Errore";
      toast({ title: "Errore", description: msg, variant: "destructive" });
    } finally {
      isDraggingRef.current = false;
      if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
      setIsLoadingDragDrop(false);
    }
  };

  if (isExtractingLogistics) {
    return (
      <div className="bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary"></div>
          </div>
          <h2 className="text-2xl font-bold text-foreground">
            {logisticsLoaderKind === "extract"
              ? "Estrazione Dati in Corso"
              : logisticsLoaderKind === "load-tasks"
                ? "Caricamento Task"
                : "Caricamento Dati"}
          </h2>
          <p className="text-muted-foreground">{extractionStep}</p>
          <div className="flex items-center justify-center space-x-2 text-sm text-muted-foreground">
            {logisticsLoaderKind === "extract" && (
              <>
                <span className="inline-block w-2 h-2 bg-primary rounded-full animate-pulse"></span>
                <span>Step 1/2: Estrazione driver dal database</span>
              </>
            )}
            {logisticsLoaderKind === "load-tasks" && (
              <>
                <span className="inline-block w-2 h-2 bg-primary rounded-full animate-pulse"></span>
                <span>Step 2/2: Caricamento nei contenitori</span>
              </>
            )}
            {logisticsLoaderKind === "general" && (
              <>
                <span className="inline-block w-2 h-2 bg-primary rounded-full animate-pulse"></span>
                <span>Caricamento generale...</span>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground min-h-screen">
      <WassSiteHeader
        right={
          <>
            <Link href={`/unconfirmed-tasks?date=${format(selectedDate, "yyyy-MM-dd")}`}>
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                title="Task Non Confermate"
                data-testid="link-unconfirmed-tasks-logistics"
              >
                <HelpCircle className="h-5 w-5" />
              </Button>
            </Link>
            <ThemeToggle />
          </>
        }
      />
      <div className="w-full px-4 pt-3 pb-6">
        <div className="mx-auto mb-6 flex w-full max-w-[1920px] flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <h1 className="flex items-center gap-2 text-[25px] font-bold text-foreground">
              LOGISTICS del
            </h1>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "justify-start border-2 border-custom-blue text-left text-[13px] font-normal [background-clip:unset] [-webkit-background-clip:unset]",
                    !selectedDate && "text-muted-foreground"
                  )}
                  data-testid="button-logistics-work-date"
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {selectedDate ? format(selectedDate, "dd/MM/yyyy", { locale: it }) : <span>Seleziona data</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={handleDateSelect}
                  initialFocus
                  locale={it}
                />
              </PopoverContent>
            </Popover>
          </div>
          <HousekeepingLogisticsSwitch active="logistics" />
        </div>

        <div className="mx-auto mb-4 flex w-full max-w-[1920px] flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 transform text-custom-blue" />
              <Input
                placeholder="Cerca task..."
                value={searchTask}
                onChange={(e) => setSearchTask(e.target.value)}
                className="border-2 border-custom-blue pl-10"
                data-testid="input-search-task-logistics"
              />
            </div>
            <div className="flex shrink-0 items-center overflow-hidden rounded-md border-2 border-custom-blue bg-custom-blue">
              <Button
                variant="ghost"
                size="sm"
                disabled={isRefreshingContainers}
                title="Aggiorna containers da ADAM"
                onClick={() => void refreshLogisticsContainersFromAdam()}
                className="flex items-center rounded-none px-3 text-black hover:bg-custom-blue/80 dark:text-white"
                data-testid="button-logistics-refresh-adam"
              >
                {isRefreshingContainers ? (
                  <span className="relative inline-flex">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                  </span>
                ) : (
                  <span className="relative inline-flex">
                    <RefreshCw className="h-4 w-4" />
                    {hasAdamUpdates && (
                      <span
                        className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500"
                        title="Aggiornamenti disponibili da ADAM"
                      />
                    )}
                  </span>
                )}
              </Button>
              <div className="h-6 w-px bg-black/20 dark:bg-white/20" />
              <Button
                variant="ghost"
                size="sm"
                disabled
                title="In arrivo"
                className="flex items-center gap-2 rounded-none px-3 text-black hover:bg-custom-blue/80 dark:text-white"
              >
                <CalendarIcon className="h-4 w-4" />
                Assegna
              </Button>
            </div>
          </div>
        </div>

        <DragDropContext onDragEnd={onDragEnd} onDragUpdate={onDragUpdate}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6 w-full">
            <PriorityColumn
              title="EARLY OUT"
              priority="early-out"
              tasks={earlyOutTasks}
              droppableId="early-out"
              icon="clock"
              isDragDisabled={isTimelineReadOnly}
              disableToolbar
              flushDropZone
              operationsScope="logistics"
              highlightedTaskIds={highlightedEarlyOut}
            />
            <PriorityColumn
              title="HIGH PRIORITY"
              priority="high"
              tasks={highPriorityTasks}
              droppableId="high"
              icon="alert-circle"
              isDragDisabled={isTimelineReadOnly}
              disableToolbar
              flushDropZone
              operationsScope="logistics"
              highlightedTaskIds={highlightedHighPriority}
            />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={lowPriorityTasks}
              droppableId="low"
              icon="arrow-down"
              isDragDisabled={isTimelineReadOnly}
              disableToolbar
              flushDropZone
              operationsScope="logistics"
              highlightedTaskIds={highlightedLowPriority}
            />
          </div>

          <div className="mt-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
              <LogisticsTimelineView
                workDate={format(selectedDate, "yyyy-MM-dd")}
                drivers={logisticsDrivers}
                driversAssignments={logisticsDriversAssignments}
                searchTask={searchTask}
                isReadOnly={isTimelineReadOnly}
                isLoadingOverlay={isLoadingDragDrop}
                onRefresh={reloadLogisticsPage}
              />
            </div>

            <div className="space-y-6">
            <div className="min-h-[200px] rounded-lg border-2 border-border bg-card shadow-sm flex items-center justify-center text-muted-foreground text-sm">
              Mappa (in arrivo)
            </div>

            <div className="bg-card rounded-lg border shadow-sm">
              <div className="p-4 border-b border-border">
                <h3 className="font-semibold text-foreground flex items-center">
                  <svg
                    className="w-5 h-5 mr-2 text-custom-blue"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                    />
                  </svg>
                  Statistiche Task
                </h3>
              </div>
              <div className="p-4 grid grid-cols-2 gap-3">
                <div className="bg-blue-100 dark:bg-blue-950/50 rounded-lg p-3 border-2 border-blue-300 dark:border-blue-700">
                  <div className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">
                    Totale
                  </div>
                  <div className="text-2xl font-bold text-blue-800 dark:text-blue-200">
                    {s?.total ?? 0}
                  </div>
                </div>
                <div className="bg-yellow-100 dark:bg-yellow-950/50 rounded-lg p-3 border-2 border-yellow-300 dark:border-yellow-700">
                  <div className="text-xs text-yellow-700 dark:text-yellow-300 font-medium mb-1">
                    Premium
                  </div>
                  <div className="text-2xl font-bold text-yellow-800 dark:text-yellow-200">
                    {s?.premium ?? 0}
                  </div>
                </div>
                <div className="bg-green-100 dark:bg-green-950/50 rounded-lg p-3 border-2 border-green-300 dark:border-green-700">
                  <div className="text-xs text-green-700 dark:text-green-300 font-medium mb-1">
                    Standard
                  </div>
                  <div className="text-2xl font-bold text-green-800 dark:text-green-200">
                    {s?.standard ?? 0}
                  </div>
                </div>
                <div className="bg-red-100 dark:bg-red-950/50 rounded-lg p-3 border-2 border-red-300 dark:border-red-700">
                  <div className="text-xs text-red-700 dark:text-red-300 font-medium mb-1">
                    Straordinarie
                  </div>
                  <div className="text-2xl font-bold text-red-800 dark:text-red-200">
                    {s?.straordinarie ?? 0}
                  </div>
                </div>
                <div className="bg-gray-100 dark:bg-gray-950/50 rounded-lg p-3 border-2 border-gray-300 dark:border-gray-700 col-span-2 text-center">
                  <div className="text-xs text-gray-700 dark:text-gray-300 font-medium mb-1">
                    Non Assegnate
                  </div>
                  <div className="text-2xl font-bold text-gray-800 dark:text-gray-200">
                    {s?.total ?? 0}
                  </div>
                </div>
              </div>
            </div>
            </div>
          </div>
        </DragDropContext>
      </div>
    </div>
  );
}
