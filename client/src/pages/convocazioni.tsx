import { Fragment, useState, useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Users, CalendarIcon, ArrowLeft, Save, UserPlus, Search, RefreshCw, AlertTriangle, Truck, Bike, BarChart3 } from "lucide-react";
import TimelineFloatingPanel from "@/components/timeline/timeline-floating-panel";
import AssignmentTaskStatisticsPanel, {
  computeAssignmentTaskStatisticsFromTasks,
  type AssignmentTaskStatistics,
} from "@/components/stats/assignment-task-statistics";
import {
  getDefaultTimelineFloatingPanel,
  useTimelineFloatingPanel,
} from "@/hooks/use-timeline-floating-panel";
import type { TaskType } from "@shared/schema";
import { format, differenceInCalendarDays } from "date-fns";
import { it } from "date-fns/locale";
import { cn, toEntityId, entityIdSet, entityIdSetHas } from "@/lib/utils";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from 'wouter';
import { isTaskLocked } from "@/lib/taskValidation";

const OFFICE_SCOPE_ENABLED = false;

interface LogisticsVehicleOption {
  id: number;
  name: string;
  pms_code: string | null;
}

interface Cleaner {
  id: number;
  name: string;
  lastname: string;
  alias?: string | null;
  role: string;
  active: boolean;
  ranking: number;
  counter_hours: number;
  counter_days: number;
  available: boolean;
  contract_type: string;
  last_worked_date?: string | null;
  preferred_customers: number[];
  telegram_id: number | null;
  start_time: string | null;
  end_time?: string | null;
  show_plus_one?: boolean;
  assigned_vehicle_id?: number | null;
  assigned_vehicle_name?: string | null;
  assigned_vehicle_pms_code?: string | null;
  assigned_vehicle_task_id?: number | null;
}

interface TaskStats {
  total: number;
  premium: number;
  standard: number;
  straordinarie: number;
  officeInternal: number;
  logistics: number;
}

const getDefaultConvocazioniStatsPanel = () =>
  getDefaultTimelineFloatingPanel("right", { width: 320, height: 320 });
const getDefaultConvocazioniDriversPanel = () =>
  getDefaultTimelineFloatingPanel("right", { width: 320, height: 420 });
const getDefaultConvocazioniVehiclesPanel = () =>
  getDefaultTimelineFloatingPanel("right", { width: 300, height: 360 });

function ConvocazioniRosterStatsPanelContent({
  roster,
  title,
  variant,
}: {
  roster: Cleaner[];
  title: string;
  variant: "drivers" | "housekeeping";
}) {
  const total = roster.length;
  const pct = (count: number) => (total > 0 ? Math.round((count / total) * 100) : 0);
  const dash = (count: number) => `${total > 0 ? (count / total) * 251.2 : 0} 251.2`;

  const availableCount = roster.filter((c) => c.available !== false).length;
  const unavailableCount = roster.filter((c) => c.available === false).length;
  const premiumCount = roster.filter((c) => c.role === "Premium").length;
  const standardCount = roster.filter((c) => c.role === "Standard").length;
  const formatoreCount = roster.filter((c) => c.role === "Formatore").length;
  const straordinarioCount = roster.filter((c) => c.role === "Straordinario").length;

  const ring = (
    label: string,
    count: number,
    boxClass: string,
    trackClass: string,
    arcClass: string,
    textClass: string,
    countClass: string
  ) => (
    <div className={`flex h-[112px] flex-col items-center justify-center rounded-lg border-2 p-2.5 ${boxClass}`}>
      <svg className="mb-1 h-14 w-14" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" strokeWidth="8" className={trackClass} />
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="currentColor"
          strokeWidth="8"
          strokeDasharray={dash(count)}
          strokeDashoffset="0"
          transform="rotate(-90 50 50)"
          className={`${arcClass} transition-all duration-500`}
          strokeLinecap="round"
        />
        <text x="50" y="50" textAnchor="middle" dominantBaseline="middle" className={`text-lg font-bold ${textClass}`}>
          {pct(count)}%
        </text>
      </svg>
      <span className={`text-center text-[11px] font-semibold ${countClass}`}>{label}</span>
      <span className={`text-[10px] ${countClass}`}>
        {count}/{total}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col">
      <div className="border-b border-border px-4 py-3">
        <h3 className="flex items-center font-semibold text-foreground">
          <Users className="mr-2 h-5 w-5 text-custom-blue" />
          {title}
        </h3>
      </div>
      <div className="p-4">
        <div className="grid grid-cols-2 gap-3">
          {ring(
            "Disponibili",
            availableCount,
            "border-blue-300 bg-blue-100 dark:border-blue-700 dark:bg-blue-950/50",
            "text-blue-200 dark:text-blue-900",
            "text-blue-500 dark:text-blue-600",
            "fill-blue-600 dark:fill-blue-400",
            "text-blue-800 dark:text-blue-200"
          )}
          {ring(
            "Non Disponibili",
            unavailableCount,
            "border-gray-300 bg-gray-100 dark:border-gray-700 dark:bg-gray-950/50",
            "text-gray-200 dark:text-gray-800",
            "text-gray-500 dark:text-gray-600",
            "fill-gray-600 dark:fill-gray-400",
            "text-gray-800 dark:text-gray-200"
          )}
          {variant === "housekeeping" && (
            <>
              {ring(
                "Premium",
                premiumCount,
                "border-yellow-300 bg-yellow-100 dark:border-yellow-700 dark:bg-yellow-950/50",
                "text-yellow-200 dark:text-yellow-900",
                "text-yellow-500 dark:text-yellow-600",
                "fill-yellow-600 dark:fill-yellow-400",
                "text-yellow-800 dark:text-yellow-200"
              )}
              {ring(
                "Standard",
                standardCount,
                "border-green-300 bg-green-100 dark:border-green-700 dark:bg-green-950/50",
                "text-green-200 dark:text-green-900",
                "text-green-500 dark:text-green-600",
                "fill-green-600 dark:fill-green-400",
                "text-green-800 dark:text-green-200"
              )}
              {ring(
                "Formatori",
                formatoreCount,
                "border-orange-300 bg-orange-100 dark:border-orange-700 dark:bg-orange-950/50",
                "text-orange-200 dark:text-orange-900",
                "text-orange-500 dark:text-orange-600",
                "fill-orange-600 dark:fill-orange-400",
                "text-orange-800 dark:text-orange-200"
              )}
              {ring(
                "Straordinari",
                straordinarioCount,
                "border-red-300 bg-red-100 dark:border-red-700 dark:bg-red-950/50",
                "text-red-200 dark:text-red-900",
                "text-red-500 dark:text-red-600",
                "fill-red-600 dark:fill-red-400",
                "text-red-800 dark:text-red-200"
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function driverVehiclePanelLabel(driver: Cleaner): string {
  const alias = String(driver.alias ?? "").trim();
  if (alias) return alias;
  return `${driver.name} ${driver.lastname}`.trim();
}

function ConvocazioniVehiclesPanelContent({
  selectedDrivers,
  selectedVehicleByDriver,
  setSelectedVehicleByDriver,
  availableVehicles,
  assignedVehicleIds,
}: {
  selectedDrivers: Cleaner[];
  selectedVehicleByDriver: Record<number, string>;
  setSelectedVehicleByDriver: Dispatch<SetStateAction<Record<number, string>>>;
  availableVehicles: LogisticsVehicleOption[];
  assignedVehicleIds: Set<number>;
}) {
  return (
    <div className="flex flex-col">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <h3 className="flex items-center font-semibold text-foreground">
          <Truck className="mr-2 h-5 w-5 text-custom-blue" />
          Veicoli
        </h3>
      </div>
      <div className="p-4">
        {selectedDrivers.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nessun driver selezionato.</p>
        ) : (
          <div className="grid w-fit max-w-full grid-cols-[auto_9.5rem] items-start gap-x-2 gap-y-2.5">
            {selectedDrivers.map((driver) => {
              const currentVehicleId = Number(selectedVehicleByDriver[driver.id] ?? "");
              const selectableVehicles = availableVehicles.filter((vehicle) => {
                if (vehicle.id === currentVehicleId) return true;
                return !assignedVehicleIds.has(vehicle.id);
              });
              const driverLabel = driverVehiclePanelLabel(driver);
              return (
                <Fragment key={driver.id}>
                  <div className="max-w-[9rem] break-words text-xs font-medium leading-snug text-slate-800 dark:text-slate-200">
                    {driverLabel}
                  </div>
                  <select
                    value={selectedVehicleByDriver[driver.id] ?? ""}
                    onChange={(e) =>
                      setSelectedVehicleByDriver((prev) => ({
                        ...prev,
                        [driver.id]: e.target.value,
                      }))
                    }
                    className="h-7 w-full rounded border border-slate-300 bg-background px-2 text-xs dark:border-slate-700"
                  >
                    <option value="">Seleziona veicolo</option>
                    {selectableVehicles.map((vehicle) => (
                      <option key={vehicle.id} value={vehicle.id}>
                        {vehicle.name}
                      </option>
                    ))}
                  </select>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function priorityUiFromLogisticsTask(raw: any): "early-out" | "high" | "low" {
  const p = String(raw?.priority || "").toLowerCase();
  if (["early_out", "early-out", "earlyout", "early_out_assignment", "eo"].includes(p)) {
    return "early-out";
  }
  if (
    ["high_priority", "high-priority", "highpriority", "high", "high_priority_assignment", "hp"].includes(p)
  ) {
    return "high";
  }
  return "low";
}

function convLogisticsRawToStatsTask(
  raw: any,
  priority: "early-out" | "high" | "low"
): TaskType {
  const id = String(raw?.task_id ?? raw?.id ?? "");
  return {
    id,
    name: String(raw?.logistic_code ?? id),
    type: String(raw?.customer_name || ""),
    duration: "0.00",
    priority,
    assignedTo: null,
    status: "pending",
    scheduledTime: null,
    locked: Boolean(raw?.locked),
    locked_reason: raw?.locked_reason != null ? String(raw.locked_reason) : undefined,
    premium: Boolean(raw?.premium),
    pax_in: typeof raw?.pax_in === "number" ? raw.pax_in : undefined,
    ...(raw?.logistics_task_kind != null
      ? { logistics_task_kind: String(raw.logistics_task_kind) }
      : {}),
    ...(raw?.logistics_task_kind_source != null
      ? { logistics_task_kind_source: String(raw.logistics_task_kind_source) }
      : {}),
    ...(raw?.cleaner_id != null && Number.isFinite(Number(raw.cleaner_id))
      ? { cleaner_id: Number(raw.cleaner_id) }
      : {}),
    ...(raw?.cleaner_sequence != null && Number.isFinite(Number(raw.cleaner_sequence))
      ? { cleaner_sequence: Number(raw.cleaner_sequence) }
      : {}),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as TaskType;
}

function convLogisticsTimelineToStatsTask(raw: any, driverId: number): TaskType {
  const task = convLogisticsRawToStatsTask(raw, priorityUiFromLogisticsTask(raw));
  return {
    ...task,
    assignedCleaner: driverId,
    cleaner_id:
      raw?.cleaner_id != null && Number.isFinite(Number(raw.cleaner_id))
        ? Number(raw.cleaner_id)
        : driverId,
    cleaner_sequence:
      raw?.cleaner_sequence != null && Number.isFinite(Number(raw.cleaner_sequence))
        ? Number(raw.cleaner_sequence)
        : raw?.sequence != null && Number.isFinite(Number(raw.sequence))
          ? Number(raw.sequence)
          : undefined,
  } as TaskType;
}

function buildLogisticsStatsTasks(containers: any, timelineRows: any[]): TaskType[] {
  const c = containers || {};
  const containerPriority = (
    raw: any,
    bucket: "early_out" | "high_priority" | "low_priority"
  ): TaskType => {
    const priority: "early-out" | "high" | "low" =
      bucket === "early_out" ? "early-out" : bucket === "high_priority" ? "high" : "low";
    return convLogisticsRawToStatsTask(raw, priority);
  };

  const containerTasks = [
    ...(c.early_out?.tasks || []).map((raw: any) => containerPriority(raw, "early_out")),
    ...(c.high_priority?.tasks || []).map((raw: any) => containerPriority(raw, "high_priority")),
    ...(c.low_priority?.tasks || []).map((raw: any) => containerPriority(raw, "low_priority")),
  ];

  const assigned: TaskType[] = [];
  const assignedTaskIds = new Set<string>();
  for (const row of timelineRows) {
    const driverId = Number(row?.driver?.id);
    if (!Number.isFinite(driverId)) continue;
    for (const task of row?.tasks || []) {
      const mapTask = convLogisticsTimelineToStatsTask(task, driverId);
      assigned.push(mapTask);
      assignedTaskIds.add(String(mapTask.id));
    }
  }

  const unassigned = containerTasks.filter((task) => !assignedTaskIds.has(String(task.id)));
  return [...unassigned, ...assigned];
}

function convHousekeepingRawToStatsTask(
  raw: any,
  priority: "early-out" | "high" | "low"
): TaskType {
  const id = String(raw?.task_id ?? raw?.id ?? "");
  return {
    id,
    name: String(raw?.name ?? raw?.logistic_code ?? id),
    type: String(raw?.customer_name || raw?.type || ""),
    duration: "0.00",
    priority,
    assignedTo: null,
    status: "pending",
    scheduledTime: null,
    locked: Boolean(raw?.locked),
    locked_reason: raw?.locked_reason != null ? String(raw.locked_reason) : undefined,
    premium: raw?.premium === true || raw?.premium === 1 || raw?.premium === "1",
    straordinaria:
      raw?.straordinaria === true ||
      raw?.is_straordinaria === true ||
      Number(raw?.operation_id) === 3 ||
      Number(raw?.operation_id) === 37,
    operation_id: typeof raw?.operation_id === "number" ? raw.operation_id : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as TaskType;
}

function convHousekeepingTimelineToStatsTask(raw: any, cleanerId: number): TaskType {
  const task = convHousekeepingRawToStatsTask(raw, priorityUiFromLogisticsTask(raw));
  return {
    ...task,
    assignedCleaner: cleanerId,
  } as TaskType;
}

function buildHousekeepingStatsTasks(containers: any, timelineRows: any[]): TaskType[] {
  const c = containers || {};
  const containerPriority = (
    raw: any,
    bucket: "early_out" | "high_priority" | "low_priority"
  ): TaskType => {
    const priority: "early-out" | "high" | "low" =
      bucket === "early_out" ? "early-out" : bucket === "high_priority" ? "high" : "low";
    return convHousekeepingRawToStatsTask(raw, priority);
  };

  const containerTasks = [
    ...(c.early_out?.tasks || []).map((raw: any) => containerPriority(raw, "early_out")),
    ...(c.high_priority?.tasks || []).map((raw: any) => containerPriority(raw, "high_priority")),
    ...(c.low_priority?.tasks || []).map((raw: any) => containerPriority(raw, "low_priority")),
  ];

  const assigned: TaskType[] = [];
  const assignedTaskIds = new Set<string>();
  for (const row of timelineRows) {
    const cleanerId = Number(row?.cleaner?.id);
    if (!Number.isFinite(cleanerId)) continue;
    for (const task of row?.tasks || []) {
      const mapTask = convHousekeepingTimelineToStatsTask(task, cleanerId);
      assigned.push(mapTask);
      assignedTaskIds.add(String(mapTask.id));
    }
  }

  const unassigned = containerTasks.filter((task) => !assignedTaskIds.has(String(task.id)));
  return [...unassigned, ...assigned];
}

function convocationKindFromSearch(): "cleaners" | "drivers" | "office" {
  if (typeof window === "undefined") return "cleaners";
  const kind = new URLSearchParams(window.location.search).get("kind");
  if (kind === "drivers") return "drivers";
  if (kind === "office") return OFFICE_SCOPE_ENABLED ? "office" : "cleaners";
  return "cleaners";
}

function useConvocationKind(): "cleaners" | "drivers" | "office" {
  const [kind, setKind] = useState<"cleaners" | "drivers" | "office">(convocationKindFromSearch);
  useEffect(() => {
    const sync = () => setKind(convocationKindFromSearch());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return kind;
}

export default function Convocazioni() {
  const convKind = useConvocationKind();
  const isDrivers = convKind === "drivers";
  const isOffice = convKind === "office";
  const isHousekeeping = !isDrivers && !isOffice;
  const scopeValue: "housekeeping" | "office" = isOffice ? "office" : "housekeeping";
  const withScope = (url: string) =>
    `${url}${url.includes("?") ? "&" : "?"}scope=${scopeValue}`;

  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [taskStats, setTaskStats] = useState<TaskStats>({ total: 0, premium: 0, standard: 0, straordinarie: 0, officeInternal: 0, logistics: 0 });
  const [logisticsAssignmentStats, setLogisticsAssignmentStats] = useState<AssignmentTaskStatistics>({
    total: 0,
    locked: 0,
    unassigned: 0,
    pickUp: 0,
    deliveryPickUp: 0,
    delivery: 0,
    altro: 0,
  });
  const [housekeepingAssignmentStats, setHousekeepingAssignmentStats] = useState<AssignmentTaskStatistics>({
    total: 0,
    locked: 0,
    unassigned: 0,
    standard: 0,
    premium: 0,
    straordinarie: 0,
    altro: 0,
  });
  const convocazioniStatsPanel = useTimelineFloatingPanel("right", getDefaultConvocazioniStatsPanel);
  const convocazioniDriversPanel = useTimelineFloatingPanel("right", getDefaultConvocazioniDriversPanel);
  const convocazioniVehiclesPanel = useTimelineFloatingPanel("right", getDefaultConvocazioniVehiclesPanel);
  const [selectedCleaners, setSelectedCleaners] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Inizializzazione...");
  const [searchCleaner, setSearchCleaner] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    // Leggi la data dal parametro URL se presente
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date');

    if (dateParam) {
      // Converte yyyy-MM-dd in Date senza problemi di timezone
      const [year, month, day] = dateParam.split('-').map(Number);
      return new Date(year, month - 1, day);
    }

    // Altrimenti usa la data salvata in localStorage
    const savedDate = localStorage.getItem('selected_work_date');
    if (savedDate) {
      const [year, month, day] = savedDate.split('-').map(Number);
      return new Date(year, month - 1, day);
    }

    return new Date();
  });
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const { toast } = useToast();
  const [location, setLocation] = useLocation();

  // Aggiunto uno stato per i cleaners filtrati per evitare che vengano sovrascritti quando cambia la data
  const [filteredCleaners, setFilteredCleaners] = useState<Cleaner[]>([]);
  const [showOnlyNotConvocatiDaDueGiorni, setShowOnlyNotConvocatiDaDueGiorni] = useState(false);

  // Blocca lo scroll della pagina mentre Convocazioni e montata
  useEffect(() => {
    if (typeof document === "undefined") return;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  // Canonical URL: rimuovi il parametro date dalla querystring (replace, non push)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has("date")) return;
    const kind = params.get("kind");
    setLocation(kind ? `/convocazioni?kind=${kind}` : "/convocazioni", { replace: true });
  }, [location, setLocation]);

  // Convocazioni logistica: indietro del browser → home logistica (come pulsante Home)
  useEffect(() => {
    if (!isDrivers || typeof window === "undefined") return;

    const handleDriversBack = () => {
      const path = window.location.pathname;
      const kind = new URLSearchParams(window.location.search).get("kind");

      if (path === "/generate-logistics-assignments") return;
      if (path === "/convocazioni" && kind === "drivers") return;

      setLocation("/generate-logistics-assignments", { replace: true });
    };

    window.addEventListener("popstate", handleDriversBack);
    return () => window.removeEventListener("popstate", handleDriversBack);
  }, [isDrivers, setLocation]);
  const handleDateSelect = (date: Date | undefined) => {
    if (!date) return;
    setSelectedDate(date);
  };

  useEffect(() => {
    let cancelled = false;
    const loadCleaners = async () => {
      try {
        setIsLoading(true);
        // Evita di mostrare selezioni stale mentre cambia data/kind
        setSelectedCleaners(new Set());
        setSelectedVehicleByDriver({});
        setLoadingMessage(
          isDrivers
            ? "Estrazione driver dal database..."
            : isOffice
              ? "Estrazione cleaners ufficio dal database..."
              : "Estrazione cleaners dal database..."
        );

        const dateStr = format(selectedDate, "yyyy-MM-dd");
        localStorage.setItem("selected_work_date", dateStr);

        const extractUrl = isDrivers ? "/api/extract-logistics-drivers" : "/api/extract-cleaners-optimized";
        const extractResponse = await fetch(extractUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            isDrivers ? { date: dateStr } : { date: dateStr, scope: scopeValue }
          ),
        });

        if (!extractResponse.ok) {
          throw new Error(isDrivers ? "Errore durante l'estrazione dei driver" : "Errore durante l'estrazione dei cleaners");
        }

        const extractResult = await extractResponse.json();
        console.log("Estrazione completata:", extractResult);

        setLoadingMessage(
          isDrivers
            ? "Caricamento driver..."
            : isOffice
              ? "Caricamento cleaners ufficio..."
              : "Caricamento cleaners..."
        );

        const rosterUrl = isDrivers
          ? `/api/logistics-drivers?date=${dateStr}`
          : withScope(`/api/cleaners?date=${dateStr}`);
        const rosterResponse = await fetch(rosterUrl, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        if (!rosterResponse.ok) {
          throw new Error(isDrivers ? "Impossibile caricare i driver" : "Impossibile caricare i cleaners");
        }

        const rosterData = await rosterResponse.json();
        let dateCleaners = (isDrivers ? rosterData.drivers : rosterData.cleaners) || [];

        // Convocazioni: cleaners standard esclude Ufficio; ufficio include solo Ufficio.
        if (!isDrivers) {
          dateCleaners = isOffice
            ? dateCleaners.filter((c: any) => c?.role === "Ufficio")
            : dateCleaners.filter((c: any) => c?.role !== "Ufficio");
        }

        if (isDrivers) {
          const vRes = await fetch(`/api/logistics-vehicles?date=${dateStr}`, {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
          });
          if (vRes.ok) {
            const vj = await vRes.json();
            setLogisticsVehicles(Array.isArray(vj.vehicles) ? vj.vehicles : []);
          } else {
            setLogisticsVehicles([]);
          }
        } else {
          setLogisticsVehicles([]);
        }

        const selectedUrl = isDrivers
          ? `/api/selected-logistics-drivers?date=${dateStr}`
          : withScope(`/api/selected-cleaners?date=${dateStr}`);
        const selectedResponse = await fetch(selectedUrl, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        let alreadySelectedIds = new Set<number>();
        let preselectedIds = new Set<number>();
        const preselectedVehicleByDriver: Record<number, string> = {};

        if (selectedResponse.ok) {
          const selectedData = await selectedResponse.json();
          const selectedDateFromFile = selectedData.metadata?.date;
          if (selectedDateFromFile === dateStr) {
            const selectedIds = (isDrivers
              ? selectedData.drivers?.map((c: any) => toEntityId(c.id)) || []
              : selectedData.cleaners?.map((c: any) => toEntityId(c.id)) || []
            ).filter((id: number | null): id is number => id !== null);
            alreadySelectedIds = new Set(selectedIds);
            preselectedIds = new Set(selectedIds);
            if (isDrivers) {
              for (const d of selectedData.drivers || []) {
                if (d?.id != null && d?.assigned_vehicle_id != null) {
                  const sid = Number(d.assigned_vehicle_id);
                  if (Number.isFinite(sid)) {
                    preselectedVehicleByDriver[Number(d.id)] = String(sid);
                  }
                }
              }
            }
          }
        }

        const timelineUrl = isDrivers
          ? `/api/logistics-timeline?date=${dateStr}`
          : withScope(`/api/timeline?date=${dateStr}`);
        const timelineResponse = await fetch(timelineUrl);
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            const timelineDateFromFile = timelineData.metadata?.date;
            if (timelineDateFromFile === dateStr) {
              if (isDrivers && timelineData.drivers_assignments) {
                for (const row of timelineData.drivers_assignments) {
                  const id = toEntityId(row.driver?.id);
                  if (id !== null) preselectedIds.add(id);
                }
              }
              if (!isDrivers && timelineData.cleaners_assignments) {
                for (const row of timelineData.cleaners_assignments) {
                  const id = toEntityId(row.cleaner?.id);
                  if (id !== null) preselectedIds.add(id);
                }
              }
            }
          } catch (e) {
            console.warn("⚠️ Errore parsing timeline:", e);
          }
        }

        const availableCleaners = dateCleaners
          .filter((c: any) => c.active === true)
          .map((c: any) => {
            const id = toEntityId(c?.id);
            return id === null ? null : { ...c, id };
          })
          .filter((c): c is Cleaner => c !== null);
        availableCleaners.sort((a: any, b: any) => {
          // Mantieni lo stesso ordinamento del dialog "Aggiungi cleaner":
          // Formatore -> Straordinario -> Premium -> Standard/altro
          const getPriority = (cleaner: any) => {
            if (cleaner.role === "Formatore") return 1;
            if (cleaner.role === "Straordinario") return 2;
            if (cleaner.role === "Premium") return 3;
            return 4;
          };

          const priorityA = getPriority(a);
          const priorityB = getPriority(b);
          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }

          const hoursA = Number(
            a.weekly_hours !== undefined && a.weekly_hours !== null
              ? a.weekly_hours
              : a.counter_hours ?? 0
          );
          const hoursB = Number(
            b.weekly_hours !== undefined && b.weekly_hours !== null
              ? b.weekly_hours
              : b.counter_hours ?? 0
          );
          return hoursB - hoursA;
        });

        if (cancelled) return;
        setCleaners(availableCleaners);
        setFilteredCleaners(availableCleaners);

        const visibleIds = entityIdSet(availableCleaners.map((c: any) => c.id));
        const allPreselectedIds = new Set(
          [...alreadySelectedIds, ...preselectedIds].filter((id) => visibleIds.has(id))
        );
        if (cancelled) return;
        setSelectedCleaners(allPreselectedIds);
        setSelectedVehicleByDriver(preselectedVehicleByDriver);

        setLoadingMessage("Caricamento statistiche task...");
        await loadTaskStats(dateStr, isDrivers, isOffice);

        if (cancelled) return;
        setIsLoading(false);
        setLoadingMessage("Caricamento completato!");
      } catch (error) {
        console.error("Errore nel caricamento convocazioni:", error);
        if (cancelled) return;
        setLoadingMessage(
          isDrivers
            ? "Errore nel caricamento dei driver"
            : isOffice
              ? "Errore nel caricamento dei cleaners ufficio"
              : "Errore nel caricamento dei cleaners"
        );
        setIsLoading(false);
        setSelectedCleaners(new Set());
        setSelectedVehicleByDriver({});
      }
    };

    void loadCleaners();
    return () => {
      cancelled = true;
    };
  }, [selectedDate, convKind]);

  const loadTaskStats = async (dateStr: string, driversMode: boolean, officeMode: boolean) => {
    try {
      const containersUrl = driversMode
        ? `/api/logistics-containers?date=${encodeURIComponent(dateStr)}`
        : withScope(`/api/containers?date=${encodeURIComponent(dateStr)}`);
      const timelineUrl = driversMode
        ? `/api/logistics-timeline?date=${encodeURIComponent(dateStr)}`
        : withScope(`/api/timeline?date=${encodeURIComponent(dateStr)}`);

      const [containersRes, timelineRes] = await Promise.all([
        fetch(containersUrl),
        fetch(timelineUrl),
      ]);

      if (!containersRes.ok) throw new Error('Errore durante il caricamento dei containers');
      const data = await containersRes.json();
      const c = data.containers || {};

      const timelinePayload = timelineRes.ok ? await timelineRes.json() : {};
      const timelineRows = driversMode
        ? (Array.isArray((timelinePayload as any)?.drivers_assignments) ? (timelinePayload as any).drivers_assignments : [])
        : (Array.isArray((timelinePayload as any)?.cleaners_assignments) ? (timelinePayload as any).cleaners_assignments : []);

      if (driversMode) {
        const mapTasks = buildLogisticsStatsTasks(c, timelineRows);
        setLogisticsAssignmentStats(computeAssignmentTaskStatisticsFromTasks(mapTasks, "logistics"));
        return;
      }

      if (!officeMode) {
        const mapTasks = buildHousekeepingStatsTasks(c, timelineRows);
        setHousekeepingAssignmentStats(
          computeAssignmentTaskStatisticsFromTasks(mapTasks, "housekeeping")
        );
        return;
      }

      const containerTasks = [
        ...(c.early_out?.tasks || []),
        ...(c.high_priority?.tasks || []),
        ...(c.low_priority?.tasks || []),
      ];
      const timelineTasks = timelineRows.flatMap((row: any) => (Array.isArray(row?.tasks) ? row.tasks : []));

      const assignedTaskIds = new Set<string>(
        timelineTasks
          .map((task: any) => String(task?.task_id ?? task?.id ?? "").trim())
          .filter(Boolean)
      );

      const unassignedContainerTasks = containerTasks.filter((task: any) => {
        const taskId = String(task?.task_id ?? task?.id ?? "").trim();
        return !taskId || !assignedTaskIds.has(taskId);
      });

      const allTasks = [...unassignedContainerTasks, ...timelineTasks];
      let total = 0, premium = 0, standard = 0, straordinarie = 0, officeInternal = 0;
      for (const t of allTasks) {
        const opId = Number((t as any).operation_id);
        const isLocked = isTaskLocked(t);
        const isStraordinaria =
          t.straordinaria === true ||
          (t as any).is_straordinaria === true ||
          opId === 3 ||
          opId === 37;
        const isPremium = t.premium === true || t.premium === 1 || t.premium === "1";
        const isOfficeInternal = Number((t as any).operation_id) === 15;
        if (!isLocked) {
          total += 1;
          if (isStraordinaria) straordinarie += 1;
          else if (isPremium) premium += 1;
          else standard += 1;
          if (isOfficeInternal) officeInternal += 1;
        }
      }
      setTaskStats({ total, premium, standard, straordinarie, officeInternal, logistics: 0 });
    } catch (error) {
      console.error('Errore nel caricamento delle statistiche task:', error);
    }
  };

    const notConvocatiDaDueGiorniCount = useMemo(() => {
    const today = new Date();
    return filteredCleaners.filter((c) => {
      if (!c.last_worked_date) return false;
      const s = String(c.last_worked_date).trim();
      const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const d = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
      if (!d || isNaN(d.getTime())) return false;
      const days = differenceInCalendarDays(today, d);
      return days > 2;
    }).length;
  }, [filteredCleaners]);

  const cleanersToShow = useMemo(() => {
    if (!showOnlyNotConvocatiDaDueGiorni) return filteredCleaners;
    const today = new Date();
    return filteredCleaners.filter((c) => {
      if (!c.last_worked_date) return false;
      const s = String(c.last_worked_date).trim();
      const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const d = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
      if (!d || isNaN(d.getTime())) return false;
      return differenceInCalendarDays(today, d) > 2;
    });
  }, [filteredCleaners, showOnlyNotConvocatiDaDueGiorni]);

  const [selectedVehicleByDriver, setSelectedVehicleByDriver] = useState<Record<number, string>>({});
  const [logisticsVehicles, setLogisticsVehicles] = useState<LogisticsVehicleOption[]>([]);

  const availableVehicles = logisticsVehicles;
  const availableVehicleById = useMemo(() => {
    const map = new Map<number, LogisticsVehicleOption>();
    for (const v of availableVehicles) map.set(v.id, v);
    return map;
  }, [availableVehicles]);
  const vehiclePmsCodeById = useMemo(() => {
    const map: Record<number, string | null> = {};
    for (const v of availableVehicles) {
      map[v.id] = v.pms_code && String(v.pms_code).trim() ? String(v.pms_code).trim() : null;
    }
    return map;
  }, [availableVehicles]);

  const driversRoster = useMemo(() => filteredCleaners, [filteredCleaners]);

  const visibleRoster = useMemo(() => cleanersToShow, [cleanersToShow]);

  const selectedDrivers = useMemo(
    () => (isDrivers ? driversRoster.filter((c) => entityIdSetHas(selectedCleaners,c.id)) : []),
    [driversRoster, selectedCleaners, isDrivers]
  );
  const assignedVehicleIds = useMemo(() => {
    const used = new Set<number>();
    for (const rawId of Object.values(selectedVehicleByDriver)) {
      const id = Number(rawId);
      if (Number.isFinite(id)) used.add(id);
    }
    return used;
  }, [selectedVehicleByDriver]);

  const allSelectedDriversHaveVehicles = useMemo(() => {
    if (!isDrivers || selectedDrivers.length === 0) return true;
    return selectedDrivers.every((driver) => {
      const raw = selectedVehicleByDriver[driver.id];
      if (raw == null || raw === "") return false;
      const id = Number(raw);
      return Number.isFinite(id) && id > 0;
    });
  }, [isDrivers, selectedDrivers, selectedVehicleByDriver]);

  const toggleCleanerSelection = (cleanerId: number, isAvailable: boolean) => {
    // Se il cleaner è già selezionato, lo deseleziona
    if (entityIdSetHas(selectedCleaners,cleanerId)) {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        newSet.delete(cleanerId);
        return newSet;
      });
      setSelectedVehicleByDriver((prev) => {
        const next = { ...prev };
        delete next[cleanerId];
        return next;
      });
      // (+1) istantaneo: nascondi quando deselezioni
      setCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: false } : c));
      setFilteredCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: false } : c));
      return;
    }

    // Se non è disponibile, mostra il dialog di conferma
    if (!isAvailable) {
      setConfirmDialog({ open: true, cleanerId });
      return;
    }

    // Altrimenti seleziona direttamente il cleaner
    setSelectedCleaners(prev => {
      const newSet = new Set(prev);
      newSet.add(cleanerId);
      return newSet;
    });
    // (+1) istantaneo: mostra quando convochi
    setCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: true } : c));
    setFilteredCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: true } : c));
  };

  const handleConfirmUnavailable = () => {
    if (confirmDialog.cleanerId === null) {
      setConfirmDialog({ open: false, cleanerId: null });
      return;
    }
    const id = confirmDialog.cleanerId;
    const isCurrentlySelected = entityIdSetHas(selectedCleaners,id);
    if (isCurrentlySelected) {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
      setSelectedVehicleByDriver((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: false } : c));
      setFilteredCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: false } : c));
    } else {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        newSet.add(id);
        return newSet;
      });
      setCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: true } : c));
      setFilteredCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: true } : c));
    }
    setConfirmDialog({ open: false, cleanerId: null });
  };

  const handleSaveSelection = async (): Promise<boolean> => {
    const label = isDrivers ? "driver" : "cleaner";
    if (selectedCleaners.size === 0) {
      toast({
        variant: "destructive",
        title: `⚠️ Nessun ${label} selezionato`,
        description: `Seleziona almeno un ${label} prima di salvare`,
      });
      return false;
    }

    if (isDrivers && !allSelectedDriversHaveVehicles) {
      toast({
        variant: "destructive",
        title: "Veicoli mancanti",
        description: "Associa un veicolo a ogni driver selezionato prima di salvare",
      });
      return false;
    }

    try {
      setIsSaving(true);
      const dateStr = format(selectedDate, "yyyy-MM-dd");
      const user = JSON.parse(localStorage.getItem("user") || "{}");

      if (isDrivers) {
        const timelineResponse = await fetch(`/api/logistics-timeline?date=${dateStr}`);
        let timelineDrivers: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.drivers_assignments) {
              timelineDrivers = timelineData.drivers_assignments
                .map((ca: any) => ca.driver)
                .filter((c: any) => c && entityIdSetHas(selectedCleaners,c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline logistics:", e);
          }
        }
        const fromUI = filteredCleaners.filter((c) => entityIdSetHas(selectedCleaners,c.id));
        const tlIds = entityIdSet(timelineDrivers.map((c) => c.id));
        const uniqueFromUI = fromUI.filter((c) => !entityIdSetHas(tlIds, c.id));
        const selectedData = [...timelineDrivers, ...uniqueFromUI].map((d: any) => {
          const assignedVehicleIdRaw = selectedVehicleByDriver[d.id];
          const assignedVehicleId = assignedVehicleIdRaw ? Number(assignedVehicleIdRaw) : null;
          const assignedVehicle = assignedVehicleId ? availableVehicleById.get(assignedVehicleId) : undefined;
          return {
            ...d,
            assigned_vehicle_id: assignedVehicleId,
            assigned_vehicle_name: assignedVehicle?.name ?? null,
            assigned_vehicle_pms_code: assignedVehicle?.pms_code ?? null,
          };
        });
        const response = await fetch("/api/save-selected-logistics-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            drivers: selectedData,
            total_selected: selectedData.length,
            date: dateStr,
            action_type: "replace",
            modified_by: user.username || "unknown",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio dei driver");
        const transferResponse = await fetch("/api/sync-logistics-driver-vehicles-to-adam", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: dateStr,
            username: user.username || "unknown",
          }),
        });
        if (!transferResponse.ok) {
          throw new Error("Errore nella sincronizzazione driver-veicolo su ADAM");
        }
        const transferResult = await transferResponse.json();
        if (!transferResult?.success) {
          throw new Error(
            transferResult?.message || "Sincronizzazione driver-veicolo su ADAM non riuscita"
          );
        }
        toast({
          variant: "success",
          title: `${selectedData.length} driver salvati con successo`,
          description: `Salvati su PG e sincronizzati su ADAM per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
        });
      } else {
        const timelineResponse = await fetch(withScope(`/api/timeline?date=${dateStr}`));
        let timelineCleaners: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.cleaners_assignments) {
              timelineCleaners = timelineData.cleaners_assignments
                .map((ca: any) => ca.cleaner)
                .filter((c: any) => c && entityIdSetHas(selectedCleaners,c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline cleaners:", e);
          }
        }
        const cleanersFromUI = filteredCleaners.filter((c) => entityIdSetHas(selectedCleaners,c.id));
        const timelineCleanerIds = entityIdSet(timelineCleaners.map((c) => c.id));
        const uniqueCleanersFromUI = cleanersFromUI.filter((c) => !entityIdSetHas(timelineCleanerIds, c.id));
        const selectedCleanersData = [...timelineCleaners, ...uniqueCleanersFromUI];
        const response = await fetch("/api/save-selected-cleaners", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cleaners: selectedCleanersData,
            total_selected: selectedCleanersData.length,
            date: dateStr,
            scope: scopeValue,
            action_type: "replace",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio dei cleaners");
        sessionStorage.setItem(
          "refreshAssignmentsAfterConvocations",
          JSON.stringify({ date: dateStr, scope: scopeValue, savedAt: Date.now() })
        );
        toast({
          variant: "success",
          title: `${selectedCleanersData.length} cleaner salvati con successo!`,
          description: `I cleaners sono stati salvati per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
        });
      }
      return true;
    } catch (error) {
      console.error("Errore nel salvataggio:", error);
      toast({
        variant: "destructive",
        title: "❌ Errore nel salvataggio",
        description: isDrivers
          ? "Si è verificato un errore nel salvataggio/sincronizzazione driver"
          : "Si è verificato un errore nel salvataggio dei cleaners selezionati",
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddCleaners = async () => {
    const label = isDrivers ? "driver" : "cleaner";
    if (selectedCleaners.size === 0) {
      toast({
        variant: "destructive",
        title: `⚠️ Nessun ${label} selezionato`,
        description: `Seleziona almeno un ${label} prima di aggiungere`,
      });
      return;
    }

    try {
      setIsSaving(true);
      const dateStr = format(selectedDate, "yyyy-MM-dd");
      const user = JSON.parse(localStorage.getItem("user") || "{}");

      if (isDrivers) {
        const timelineResponse = await fetch(`/api/logistics-timeline?date=${dateStr}`);
        let timelineDrivers: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.drivers_assignments) {
              timelineDrivers = timelineData.drivers_assignments
                .map((ca: any) => ca.driver)
                .filter((c: any) => c && entityIdSetHas(selectedCleaners,c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline logistics:", e);
          }
        }
        const currentResponse = await fetch(`/api/selected-logistics-drivers?date=${dateStr}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        const currentData = await currentResponse.json();
        const currentDrivers = currentData.drivers || [];
        const fromUI = filteredCleaners.filter((c) => entityIdSetHas(selectedCleaners,c.id));
        const tlIds = entityIdSet(timelineDrivers.map((c) => c.id));
        const uniqueFromUI = fromUI.filter((c) => !entityIdSetHas(tlIds, c.id));
        const allSelected = [...timelineDrivers, ...uniqueFromUI].map((d: any) => {
          const assignedVehicleIdRaw = selectedVehicleByDriver[d.id];
          const assignedVehicleId = assignedVehicleIdRaw ? Number(assignedVehicleIdRaw) : null;
          const assignedVehicle = assignedVehicleId ? availableVehicleById.get(assignedVehicleId) : undefined;
          return {
            ...d,
            assigned_vehicle_id: assignedVehicleId,
            assigned_vehicle_name: assignedVehicle?.name ?? null,
            assigned_vehicle_pms_code: assignedVehicle?.pms_code ?? null,
          };
        });
        const existingIds = entityIdSet(currentDrivers.map((c: any) => c.id));
        const newOnes = allSelected.filter((c) => !entityIdSetHas(existingIds, c.id));
        const merged = [...currentDrivers, ...newOnes];
        const response = await fetch("/api/save-selected-logistics-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            drivers: merged,
            total_selected: merged.length,
            date: dateStr,
            action_type: "add",
            modified_by: user.username || "unknown",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio");
        if (newOnes.length === 0) {
          toast({
            variant: "success",
            title: "Nessun nuovo driver aggiunto",
            description: `Tutti i driver selezionati sono già presenti per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 4000,
          });
        } else {
          toast({
            variant: "success",
            title: `${newOnes.length} driver aggiunti correttamente!`,
            description: `Totale driver: ${merged.length} per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 3000,
          });
        }
        sessionStorage.setItem("preserveAssignments", "true");
        setLocation("/generate-logistics-assignments");
      } else {
        const timelineResponse = await fetch(withScope(`/api/timeline?date=${dateStr}`));
        let timelineCleaners: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.cleaners_assignments) {
              timelineCleaners = timelineData.cleaners_assignments
                .map((ca: any) => ca.cleaner)
                .filter((c: any) => c && entityIdSetHas(selectedCleaners,c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline cleaners:", e);
          }
        }
        const currentResponse = await fetch(withScope(`/api/selected-cleaners?date=${dateStr}`), {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        const currentData = await currentResponse.json();
        const currentCleaners = currentData.cleaners || [];
        const cleanersFromUI = filteredCleaners.filter((c) => entityIdSetHas(selectedCleaners,c.id));
        const timelineCleanerIds = entityIdSet(timelineCleaners.map((c) => c.id));
        const uniqueCleanersFromUI = cleanersFromUI.filter((c) => !entityIdSetHas(timelineCleanerIds, c.id));
        const allSelectedCleaners = [...timelineCleaners, ...uniqueCleanersFromUI];
        const existingIds = entityIdSet(currentCleaners.map((c: any) => c.id));
        const newCleaners = allSelectedCleaners.filter((c) => !entityIdSetHas(existingIds, c.id));
        const mergedCleaners = [...currentCleaners, ...newCleaners];
        const response = await fetch("/api/save-selected-cleaners", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cleaners: mergedCleaners,
            total_selected: mergedCleaners.length,
            date: dateStr,
            scope: scopeValue,
            action_type: "add",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio");
        sessionStorage.setItem(
          "refreshAssignmentsAfterConvocations",
          JSON.stringify({ date: dateStr, scope: scopeValue, savedAt: Date.now() })
        );
        if (newCleaners.length === 0) {
          toast({
            variant: "success",
            title: "Nessun nuovo cleaner aggiunto",
            description: `Tutti i cleaners selezionati sono già presenti per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 4000,
          });
        } else {
          toast({
            variant: "success",
            title: `${newCleaners.length} cleaner aggiunti correttamente!`,
            description: `Totale cleaners: ${mergedCleaners.length} per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 3000,
          });
        }
        sessionStorage.setItem("preserveAssignments", "true");
        setLocation(isOffice ? "/generate-assignments?scope=office" : "/generate-assignments");
      }
    } catch (error) {
      console.error("Errore nell'aggiunta:", error);
      toast({
        variant: "destructive",
        title: "❌ Errore nell'aggiunta",
        description: isDrivers
          ? "Si è verificato un errore durante l'aggiunta dei driver"
          : "Si è verificato un errore durante l'aggiunta dei cleaners",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="convocazioni-page h-[calc(100dvh-3.5rem-1px)] overflow-hidden bg-background text-foreground md:h-[calc(100dvh-3.75rem-1px)]">
      <div className="flex h-full w-full min-w-0 flex-col overflow-x-hidden px-4 pb-6 pt-3">
        {isLoading ? (
          <PageViewportCentered layout="fill" className="py-4">
            <div className="max-w-lg space-y-4 text-center">
              <div className="flex justify-center">
                <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
              </div>
              <h2 className="text-xl font-bold text-foreground">Caricamento Convocazioni</h2>
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                <span>{loadingMessage}</span>
              </div>
            </div>
          </PageViewportCentered>
        ) : (
          <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="mb-3 shrink-0 space-y-3">
          {/* Header con titolo e selettore data */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="flex flex-wrap items-center gap-2 text-3xl font-bold text-foreground">
                <Users className="h-8 w-8 shrink-0 text-custom-blue" />
                {isDrivers ? "CONVOCAZIONI DRIVER del" : isOffice ? "CONVOCAZIONI UFFICIO del" : "CONVOCAZIONI HOUSEKEEPING del" }
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
          </div>

            {/* Barra Contatore */}
            <div className="rounded-xl border-2 border-custom-blue bg-custom-blue-light p-4 shadow-lg">
              <div className="flex w-full items-center gap-4">
                <div className="flex shrink-0 items-center gap-4">
                  <div className="text-lg font-semibold text-foreground">
                    {isDrivers ? "DRIVERS SELEZIONATI" : isOffice ? "CLEANERS UFFICIO SELEZIONATI" : "CLEANERS SELEZIONATI"}
                  </div>
                  <div className="text-lg font-bold">
                    <span className="text-primary">{isDrivers ? selectedDrivers.length : selectedCleaners.size}</span>
                    <span className="mx-1 text-muted-foreground">/</span>
                    <span className="text-foreground">{driversRoster.length}</span>
                  </div>
                </div>
                <div className="min-w-0 flex-1" aria-hidden />
                <button
                  type="button"
                  onClick={() => setShowOnlyNotConvocatiDaDueGiorni((prev) => !prev)}
                  className={cn(
                    "-mx-2 -my-1 shrink-0 rounded px-2 py-1 text-right text-sm transition-colors",
                    showOnlyNotConvocatiDaDueGiorni
                      ? "bg-amber-500/20 text-yellow-600 underline dark:text-yellow-400"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  )}
                >
                  {isDrivers ? "Driver" : isOffice ? "Cleaners ufficio" : "Cleaners"} non convocati da due giorni o più:{" "}
                  <span className="font-bold text-yellow-500 dark:text-yellow-400">{notConvocatiDaDueGiorniCount}</span>
                  {showOnlyNotConvocatiDaDueGiorni && " (clicca per mostrare tutti)"}
                </button>
              </div>
            </div>
        </div>

        {/* Grid con lista cleaners e statistiche affiancate */}
        <div className={cn("grid grid-cols-1 gap-4 flex-1 min-h-0", isOffice && "lg:grid-cols-3")}>
          {/* Lista Cleaners - full width per logistica e housekeeping */}
          <Card className={cn("p-4 flex flex-col h-full min-h-0 overflow-hidden border-2 border-custom-blue bg-custom-blue-light dark:bg-custom-blue", isOffice && "lg:col-span-2")}>
            <div className="mb-3 relative shrink-0">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-custom-blue" />
              <Input
                placeholder={isDrivers ? "Cerca driver per nome..." : isOffice ? "Cerca cleaner ufficio per nome..." : "Cerca cleaner per nome..."}
                value={searchCleaner}
                onChange={(e) => setSearchCleaner(e.target.value)}
                className="pl-10 border-2 border-custom-blue"
                data-testid="input-search-cleaner"
              />
            </div>

            <div className="space-y-2.5 flex-1 min-h-0 overflow-y-auto">
              {visibleRoster
                .filter((cleaner) =>
                  `${cleaner.name} ${cleaner.lastname}`
                    .toUpperCase()
                    .includes(searchCleaner.toUpperCase())
                )
                .map((cleaner) => {
                  const isAvailable = cleaner.available !== false;
                  const isPremium = cleaner.role === "Premium";
                  const isFormatore = cleaner.role === "Formatore";
                  const canDoStraordinaria = cleaner.role === "Straordinario";
                  const selectedVehicleIdRaw = selectedVehicleByDriver[cleaner.id];
                  const selectedVehicleId = selectedVehicleIdRaw ? Number(selectedVehicleIdRaw) : null;
                  const selectedVehicleName = selectedVehicleId
                    ? (availableVehicleById.get(selectedVehicleId)?.name ?? "").toString().trim()
                    : "";
                  const isScooterVehicle = /^piaggio\b/i.test(selectedVehicleName);
                  const selectedVehiclePlate = selectedVehicleId
                    ? vehiclePmsCodeById[selectedVehicleId] ?? null
                    : null;
                  const lastWorked = cleaner.last_worked_date
                    ? (() => {
                        const s = String(cleaner.last_worked_date).trim();
                        const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
                        return match
                          ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
                          : null;
                      })()
                    : null;
                  const daysSinceLastWorked =
                    lastWorked != null ? differenceInCalendarDays(new Date(), lastWorked) : null;
                  const showNotConvocatoWarning =
                    daysSinceLastWorked != null && daysSinceLastWorked > 2;

                  const borderColor = "border-2 border-custom-blue";
                  const bgColor = "bg-white dark:bg-background";

                  return (
                    <div
                      key={cleaner.id}
                      onClick={() => toggleCleanerSelection(cleaner.id, isAvailable)}
                      className={`flex items-center justify-between p-3 rounded-lg transition-all ${borderColor} ${bgColor} ${
                        !isAvailable
                          ? "opacity-60 cursor-pointer hover:opacity-70"
                          : "hover:opacity-80 cursor-pointer"
                      }`}
                    >
                  <div className="flex items-start gap-4 flex-1">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground text-base">
                          {cleaner.name.toUpperCase()} {cleaner.lastname.toUpperCase()}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {!isAvailable && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                              Non disponibile
                            </span>
                          )}
                          {isDrivers ? (
                            <>
                              {cleaner.role === "Formatore" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                                  Formatore
                                </span>
                              )}
                              {cleaner.role === "Straordinario" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700">
                                  Straordinario
                                </span>
                              )}
                              {cleaner.role === "Premium" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700">
                                  Premium
                                </span>
                              )}
                              {cleaner.role === "Standard" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                                  Standard
                                </span>
                              )}
                              {!["Formatore", "Straordinario", "Premium", "Standard"].includes(
                                String(cleaner.role || "")
                              ) && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-500/30 text-sky-900 dark:bg-sky-500/40 dark:text-sky-100 border-sky-600 dark:border-sky-400">
                                  Driver
                                </span>
                              )}
                              {selectedVehiclePlate && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200 border-sky-300 dark:border-sky-700">
                                  {isScooterVehicle ? (
                                    <Bike className="h-3.5 w-3.5" />
                                  ) : (
                                    <Truck className="h-3.5 w-3.5" />
                                  )}
                                  <span>{selectedVehiclePlate}</span>
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              {isFormatore && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-500/30 text-orange-800 dark:bg-orange-500/40 dark:text-orange-200 border-orange-600 dark:border-orange-400">
                                  Formatore
                                </span>
                              )}
                              {canDoStraordinaria && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-500/30 text-red-800 dark:bg-red-500/40 dark:text-red-200 border-red-600 dark:border-red-400">
                                  Straordinario
                                </span>
                              )}
                              {cleaner.role === "Ufficio" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-500/30 text-sky-800 dark:bg-sky-500/40 dark:text-sky-200 border-sky-600 dark:border-sky-400">
                                  Ufficio
                                </span>
                              )}
                              {isPremium && !canDoStraordinaria && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400">
                                  Premium
                                </span>
                              )}
                              {!isPremium && !isFormatore && !canDoStraordinaria && cleaner.role !== "Ufficio" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400">
                                  Standard
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-foreground/80">
                        <span className="font-semibold">Ore questa settimana:</span> {(() => {
                          const hours = cleaner.counter_hours;
                          // Handle if counter_hours is accidentally a time string like "10:00"
                          if (typeof hours === 'string' && (hours as string).includes(':')) {
                            return '0.00';
                          }
                          return Number(hours || 0).toFixed(2);
                        })()}h
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Giorni consecutivi:</span>{' '}
                        <span className="inline-flex items-center gap-1">
                          {cleaner.counter_days}
                          {cleaner.show_plus_one && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="font-semibold text-yellow-600 dark:text-yellow-500">(+1)</span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>In programma per questa data ma report non ancora compilato</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Ultimo giorno lavorato:</span> {cleaner.last_worked_date ? (() => {
                          const s = String(cleaner.last_worked_date).trim();
                          const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
                          const d = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(s);
                          return isNaN(d.getTime()) ? "—" : format(d, "dd/MM/yyyy", { locale: it });
                        })() : "—"}
                        {showNotConvocatoWarning && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center align-middle ml-1">
                                <AlertTriangle className="h-4 w-4 text-amber-500 -translate-y-px animate-pulse shrink-0" aria-hidden />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Non convocato da {daysSinceLastWorked} giorni</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Contratto:</span> {cleaner.contract_type}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className={`flex items-center gap-1 bg-background border-2 rounded-lg px-3 py-1 ${borderColor}`}>
                      <span className="text-xs font-semibold text-foreground mr-2">Start Time:</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.start_time || "10:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes - 30;
                          if (totalMinutes < 0) totalMinutes += 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          // Aggiorna ENTRAMBI gli stati (cleaners E filteredCleaners)
                          setCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">−</span>
                      </Button>
                      <span className="text-sm font-mono font-bold min-w-[45px] text-center">
                        {cleaner.start_time || "10:00"}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.start_time || "10:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes + 30;
                          if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          // Aggiorna ENTRAMBI gli stati (cleaners E filteredCleaners)
                          setCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">+</span>
                      </Button>
                    </div>
                    <div className={`flex items-center gap-1 bg-background border-2 rounded-lg px-3 py-1 ${borderColor}`}>
                      <span className="text-xs font-semibold text-foreground mr-2">End Time:</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.end_time || "20:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes - 30;
                          if (totalMinutes < 0) totalMinutes += 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          setCleaners(prev => prev.map(c =>
                            c.id === cleaner.id ? { ...c, end_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c =>
                            c.id === cleaner.id ? { ...c, end_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">−</span>
                      </Button>
                      <span className="text-sm font-mono font-bold min-w-[45px] text-center">
                        {cleaner.end_time || "20:00"}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.end_time || "20:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes + 30;
                          if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          setCleaners(prev => prev.map(c =>
                            c.id === cleaner.id ? { ...c, end_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c =>
                            c.id === cleaner.id ? { ...c, end_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">+</span>
                      </Button>
                    </div>
                    <Switch
                      checked={entityIdSetHas(selectedCleaners,cleaner.id)}
                      onCheckedChange={() => toggleCleanerSelection(cleaner.id, isAvailable)}
                      className="scale-150 pointer-events-none"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <Dialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog({ open, cleanerId: null })}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{isDrivers ? "Driver non disponibile" : "Cleaner Non Disponibile"}</DialogTitle>
                <DialogDescription>
                  {isDrivers
                    ? "Questo driver risulta non disponibile. Sei sicuro di volerlo selezionare?"
                    : "Questo cleaner risulta non disponibile. Sei sicuro di volerlo selezionare?"}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button 
                  variant="outline" 
                  onClick={() => setConfirmDialog({ open: false, cleanerId: null })}
                  className="border-2 border-custom-blue"
                >
                  Annulla
                </Button>
                <Button 
                  onClick={handleConfirmUnavailable}
                  className="bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
                >
                  Conferma
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <div className="flex justify-center mt-3 pt-3 border-t shrink-0">
            <Button
              onClick={async () => {
                const ok = await handleSaveSelection();
                if (ok) {
                  setLocation(isDrivers ? "/generate-logistics-assignments" : isOffice ? "/generate-assignments?scope=office" : "/generate-assignments");
                }
              }}
              size="lg"
              disabled={
                selectedCleaners.size === 0 ||
                isSaving ||
                (isDrivers && !allSelectedDriversHaveVehicles)
              }
              className="flex items-center gap-2 bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
              data-testid="button-save-and-home"
            >
              {isSaving ? (
                <RefreshCw className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1" />
              )}
              {isSaving ? "Salvataggio..." : "Salva e Torna alla Home"}
              {!isSaving && <ArrowLeft className="w-4 h-4 ml-1" />}
            </Button>
          </div>
        </Card>

        {isOffice && (
        <Card className="p-4 border-2 bg-background flex flex-col h-full min-h-0 overflow-hidden">
          <h3 className="text-lg font-semibold text-foreground mb-3 flex shrink-0 items-center">
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
            Statistiche
          </h3>

          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
          <div className="mb-3 pb-2 border-b border-border shrink-0">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">Task Ufficio</h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 bg-blue-100 dark:bg-blue-950/50 rounded-lg p-2 border-2 border-blue-300 dark:border-blue-700">
                <div className="text-lg font-bold text-blue-800 dark:text-blue-200">{taskStats.total}</div>
                <div className="text-[10px] text-blue-800 dark:text-blue-200">Totale</div>
              </div>
              <div className="bg-sky-100 dark:bg-sky-950/50 rounded-lg p-2 border-2 border-sky-300 dark:border-sky-700">
                <div className="text-lg font-bold text-sky-800 dark:text-sky-200">
                  {Math.max(0, taskStats.total - taskStats.straordinarie)}
                </div>
                <div className="text-[10px] text-sky-800 dark:text-sky-200">Pulizia Ufficio</div>
              </div>
              <div className="bg-red-100 dark:bg-red-950/50 rounded-lg p-2 border-2 border-red-300 dark:border-red-700">
                <div className="text-lg font-bold text-red-800 dark:text-red-200">{taskStats.straordinarie}</div>
                <div className="text-[10px] text-red-800 dark:text-red-200">Pulizia Ufficio Straordinaria</div>
              </div>
            </div>
          </div>

          {/* Statistiche roster ufficio */}
          <h4 className="text-xs font-semibold text-muted-foreground mb-2 shrink-0">Cleaners Ufficio</h4>
          <div className="grid grid-cols-2 gap-2 auto-rows-[112px] shrink-0">
            {/* Disponibili */}
            <div className="bg-blue-100 dark:bg-blue-950/50 rounded-lg p-2.5 h-[112px] flex flex-col items-center justify-center border-2 border-blue-300 dark:border-blue-700">
              <svg className="w-14 h-14 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-blue-200 dark:text-blue-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.available !== false).length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-blue-500 dark:text-blue-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-blue-600 dark:fill-blue-400"
                >
                {driversRoster.length > 0 ? Math.round((driversRoster.filter(c => c.available !== false).length / driversRoster.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[11px] font-semibold text-blue-800 dark:text-blue-200 text-center">Disponibili</span>
              <span className="text-[10px] text-blue-800 dark:text-blue-200">
                {driversRoster.filter(c => c.available !== false).length}/{driversRoster.length}
              </span>
            </div>

            {/* Non Disponibili */}
            <div className="bg-gray-100 dark:bg-gray-950/50 rounded-lg p-2.5 h-[112px] flex flex-col items-center justify-center border-2 border-gray-300 dark:border-gray-700">
              <svg className="w-14 h-14 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-gray-200 dark:text-gray-800"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${driversRoster.length > 0 ? (driversRoster.filter(c => c.available === false).length / driversRoster.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-gray-500 dark:text-gray-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-gray-600 dark:fill-gray-400"
                >
                  {driversRoster.length > 0 ? Math.round((driversRoster.filter(c => c.available === false).length / driversRoster.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[11px] font-semibold text-gray-800 dark:text-gray-200 text-center">Non Disponibili</span>
              <span className="text-[10px] text-gray-800 dark:text-gray-200">
                {driversRoster.filter(c => c.available === false).length}/{driversRoster.length}
              </span>
            </div>

          </div>
          </div>

          <div className="mt-3 pt-3 border-t border-border flex flex-col flex-1 min-h-0">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">Legenda Ufficio</h4>
          </div>
        </Card>
        )}
      </div>

            {isHousekeeping && (
              <>
              <TimelineFloatingPanel
                side="right"
                fitContent
                toggleVerticalOffset={-26}
                isOpen={convocazioniStatsPanel.isOpen}
                onOpenChange={convocazioniStatsPanel.setIsOpen}
                panel={convocazioniStatsPanel.panel}
                onResetPanel={convocazioniStatsPanel.resetPanel}
                toggleAriaLabel="Mostra statistiche task"
                toggleTitle="Mostra statistiche task"
                toggleIcon={<BarChart3 className="h-4 w-4" />}
                dragTitle="Trascina statistiche"
                closeAriaLabel="Nascondi statistiche"
                closeTitle="Nascondi statistiche"
                onPointerDown={convocazioniStatsPanel.handlePointerDown}
                onPointerMove={convocazioniStatsPanel.handlePointerMove}
                onPointerEnd={convocazioniStatsPanel.handlePointerEnd}
              >
                <AssignmentTaskStatisticsPanel
                  variant="housekeeping"
                  stats={housekeepingAssignmentStats}
                />
              </TimelineFloatingPanel>
              <TimelineFloatingPanel
                side="right"
                fitContent
                toggleVerticalOffset={26}
                isOpen={convocazioniDriversPanel.isOpen}
                onOpenChange={convocazioniDriversPanel.setIsOpen}
                panel={convocazioniDriversPanel.panel}
                onResetPanel={convocazioniDriversPanel.resetPanel}
                toggleAriaLabel="Mostra statistiche cleaners"
                toggleTitle="Mostra statistiche cleaners"
                toggleIcon={<Users className="h-4 w-4" />}
                dragTitle="Trascina statistiche cleaners"
                closeAriaLabel="Nascondi statistiche cleaners"
                closeTitle="Nascondi statistiche cleaners"
                onPointerDown={convocazioniDriversPanel.handlePointerDown}
                onPointerMove={convocazioniDriversPanel.handlePointerMove}
                onPointerEnd={convocazioniDriversPanel.handlePointerEnd}
              >
                <ConvocazioniRosterStatsPanelContent
                  roster={driversRoster}
                  title="Cleaners"
                  variant="housekeeping"
                />
              </TimelineFloatingPanel>
              </>
            )}

            {isDrivers && (
              <>
              <TimelineFloatingPanel
                side="right"
                fitContent
                toggleVerticalOffset={-52}
                isOpen={convocazioniStatsPanel.isOpen}
                onOpenChange={convocazioniStatsPanel.setIsOpen}
                panel={convocazioniStatsPanel.panel}
                onResetPanel={convocazioniStatsPanel.resetPanel}
                toggleAriaLabel="Mostra statistiche task"
                toggleTitle="Mostra statistiche task"
                toggleIcon={<BarChart3 className="h-4 w-4" />}
                dragTitle="Trascina statistiche"
                closeAriaLabel="Nascondi statistiche"
                closeTitle="Nascondi statistiche"
                onPointerDown={convocazioniStatsPanel.handlePointerDown}
                onPointerMove={convocazioniStatsPanel.handlePointerMove}
                onPointerEnd={convocazioniStatsPanel.handlePointerEnd}
              >
                <AssignmentTaskStatisticsPanel
                  variant="logistics"
                  stats={logisticsAssignmentStats}
                />
              </TimelineFloatingPanel>
              <TimelineFloatingPanel
                side="right"
                fitContent
                isOpen={convocazioniDriversPanel.isOpen}
                onOpenChange={convocazioniDriversPanel.setIsOpen}
                panel={convocazioniDriversPanel.panel}
                onResetPanel={convocazioniDriversPanel.resetPanel}
                toggleAriaLabel="Mostra statistiche driver"
                toggleTitle="Mostra statistiche driver"
                toggleIcon={<Users className="h-4 w-4" />}
                dragTitle="Trascina statistiche driver"
                closeAriaLabel="Nascondi statistiche driver"
                closeTitle="Nascondi statistiche driver"
                onPointerDown={convocazioniDriversPanel.handlePointerDown}
                onPointerMove={convocazioniDriversPanel.handlePointerMove}
                onPointerEnd={convocazioniDriversPanel.handlePointerEnd}
              >
                <ConvocazioniRosterStatsPanelContent
                  roster={driversRoster}
                  title="Driver"
                  variant="drivers"
                />
              </TimelineFloatingPanel>
              <TimelineFloatingPanel
                side="right"
                fitContent
                fitContentWidth
                isOpen={convocazioniVehiclesPanel.isOpen}
                onOpenChange={convocazioniVehiclesPanel.setIsOpen}
                panel={convocazioniVehiclesPanel.panel}
                onResetPanel={convocazioniVehiclesPanel.resetPanel}
                toggleVerticalOffset={52}
                toggleAriaLabel="Mostra veicoli"
                toggleTitle="Mostra veicoli"
                toggleIcon={<Truck className="h-4 w-4" />}
                dragTitle="Trascina veicoli"
                closeAriaLabel="Nascondi veicoli"
                closeTitle="Nascondi veicoli"
                onPointerDown={convocazioniVehiclesPanel.handlePointerDown}
                onPointerMove={convocazioniVehiclesPanel.handlePointerMove}
                onPointerEnd={convocazioniVehiclesPanel.handlePointerEnd}
              >
                <ConvocazioniVehiclesPanelContent
                  selectedDrivers={selectedDrivers}
                  selectedVehicleByDriver={selectedVehicleByDriver}
                  setSelectedVehicleByDriver={setSelectedVehicleByDriver}
                  availableVehicles={availableVehicles}
                  assignedVehicleIds={assignedVehicleIds}
                />
              </TimelineFloatingPanel>
              </>
            )}

          </div>
        )}
      </div>
    </div>
  );
}