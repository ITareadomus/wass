import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { DragDropContext } from "react-beautiful-dnd";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import PriorityColumn from "@/components/drag-drop/priority-column";
import type { TaskType } from "@shared/schema";
import {
  CalendarIcon,
  RefreshCw,
  HelpCircle,
  Search,
  Users,
  RotateCcw,
  UserMinus,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Link } from "wouter";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Allineato a timeline-view: colonna cleaner senza convocati + slot 10:00–19:00 */
const TIMELINE_SKELETON_CLEANER_COL = 96;
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

const TIMELINE_SKELETON_SLOTS = [
  "10:00",
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
  "18:00",
  "19:00",
];

function TimelineSkeleton() {
  return (
    <div
      data-print-timeline
      className="bg-custom-blue-light rounded-lg border-2 border-custom-blue shadow-sm relative"
    >
      <div className="px-4 py-4 border-b border-border">
        <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
          <div>
            <h2 className="text-xl font-bold text-foreground flex items-center">
              <CalendarIcon className="w-5 h-5 mr-2 text-custom-blue" />
              Timeline Assegnazioni - 0 Cleaners
            </h2>
          </div>
          <div className="flex gap-3 print:hidden">
            <Button
              variant="outline"
              size="sm"
              disabled
              title="In arrivo"
              className="flex items-center gap-2 border-2 border-custom-blue"
            >
              <Users className="w-4 h-4" />
              Convocazioni
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled
              title="In arrivo"
              className="flex items-center gap-2 border-2 border-custom-blue"
            >
              <RotateCcw className="w-4 h-4" />
              Reset Assegnazioni
            </Button>
          </div>
        </div>
      </div>

      <div className="px-4 pt-4 pb-4 overflow-x-auto">
        {/* Fascie indicative EO / HP / LP (solo grafica) */}
        <div className="flex items-stretch mb-1 px-4 h-[26px]">
          <div
            className="flex-shrink-0 h-full print:hidden"
            style={{ width: TIMELINE_SKELETON_CLEANER_COL }}
          />
          <div className="flex-1 h-full relative">
            <div className="absolute inset-0 flex justify-between items-end px-1">
              {(
                [
                  { key: "EO", left: "2%", width: "22%" },
                  { key: "HP", left: "28%", width: "32%" },
                  { key: "LP", left: "64%", width: "34%" },
                ] as const
              ).map((w) => (
                <div
                  key={w.key}
                  className="absolute bottom-0 h-[20px]"
                  style={{ left: w.left, width: w.width }}
                >
                  <div className="relative h-full">
                    <div className="absolute left-0 right-0 top-[10px] border-t border-slate-500/60 dark:border-white/60" />
                    <div className="absolute left-0 top-[6px] h-[8px] border-l border-slate-500/60 dark:border-white/60" />
                    <div className="absolute right-0 top-[6px] h-[8px] border-r border-slate-500/60 dark:border-white/60" />
                    <Badge
                      variant="outline"
                      className={cn(
                        "absolute left-1/2 -translate-x-1/2 top-[-1px] text-xs shrink-0",
                        w.key === "EO"
                          ? "bg-blue-500 text-white border-blue-700 dark:bg-blue-600 dark:border-blue-300"
                          : w.key === "HP"
                            ? "bg-orange-500 text-white border-orange-700 dark:bg-orange-600 dark:border-orange-300"
                            : "bg-gray-500 text-white border-gray-700 dark:bg-gray-600 dark:border-gray-300"
                      )}
                    >
                      {w.key}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="flex-shrink-0 w-20 h-full" />
        </div>

        {/* Header orari */}
        <div className="flex items-stretch mb-2 px-4 h-[44px]">
          <div
            className="flex-shrink-0 p-1 flex items-center justify-center h-full print:hidden"
            style={{ width: TIMELINE_SKELETON_CLEANER_COL }}
          >
            <Button
              variant="ghost"
              size="sm"
              disabled
              title="In arrivo"
              className={cn(
                "w-full h-full border-2",
                "border-red-600 dark:border-red-500",
                "text-red-700 dark:text-red-200"
              )}
            >
              <UserMinus className="w-5 h-5" />
            </Button>
          </div>
          <div
            className="flex-1 h-full grid"
            style={{
              gridTemplateColumns: `repeat(${TIMELINE_SKELETON_SLOTS.length}, 1fr)`,
            }}
          >
            {TIMELINE_SKELETON_SLOTS.map((slot, idx) => (
              <div
                key={slot}
                className="h-full flex items-center justify-center text-center text-xs font-semibold text-foreground border-r border-border px-1"
              >
                {slot}
              </div>
            ))}
          </div>
          <div className="flex-shrink-0 w-20 h-full text-center text-xs font-semibold text-foreground border-l border-border px-1 flex items-center justify-center">
            Ore lavorate
          </div>
        </div>

        {/* Righe placeholder (nessun cleaner reale) */}
        <div className="flex-1 overflow-auto px-4 pb-4 pt-1">
          {[1, 2, 3].map((row) => (
            <div key={row} className="flex mb-0.5">
              <div
                className="flex-shrink-0 p-1 flex items-center border-2 border-custom-blue bg-custom-blue/10"
                style={{ width: TIMELINE_SKELETON_CLEANER_COL }}
              >
                <div className="w-full flex items-center gap-2 min-w-0 px-0.5">
                  <div className="flex-shrink-0 w-3 h-3 rounded-full bg-muted animate-pulse" />
                  <div className="h-3.5 flex-1 rounded bg-muted/70 animate-pulse min-w-0" />
                </div>
              </div>
              <div className="relative min-h-[45px] flex-1 border-l border-border bg-background">
                <div
                  className="absolute inset-0 pointer-events-none grid"
                  style={{
                    gridTemplateColumns: `repeat(${TIMELINE_SKELETON_SLOTS.length}, 1fr)`,
                  }}
                >
                  {TIMELINE_SKELETON_SLOTS.map((slot, idx) => (
                    <div
                      key={`${row}-${slot}`}
                      title={slot}
                      className={cn(
                        "border-r border-border",
                        idx % 2 === 0
                          ? "bg-blue-50/30 dark:bg-blue-950/10"
                          : "bg-sky-100/30 dark:bg-sky-900/10"
                      )}
                    />
                  ))}
                </div>
              </div>
              <div className="flex-shrink-0 w-20 min-h-[45px] border-l border-border flex items-center justify-center text-xs text-muted-foreground">
                —
              </div>
            </div>
          ))}
          <p className="text-center text-xs text-muted-foreground pt-3 pb-1">
            Contenuto timeline in arrivo
          </p>
        </div>
      </div>
    </div>
  );
}

type AdamFingerprint = {
  count: number;
  max_updated_at_unix: number | null;
  signature_xor: number | null;
  signature_sum: string | number | null;
};

export default function GenerateLogisticsAssignments() {
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());
  const [searchTask, setSearchTask] = useState("");
  /** Solo sul pulsante refresh (come generate-assignments), nessun overlay pagina */
  const [isRefreshingContainers, setIsRefreshingContainers] = useState(false);
  const [logisticsSummary, setLogisticsSummary] = useState<LogisticsSummaryState | null>(null);
  const [logisticsTaskLists, setLogisticsTaskLists] = useState<LogisticsTaskLists>(EMPTY_LOGISTICS_TASK_LISTS);

  const adamBaselineRef = useRef<AdamFingerprint | null>(null);
  const [hasAdamUpdates, setHasAdamUpdates] = useState(false);

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
      if (!getRes.ok) {
        throw new Error("Impossibile caricare i containers logistics");
      }
      const data = await getRes.json();
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

  useEffect(() => {
    void loadLogisticsContainers(selectedDate);
  }, [selectedDate, loadLogisticsContainers]);

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
      await loadLogisticsContainers(selectedDate);
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
  }, [selectedDate, toast, fetchAdamLogisticsFingerprint, loadLogisticsContainers]);

  const handleDateSelect = (date: Date | undefined) => {
    if (date) setSelectedDate(date);
  };

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

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="w-full px-4 py-6">
        <div className="mb-6 flex justify-between items-center flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl flex items-center gap-2 font-bold text-foreground">
              WASS LOGISTICS del
            </h1>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "justify-start text-left font-normal",
                    !selectedDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {selectedDate ? (
                    format(selectedDate, "dd/MM/yyyy", { locale: it })
                  ) : (
                    <span>Seleziona data</span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="w-auto p-0"
                align="start"
                onOpenAutoFocus={(e) => e.preventDefault()}
              >
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={handleDateSelect}
                  defaultMonth={selectedDate}
                  initialFocus
                  locale={it}
                />
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex items-center gap-3">
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
          </div>
        </div>

        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-custom-blue" />
            <Input
              placeholder="Cerca task..."
              value={searchTask}
              onChange={(e) => setSearchTask(e.target.value)}
              className="border-2 border-custom-blue pl-10"
              data-testid="input-search-task-logistics"
            />
          </div>
          <div className="flex items-center flex-shrink-0 bg-custom-blue rounded-md overflow-hidden border-2 border-custom-blue">
            <Button
              variant="ghost"
              size="sm"
              disabled={isRefreshingContainers}
              title="Aggiorna containers da ADAM"
              onClick={() => void refreshLogisticsContainersFromAdam()}
              className="flex items-center rounded-none text-black dark:text-white hover:bg-custom-blue/80 px-3"
              data-testid="button-logistics-refresh-adam"
            >
              {isRefreshingContainers ? (
                <span className="relative inline-flex">
                  <RefreshCw className="w-4 h-4 animate-spin" />
                </span>
              ) : (
                <span className="relative inline-flex">
                  <RefreshCw className="w-4 h-4" />
                  {hasAdamUpdates && (
                    <span
                      className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-red-500"
                      title="Aggiornamenti disponibili da ADAM"
                    />
                  )}
                </span>
              )}
            </Button>
            <div className="w-px h-6 bg-black/20 dark:bg-white/20" />
            <Button
              variant="ghost"
              size="sm"
              disabled
              title="In arrivo"
              className="flex items-center gap-2 rounded-none text-black dark:text-white hover:bg-custom-blue/80 px-3"
            >
              <CalendarIcon className="w-4 h-4" />
              Assegna
            </Button>
          </div>
        </div>

        <DragDropContext onDragEnd={() => {}} onDragUpdate={() => {}}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6 w-full">
            <PriorityColumn
              title="EARLY OUT"
              priority="early-out"
              tasks={earlyOutTasks}
              droppableId="early-out"
              icon="clock"
              isDragDisabled
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
              isDragDisabled
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
              isDragDisabled
              disableToolbar
              flushDropZone
              operationsScope="logistics"
              highlightedTaskIds={highlightedLowPriority}
            />
          </div>
        </DragDropContext>

        <div className="mt-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2">
            <TimelineSkeleton />
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
      </div>
    </div>
  );
}
