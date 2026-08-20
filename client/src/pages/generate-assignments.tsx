import { DndContext, MeasuringStrategy } from "@dnd-kit/core";
import { TaskType as Task } from "@shared/schema";
import {
  isWorkDateHistoricallyLocked,
  isWorkDateInPast,
} from "@shared/work-date-access";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import MapSection from "@/components/map/map-section";
import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";

const DEBUG = false;
const dlog = (...args: any[]) => DEBUG && console.log(...args);
import { HousekeepingLogisticsSwitch } from "@/components/housekeeping-logistics-switch";
import { CalendarIcon, Users, RefreshCw, Settings, Search, Map as MapIcon, BarChart3 } from "lucide-react";
import TaskCardDragOverlay from "@/components/drag-drop/task-card-drag-overlay";
import TimelineFloatingPanel from "@/components/timeline/timeline-floating-panel";
import {
  registerTimelineMapPanelOpener,
  unregisterTimelineMapPanelOpener,
} from "@/lib/timeline-map-panel";
import AssignmentTaskStatisticsPanel, {
  computeAssignmentTaskStatisticsFromTasks,
} from "@/components/stats/assignment-task-statistics";
import {
  getDefaultTimelineFloatingPanel,
  useTimelineFloatingPanel,
} from "@/hooks/use-timeline-floating-panel";
import { Input } from "@/components/ui/input";
import { useLocation } from 'wouter';
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { useToast } from "@/hooks/use-toast";
import { isContinuazioneStraordinariaTask } from "@/lib/taskValidation";
import {
  DndRemoveZone,
  useAssignmentDnd,
  type DndDropOperation,
  type DndInsertTarget,
} from "@/lib/dnd";

type AdamRefreshMode = "apt" | "assignments";
type LockedConflictTask = {
  task_id: number;
  logistic_code: number | null;
  locked_reason: string | null;
  currentCleanerId: number | null;
  adamCleanerId: number | null;
};
const OFFICE_SCOPE_ENABLED = false;
const getDefaultTimelineMapPanel = () => getDefaultTimelineFloatingPanel("right");
const getDefaultTimelineStatsPanel = () =>
  getDefaultTimelineFloatingPanel("right", { width: 320, height: 320 });
type PreAssignedMode = "normal" | "readonly";
const PREASSIGNED_REASON_NORMAL = "preassigned_enable_wass";
const PREASSIGNED_REASON_READONLY = "preassigned_enable_wass_readonly";

interface RawTask {
  task_id: number;
  structure_id: number;
  logistic_code: number;
  client_id: number;
  premium: boolean;
  straordinaria?: boolean;
  address: string;
  lat: string;
  lng: string;
  cleaning_time: number;
  checkin: string;
  checkout: string;
  checkin_time: string | null;
  checkout_time: string | null;
  pax_in: number;
  pax_out: number;
  small_equipment: boolean;
  operation_id: number;
  zone: number;
  reasons?: string[];
  alias?: string;
  confirmed_operation?: boolean;
  customer_reference?: string | number;
  locked?: boolean;
  locked_reason?: string;
  duplicate_group_id?: string;
  duplicate_group_size_active?: number;
  is_duplicate_active?: boolean;
  preAssignedMode?: PreAssignedMode;
}

const normalizeTaskReasons = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const reason of value) {
    const normalized = String(reason ?? "").trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return Array.from(unique);
};

const resolvePreAssignedModeFromTask = (task: any): PreAssignedMode | null => {
  const explicit = String(task?.preAssignedMode ?? "").trim().toLowerCase();
  if (explicit === "readonly") return "readonly";
  if (explicit === "normal") return "normal";
  const reasons = normalizeTaskReasons(task?.reasons);
  if (reasons.includes(PREASSIGNED_REASON_READONLY)) return "readonly";
  if (reasons.includes(PREASSIGNED_REASON_NORMAL)) return "normal";
  return null;
};

const isEquivalentStraordinariaTask = (task: any): boolean =>
  Boolean(task?.straordinaria) || isContinuazioneStraordinariaTask(task);

// === HELPERS per gestire id univoco e logisticCode non univoco ===
function getLogisticCode(t: RawTask | Task | null | undefined): string | null {
  if (!t) return null;
  return String(
    (t as any).logisticCode ??
    (t as any).logisticsCode ??
    (t as any).logistic_code ??
    (t as any).name ?? // name è usato come logistic_code in questo progetto
    null
  );
}

function getTaskId(t: RawTask | Task | null | undefined): string {
  if (!t) return "";
  return String(
    (t as any).id ??
    (t as any).taskId ??
    (t as any).task_id ??
    ""
  );
}

// DEDUPE per id (non per logisticCode!)
function dedupeById(list: Task[]): Task[] {
  const seen = new Set<string>();
  const out: Task[] = [];
  for (const t of list) {
    const tid = getTaskId(t);
    if (tid && !seen.has(tid)) {
      seen.add(tid);
      out.push(t);
    }
  }
  return out;
}

type WavePriorityState = 'early_out' | 'high_priority' | 'low_priority' | null;

function normalizeWavePriority(value: unknown): WavePriorityState {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'early_out' || normalized === 'early-out') return 'early_out';
  if (normalized === 'high_priority' || normalized === 'high') return 'high_priority';
  if (normalized === 'low_priority' || normalized === 'low') return 'low_priority';
  return null;
}

// Indice per id (1:1)
function indexById(list: Task[]): Map<string, Task> {
  const m = new Map<string, Task>();
  for (const t of list) {
    const tid = getTaskId(t);
    if (tid) m.set(tid, t);
  }
  return m;
}

// Tipo per risposta API timeline (evita inferenza never[] su assignments/cleaners_assignments)
interface TimelineCleanerEntry {
  cleaner: { id: number; name?: string };
  tasks?: Array<{
    task_id: number;
    id?: number;
    logistic_code?: number;
    sequence?: number;
    priority?: string;
    preAssignedMode?: PreAssignedMode;
    reasons?: string[];
  }>;
}
interface TimelineAssignmentEntry {
  task_id: number;
  cleanerId?: number;
  cleaner_id?: number;
  id?: number;
  logistic_code?: number;
  priority?: string;
  preAssignedMode?: PreAssignedMode;
  reasons?: string[];
}
interface TimelineAssignmentsData {
  assignments: TimelineAssignmentEntry[];
  metadata: { date?: string };
  cleaners_assignments: TimelineCleanerEntry[];
}



// MultiSelect Context per gestire selezione multipla task
interface MultiSelectContextType {
  isMultiSelectMode: boolean;
  selectedTasks: Array<{taskId: string; order: number; container?: string}>;
  toggleMode: () => void;
  toggleTask: (taskId: string, container?: string) => void;
  clearSelection: () => void;
  isTaskSelected: (taskId: string) => boolean;
  getTaskOrder: (taskId: string) => number | undefined;
}

const MultiSelectContext = createContext<MultiSelectContextType | null>(null);

export const useMultiSelect = () => {
  const context = useContext(MultiSelectContext);
  if (!context) {
    throw new Error('useMultiSelect must be used within MultiSelectProvider');
  }
  return context;
};

// Helper per ottenere lo username corrente dal localStorage
const getCurrentUsername = (): string => {
  const user = localStorage.getItem("user");
  if (user) {
    try {
      const userData = JSON.parse(user);
      return userData.username || "unknown";
    } catch (e) {
      console.error("Failed to parse user data from localStorage", e);
      return "unknown";
    }
  }
  return "unknown";
};

export default function GenerateAssignments() {
  // Ripristina l'ultima data selezionata da localStorage, altrimenti usa oggi
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const savedDate = localStorage.getItem('selected_work_date');
    if (savedDate) {
      try {
        // Parse formato YYYY-MM-DD
        const [year, month, day] = savedDate.split('-').map(Number);
        const parsedDate = new Date(year, month - 1, day); // month è 0-indexed in JS
        return parsedDate;
      } catch (e) {
        console.error('Errore parsing data salvata:', e);
        return new Date();
      }
    }
    return new Date();
  });

  // Traccia il primo caricamento per evitare reload automatici
  const [isInitialMount, setIsInitialMount] = useState(true);

  // Stato per tracciare se la timeline è in modalità di sola visualizzazione
  const [isTimelineReadOnly, setIsTimelineReadOnly] = useState<boolean>(false);

  // Ref per tracciare se è in corso un'operazione di drag-and-drop (useRef per sincronizzazione immediata)
  const isDraggingRef = useRef<boolean>(false);
  const dragTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // PATCH B: Debounce per refreshAssignments (evita reload multipli)
  const refreshDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const scheduleManualRefresh = useCallback((delayMs: number = 600) => {
    if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
    refreshDebounceRef.current = setTimeout(() => {
      refreshAssignments("manual").catch(console.error);
    }, delayMs);
  }, []);

  // Preview della posizione di sequenza mentre trascini
  const [dragSequencePreview, setDragSequencePreview] = useState<{ sequenceIndex: number } | null>(null);
  
  // Traccia l'indice valido durante il drag per evitare bug con destination.index
  const [lastValidDragIndex, setLastValidDragIndex] = useState<number | null>(null);
  const lastValidDragIndexRef = useRef<number | null>(null);
  
  // Traccia il cleaner su cui si sta trascinando per posizionare il placeholder
  const [draggingOverCleanerId, setDraggingOverCleanerId] = useState<number | null>(null);
  const [activeDragCleanerId, setActiveDragCleanerId] = useState<number | null>(null);

  // Stati per selezione multipla INDIPENDENTE per container (ma selezione CROSS-CONTAINER)
  const [multiSelectModes, setMultiSelectModes] = useState<{
    early_out: boolean;
    high_priority: boolean;
    low_priority: boolean;
  }>({
    early_out: false,
    high_priority: false,
    low_priority: false
  });
  const [selectedTasks, setSelectedTasks] = useState<Array<{taskId: string; order: number; container: string}>>([]);

  // Determina se ALMENO un container ha multi-select attivo
  const isAnyMultiSelectActive = multiSelectModes.early_out || multiSelectModes.high_priority || multiSelectModes.low_priority;

  // Helper functions per multi-select context cross-container
  const toggleMode = useCallback(() => {
    // Toggle globale (attiva/disattiva tutti i container)
    const newState = !isAnyMultiSelectActive;
    setMultiSelectModes({
      early_out: newState,
      high_priority: newState,
      low_priority: newState
    });
    if (!newState) {
      setSelectedTasks([]);
    }
  }, [isAnyMultiSelectActive]);

  const toggleTask = useCallback((taskId: string, container?: string) => {
    setSelectedTasks(prev => {
      const existing = prev.find(t => t.taskId === taskId);
      if (existing) {
        return prev.filter(t => t.taskId !== taskId);
      } else {
        const maxOrder = prev.length > 0 ? Math.max(...prev.map(t => t.order)) : 0;
        return [...prev, { taskId, order: maxOrder + 1, container: container ?? 'high_priority' }];
      }
    });
  }, []);

  const clearSelection = useCallback(() => {
    console.log('[DEBUG] Clearing all selections');
    setSelectedTasks([]);
  }, []);

  const isTaskSelected = useCallback((taskId: string) => {
    return selectedTasks.some(t => t.taskId === taskId);
  }, [selectedTasks]);

  const getTaskOrder = useCallback((taskId: string) => {
    const task = selectedTasks.find(t => t.taskId === taskId);
    return task?.order;
  }, [selectedTasks]);

  // Helper per ottenere lo stato multi-select di un container specifico
  const getContainerMultiSelectState = useCallback((container: 'early_out' | 'high_priority' | 'low_priority') => {
    return {
      isActive: multiSelectModes[container],
      toggleMode: () => {
        // Use functional updates to avoid stale closures
        setMultiSelectModes(prev => {
          const wasActive = prev[container];
          // If deactivating, clear selections from this container
          if (wasActive) {
            setSelectedTasks(prevTasks => prevTasks.filter(t => t.container !== container));
          }
          return {
            ...prev,
            [container]: !wasActive
          };
        });
      },
      selectedTasks,
      toggleTask: (taskId: string) => toggleTask(taskId, container),
      clearSelection,
      isTaskSelected,
      getTaskOrder,
    };
  }, [multiSelectModes, selectedTasks, toggleTask, clearSelection, isTaskSelected, getTaskOrder]);

  // Memoizza il context value cross-container
  const multiSelectContextValue: MultiSelectContextType = useMemo(() => ({
    isMultiSelectMode: isAnyMultiSelectActive,
    selectedTasks,
    toggleMode,
    toggleTask,
    clearSelection,
    isTaskSelected,
    getTaskOrder,
  }), [isAnyMultiSelectActive, selectedTasks, toggleMode, toggleTask, clearSelection, isTaskSelected, getTaskOrder]);

  // Salva la data in localStorage ogni volta che cambia (formato locale senza timezone)
  useEffect(() => {
    const year = selectedDate.getFullYear();
    const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
    const day = String(selectedDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;
    localStorage.setItem('selected_work_date', dateStr);
  }, [selectedDate]);
  const [earlyOutTasks, setEarlyOutTasks] = useState<Task[]>([]);
  const [highPriorityTasks, setHighPriorityTasks] = useState<Task[]>([]);
  const [lowPriorityTasks, setLowPriorityTasks] = useState<Task[]>([]);

  // Task assegnati per ogni cleaner (non più usati, le task restano nelle liste originali)
  const [lopezTasks, setLopezTasks] = useState<Task[]>([]);
  const [garciaTasks, setGarciaTasks] = useState<Task[]>([]);
  const [rossiTasks, setRossiTasks] = useState<Task[]>([]);

  // Stato per tracciare tutte le task con le loro assegnazioni
  const [allTasksWithAssignments, setAllTasksWithAssignments] = useState<Task[]>([]);

  // Stato per la ricerca di task
  const [searchTask, setSearchTask] = useState("");
  const timelineMapPanel = useTimelineFloatingPanel("right", getDefaultTimelineMapPanel);
  const timelineStatsPanel = useTimelineFloatingPanel("right", getDefaultTimelineStatsPanel);

  useEffect(() => {
    registerTimelineMapPanelOpener(() => timelineMapPanel.setIsOpen(true));
    return unregisterTimelineMapPanelOpener;
  }, [timelineMapPanel.setIsOpen]);

  // Stato per highlight task da mappa (doppio click su pallino grigio)
  const [containerHighlightTaskId, setContainerHighlightTaskId] = useState<string | null>(null);
  const containerHighlightRef = useRef<string | null>(null);

  // Polling per containerHighlightTaskId dalla mappa
  useEffect(() => {
    const checkContainerHighlight = setInterval(() => {
      const newHighlight = (window as any).containerHighlightTaskId ?? null;
      if (newHighlight !== containerHighlightRef.current) {
        containerHighlightRef.current = newHighlight;
        setContainerHighlightTaskId(newHighlight);
      }
    }, 200);

    return () => clearInterval(checkContainerHighlight);
  }, []);

  // Stato per tracciare modifiche non salvate
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Stato per tracciare se un drag&drop è in corso
  const [isLoadingDragDrop, setIsLoadingDragDrop] = useState(false);
  const [isDraggingTimelineTask, setIsDraggingTimelineTask] = useState(false);

  // Stati di caricamento
  const [isExtracting, setIsExtracting] = useState(true);
  const [extractionStep, setExtractionStep] = useState<string>("Inizializzazione...");
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransferringToAdam, setIsTransferringToAdam] = useState(false);
  const [lastSavedTimestamp, setLastSavedTimestamp] = useState<string | null>(null); // Renamed from lastSavedAssignment
  const { toast } = useToast();
  const [location, setLocation] = useLocation();
  const isOfficeScope = useMemo(() => {
    if (!OFFICE_SCOPE_ENABLED) return false;
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const scopeParam = params.get("scope");
      const kindParam = params.get("kind");
      const storedScope = localStorage.getItem("assignments_scope");
      return scopeParam === "office" || kindParam === "office" || storedScope === "office";
    }
    return location.includes("scope=office") || location.includes("kind=office");
  }, [location]);
  const scopeValue = isOfficeScope ? "office" : "housekeeping";
  const withScope = useCallback((url: string) => {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}scope=${scopeValue}`;
  }, [scopeValue]);
  const [preassignedAnimatedTaskIds, setPreassignedAnimatedTaskIds] = useState<Set<string>>(new Set());
  const preassignedReplayByDateRef = useRef<Set<string>>(new Set());

  const replayPreassignedTasks = useCallback((dateStr: string, tasks: Task[]) => {
    if (preassignedReplayByDateRef.current.has(dateStr)) return;
    const preassignedOnTimeline = tasks.filter((task) => {
      const assignedCleaner = Number((task as any).assignedCleaner ?? (task as any).cleanerId);
      if (!Number.isFinite(assignedCleaner)) return false;
      return resolvePreAssignedModeFromTask(task) !== null;
    });
    if (preassignedOnTimeline.length === 0) return;

    preassignedReplayByDateRef.current.add(dateStr);
    const animatedIds = new Set<string>(
      preassignedOnTimeline.map((task) =>
        String((task as any).id ?? (task as any).task_id ?? (task as any).name ?? "")
      )
    );
    setPreassignedAnimatedTaskIds(animatedIds);
    window.setTimeout(() => setPreassignedAnimatedTaskIds(new Set()), 4000);

    const readonlyCount = preassignedOnTimeline.filter(
      (task) => resolvePreAssignedModeFromTask(task) === "readonly"
    ).length;
    const normalCount = preassignedOnTimeline.length - readonlyCount;
    const maxSingleToasts = 5;
    for (let i = 0; i < Math.min(preassignedOnTimeline.length, maxSingleToasts); i++) {
      const task = preassignedOnTimeline[i];
      const mode = resolvePreAssignedModeFromTask(task) === "readonly" ? "readonly" : "normal";
      const cleanerId = Number((task as any).assignedCleaner ?? (task as any).cleanerId);
      window.setTimeout(() => {
        toast({
          title: "Task pre-assegnata in timeline",
          description: `Task ${(task as any).name} auto-collocata sul cleaner ${cleanerId}${mode === "readonly" ? " (readonly)" : ""}`,
          variant: "success",
          duration: 2500,
        });
      }, i * 180);
    }
    if (preassignedOnTimeline.length > maxSingleToasts) {
      window.setTimeout(() => {
        toast({
          title: "Task pre-assegnate caricate",
          description: `${preassignedOnTimeline.length} task ripristinate (${normalCount} normali, ${readonlyCount} readonly)`,
          variant: "success",
          duration: 3500,
        });
      }, maxSingleToasts * 180);
    }
  }, [toast]);

  useEffect(() => {
    localStorage.setItem("assignments_scope", scopeValue);
  }, [scopeValue]);

  // Nuova variabile di stato per gestire il caricamento generale
  const [isLoading, setIsLoading] = useState(false);
  
  // Stati per pulsanti Assegna e Refresh Containers
  const [isAssigning, setIsAssigning] = useState(false);
  const [isRefreshingContainers, setIsRefreshingContainers] = useState(false);
  const [showAdamRefreshDialog, setShowAdamRefreshDialog] = useState(false);
  const [adamRefreshMode, setAdamRefreshMode] = useState<AdamRefreshMode>("apt");
  const [showUnlockConfirmDialog, setShowUnlockConfirmDialog] = useState(false);
  const [pendingLockedTasks, setPendingLockedTasks] = useState<LockedConflictTask[]>([]);
  const [pendingRefreshMode, setPendingRefreshMode] = useState<AdamRefreshMode>("assignments");
  // Disabilitazione pulsanti Assegna solo dopo aver premuto il pulsante (non per D&D)
  const [hasRunAssignEo, setHasRunAssignEo] = useState(false);
  const [hasRunAssignHp, setHasRunAssignHp] = useState(false);
  const [hasRunAssignLp, setHasRunAssignLp] = useState(false);

  // Reset flag "ha premuto Assegna" al cambio data
  useEffect(() => {
    setHasRunAssignEo(false);
    setHasRunAssignHp(false);
    setHasRunAssignLp(false);
  }, [selectedDate]);

  // Polling ADAM: fingerprint su campi "di interesse" per segnalare aggiornamenti disponibili
  type AdamFingerprint = {
    count: number;
    max_updated_at_unix: number | null;
    signature_xor: number | null;
    signature_sum: string | number | null;
  };

  const adamBaselineRef = useRef<AdamFingerprint | null>(null);
  const [hasAdamUpdates, setHasAdamUpdates] = useState(false);

  const fetchAdamFingerprint = useCallback(async (workDate: string): Promise<AdamFingerprint | null> => {
    try {
      const r = await fetch(withScope(`/api/adam/housekeeping/fingerprint?date=${encodeURIComponent(workDate)}`), {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" }
      });
      if (!r.ok) return null;
      const data = await r.json();
      if (!data?.success) return null;
      return {
        count: Number(data.count ?? 0),
        max_updated_at_unix: data.max_updated_at_unix !== null && data.max_updated_at_unix !== undefined ? Number(data.max_updated_at_unix) : null,
        signature_xor: data.signature_xor !== null && data.signature_xor !== undefined ? Number(data.signature_xor) : null,
        signature_sum: data.signature_sum ?? null,
      };
    } catch {
      return null;
    }
  }, []);

  // Polling fingerprint ADAM (pausato quando tab non visibile)
  useEffect(() => {
    adamBaselineRef.current = null;
    setHasAdamUpdates(false);

    let stopped = false;
    const workDate = format(selectedDate, "yyyy-MM-dd");

    const poll = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") return;

      const fp = await fetchAdamFingerprint(workDate);
      if (!fp) return;

      // Prima lettura: baseline senza segnale
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

    const timer = setInterval(poll, 15000);
    poll();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [selectedDate, fetchAdamFingerprint]);

  // Callback per notificare modifiche dopo movimenti task
  const handleTaskMoved = useCallback(() => {
    setHasUnsavedChanges(true);
  }, []);

  // Funzione per caricare assegnazioni salvate da Object Storage
  const loadSavedAssignments = async (date: Date) => {
    try {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const response = await fetch('/api/load-saved-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr, scope: scopeValue })
      });

      if (!response.ok) {
        throw new Error('Errore durante il caricamento delle assegnazioni');
      }

      const result = await response.json();

      if (result.found) {
        console.log("✅ Assegnazioni salvate caricate:", result.filename);
        // Salva la data e ora formattate in localStorage per mostrarlo nella timeline
        const displayDateTime = result.formattedDateTime || result.filename;
        localStorage.setItem('last_saved_assignment', displayDateTime);
        setLastSavedTimestamp(displayDateTime);

        // CRITICAL: Quando carichiamo assegnazioni salvate, NON ci sono modifiche
        setHasUnsavedChanges(false);

        // CRITICAL: Verifica e aggiorna la data nella timeline dopo il caricamento
        const timelineResponse = await fetch(withScope(`/api/timeline?date=${dateStr}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });

        if (timelineResponse.ok) {
          const timelineData = await timelineResponse.json();
          if (timelineData.metadata?.date !== dateStr) {
            console.log(`🔄 Aggiornamento data in timeline da ${timelineData.metadata?.date} a ${dateStr}`);
            // La data verrà aggiornata dal backend al prossimo salvataggio
          }
        }

        // CRITICAL: Forza il refresh della timeline per mostrare i cleaners con task
        if ((window as any).loadTimelineCleaners) {
          console.log("🔄 Ricaricamento timeline cleaners dopo caricamento assegnazioni salvate...");
          await (window as any).loadTimelineCleaners();
        }

        return true;
      } else {
        console.log("ℹ️ Nessuna assegnazione salvata per questa data");
        localStorage.removeItem('last_saved_assignment');
        setLastSavedTimestamp(null);
        return false;
      }
    } catch (error) {
      console.error("Errore nel caricamento delle assegnazioni salvate:", error);
      setLastSavedTimestamp(null);
      return false;
    }
  };

  // Orchestratore centralizzato per refresh assegnazioni
  const refreshAssignments = async (
    trigger: "initial" | "date-change" | "manual" | "manual-refresh",
    date: Date = selectedDate
  ) => {
    console.log(`🔄 refreshAssignments chiamato con trigger: "${trigger}"`);

    // Mostra il loader globale solo quando serve davvero
    const shouldShowGlobalLoader =
      trigger === "initial" ||
      trigger === "date-change" ||
      trigger === "manual-refresh";

    if (shouldShowGlobalLoader) {
      setIsLoading(true);
    }

    try {
      if (trigger === "manual" || trigger === "manual-refresh") {
        // Refresh manuale dopo drag-and-drop: solo reload file, NO auto-load, NO extractData
        // silent=true per "manual" (DnD) per evitare schermata di caricamento
        const isSilent = trigger === "manual";
        dlog('📂 Refresh manuale - solo reload file JSON (preserva timeline.json)', { silent: isSilent });
        await loadTasks(true, isSilent);
        return;
      }

      // Per initial e date-change, esegui auto-load completo
      await checkAndAutoLoadSavedAssignments(date);
    } catch (error) {
      console.error("Errore durante refreshAssignments:", error);
    } finally {
      if (shouldShowGlobalLoader) {
        setIsLoading(false);
      }
    }
  };

  // Listener per evento refresh-assignments (es. dopo dissoluzione collaborazione)
  useEffect(() => {
    const handleRefreshAssignments = () => {
      console.log("🔄 Ricevuto evento refresh-assignments, ricarico dati...");
      refreshAssignments("manual");
    };
    
    window.addEventListener('refresh-assignments', handleRefreshAssignments);
    return () => window.removeEventListener('refresh-assignments', handleRefreshAssignments);
  }, []);

  // Funzione per controllare e caricare automaticamente assegnazioni salvate
  const checkAndAutoLoadSavedAssignments = async (date: Date) => {
    try {
      setIsExtracting(true);
      setExtractionStep("Caricamento dati...");

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // CRITICAL: Calcola se la data è passata, presente o futura
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const targetDate = new Date(date);
      targetDate.setHours(0, 0, 0, 0);
      const isPastDate = isWorkDateInPast(date);
      const isCurrentDate = targetDate.getTime() === today.getTime();

      // CRITICAL: Verifica SE esistono assegnazioni salvate per questa data
      const checkResponse = await fetch('/api/check-saved-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr, scope: scopeValue })
      });

      const checkResult = await checkResponse.json();

      if (checkResult.found) {
        // Per TUTTE le date con salvataggio esistente: carica automaticamente
        // CRITICAL: Salva il timestamp PRIMA di caricare per evitare loop infiniti
        const savedKey = `last_saved_${dateStr}`;
        localStorage.setItem(savedKey, checkResult.lastSavedTimestamp || dateStr);

        const dateType = isPastDate ? "data passata" : (isCurrentDate ? "data corrente" : "data futura");
        console.log(`📥 Auto-caricamento assegnazioni salvate per ${dateStr} (${dateType})`);
        setExtractionStep("Caricamento assegnazioni salvate...");

        // Carica automaticamente i dati salvati
        const loadResponse = await fetch('/api/load-saved-assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: dateStr, scope: scopeValue })
        });

        const loadResult = await loadResponse.json();

        if (loadResult.success && loadResult.found) {
          console.log(`✅ Assegnazioni salvate caricate automaticamente per ${dateStr}`);
          setLastSavedTimestamp(checkResult.formattedDateTime || null);

          // CRITICAL: Verifica che la timeline sia valida prima di caricare
          const timelineCheckResponse = await fetch(withScope(`/api/timeline?date=${dateStr}`), {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });

          if (!timelineCheckResponse.ok) {
            console.error("❌ Errore nel caricamento della timeline da /api/timeline");
            toast({
              title: "Errore",
              description: "Impossibile caricare la timeline, riprova tra qualche secondo",
              variant: "destructive",
              duration: 5000
            });
            setIsExtracting(false);
            return;
          }

          // Ricarica i task per mostrare i dati aggiornati
          console.log("⏳ Caricamento task in corso (includerà recalcolo tempi)...");
          await loadTasks(true);
          
          // CRITICAL: Attendi che il server finisca il recalcolo dei tempi
          // Questo è necessario perché il POST /api/load-saved-assignments nel backend
          // chiama il POST /api/timeline che ricalcola i travel_time
          console.log("⏳ Attendendo completamento recalcolo tempi dal server...");
          await new Promise(resolve => setTimeout(resolve, 500));

          // SOLO date passate sono READ-ONLY, tutte le altre (corrente e future) sono EDITABILI
          const toastMessage = isPastDate
            ? "📥 Assegnazioni caricate (sola lettura)"
            : "📥 Assegnazioni caricate (modificabili)";

          const toastDescription = isPastDate
            ? `Ultime assegnazioni salvate il ${checkResult.formattedDateTime || dateStr}`
            : `Ultime assegnazioni salvate il ${checkResult.formattedDateTime || dateStr}`;

          toast({
            variant: "success",
            title: toastMessage,
            description: toastDescription,
            duration: 3000
          });

          // Imposta timeline in modalità read-only SOLO per date passate
          setIsTimelineReadOnly(isWorkDateHistoricallyLocked(date));
          if (isWorkDateHistoricallyLocked(date)) {
            console.log("🔒 Timeline impostata in modalità READ-ONLY (data passata)");
          } else {
            console.log("✏️ Timeline impostata in modalità EDITABILE (data corrente/futura con salvataggio)");
          }

          // Ricarica la timeline UI e aspetta che il rendering sia completato
          if ((window as any).loadTimelineCleaners) {
            console.log("🔄 Ricaricamento timeline cleaners dopo auto-load...");
            setExtractionStep("⏳ Generazione visualizzazione travel time...");
            await new Promise<void>(resolve => {
              (window as any).loadTimelineCleaners(() => {
                console.log("✅ Timeline cleaners caricati e renderizzati");
                resolve();
              });
            });
          }

          // CRITICAL: Dopo aver caricato assegnazioni salvate, NON ci sono modifiche
          setHasUnsavedChanges(false);

          setExtractionStep("✅ Timeline pronta!");
          await new Promise(resolve => setTimeout(resolve, 100));
          setIsExtracting(false);
        } else {
          // Caricamento fallito = nessun salvataggio disponibile
          if (isWorkDateHistoricallyLocked(date)) {
            console.log("📭 Data passata senza salvataggi disponibili - mostro container in sola lettura");
            setIsTimelineReadOnly(true);
          } else {
            console.log("📭 Data corrente/futura senza salvataggi disponibili - modalità EDITABILE");
            setIsTimelineReadOnly(false);
          }
          await extractData(date);
        }
      } else {
        // NON esistono assegnazioni salvate in Object Storage
        console.log("ℹ️ Nessuna assegnazione salvata in Object Storage per", dateStr);

        // Verifica se esiste timeline locale (da DB)
        try {
          const timelineResponse = await fetch(withScope(`/api/timeline?date=${dateStr}`), {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });

          if (timelineResponse.ok) {
            const timelineData = await timelineResponse.json();
            const hasLocalAssignments = timelineData.cleaners_assignments?.length > 0;

            if (hasLocalAssignments && timelineData.metadata?.date === dateStr) {
              console.log("✅ Timeline esistente con assegnazioni - mantieni senza resettare");

              // Carica solo i task senza estrarre
              await loadTasks(true);
              setExtractionStep("Dati caricati!");
              await new Promise(resolve => setTimeout(resolve, 100));
              setIsExtracting(false);
              return;
            }
          }
        } catch (err) {
          console.log("Timeline non trovata o vuota, procedo con estrazione");
        }

        // SOLO date STRETTAMENTE passate sono read-only
        if (isWorkDateHistoricallyLocked(date)) {
          console.log("🔒 Data passata senza assegnazioni salvate - NESSUNA ESTRAZIONE");
          setIsTimelineReadOnly(true);

          // NON estrarre dati per date passate - mostra solo messaggio
          toast({
            title: "Nessun dato disponibile",
            description: `Non ci sono assegnazioni salvate per il ${format(date, "dd/MM/yyyy", { locale: it })}`,
            variant: "default",
            duration: 5000,
          });

          // Imposta stati vuoti
          setEarlyOutTasks([]);
          setHighPriorityTasks([]);
          setLowPriorityTasks([]);
          setAllTasksWithAssignments([]);
          setExtractionStep("Nessun dato per questa data");
          setIsExtracting(false);
        } else {
          console.log("✏️ Data presente/futura - modalità EDITABILE, estrazione dati...");
          setIsTimelineReadOnly(false);
          await extractData(date);
        }
      }
    } catch (error) {
      console.error("Errore nella verifica assegnazioni salvate:", error);

      // Fallback SOLO per date NON passate
      if (!isWorkDateHistoricallyLocked(date)) {
        console.log("Fallback: estrazione per data presente/futura (o passata in development)");
        await extractData(date);
      } else {
        console.log("Fallback: data passata, nessuna estrazione");
        setIsTimelineReadOnly(true);
        setIsExtracting(false);
      }
    }
  };


  // Funzione per estrarre i dati dal database (quando NON esistono assegnazioni salvate)
  const extractData = async (date?: Date) => {
    try {
      setIsExtracting(true);
      setExtractionStep("Estrazione dati dal database...");

      const dateToProcess = date || selectedDate;
      const year = dateToProcess.getFullYear();
      const month = String(dateToProcess.getMonth() + 1).padStart(2, '0');
      const day = String(dateToProcess.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      console.log("Estrazione dati per data:", dateStr);

      // Ottieni username corrente
      const currentUsername = getCurrentUsername();

      const response = await fetch('/api/extract-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr, created_by: currentUsername, scope: scopeValue })
      });

      if (!response.ok) {
        throw new Error('Errore durante l\'estrazione dei dati');
      }

      const result = await response.json();
      console.log("Estrazione completata:", result);

      setExtractionStep("Caricamento task...");
      await loadTasks();

      setExtractionStep("Task caricati!");

      // CRITICAL: Dopo estrazione nuovi dati, NON ci sono modifiche da salvare
      setHasUnsavedChanges(false);

      setIsExtracting(false);
    } catch (error) {
      console.error("Errore nell'estrazione:", error);
      setExtractionStep("Errore durante l'estrazione. Caricamento task esistenti...");
      await loadTasks();
      setIsExtracting(false);
    }
  };

  // Traccia se è un reload o un cambio data effettivo
  const prevDateRef = useRef<string | null>(null);

  useEffect(() => {
    const currentDateStr = format(selectedDate, 'yyyy-MM-dd');
    const consumeConvocationsRefreshRequest = () => {
      try {
        const raw = sessionStorage.getItem("refreshAssignmentsAfterConvocations");
        if (!raw) return false;

        const request = JSON.parse(raw);
        if (request?.date !== currentDateStr || request?.scope !== scopeValue) return false;

        sessionStorage.removeItem("refreshAssignmentsAfterConvocations");
        return true;
      } catch {
        sessionStorage.removeItem("refreshAssignmentsAfterConvocations");
        return false;
      }
    };

    // CRITICAL: Se la data è cambiata (non al primo mount), redirect a unconfirmed-tasks
    const isDateChange = prevDateRef.current !== null && prevDateRef.current !== currentDateStr;
    
    if (isDateChange) {
      console.log(`🔄 Data cambiata da ${prevDateRef.current} a ${currentDateStr}, redirect a unconfirmed-tasks...`);
      prevDateRef.current = currentDateStr;
      setLocation(`/unconfirmed-tasks?date=${currentDateStr}`);
      return; // Non eseguire refreshAssignments se stiamo reindirizzando
    }

    // Al primo mount, carica i dati
    if (isInitialMount) {
      const shouldForceRefreshAfterConvocations = consumeConvocationsRefreshRequest();
      console.log(
        shouldForceRefreshAfterConvocations
          ? `📅 Initial mount dopo convocazioni - refresh forzato`
          : `📅 Initial mount - trigger: "initial"`
      );
      refreshAssignments(
        shouldForceRefreshAfterConvocations ? "manual-refresh" : "initial",
        selectedDate
      );
      setIsInitialMount(false);
      prevDateRef.current = currentDateStr;
    }
  }, [selectedDate, isInitialMount, setLocation]);

  // Funzione per convertire cleaning_time (minuti) in formato ore.minuti
  const formatDuration = (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}.${mins.toString().padStart(2, '0')}`;
  };

  // Funzione per convertire un task raw in Task
  const convertRawTask = (rawTask: RawTask, priority: string): Task => {
    const convertedTask: Task & {
      duplicate_group_id?: string;
      duplicate_group_size_active?: number;
      is_duplicate_active?: boolean;
      preAssignedMode?: PreAssignedMode;
    } = {
      id: rawTask.task_id.toString(),
      name: rawTask.logistic_code?.toString() || 'N/A',
      alias: rawTask.alias,
      type: (rawTask as any).customer_name || `Client ${rawTask.client_id}`,
      duration: formatDuration(rawTask.cleaning_time || 0),
      priority: priority as any,
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: rawTask.address,
      lat: rawTask.lat,
      lng: rawTask.lng,
      premium: rawTask.premium,
      straordinaria:
        rawTask.straordinaria ??
        (rawTask as any).is_straordinaria ??
        isContinuazioneStraordinariaTask(rawTask),
      confirmed_operation: rawTask.confirmed_operation,
      checkout_date: (rawTask as any).checkout_date,
      checkout_time: rawTask.checkout_time,
      checkin_date: (rawTask as any).checkin_date,
      checkin_time: rawTask.checkin_time,
      pax_in: rawTask.pax_in,
      pax_out: rawTask.pax_out,
      operation_id: rawTask.operation_id,
      customer_name: (rawTask as any).customer_name,
      customer_reference: rawTask.customer_reference != null ? String(rawTask.customer_reference) : undefined,
      type_apt: (rawTask as any).type_apt,
      locked: (rawTask as any).locked,
      locked_reason: (rawTask as any).locked_reason,
      reasons: Array.isArray(rawTask.reasons) ? rawTask.reasons : undefined,
      preAssignedMode: rawTask.preAssignedMode ?? resolvePreAssignedModeFromTask(rawTask) ?? undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    convertedTask.duplicate_group_id = rawTask.duplicate_group_id;
    convertedTask.duplicate_group_size_active = rawTask.duplicate_group_size_active ?? 0;
    convertedTask.is_duplicate_active = Boolean(rawTask.is_duplicate_active);
    return convertedTask as Task;
  };

  // Carica i task dai file JSON (SENZA rieseguire extract-data)
  // silent=true per evitare loader durante DnD background refresh
  const loadTasks = async (skipExtraction: boolean = false, silent: boolean = false) => {
    try {
      if (!silent) {
        setIsLoadingTasks(true);
        setExtractionStep("Caricamento task nei contenitori...");
      }

      const dateStr = format(selectedDate, "yyyy-MM-dd");

      console.log("🔄 Caricamento task da PostgreSQL...");

      const [containersResponse, timelineResponse] = await Promise.all([
        fetch(withScope(`/api/containers?date=${dateStr}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        }),
        fetch(withScope(`/api/timeline?date=${dateStr}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        })
      ]);

      if (!containersResponse.ok) {
        throw new Error('Errore nel caricamento dei containers');
      }

      const containersData = await containersResponse.json();

      // Carica da /api/timeline (DB source) con gestione errori robusta
      let timelineAssignmentsData: TimelineAssignmentsData = {
        assignments: [],
        metadata: { date: dateStr },
        cleaners_assignments: []
      };

      if (timelineResponse.ok) {
        try {
          const contentType = timelineResponse.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const timelineText = await timelineResponse.text();

            // Verifica che il contenuto sia JSON valido
            if (!timelineText.trim().startsWith('{') && !timelineText.trim().startsWith('[')) {
              console.warn('Timeline corrotta, non è JSON:', timelineText.substring(0, 100));
              timelineAssignmentsData = { assignments: [], metadata: { date: dateStr }, cleaners_assignments: [] };
            } else {
              timelineAssignmentsData = JSON.parse(timelineText) as TimelineAssignmentsData;
              dlog("Timeline assignments data:", timelineAssignmentsData);
              dlog("Cleaners assignments count:", timelineAssignmentsData.cleaners_assignments?.length || 0);
              dlog("Total tasks in timeline:", timelineAssignmentsData.cleaners_assignments?.reduce((sum: number, c: any) => sum + (c.tasks?.length || 0), 0) || 0);
            }
          } else {
            console.warn('Timeline file is not JSON, using empty timeline');
          }
        } catch (e) {
          console.error('Errore parsing timeline:', e);
          // In caso di errore, usa timeline vuota
          timelineAssignmentsData = { assignments: [], metadata: { date: dateStr }, cleaners_assignments: [] };
        }
      } else {
        console.warn(`Timeline not found (${timelineResponse.status}), using empty timeline`);
      }

      console.log("Containers data:", containersData);

      // Estrai task dai container
      const initialEarlyOut: Task[] = (containersData.containers?.early_out?.tasks || []).map((task: RawTask) =>
        convertRawTask(task, "early_out")
      );

      const initialHigh: Task[] = (containersData.containers?.high_priority?.tasks || []).map((task: RawTask) =>
        convertRawTask(task, "high_priority")
      );

      const initialLow: Task[] = (containersData.containers?.low_priority?.tasks || []).map((task: RawTask) =>
        convertRawTask(task, "low_priority")
      );

      dlog("Task convertiti - Early:", initialEarlyOut.length, "High:", initialHigh.length, "Low:", initialLow.length);

      // Costruisci la mappa task_id -> assegnazioni dalla timeline
      // NOTA: usare Set per sapere quali task_id sono assegnati (per filtrare containers)
      // e Map con chiave composita task_id-cleaner_id per tracciare tutte le assegnazioni
      const assignedTaskIds = new Set<string>();
      const timelineAssignmentsMap = new Map<string, any>(); // chiave: taskId-cleanerId
      const timelineTasks: Task[] = [];

      if (timelineAssignmentsData.cleaners_assignments) {
        dlog('📋 Caricamento da cleaners_assignments:', timelineAssignmentsData.cleaners_assignments.length);
        for (const cleanerEntry of timelineAssignmentsData.cleaners_assignments) {
          if (!cleanerEntry.cleaner || !cleanerEntry.cleaner.id) {
            console.warn('⚠️ Trovata entry senza cleaner, salto:', cleanerEntry);
            continue;
          }

          dlog(`   Cleaner ${cleanerEntry.cleaner.id} (${cleanerEntry.cleaner.name}) ha ${cleanerEntry.tasks?.length || 0} task`);
          for (const task of cleanerEntry.tasks || []) {
            const taskId = String(task.task_id);
            const cleanerId = cleanerEntry.cleaner.id;
            const taskLC = String(task.logistic_code);
            dlog(`      → Task ${taskLC} (ID: ${taskId}) assegnata a cleaner ${cleanerId}`);

            const taskWithAssignment = {
              ...task,
              id: task.task_id || task.id,
              name: String(task.logistic_code),
              assignedCleaner: cleanerId,
              cleanerId: cleanerId,
              sequence: task.sequence,
              priority: task.priority || 'low_priority',
              preAssignedMode: (task as any).preAssignedMode ?? resolvePreAssignedModeFromTask(task) ?? undefined,
            };

            // Chiave composita per supportare collaborazione (stesso task su più cleaners)
            const compositeKey = `${taskId}-${cleanerId}`;
            assignedTaskIds.add(taskId); // Per filtrare containers
            timelineAssignmentsMap.set(compositeKey, taskWithAssignment);
            timelineTasks.push(taskWithAssignment as unknown as Task);
          }
        }
      } else if (timelineAssignmentsData.assignments) {
        // Vecchia struttura piatta (fallback)
        dlog('📋 Caricamento da assignments (vecchia struttura):', timelineAssignmentsData.assignments.length);
        for (const a of timelineAssignmentsData.assignments) {
          const taskId = String(a.task_id);
          const cleanerId = a.cleanerId || a.cleaner_id;
          const taskWithAssignment = {
            ...a,
            id: a.task_id || a.id,
            name: String(a.logistic_code),
            assignedCleaner: cleanerId,
            priority: a.priority || 'low_priority',
            preAssignedMode: (a as any).preAssignedMode ?? resolvePreAssignedModeFromTask(a) ?? undefined,
          };
          const compositeKey = `${taskId}-${cleanerId}`;
          assignedTaskIds.add(taskId);
          timelineAssignmentsMap.set(compositeKey, taskWithAssignment);
          timelineTasks.push(taskWithAssignment as unknown as Task);
        }
      }

      dlog("✅ Task assegnate nella timeline (task_id):", Array.from(assignedTaskIds));
      dlog("✅ Timeline tasks array length:", timelineTasks.length);


      // Filtra le task già presenti nella timeline dai container usando l'id univoco
      const filteredEarlyOut = initialEarlyOut.filter(task => {
        const tid = String(task.id);
        const isAssigned = assignedTaskIds.has(tid);
        if (isAssigned) {
          dlog(`Task ${task.name} (ID: ${tid}) filtrata da Early Out (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredHigh = initialHigh.filter(task => {
        const tid = String(task.id);
        const isAssigned = assignedTaskIds.has(tid);
        if (isAssigned) {
          dlog(`Task ${task.name} (ID: ${tid}) filtrata da High Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredLow = initialLow.filter(task => {
        const tid = String(task.id);
        const isAssigned = assignedTaskIds.has(tid);
        if (isAssigned) {
          dlog(`Task ${task.name} (ID: ${tid}) filtrata da Low Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      dlog("Task dopo filtro - Early:", filteredEarlyOut.length, "High:", filteredHigh.length, "Low:", filteredLow.length);

      // AGGIORNA GLI STATI IN MODO SINCRONIZZATO
      setEarlyOutTasks(filteredEarlyOut);
      setHighPriorityTasks(filteredHigh);
      setLowPriorityTasks(filteredLow);

      dlog(`📊 SINCRONIZZAZIONE CONTAINERS:`);
      dlog(`   - Early Out: ${filteredEarlyOut.length} task (filtrate ${initialEarlyOut.length - filteredEarlyOut.length})`);
      dlog(`   - High Priority: ${filteredHigh.length} task (filtrate ${initialHigh.length - filteredHigh.length})`);
      dlog(`   - Low Priority: ${filteredLow.length} task (filtrate ${initialLow.length - filteredLow.length})`);
      dlog(`   - Timeline ha ${assignedTaskIds.size} task assegnate (${timelineAssignmentsMap.size} assegnazioni totali inclusi collaboratori)`);

      // Crea l'array unificato usando dedupe per chiave composita id-cleanerId
      // per supportare la collaborazione (stesso task su più cleaners)
      const tasksWithAssignments: Task[] = [];

      // CRITICAL: usa Set per tracciare chiavi composite già inserite
      const addedKeys = new Set<string>();

      // Aggiungi task NON assegnate dai containers (dedupe per id, non hanno cleanerId)
      for (const task of [...filteredEarlyOut, ...filteredHigh, ...filteredLow]) {
        const tid = String(task.id);
        if (!addedKeys.has(tid)) {
          tasksWithAssignments.push(task);
          addedKeys.add(tid);
        }
      }

      // Aggiungi SOLO task che sono effettivamente in timeline.json con i loro dati completi
      dlog(`🔄 Elaborazione ${timelineAssignmentsMap.size} assegnazioni dalla timeline...`);
      for (const [compositeKey, timelineAssignment] of timelineAssignmentsMap.entries()) {
        // La chiave composita è taskId-cleanerId, estraiamo il taskId
        const taskId = String(timelineAssignment.task_id || timelineAssignment.id);
        
        // Trova la task originale dai containers usando l'id univoco
        const originalTask = [...initialEarlyOut, ...initialHigh, ...initialLow].find(
          t => String(t.id) === taskId
        );

        dlog(`   → Task ${timelineAssignment.logistic_code} (ID: ${taskId}, key: ${compositeKey}):`, {
          hasOriginalTask: !!originalTask,
          cleanerId: timelineAssignment.cleanerId,
          priority: timelineAssignment.priority
        });

        if (timelineAssignment.cleanerId) {
          // Se la task esiste nei containers, usa quei dati come base
          // Altrimenti usa i dati dalla timeline (task già assegnata in sessioni precedenti)
          const baseTask = originalTask || {
            id: String(timelineAssignment.task_id),
            name: String(timelineAssignment.logistic_code),
            type: timelineAssignment.customer_name || 'Unknown',
            duration: formatDuration(timelineAssignment.cleaning_time || 0),
            priority: (timelineAssignment.priority || 'unknown') as any,
            assignedTo: null,
            status: "pending" as const,
            scheduledTime: null,
            address: timelineAssignment.address,
            lat: timelineAssignment.lat,
            lng: timelineAssignment.lng,
            premium: timelineAssignment.premium,
            straordinaria: isEquivalentStraordinariaTask(timelineAssignment),
            confirmed_operation: timelineAssignment.confirmed_operation,
            customer_reference: timelineAssignment.customer_reference,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          const taskLogCode = getLogisticCode(baseTask);
          dlog(`➕ Aggiungendo task ${taskLogCode} dalla timeline a cleaner ${timelineAssignment.cleanerId} con sequence ${timelineAssignment.sequence}`);

          // IMPORTANTE: Assicurati che assignedCleaner sia propagato correttamente
          // IMPORTANTE: duration dalla timeline ha priorità (per collaborazioni con tempo diviso)
          // Usa formatDuration per calcolare duration dal cleaning_time aggiornato
          const taskWithAssignment = {
            ...baseTask,
            duration: (typeof timelineAssignment.cleaning_time === "number")
              ? formatDuration(timelineAssignment.cleaning_time) 
              : baseTask.duration,
            cleaning_time: (typeof timelineAssignment.cleaning_time === "number")
              ? timelineAssignment.cleaning_time
              : (baseTask as any).cleaning_time,
            base_cleaning_time: timelineAssignment.base_cleaning_time,
            collaborator_ids: timelineAssignment.collaborator_ids,
            collaborator_count: timelineAssignment.collaborator_count,
            is_primary: timelineAssignment.is_primary,
            priority: timelineAssignment.priority || baseTask.priority,
            assignedCleaner: timelineAssignment.cleanerId,
            sequence: timelineAssignment.sequence,
            start_time: timelineAssignment.start_time,
            end_time: timelineAssignment.end_time,
            startTime: timelineAssignment.start_time || (baseTask as any).startTime,
            endTime: timelineAssignment.end_time || (baseTask as any).endTime,
            travelTime: timelineAssignment.travel_time || 0,
            address: timelineAssignment.address || baseTask.address,
            lat: timelineAssignment.lat || baseTask.lat,
            lng: timelineAssignment.lng || baseTask.lng,
            premium: timelineAssignment.premium !== undefined ? timelineAssignment.premium : baseTask.premium,
            straordinaria:
              timelineAssignment.straordinaria !== undefined
                ? isEquivalentStraordinariaTask(timelineAssignment)
                : isEquivalentStraordinariaTask(baseTask),
            confirmed_operation: timelineAssignment.confirmed_operation !== undefined ? timelineAssignment.confirmed_operation : (baseTask as any).confirmed_operation,
            customer_name: timelineAssignment.customer_name,
            customer_reference: timelineAssignment.customer_reference,
            type_apt: timelineAssignment.type_apt,
            checkin_date: timelineAssignment.checkin_date,
            checkout_date: timelineAssignment.checkout_date,
            checkin_time: timelineAssignment.checkin_time,
            checkout_time: timelineAssignment.checkout_time,
            pax_in: timelineAssignment.pax_in,
            pax_out: timelineAssignment.pax_out,
            operation_id: timelineAssignment.operation_id,
            alias: timelineAssignment.alias,
            reasons: Array.isArray((timelineAssignment as any).reasons)
              ? (timelineAssignment as any).reasons
              : Array.isArray((baseTask as any).reasons)
                ? (baseTask as any).reasons
                : undefined,
            preAssignedMode:
              (timelineAssignment as any).preAssignedMode ??
              resolvePreAssignedModeFromTask(timelineAssignment) ??
              resolvePreAssignedModeFromTask(baseTask) ??
              undefined,
          } as any;

          // Usa chiave composita per evitare dedup tra collaboratori
          if (!addedKeys.has(compositeKey)) {
            tasksWithAssignments.push(taskWithAssignment);
            addedKeys.add(compositeKey);
          }
        }
      }

      // NON usare dedupeById perché rimuoverebbe i collaboratori
      // La dedupe è già gestita con addedKeys
      const dedupedTasks = tasksWithAssignments;

      dlog(`📊 SINCRONIZZAZIONE TIMELINE:`);
      dlog(`   - Task totali (prima dedupe): ${tasksWithAssignments.length}`);
      dlog(`   - Task totali (dopo dedupe): ${dedupedTasks.length}`);
      dlog(`   - Task assegnate: ${dedupedTasks.filter(t => (t as any).assignedCleaner).length}`);
      dlog(`   - Task nei containers: ${dedupedTasks.filter(t => !(t as any).assignedCleaner).length}`);

      setAllTasksWithAssignments(dedupedTasks);
      if (!silent) {
        replayPreassignedTasks(dateStr, dedupedTasks);
      }

      if (!silent) {
        setIsLoadingTasks(false);
        setExtractionStep("Task caricati con successo!");
      }

      dlog(`✅ SINCRONIZZAZIONE COMPLETATA - Containers e Timeline allineati con i file JSON`);
    } catch (error) {
      console.error("Errore nel caricamento dei task:", error);
      if (!silent) {
        setIsLoadingTasks(false);
        setExtractionStep("Errore nel caricamento dei task");
      }
    }
  };

  // Funzione esposta per ricaricare i task e le assegnazioni
  const reloadAllTasks = async () => {
    await refreshAssignments("manual");
  };

  const runAdamContainersRefresh = async (opts: {
    mode: AdamRefreshMode;
    confirmUnlockLocked?: boolean;
    skipContainersRefresh?: boolean;
  }) => {
    const year = selectedDate.getFullYear();
    const month = String(selectedDate.getMonth() + 1).padStart(2, "0");
    const day = String(selectedDate.getDate()).padStart(2, "0");
    const dateStr = `${year}-${month}-${day}`;

    setIsRefreshingContainers(true);
    let keepFrozenForUnlockDialog = false;
    try {
      const response = await fetch("/api/containers/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: dateStr,
          scope: scopeValue,
          mode: opts.mode,
          confirmUnlockLocked: Boolean(opts.confirmUnlockLocked),
          skipContainersRefresh: Boolean(opts.skipContainersRefresh),
        }),
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.error || "Errore durante il refresh");
      }

      if (result.needsUnlockConfirm) {
        keepFrozenForUnlockDialog = true;
        setPendingRefreshMode(opts.mode);
        setPendingLockedTasks(
          Array.isArray(result.lockedTasks) ? result.lockedTasks : []
        );
        setShowUnlockConfirmDialog(true);
        return;
      }

      const fp = await fetchAdamFingerprint(dateStr);
      if (fp) {
        adamBaselineRef.current = fp;
        setHasAdamUpdates(false);
      }

      const sync = result.assignmentSync;
      const description =
        opts.mode === "assignments"
          ? `Dati apt aggiornati. Assegnazioni: ${sync?.assigned ?? 0} aggiunte, ${sync?.moved ?? 0} spostate, ${sync?.unassigned ?? 0} tolte${
              sync?.removedUnhandled
                ? `, ${sync.removedUnhandled} rimosse (tipologia non gestita da WASS)`
                : ""
            }${
              sync?.skippedReadonly
                ? `, ${sync.skippedReadonly} ignorate (tipologia non gestita, cleaner non convocato)`
                : ""
            }. Orari ricalcolati su ${sync?.recalculatedCleaners ?? 0} cleaner.`
          : "I dati dei task (appartamento) sono stati aggiornati da ADAM";

      toast({
        variant: "success",
        title:
          opts.mode === "assignments"
            ? "Sincronizzazione ADAM completata"
            : "Containers aggiornati",
        description,
      });
      await reloadAllTasks();
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Errore",
        description: error?.message || "Errore durante il refresh dei containers",
      });
    } finally {
      if (!keepFrozenForUnlockDialog) {
        setIsRefreshingContainers(false);
      }
    }
  };





  const runWaveAssignment = async (priority: 'early_out' | 'high_priority' | 'low_priority', label: string) => {
    try {
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const response = await fetch("/api/optimizer/run-wave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr, priority, scope: scopeValue }),
      });

      const result = await response.json();

      if (result.success) {
        if (priority === 'early_out') setHasRunAssignEo(true);
        if (priority === 'high_priority') setHasRunAssignHp(true);
        if (priority === 'low_priority') setHasRunAssignLp(true);

        toast({
          title: `${label} Assegnati!`,
          description: result.message || `${result.applied?.insertedCount || 0} task assegnati`,
          duration: 3000,
        });

        if (result.warnings?.length) {
          toast({
            title: `Attenzione: ${result.warnings.length} violazione/i checkin`,
            description: result.warnings.join(' | '),
            variant: "destructive",
            duration: 10000,
          });
        }

        scheduleManualRefresh(0);
      } else {
        toast({
          title: "Errore",
          description: result.error || result.message || `Errore durante l'assegnazione ${label}`,
          variant: "destructive",
          duration: 3000,
        });
      }
    } catch (error: any) {
      console.error(`Errore nell'assegnazione ${label}:`, error);
      toast({
        title: "Errore",
        description: error.message || `Errore durante l'assegnazione ${label}`,
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  const assignEarlyOutToTimeline = async () => runWaveAssignment('early_out', 'Early Out');

  const assignHighPriorityToTimeline = async () => runWaveAssignment('high_priority', 'High Priority');

  const assignLowPriorityToTimeline = async () => runWaveAssignment('low_priority', 'Low Priority');

  // Esponi le funzioni per poterle chiamare da altri componenti
  (window as any).reloadAllTasks = reloadAllTasks;
  (window as any).assignEarlyOutToTimeline = assignEarlyOutToTimeline;
  (window as any).assignHighPriorityToTimeline = assignHighPriorityToTimeline;
  (window as any).assignLowPriorityToTimeline = assignLowPriorityToTimeline;
  (window as any).setHasUnsavedChanges = setHasUnsavedChanges;


  const saveTaskAssignments = async (tasks: Task[]) => {
    try {
      const response = await fetch('/api/save-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tasks),
      });
      if (!response.ok) {
        console.error('Errore nel salvataggio delle assegnazioni');
      } else {
        console.log('Assegnazioni salvate con successo');
      }
    } catch (error) {
      console.error('Errore nella chiamata API di salvataggio:', error);
    }
  };

  const saveTaskAssignment = async (taskId: string, cleanerId: number, logisticCode?: string, dropIndex?: number) => {
    try {
      const dateStr = format(selectedDate, "yyyy-MM-dd");

      // Trova il task completo usando l'id univoco
      const task = allTasksWithAssignments.find(t => String(t.id) === String(taskId));

      if (!task) {
        console.error(`Task ${taskId} non trovata in allTasksWithAssignments`);
        return;
      }

      // Determina la priorità originale della task usando l'id
      let priority = 'low_priority'; // default
      let modificationType = 'dnd_from_low_priority';

      if (earlyOutTasks.find(t => String(t.id) === String(taskId))) {
        priority = 'early_out';
        modificationType = 'dnd_from_early_out';
      } else if (highPriorityTasks.find(t => String(t.id) === String(taskId))) {
        priority = 'high_priority';
        modificationType = 'dnd_from_high_priority';
      }

      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

      // ENFORCEMENT: Check se la task è locked prima di assegnare
      if ((task as any).locked) {
        console.log(`🔒 Task ${taskId} è bloccata, assegnazione annullata`);
        throw new Error((task as any).locked_reason || 'Task bloccata: impossibile assegnare');
      }

      const response = await fetch("/api/save-timeline-assignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          logisticCode: task.name,
          cleanerId: cleanerId,
          insertAt: dropIndex,
          taskData: task,
          priority: priority,
          date: dateStr,
          scope: scopeValue,
          modified_by: currentUser.username || 'unknown',
          modification_type: modificationType
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        // Gestione errore 423 (Task bloccata o Cleaner bloccato)
        if (response.status === 423) {
          if (errData.error === 'PREASSIGNED_READONLY') {
            throw new Error('Task pre-assegnata readonly: operazione non consentita');
          }
          if (errData.error === 'CLEANER_LOCKED') {
            throw new Error('Cleaner bloccato: impossibile assegnare');
          }
          throw new Error(errData.locked_reason || 'Task bloccata: impossibile assegnare');
        }
        throw new Error(`Errore nel salvataggio dell'assegnazione: ${errData.error || response.statusText}`);
      }
      console.log(`Assegnazione salvata: taskId=${taskId}, logisticCode=${logisticCode}`);
    } catch (error: any) {
      console.error('Errore nella chiamata API di salvataggio timeline:', error);
      // CRITICAL: Propaga l'errore al chiamante (DnD) per evitare toast di successo falsi
      throw error;
    }
  };

  const reorderTimelineAssignment = async (taskId: string, logisticCode: string | undefined, cleanerId: number, fromIndex: number, toIndex: number) => {
    try {
      const dateStr = format(selectedDate, "yyyy-MM-dd");
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await fetch('/api/reorder-timeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateStr,
          scope: scopeValue,
          cleanerId,
          taskId,
          logisticCode,
          fromIndex,
          toIndex,
          modified_by: currentUser.username || 'unknown',
          modification_type: 'dnd_reorder_same_cleaner'
        }),
      });
      if (!response.ok) {
        const errorData = await response.json();
        console.error('Errore nel reorder della timeline:', errorData);

        if (response.status === 400) {
          toast({
            title: "Errore di sincronizzazione",
            description: errorData.message || "La timeline non è sincronizzata. Ricarica la pagina.",
            variant: "destructive"
          });
          // Ricarica i dati per sincronizzare lo stato
          await refreshAssignments("manual");
        }
      } else {
        console.log('Timeline riordinata con successo');
      }
    } catch (error) {
      console.error('Errore nella chiamata API di reorder timeline:', error);
      toast({
        title: "Errore di rete",
        description: "Impossibile riordinare la task. Verifica la connessione.",
        variant: "destructive"
      });
    }
  };

  const removeTimelineAssignment = async (taskId: string, logisticCode?: string) => {
    try {
      const dateStr = format(selectedDate, "yyyy-MM-dd");
      const response = await fetch('/api/remove-timeline-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, logisticCode, date: dateStr, scope: scopeValue }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (response.status === 423 && errorData.error === "PREASSIGNED_READONLY") {
          toast({
            title: "Task pre-assegnata readonly",
            description: "Puoi solo riordinarla nella stessa riga cleaner.",
            variant: "warning",
          });
          return;
        }
        console.error('Errore nella rimozione dell\'assegnazione dalla timeline', errorData);
        toast({
          title: "Errore",
          description: "Impossibile spostare la task dalla timeline",
          variant: "destructive",
        });
      } else {
        console.log('Assegnazione rimossa dalla timeline con successo');
        toast({
          title: "Task spostata",
          description: `Task ${logisticCode || taskId} rimossa dalla timeline e riportata nel container`,
        });
      }
    } catch (error) {
      console.error('Errore nella chiamata API di rimozione timeline:', error);
    }
  };

  const pendingRouteSpacerHideRafRef = useRef<number | null>(null);

  const resetDndUiState = useCallback(() => {
    if (pendingRouteSpacerHideRafRef.current != null) {
      cancelAnimationFrame(pendingRouteSpacerHideRafRef.current);
      pendingRouteSpacerHideRafRef.current = null;
    }
    setIsDraggingTimelineTask(false);
    setDragSequencePreview(null);
    setLastValidDragIndex(null);
    lastValidDragIndexRef.current = null;
    setDraggingOverCleanerId(null);
    setActiveDragCleanerId(null);
  }, []);

  const handleDndOperation = useCallback(
    async (operation: DndDropOperation) => {
      if (operation.type === "noop") return;
      if (isDraggingRef.current || isLoadingDragDrop || isRefreshingContainers) return;

      if (isTimelineReadOnly) {
        toast({
          title: "Operazione non permessa",
          description: "La timeline è in sola visualizzazione per questa data.",
          variant: "warning",
        });
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
        switch (operation.type) {
          case "assign": {
            const cleanerId = operation.to.staffId;
            let insertIndex = operation.index;
            for (const taskId of operation.taskIds) {
              const task = allTasksWithAssignments.find(
                (t) => String(t.id) === String(taskId),
              );
              if (!task) continue;
              if ((task as any).locked) {
                throw new Error(
                  (task as any).locked_reason ||
                    "Task bloccata: impossibile assegnare",
                );
              }
              await saveTaskAssignment(
                taskId,
                cleanerId,
                task.name,
                insertIndex,
              );
              insertIndex += 1;
            }
            setHasUnsavedChanges(true);
            handleTaskMoved?.();
            await refreshAssignments("manual");
            break;
          }

          case "reorder": {
            const cleanerId = operation.in.staffId;
            let destIndex = operation.toIndex;
            for (const taskId of operation.taskIds) {
              const task = allTasksWithAssignments.find(
                (t) => String(t.id) === String(taskId),
              );
              await reorderTimelineAssignment(
                taskId,
                task?.name,
                cleanerId,
                operation.fromIndex,
                destIndex,
              );
              destIndex += 1;
            }
            setHasUnsavedChanges(true);
            handleTaskMoved?.();
            await refreshAssignments("manual");
            break;
          }

          case "reassign": {
            let destIndex = operation.index;
            for (const taskId of operation.taskIds) {
              const task = allTasksWithAssignments.find(
                (t) => String(t.id) === String(taskId),
              );
              const logisticCode = task?.name;
              const taskPreAssignedMode = resolvePreAssignedModeFromTask(task);
              if (taskPreAssignedMode === "readonly") {
                throw new Error(
                  "Task pre-assegnata readonly: non puoi cambiare cleaner",
                );
              }

              const response = await fetch("/api/move-task-between-cleaners", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  taskId,
                  logisticCode,
                  sourceCleanerId: operation.from.staffId,
                  destCleanerId: operation.to.staffId,
                  destIndex,
                  date: format(selectedDate, "yyyy-MM-dd"),
                  scope: scopeValue,
                  mode: "move_assignment",
                  modified_by:
                    JSON.parse(localStorage.getItem("user") || "{}").username ||
                    "unknown",
                }),
              });

              if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                if (response.status === 423) {
                  if (errorData.error === "PREASSIGNED_READONLY") {
                    throw new Error(
                      "Task pre-assegnata readonly: non puoi cambiare cleaner",
                    );
                  }
                  if (errorData.error === "CLEANER_LOCKED") {
                    throw new Error("Cleaner bloccato: impossibile assegnare");
                  }
                  throw new Error(
                    errorData.locked_reason ||
                      "Task bloccata: impossibile assegnare",
                  );
                }
                throw new Error(
                  errorData.message ||
                    errorData.locked_reason ||
                    "Errore nello spostamento tra cleaners",
                );
              }
              destIndex += 1;
            }
            setHasUnsavedChanges(true);
            handleTaskMoved?.();
            await refreshAssignments("manual");
            break;
          }

          case "remove": {
            for (const taskId of operation.taskIds) {
              const task = allTasksWithAssignments.find(
                (t) => String(t.id) === String(taskId),
              );
              await removeTimelineAssignment(taskId, task?.name);
            }
            setHasUnsavedChanges(true);
            handleTaskMoved?.();
            await refreshAssignments("manual");
            break;
          }
        }
      } catch (error) {
        console.error("Errore nell'operazione drag-and-drop:", error);
        toast({
          title: "Errore",
          description:
            error instanceof Error
              ? error.message
              : "Errore nello spostamento della task",
          variant: "destructive",
        });
      } finally {
        isDraggingRef.current = false;
        if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
        setIsLoadingDragDrop(false);
        resetDndUiState();
        // Il movimento (anche multi-selezione) è concluso: azzera la selezione
        // così il prossimo drag riparte da zero e non "trascina" i task
        // selezionati in precedenza. I drop non validi (noop) escono prima del
        // try, quindi qui la selezione viene azzerata solo dopo un'operazione reale.
        clearSelection();
      }
    },
    [
      allTasksWithAssignments,
      selectedDate,
      scopeValue,
      isTimelineReadOnly,
      isLoadingDragDrop,
      isRefreshingContainers,
      reorderTimelineAssignment,
      refreshAssignments,
      handleTaskMoved,
      resetDndUiState,
      removeTimelineAssignment,
      saveTaskAssignment,
      clearSelection,
      toast,
    ],
  );

  const assignmentDnd = useAssignmentDnd({
    scope: "housekeeping",
    onOperation: handleDndOperation,
    onDragStart: (item) => {
      const isTimelineOrSummary =
        item.from.type === "timeline" || item.from.type === "summary";
      setIsDraggingTimelineTask(isTimelineOrSummary);

      // Ritarda il reflow (hide travel): DragOverlay deve misurare il rect
      // iniziale PRIMA che i task scalino a sinistra, altrimenti il cursore si stacca.
      if (pendingRouteSpacerHideRafRef.current != null) {
        cancelAnimationFrame(pendingRouteSpacerHideRafRef.current);
      }
      if (isTimelineOrSummary && item.from.type === "timeline") {
        const staffId = item.from.staffId;
        pendingRouteSpacerHideRafRef.current = requestAnimationFrame(() => {
          pendingRouteSpacerHideRafRef.current = null;
          setActiveDragCleanerId(staffId);
        });
      } else if (isTimelineOrSummary) {
        setActiveDragCleanerId(item.from.staffId);
      } else {
        setActiveDragCleanerId(null);
      }
    },
    onDragOver: (target: DndInsertTarget | null) => {
      if (target?.container.type !== "timeline" && target?.container.type !== "summary") {
        setDragSequencePreview(null);
        setLastValidDragIndex(null);
        lastValidDragIndexRef.current = null;
        setDraggingOverCleanerId(null);
        return;
      }

      const cleanerId = target.container.staffId;
      setLastValidDragIndex(target.index);
      lastValidDragIndexRef.current = target.index;
      setDraggingOverCleanerId(cleanerId);
      setDragSequencePreview({
        sequenceIndex: target.index + 1,
      });
    },
    onDragCancel: resetDndUiState,
    onDragEnd: resetDndUiState,
  });

  const updateTaskJson = async (taskId: string, logisticCode: string | undefined, fromContainer: string | null, toContainer: string | null) => {
    if (!logisticCode || !fromContainer || !toContainer) {
      console.warn('Missing required parameters for updateTaskJson');
      return;
    }
    try {
      const response = await fetch('/api/update-task-json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, logisticCode, fromContainer, toContainer }),
      });
      if (!response.ok) {
        console.error('Errore nell\'aggiornamento dei JSON');
      } else {
        console.log('JSON aggiornati con successo');
      }
    } catch (error) {
      console.error('Errore nella chiamata API di aggiornamento JSON:', error);
    }
  };

  // Combina task dalla timeline con task dai containers (senza filtri su logistic_code)
  const allTasks = [...earlyOutTasks, ...highPriorityTasks, ...lowPriorityTasks, ...lopezTasks, ...garciaTasks, ...rossiTasks];
  // The following line was replaced by the comment above.
  // const allTasks = [...timelineTasksWithoutDuplicates, ...containerTasks];

  // Determina se la modalità storica è attiva (data passata)
  const isHistoricalMode = isWorkDateHistoricallyLocked(selectedDate);

  const assignmentStatistics = useMemo(
    () =>
      computeAssignmentTaskStatisticsFromTasks(
        allTasksWithAssignments,
        isOfficeScope ? "office" : "housekeeping"
      ),
    [allTasksWithAssignments, isOfficeScope]
  );
  const timelinePriorityState = useMemo(() => {
    let hasEoOnTimeline = false;
    let hasHpOnTimeline = false;
    let hasLpOnTimeline = false;

    for (const task of allTasksWithAssignments) {
      if (!(task as any).assignedCleaner) continue;
      const normalizedPriority =
        normalizeWavePriority((task as any).priority) ??
        normalizeWavePriority((task as any).priority_type) ??
        normalizeWavePriority((task as any).priorityType);
      if (normalizedPriority === 'early_out') hasEoOnTimeline = true;
      if (normalizedPriority === 'high_priority') hasHpOnTimeline = true;
      if (normalizedPriority === 'low_priority') hasLpOnTimeline = true;
    }

    return { hasEoOnTimeline, hasHpOnTimeline, hasLpOnTimeline };
  }, [allTasksWithAssignments]);

  // Definisci la funzione handleDateSelect qui, se non è già definita
  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      setSelectedDate(date);
    }
  };

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-background text-foreground">
      <div className="mx-auto flex w-full min-h-0 max-w-[1920px] flex-1 flex-col overflow-x-hidden px-4 pb-6 pt-3">
        {!(isExtracting || isLoadingTasks || isLoading) && (
          <div className="mx-auto mb-3 flex w-full max-w-[1920px] flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 flex-wrap items-center gap-4">
              <h1 className="flex items-center gap-2 text-[25px] leading-[44px] font-bold text-foreground">
                {isOfficeScope ? "Assegnazioni Ufficio del" : "Assegnazioni Housekeeping del"}
              </h1>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "justify-start border-2 border-custom-blue text-left text-[13px] font-normal [background-clip:unset] [-webkit-background-clip:unset]",
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
            <HousekeepingLogisticsSwitch active={isOfficeScope ? "office" : "housekeeping"} />
          </div>
        )}

        {isExtracting || isLoadingTasks || isLoading ? (
          <PageViewportCentered layout="fill" className="py-4">
            <div className="max-w-lg space-y-4 text-center">
              <div className="flex justify-center">
                <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
              </div>
              <h2 className="text-xl font-bold text-foreground">
                {isExtracting
                  ? "Estrazione Dati in Corso"
                  : isLoadingTasks
                    ? "Caricamento Task"
                    : "Caricamento Dati"}
              </h2>
              <p className="text-muted-foreground">{extractionStep}</p>
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                {isExtracting && (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                    <span>Step 1/2: Estrazione dal database</span>
                  </>
                )}
                {isLoadingTasks && (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                    <span>Step 2/2: Caricamento nei contenitori</span>
                  </>
                )}
                {isLoading && !isExtracting && !isLoadingTasks && (
                  <>
                    <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                    <span>Caricamento generale...</span>
                  </>
                )}
              </div>
            </div>
          </PageViewportCentered>
        ) : (
        <MultiSelectContext.Provider value={multiSelectContextValue}>
          <DndContext
            sensors={assignmentDnd.sensors}
            collisionDetection={assignmentDnd.collisionDetection}
            modifiers={assignmentDnd.modifiers}
            measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
            {...assignmentDnd.handlers}
          >
            <div className="mb-4 flex items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-5 w-5 text-custom-blue" />
                <Input
                  placeholder="Cerca task..."
                  value={searchTask}
                  onChange={(e) => setSearchTask(e.target.value)}
                  className="border-2 border-custom-blue pl-10"
                  data-testid="input-search-task"
                />
              </div>
              <div className="flex items-center flex-shrink-0 bg-custom-blue rounded-md overflow-hidden border-2 border-custom-blue">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAdamRefreshDialog(true)}
                disabled={isRefreshingContainers || isTimelineReadOnly}
                className="flex items-center gap-2 rounded-none text-black dark:text-white hover:bg-custom-blue/80 px-3"
                title="Sync from ADAM"
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
                Sync from ADAM
              </Button>
              <div className="w-px h-6 bg-black/20 dark:bg-white/20" />
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    setIsAssigning(true);
                    const year = selectedDate.getFullYear();
                    const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
                    const day = String(selectedDate.getDate()).padStart(2, '0');
                    const dateStr = `${year}-${month}-${day}`;
                    
                    const response = await fetch('/api/optimizer/run-all', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ 
                        date: dateStr, 
                        scope: scopeValue,
                        skipPhase4: false, 
                        applyToProduction: true 
                      })
                    });
                    
                    if (!response.ok) throw new Error('Errore durante l\'assegnazione');
                    
                    const result = await response.json();
                    const summary = result.summary || {};
                    toast({
                      variant: "success",
                      title: "Assegnazione completata",
                      description: `${summary.tasksAssigned || 0} task assegnate, ${summary.tasksUnassigned || 0} non assegnate`,
                    });
                    await reloadAllTasks();
                  } catch (error) {
                    toast({
                      variant: "destructive",
                      title: "Errore",
                      description: "Errore durante l'assegnazione automatica",
                    });
                  } finally {
                    setIsAssigning(false);
                  }
                }}
                disabled={isAssigning || isTimelineReadOnly || isRefreshingContainers}
                className="flex items-center gap-2 rounded-none text-black dark:text-white hover:bg-custom-blue/80 px-3"
              >
                {isAssigning ? (
                  <><RefreshCw className="w-4 h-4 animate-spin" /> Assegnando...</>
                ) : (
                  <><CalendarIcon className="w-4 h-4" /> Assegna</>
                )}
              </Button>
              </div>
            </div>

            {(() => {
              const getHighlightedTaskIds = (tasks: Task[]): Set<string> => {
                const result = new Set<string>();
                
                // Highlight da doppio click su mappa (pallino grigio)
                if (containerHighlightTaskId) {
                  const matchingTask = tasks.find(t => 
                    String((t as any).id || (t as any).task_id || '') === containerHighlightTaskId
                  );
                  if (matchingTask) {
                    result.add(containerHighlightTaskId);
                  }
                }
                
                // Highlight da ricerca
                if (searchTask.trim()) {
                  const lowerSearch = searchTask.toLowerCase();
                  tasks
                    .filter(task => {
                      const taskId = String((task as any).id || (task as any).task_id || '');
                      const logisticCode = String((task as any).logisticCode || (task as any).logistic_code || (task as any).name || '');
                      const address = String((task as any).address || '');
                      const customerName = String((task as any).customer_name || '');
                      const alias = String((task as any).alias || '');
                      const customerReference = String((task as any).customer_reference || '');
                      
                      return (
                        taskId.toLowerCase().includes(lowerSearch) ||
                        logisticCode.toLowerCase().includes(lowerSearch) ||
                        address.toLowerCase().includes(lowerSearch) ||
                        customerName.toLowerCase().includes(lowerSearch) ||
                        alias.toLowerCase().includes(lowerSearch) ||
                        customerReference.toLowerCase().includes(lowerSearch)
                      );
                    })
                    .forEach(t => result.add(String((t as any).id || (t as any).task_id || '')));
                }
                
                return result;
              };

              const highlightedEarlyOut = getHighlightedTaskIds(earlyOutTasks);
              const highlightedHighPriority = getHighlightedTaskIds(highPriorityTasks);
              const highlightedLowPriority = getHighlightedTaskIds(lowPriorityTasks);

              return (
                <div className="relative mb-4 w-full">
                  {isRefreshingContainers && (
                    <div className="absolute inset-0 z-40 flex items-center justify-center rounded-lg bg-black/20 backdrop-blur-sm dark:bg-black/40">
                      <div className="flex flex-col items-center gap-3">
                        <RefreshCw className="h-8 w-8 animate-spin text-custom-blue" />
                        <p className="text-sm font-medium text-foreground">
                          Aggiornamento da ADAM in corso…
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Non spostare task finché non termina
                        </p>
                      </div>
                    </div>
                  )}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 w-full">
                  <PriorityColumn
                    title="EARLY OUT"
                    priority="early-out"
                    tasks={earlyOutTasks}
                    droppableId="early-out"
                    icon="clock"
                    assignAction={assignEarlyOutToTimeline}
                    assignButtonDisabled={hasRunAssignEo || isRefreshingContainers}
                    isDragDisabled={isTimelineReadOnly || isLoadingDragDrop || isRefreshingContainers}
                    containerMultiSelectState={getContainerMultiSelectState('early_out')}
                    highlightedTaskIds={highlightedEarlyOut}
                  />
                  <PriorityColumn
                    title="HIGH PRIORITY"
                    priority="high"
                    tasks={highPriorityTasks}
                    droppableId="high"
                    icon="alert-circle"
                    assignAction={assignHighPriorityToTimeline}
                    assignButtonDisabled={!timelinePriorityState.hasEoOnTimeline || hasRunAssignHp || isRefreshingContainers}
                    isDragDisabled={isTimelineReadOnly || isLoadingDragDrop || isRefreshingContainers}
                    containerMultiSelectState={getContainerMultiSelectState('high_priority')}
                    highlightedTaskIds={highlightedHighPriority}
                  />
                  <PriorityColumn
                    title="LOW PRIORITY"
                    priority="low"
                    tasks={lowPriorityTasks}
                    droppableId="low"
                    icon="arrow-down"
                    assignAction={assignLowPriorityToTimeline}
                    assignButtonDisabled={!timelinePriorityState.hasEoOnTimeline || !timelinePriorityState.hasHpOnTimeline || hasRunAssignLp || isRefreshingContainers}
                    isDragDisabled={isTimelineReadOnly || isLoadingDragDrop || isRefreshingContainers}
                    containerMultiSelectState={getContainerMultiSelectState('low_priority')}
                    highlightedTaskIds={highlightedLowPriority}
                  />
                </div>
                </div>
              );
            })()}

          <div className="mt-0 grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="xl:col-span-3">
              {/* Timeline View */}
              <div data-print-timeline className="relative">
                <TimelineView
                  personnel={[]}
                  tasks={allTasksWithAssignments}
                  hasUnsavedChanges={hasUnsavedChanges}
                  onTaskMoved={handleTaskMoved}
                  onWaveAssignStateReset={() => {
                    setHasRunAssignEo(false);
                    setHasRunAssignHp(false);
                    setHasRunAssignLp(false);
                  }}
                  isReadOnly={isTimelineReadOnly}
                  isLoadingDragDrop={isLoadingDragDrop || isRefreshingContainers}
                  loadingMessage={
                    isRefreshingContainers
                      ? "Aggiornamento da ADAM in corso…"
                      : undefined
                  }
                  lastValidDragIndex={lastValidDragIndex}
                  draggingOverCleanerId={draggingOverCleanerId}
                  activeDragCleanerId={activeDragCleanerId}
                  searchTask={searchTask}
                  preassignedAnimatedTaskIds={preassignedAnimatedTaskIds}
                />
                <TimelineFloatingPanel
                  side="right"
                  toggleVerticalOffset={52}
                  fitContent
                  isOpen={timelineStatsPanel.isOpen}
                  onOpenChange={timelineStatsPanel.setIsOpen}
                  panel={timelineStatsPanel.panel}
                  onResetPanel={timelineStatsPanel.resetPanel}
                  toggleAriaLabel="Mostra statistiche"
                  toggleTitle="Mostra statistiche"
                  toggleIcon={<BarChart3 className="h-4 w-4" />}
                  dragTitle="Trascina statistiche"
                  closeAriaLabel="Nascondi statistiche"
                  closeTitle="Nascondi statistiche"
                  onPointerDown={timelineStatsPanel.handlePointerDown}
                  onPointerMove={timelineStatsPanel.handlePointerMove}
                  onPointerEnd={timelineStatsPanel.handlePointerEnd}
                >
                  <AssignmentTaskStatisticsPanel
                    variant={isOfficeScope ? "office" : "housekeeping"}
                    stats={assignmentStatistics}
                  />
                </TimelineFloatingPanel>
                <TimelineFloatingPanel
                  side="right"
                  isOpen={timelineMapPanel.isOpen}
                  onOpenChange={timelineMapPanel.setIsOpen}
                  panel={timelineMapPanel.panel}
                  onResetPanel={timelineMapPanel.resetPanel}
                  toggleAriaLabel="Mostra mappa"
                  toggleTitle="Mostra mappa"
                  toggleIcon={<MapIcon className="h-4 w-4" />}
                  dragTitle="Trascina mappa"
                  closeAriaLabel="Nascondi mappa"
                  closeTitle="Nascondi mappa"
                  onPointerDown={timelineMapPanel.handlePointerDown}
                  onPointerMove={timelineMapPanel.handlePointerMove}
                  onPointerEnd={timelineMapPanel.handlePointerEnd}
                  contentClassName="border-custom-blue"
                >
                  <MapSection
                    tasks={allTasksWithAssignments}
                    compact
                    className="h-full"
                    bodyClassName="flex flex-col"
                    mapClassName="h-full flex-1"
                    mapMinHeight={0}
                  />
                </TimelineFloatingPanel>
              </div>
            </div>
          </div>
          {dragSequencePreview && (
            <div className="fixed bottom-4 right-4 z-[9999] bg-slate-900 text-white text-xs px-3 py-2 rounded shadow-lg pointer-events-none">
              <span className="opacity-80 mr-1">Posizione nella sequenza:</span>
              <span className="font-semibold">
                {dragSequencePreview.sequenceIndex}
              </span>
            </div>
          )}
          <DndRemoveZone
            scope="housekeeping"
            visible={isDraggingTimelineTask && !isTimelineReadOnly && !isLoadingDragDrop && !isRefreshingContainers}
            disabled={isTimelineReadOnly || isLoadingDragDrop || isRefreshingContainers}
          />
          <TaskCardDragOverlay
            activeItem={assignmentDnd.activeItem}
            activeDragTask={assignmentDnd.activeDragTask}
            activeRect={assignmentDnd.activeRect}
            tasks={allTasksWithAssignments}
            scope="housekeeping"
          />
        </DndContext>
        </MultiSelectContext.Provider>
        )}

      <AlertDialog open={showAdamRefreshDialog} onOpenChange={setShowAdamRefreshDialog}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Sync from ADAM</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  I containers vengono sempre rigenerati da ADAM e i nuovi task aggiunti nei containers (oltre che aggiornare i dati dei task esistenti come check-in/out, pax,
                  indirizzo, operazione, nuove task, task sparite). Le modifiche WASS
                  non ancora trasferite su ADAM verranno sovrascritte.
                </p>
                <div className="space-y-2 pt-1">
                  <Label className="text-foreground">Cosa sincronizzare</Label>
                  <RadioGroup
                    value={adamRefreshMode}
                    onValueChange={(value) =>
                      setAdamRefreshMode(value as AdamRefreshMode)
                    }
                    className="gap-3"
                  >
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem value="apt" id="refresh-mode-apt" className="mt-1" />
                      <Label htmlFor="refresh-mode-apt" className="font-normal leading-snug">
                        Solo containers e dati appartamento
                      </Label>
                    </div>
                    <div className="flex items-start space-x-2">
                      <RadioGroupItem
                        value="assignments"
                        id="refresh-mode-assignments"
                        className="mt-1"
                      />
                      <Label
                        htmlFor="refresh-mode-assignments"
                        className="font-normal leading-snug"
                      >
                        Anche assegnazioni (cleaner, sequenza, collaborazioni) e ricalcolo
                        orari / travel time
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={isRefreshingContainers}
              className="border-2 border-custom-blue"
            >
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isRefreshingContainers}
              onClick={(e) => {
                e.preventDefault();
                setShowAdamRefreshDialog(false);
                void runAdamContainersRefresh({ mode: adamRefreshMode });
              }}
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Conferma refresh
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={showUnlockConfirmDialog}
        onOpenChange={(open) => {
          setShowUnlockConfirmDialog(open);
          if (!open) setPendingLockedTasks([]);
        }}
      >
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Task bloccate in WASS</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  ADAM richiede di spostare o riassegnare {pendingLockedTasks.length} task
                  attualmente locked. Confermi lo sblocco e l&apos;allineamento?
                </p>
                <ul className="max-h-40 overflow-y-auto rounded border p-2 text-xs text-foreground space-y-1">
                  {pendingLockedTasks.map((task) => (
                    <li key={task.task_id}>
                      #{task.logistic_code ?? task.task_id}
                      {task.locked_reason ? ` — ${task.locked_reason}` : ""}
                      {task.currentCleanerId || task.adamCleanerId
                        ? ` (cleaner ${task.currentCleanerId ?? "—"} → ${task.adamCleanerId ?? "—"})`
                        : ""}
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setIsRefreshingContainers(false)}>
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                setShowUnlockConfirmDialog(false);
                void runAdamContainersRefresh({
                  mode: pendingRefreshMode,
                  confirmUnlockLocked: true,
                  skipContainersRefresh: true,
                });
              }}
            >
              Sblocca e sincronizza
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      </div>
    </div>
  );
}