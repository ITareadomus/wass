import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar as CalendarIcon, RotateCcw, Users, RefreshCw, UserPlus, UserMinus, Maximize2, Minimize2, Check, CheckCircle, Save, Pencil, ChevronLeft, ChevronRight, Loader2, Zap, Lock, Unlock, AlertCircle } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fetchWithOperation } from "@/lib/operationManager";
import { useToast } from "@/hooks/use-toast";
import SortableTaskCard from "@/components/drag-drop/sortable-task-card";
import { FirstApartmentTimeShift } from "@/components/timeline/first-apartment-time-shift-handle";
import { TimelineHorizontalScrollbar } from "@/components/timeline/timeline-horizontal-scrollbar";
import {
  DndDroppableSortableContainer,
  getTaskDndKey,
  taskDndId,
  type AppDndItem,
} from "@/lib/dnd";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocation } from 'wouter';
import { format } from 'date-fns';
import {
  loadValidationRules,
  canCleanerHandleTaskSync,
  isContinuazioneStraordinariaTask,
} from "@/lib/taskValidation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { openTimelineMapPanel } from "@/lib/timeline-map-panel";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
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
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface TimelineViewProps {
  personnel: Personnel[];
  tasks: Task[];
  selectedDate: Date;
  hasUnsavedChanges?: boolean; // Stato delle modifiche non salvate dal parent
  onTaskMoved?: () => void; // Callback quando una task viene spostata
  /** Dopo reset assegnazioni: ripristina stato pulsanti Assegna EO → HP → LP nel parent */
  onWaveAssignStateReset?: () => void;
  isReadOnly?: boolean; // Modalità read-only: disabilita tutte le modifiche
  isLoadingDragDrop?: boolean; // Mostra loading overlay durante drag&drop
  /** Testo overlay quando isLoadingDragDrop è true */
  loadingMessage?: string;
  lastValidDragIndex?: number | null; // Indice valido durante il drag (da container verso timeline)
  draggingOverCleanerId?: number | null; // ID del cleaner su cui si sta trascinando
  activeDragCleanerId?: number | null; // ID del cleaner sorgente durante il drag
  searchTask?: string; // Ricerca task per ID, logistic code, address o customer reference
  preassignedAnimatedTaskIds?: Set<string>;
  isOperationalDayStarted?: boolean;
  onOperationalDayToggle?: (started: boolean) => void;
  isOperationalDaySwitchDisabled?: boolean;
  className?: string;
}

interface Cleaner {
  id: number;
  name: string;
  lastname: string;
  alias?: string;
  role: string;
  active: boolean;
  ranking: number;
  counter_hours: number;
  counter_days: number;
  weekly_hours?: number;
  available: boolean;
  contract_type: string;
  preferred_customers: number[];
  telegram_id: number | null;
  start_time: string | null;
  end_time?: string | null;
  show_plus_one?: boolean;
}

const DEFAULT_TIMELINE_START_MINUTES = 10 * 60;
const DEFAULT_TIMELINE_END_MINUTES = 18 * 60;
const MIN_TIMELINE_TASK_WIDTH_PX = 75;
/** Durante DnD: stessa larghezza minima delle card logistica (slot 15') */
const COMPACT_DRAG_MIN_TIMELINE_TASK_WIDTH_PX = 56;
const FALLBACK_SHORTEST_TASK_MINUTES = 30;
const TIMELINE_END_BUFFER_MINUTES = 60;

const parseTimelineClockToMinutes = (value?: string | null) => {
  if (!value) return null;
  const parts = String(value).split(":");
  if (parts.length < 2) return null;

  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;

  return hours * 60 + minutes;
};

const parseTimelineDurationToMinutes = (duration?: string | number | null) => {
  if (duration === undefined || duration === null) return 0;

  if (typeof duration === "number") {
    return Number.isFinite(duration) ? duration : 0;
  }

  const [hoursPart = "0", minutesPart = "0"] = String(duration).split(".");
  const hours = Number.parseInt(hoursPart, 10);
  const minutes = Number.parseInt(minutesPart, 10);

  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
};

const getTimelineTaskDurationMinutes = (task: any) => {
  const directDuration = Number(task?.cleaning_time ?? task?.cleaningTime);
  if (Number.isFinite(directDuration) && directDuration > 0) {
    return directDuration;
  }

  return parseTimelineDurationToMinutes(task?.duration);
};

const getTimelineTravelMinutes = (task: any) => {
  const travel = Number(task?.travel_time ?? task?.travelTime);
  return Number.isFinite(travel) && travel > 0 ? travel : 0;
};

const roundDownToHour = (minutes: number) => Math.floor(minutes / 60) * 60;
const roundUpToHour = (minutes: number) => Math.ceil(minutes / 60) * 60;

const formatTimelineSlot = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:00`;
};

const ROME_TZ = "Europe/Rome";

type RomeClockNow = {
  dateStr: string;
  minutes: number;
  label: string;
};

function getRomeClockNow(date = new Date()): RomeClockNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: ROME_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  ) as Record<string, string>;

  const hours = Number(parts.hour);
  const mins = Number(parts.minute);
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: hours * 60 + mins,
    label: `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`,
  };
}

function HousekeepingClockNowLine({
  leftPx,
  label,
  showLabel = false,
}: {
  leftPx: number;
  label?: string;
  showLabel?: boolean;
}) {
  return (
    <div
      aria-hidden
      data-testid="housekeeping-timeline-now-line"
      className={cn(
        "pointer-events-none absolute z-40 flex -translate-x-1/2 flex-col items-center print:hidden",
        showLabel ? "top-0 bottom-0" : "inset-y-0"
      )}
      style={{ left: `${leftPx}px` }}
    >
      {showLabel && label ? (
        <span
          className={cn(
            "shrink-0 rounded bg-yellow-400/55 px-1 py-0.5 text-[11px] font-semibold tabular-nums leading-none text-yellow-950/80",
            "dark:bg-yellow-300/45 dark:text-yellow-100/80"
          )}
        >
          {label}
        </span>
      ) : null}
      <div className="w-px min-h-0 flex-1 bg-yellow-400/55 dark:bg-yellow-300/45" />
    </div>
  );
}

type CleanerDirectoryEntry = {
  id: number;
  name?: string;
  lastname?: string;
  alias?: string;
  role?: string;
};

const PREASSIGNED_REASON_NORMAL = "preassigned_enable_wass";
const PREASSIGNED_REASON_READONLY = "preassigned_enable_wass_readonly";

export default function TimelineView({
  personnel,
  tasks,
  selectedDate,
  hasUnsavedChanges = false,
  onTaskMoved,
  onWaveAssignStateReset,
  isReadOnly = false,
  isLoadingDragDrop = false,
  loadingMessage,
  lastValidDragIndex = null,
  draggingOverCleanerId = null,
  activeDragCleanerId = null,
  searchTask = "",
  preassignedAnimatedTaskIds = new Set<string>(),
  isOperationalDayStarted = false,
  onOperationalDayToggle,
  isOperationalDaySwitchDisabled = false,
  className,
}: TimelineViewProps) {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedCleaner, setSelectedCleaner] = useState<Cleaner | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedSwapCleaner, setSelectedSwapCleaner] = useState<string>("");
  const [filteredCleanerId, setFilteredCleanerId] = useState<number | null>(null);
  const [clickTimer, setClickTimer] = useState<NodeJS.Timeout | null>(null);
  const [cleanersAliases, setCleanersAliases] = useState<Record<number, { alias: string; name?: string; lastname?: string }>>({});
  const [cleanersDirectory, setCleanersDirectory] = useState<Record<number, CleanerDirectoryEntry>>({});
  const [isAddCleanerDialogOpen, setIsAddCleanerDialogOpen] = useState(false);
  const [availableCleaners, setAvailableCleaners] = useState<Cleaner[]>([]);
  const [cleanerToReplace, setCleanerToReplace] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showExecutionStatusColors, setShowExecutionStatusColors] = useState(() => {
    try {
      const raw = localStorage.getItem("wass.hk.showExecutionStatusColors");
      if (raw === "0" || raw === "false") return false;
      if (raw === "1" || raw === "true") return true;
    } catch {
      /* ignore */
    }
    return true;
  });
  const timelineRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const [confirmUnavailableDialog, setConfirmUnavailableDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const [confirmRemovalDialog, setConfirmRemovalDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const [incompatibleDialog, setIncompatibleDialog] = useState<{ open: boolean; cleanerId: number | null; tasks: Array<{ logisticCode: string; taskType: string }> }>({ open: false, cleanerId: null, tasks: [] });
  const [startTimeDialog, setStartTimeDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string; isAvailable: boolean }>({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
  const [pendingStartTime, setPendingStartTime] = useState<string>("10:00");
  const [pendingCleaner, setPendingCleaner] = useState<any>(null); // Added to track pending cleaner ID
  const [showAdamTransferDialog, setShowAdamTransferDialog] = useState(false); // Stato per il dialog di trasferimento ADAM
  const [showResetDialog, setShowResetDialog] = useState(false); // Stato per il dialog di reset assegnazioni
  const [lastAdamTransfer, setLastAdamTransfer] = useState<string | null>(null); // Timestamp ultimo trasferimento ADAM
  const [lockedCleaners, setLockedCleaners] = useState<Set<number>>(new Set()); // Set degli ID dei cleaner bloccati

  const displayInputClass =
   "h-9 border-transparent bg-transparent shadow-none focus-visible:ring-0 px-0 pointer-events-none select-none";

  const displayClickableInputClass =
   "h-9 border-transparent bg-transparent shadow-none focus-visible:ring-0 px-0";

  // Cleaner name box variants:
  // - left-bar: thin colored stripe
  // - left-tag: colored left block
  const CLEANER_BOX_VARIANT: "left-bar" | "left-tag" = "left-bar";

  // Calcola gli highlightedTaskIds per la ricerca
  const highlightedTaskIds = (() => {
    if (!searchTask.trim()) return new Set<string>();
    const lowerSearch = searchTask.toLowerCase();
    return new Set(tasks
      .filter(task => {
        const taskId = String((task as any).id || (task as any).task_id || '');
        const logisticCode = String((task as any).logisticCode || (task as any).logistic_code || (task as any).name || '');
        const address = String((task as any).address || '');
        const customerName = String((task as any).customer_name || (task as any).customerName || '');
        const customerAlias = String((task as any).alias || (task as any).customer_alias || '');
        const customerReference = String(
          (task as any).customer_reference ||
          (task as any).customerReference ||
          ''
        );
        
        return (
          taskId.toLowerCase().includes(lowerSearch) ||
          logisticCode.toLowerCase().includes(lowerSearch) ||
          address.toLowerCase().includes(lowerSearch) ||
          customerName.toLowerCase().includes(lowerSearch) ||
          customerAlias.toLowerCase().includes(lowerSearch) ||
          customerReference.toLowerCase().includes(lowerSearch)
        );
      })
      .map(t => String((t as any).id || (t as any).task_id || '')));
  })();
  const effectiveHighlightedTaskIds = React.useMemo(() => {
    return new Set<string>(highlightedTaskIds);
  }, [highlightedTaskIds]);

  // Stato per tracciare acknowledge per coppie (task, cleaner)
  type IncompatibleKey = string; // chiave del tipo `${taskId}-${cleanerId}`
  const [acknowledgedIncompatibleAssignments, setAcknowledgedIncompatibleAssignments] = useState<Set<IncompatibleKey>>(new Set());

  // Helper per costruire la chiave univoca task-cleaner
  const getIncompatibleKey = (task: any, cleanerId: number): IncompatibleKey => {
    const taskId = task.task_id ?? task.id ?? task.logisticCode;
    return `${taskId}-${cleanerId}`;
  };

  const resolvePreassignedMode = (task: any): "readonly" | "normal" | null => {
    const explicitMode = String(task?.preAssignedMode ?? "").trim().toLowerCase();
    if (explicitMode === "readonly") return "readonly";
    if (explicitMode === "normal") return "normal";
    const reasons = Array.isArray(task?.reasons) ? task.reasons : [];
    if (reasons.some((reason: unknown) => String(reason ?? "").trim() === PREASSIGNED_REASON_READONLY)) {
      return "readonly";
    }
    if (reasons.some((reason: unknown) => String(reason ?? "").trim() === PREASSIGNED_REASON_NORMAL)) {
      return "normal";
    }
    return null;
  };

  const isReadonlyPreassignedTask = (task: any): boolean => {
    return resolvePreassignedMode(task) === "readonly";
  };

  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const isOfficeScope =
    (typeof window !== "undefined" &&
      (() => {
        const params = new URLSearchParams(window.location.search);
        return (
          params.get("scope") === "office" ||
          params.get("kind") === "office" ||
          localStorage.getItem("assignments_scope") === "office"
        );
      })()) ||
    false;
  const scopeValue = isOfficeScope ? "office" : "housekeeping";
  const withScope = (url: string) => `${url}${url.includes("?") ? "&" : "?"}scope=${scopeValue}`;
  const [editingAlias, setEditingAlias] = useState<string>("");
  const [isSavingAlias, setIsSavingAlias] = useState(false);
  const [isSavingCleanerLock, setIsSavingCleanerLock] = useState(false);
  const [isLoadingAvailableCleaners, setIsLoadingAvailableCleaners] = useState(false);
  const [aliasDialog, setAliasDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string }>({ open: false, cleanerId: null, cleanerName: '' });
  const [editingStartTime, setEditingStartTime] = useState<string>("10:00");
  const [startTimeEditDialog, setStartTimeEditDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string }>({ open: false, cleanerId: null, cleanerName: '' });
  const [isSavingStartTime, setIsSavingStartTime] = useState(false);
  const [editingEndTime, setEditingEndTime] = useState<string>("20:00");
  const [endTimeEditDialog, setEndTimeEditDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string }>({ open: false, cleanerId: null, cleanerName: '' });
  const [isSavingEndTime, setIsSavingEndTime] = useState(false);
  const [firstAptTimeShiftPreview, setFirstAptTimeShiftPreview] = useState<{
    cleanerId: number;
    startMinutes: number;
  } | null>(null);
  const [isSavingFirstAptTime, setIsSavingFirstAptTime] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isTransferringToAdam, setIsTransferringToAdam] = useState(false);
  const [showOptimizerDialog, setShowOptimizerDialog] = useState(false);
  const [isRunningOptimizer, setIsRunningOptimizer] = useState(false);
  const [optimizerResult, setOptimizerResult] = useState<any>(null);
  const [showRemoveCleanersDialog, setShowRemoveCleanersDialog] = useState(false);
  const [cleanerIdsToRemove, setCleanerIdsToRemove] = useState<number[]>([]);

  // Stato per le regole di validazione task-cleaner
  const [validationRules, setValidationRules] = useState<any>(null);

  // Ref per tracciare i toast già mostrati (previene duplicati)
  const shownToastsRef = useRef<Set<string>>(new Set());

  // Unica fonte della data: lo stato della pagina padre.
  const workDate = format(selectedDate, 'yyyy-MM-dd');

  // Carica le regole di validazione una sola volta all'init
  useEffect(() => {
    loadValidationRules().then(rules => {
      setValidationRules(rules);
    }).catch(err => {
      console.error('Failed to load validation rules:', err);
      setValidationRules(null); // Fallback permissive
    });
  }, []);

  // EO/HP/LP brackets derived from the hp-centric priority settings.
  type PriorityWindows = {
    hpStart: string;
    hpEnd: string;
  };
  
  const [priorityWindows, setPriorityWindows] = useState<PriorityWindows | null>(null);
  
  useEffect(() => {
    const loadPriorityWindows = async () => {
      try {
        const res = await fetch("/api/settings", {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!res.ok) return;
  
        const s = await res.json();
  
        const hpStart = s?.["high-priority"]?.hp_start_time;
        const hpEnd = s?.["high-priority"]?.hp_end_time;

        if (hpStart && hpEnd) {
          setPriorityWindows({ hpStart, hpEnd });
        }
      } catch (e) {
        console.warn("Failed to load /api/settings for priority windows", e);
      }
    };
  
    loadPriorityWindows();
  }, []);

  // Carica timestamp ultimo trasferimento ADAM quando cambia la data
  useEffect(() => {
    const fetchLastTransfer = async () => {
      try {
        const response = await fetch(withScope(`/api/last-adam-transfer?date=${workDate}`));
        const data = await response.json();
        if (data.success && data.lastTransfer) {
          setLastAdamTransfer(data.lastTransfer);
        } else {
          setLastAdamTransfer(null);
        }
      } catch (error) {
        console.error('Error fetching last ADAM transfer:', error);
        setLastAdamTransfer(null);
      }
    };
    fetchLastTransfer();
  }, [workDate, scopeValue]);

  const loadCleanerLocks = async () => {
    try {
      const response = await fetch(`/api/cleaner-locks?date=${workDate}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const data = await response.json();
      if (data?.success && Array.isArray(data.lockedCleanerIds)) {
        setLockedCleaners(new Set<number>(data.lockedCleanerIds.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))));
      } else {
        // fallback safe: nessun lock
        setLockedCleaners(new Set<number>());
      }
    } catch (error) {
      console.error('Error fetching cleaner locks:', error);
      setLockedCleaners(new Set<number>());
    }
  };

  // Stato per memorizzare i dati della timeline (inclusi i metadata)
  const [timelineData, setTimelineData] = useState<any>(null);

  // Larghezza della timeline in pixel per calcolo larghezze task
  const [timelineWidthPx, setTimelineWidthPx] = useState<number>(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [romeClockNow, setRomeClockNow] = useState<RomeClockNow>(() => getRomeClockNow());
  const timelineRowRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRefs = useRef<HTMLDivElement[]>([]);
  const isSyncingTimelineScrollRef = useRef(false);
  // Evita di riaprire "Aggiungi Cleaner" quando Start Time si chiude dopo una conferma
  const skipReopenAddCleanerOnStartTimeCloseRef = useRef(false);
  const timelineScrollDragRef = useRef<{
    scrollContainer: HTMLDivElement;
    pointerId: number;
    startX: number;
    startScrollLeft: number;
  } | null>(null);

  // Carica anche i cleaner dalla timeline.json per mostrare quelli nascosti
  // DEVE essere definito PRIMA di allCleanersToShow che lo usa
  const [timelineCleaners, setTimelineCleaners] = useState<any[]>([]);

  const registerTimelineScrollRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node && !timelineScrollRefs.current.includes(node)) {
      timelineScrollRefs.current.push(node);
    }
  }, []);

  const handleTimelineScroll = React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
    if (isSyncingTimelineScrollRef.current) return;

    const source = event.currentTarget;
    setTimelineScrollLeft(source.scrollLeft);
    isSyncingTimelineScrollRef.current = true;
    timelineScrollRefs.current = timelineScrollRefs.current.filter((node) => node.isConnected);
    timelineScrollRefs.current.forEach((node) => {
      if (node !== source) {
        node.scrollLeft = source.scrollLeft;
      }
    });
    requestAnimationFrame(() => {
      isSyncingTimelineScrollRef.current = false;
    });
  }, []);

  const canStartTimelinePan = React.useCallback((target: EventTarget | null) => {
    const element = target instanceof HTMLElement ? target : null;
    if (!element) return false;

    return !element.closest(
      '[data-rbd-draggable-id], [data-rbd-drag-handle-draggable-id], button, input, textarea, select, a, [role="button"], [data-first-apt-time-shift]'
    );
  }, []);

  const handleTimelinePointerDown = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const scrollContainer = event.currentTarget;
    // I contenuti in portal (dialog, select, popover) bollono nell'albero React ma
    // vivono fuori dal container nel DOM: senza questo check il pan catturava il
    // puntatore e rompeva la selezione (es. orari check-out).
    if (!(event.target instanceof Node) || !scrollContainer.contains(event.target)) return;
    if (event.button !== 0 || !canStartTimelinePan(event.target)) return;
    if (scrollContainer.scrollWidth <= scrollContainer.clientWidth) return;

    timelineScrollDragRef.current = {
      scrollContainer,
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: scrollContainer.scrollLeft,
    };
    scrollContainer.setPointerCapture(event.pointerId);
    scrollContainer.classList.add("is-panning");
    event.preventDefault();
  }, [canStartTimelinePan]);

  const handleTimelinePointerMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = timelineScrollDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    dragState.scrollContainer.scrollLeft = dragState.startScrollLeft - (event.clientX - dragState.startX);
    event.preventDefault();
  }, []);

  const stopTimelinePan = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = timelineScrollDragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    dragState.scrollContainer.releasePointerCapture(event.pointerId);
    dragState.scrollContainer.classList.remove("is-panning");
    timelineScrollDragRef.current = null;
  }, []);
  const normalizeCleanerRole = (rawRole: string | undefined | null) => {
    const role = String(rawRole ?? "").trim();
    if (!role) return "";
    const lowered = role.toLowerCase();
    if (lowered.includes("ufficio") || lowered.includes("office")) {
      return "Ufficio";
    }
    return role;
  };

  const isOfficeCleanerRole = (rawRole: string | undefined | null) => {
    return normalizeCleanerRole(rawRole) === "Ufficio";
  };

  const getCleanerDisplayDataByRaw = (cleanerLike: any, cleanerId: number) => {
    const isIdLikeName = (value: string | undefined | null) => {
      const normalized = String(value ?? "").trim();
      if (!normalized) return false;
      return normalized.toUpperCase() === `ID ${cleanerId}` || /^ID\s+\d+$/i.test(normalized);
    };

    const aliasEntry = cleanersAliases[cleanerId];
    const directoryEntry = cleanersDirectory[cleanerId];

    const cleanerAlias = typeof cleanerLike?.alias === "string" ? cleanerLike.alias.trim() : "";
    const alias = String(aliasEntry?.alias || cleanerAlias || directoryEntry?.alias || "").trim();

    const rawName = String(cleanerLike?.name ?? "").trim();
    const rawLastname = String(cleanerLike?.lastname ?? "").trim();

    const name = isIdLikeName(rawName) ? "" : rawName;
    const lastname = rawLastname || aliasEntry?.lastname || directoryEntry?.lastname || "";
    const fallbackName = aliasEntry?.name || directoryEntry?.name || "";
    const resolvedName = name || fallbackName;
    const fullName = `${resolvedName} ${lastname}`.trim();
    const role = normalizeCleanerRole(cleanerLike?.role || directoryEntry?.role);
    const primaryLabel = alias || fullName || `ID ${cleanerId}`;

    return {
      alias,
      name: resolvedName,
      lastname,
      fullName,
      role,
      primaryLabel,
    };
  };

  // Mostra cleaners da selected_cleaners API + cleaners che hanno task in timeline
  // DEVE essere definito PRIMA di getGlobalStartTime() che lo usa
  const allCleanersToShow = React.useMemo(() => {
    const selectedCleanerIds = new Set(cleaners.map(c => c.id));
    const timelineCleanersWithTasks = timelineCleaners
      .filter(tc => tc.tasks && tc.tasks.length > 0) // Solo cleaners con task
      .filter(tc => !selectedCleanerIds.has(tc.cleaner?.id)) // Non già in selected_cleaners
      .map(tc => ({ ...tc.cleaner, isRemoved: true })); // Marca come rimosso

    // Combina selected_cleaners + timeline cleaners con task
    const combined = [...cleaners, ...timelineCleanersWithTasks];

    // Ordina per start_time crescente (dal minore al maggiore)
    combined.sort((a, b) => {
      const timeA = a.start_time || "10:00";
      const timeB = b.start_time || "10:00";
      return timeA.localeCompare(timeB);
    });

    if (!isOperationalDayStarted) return combined;

    const assignedIds = new Set<number>();
    for (const entry of timelineCleaners || []) {
      if (!Array.isArray(entry?.tasks) || entry.tasks.length === 0) continue;
      const id = Number(entry?.cleaner?.id);
      if (Number.isFinite(id) && id > 0) assignedIds.add(id);
    }
    // Parent `tasks` is the live source after silent ADAM sync: include it so
    // cleaner rows appear/disappear immediately without a page reload.
    for (const task of tasks || []) {
      const id = Number((task as any)?.assignedCleaner ?? (task as any)?.cleanerId);
      if (Number.isFinite(id) && id > 0) assignedIds.add(id);
    }
    // A giornata ON i convocati restano visibili (anche senza task) così si possono
    // ancora aggiungere/rimuovere cleaner; nascondi solo chi non è più in selezione
    // e non ha assegnazioni.
    return combined.filter(
      (cleaner) =>
        selectedCleanerIds.has(Number(cleaner.id)) || assignedIds.has(Number(cleaner.id))
    );
  }, [cleaners, timelineCleaners, isOperationalDayStarted, tasks]);

  const visibleCleanerIds = React.useMemo(
    () => new Set(allCleanersToShow.map(cleaner => Number(cleaner.id))),
    [allCleanersToShow]
  );

  const timelineAssignedTasks = React.useMemo(
    () => tasks.filter(task => visibleCleanerIds.has(Number((task as any).assignedCleaner))),
    [tasks, visibleCleanerIds]
  );
  const cleanerDirectoryIds = React.useMemo(() => {
    const ids = new Set<number>();
    for (const cleaner of cleaners) {
      const id = Number((cleaner as any)?.id);
      if (Number.isFinite(id)) ids.add(id);
    }
    for (const entry of timelineCleaners || []) {
      const id = Number(entry?.cleaner?.id);
      if (Number.isFinite(id)) ids.add(id);
    }
    for (const task of tasks || []) {
      const assignedRaw = (task as any)?.assignedCleaner ?? (task as any)?.cleanerId;
      const id = Number(assignedRaw);
      if (Number.isFinite(id)) ids.add(id);
    }
    return Array.from(ids).sort((a, b) => a - b);
  }, [cleaners, timelineCleaners, tasks]);

  const cleanerDirectoryIdsKey = cleanerDirectoryIds.join(",");

  // Crea Set di ID cleaner rimossi per facile lookup
  const removedCleanerIds = React.useMemo(() => {
    const selectedIds = new Set(cleaners.map(c => c.id));
    return new Set(
      timelineCleaners
        .filter(tc =>
          Array.isArray(tc.tasks) &&
          tc.tasks.some((task: any) => !isReadonlyPreassignedTask(task)) &&
          !selectedIds.has(tc.cleaner?.id)
        )
        .map(tc => tc.cleaner?.id)
    );
  }, [cleaners, timelineCleaners]);



  // Mutation per rimuovere un cleaner da selected_cleaners
  const removeCleanerMutation = useMutation({
    mutationFn: async (cleanerId: number) => {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await apiRequest("POST", "/api/remove-cleaner-from-selected", {
        cleanerId,
        date: workDate,
        scope: scopeValue,
        modified_by: currentUser.username || 'unknown'
      });
      return await response.json();
    },
    onSuccess: async (data) => {
      // CRITICAL: Marca modifiche SOLO dopo azioni utente
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
      if (onTaskMoved) {
        onTaskMoved();
      }

      // CRITICAL: Ricarica PRIMA la timeline per vedere i cleaners con task
      await loadTimelineCleaners();
      // Aggiorna i dati della timeline per mostrare i metadata aggiornati
      await loadTimelineData();

      // POI ricarica selected_cleaners
      await loadCleaners();

      const message = data.removedFromTimeline
        ? data.readonlyTasksRemoved > 0
          ? `${selectedCleaner?.name} ${selectedCleaner?.lastname} è stato rimosso completamente insieme alle task read-only.`
          : `${selectedCleaner?.name} ${selectedCleaner?.lastname} è stato rimosso completamente (nessuna task).`
        : `${selectedCleaner?.name} ${selectedCleaner?.lastname} è stato rimosso dalla selezione. Le sue task modificabili rimangono in timeline.`;

      toast({
        title: "Cleaner rimosso",
        description: message,
        variant: "success",
      });
      setIsModalOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile rimuovere il cleaner",
        variant: "destructive",
      });
    },
  });

  // Mutation per rimuovere uno o più cleaners convocati (stessa API della scheda cleaner)
  const removeSelectedCleanersMutation = useMutation({
    mutationFn: async (cleanerIds: number[]) => {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const results: Array<{
        cleanerId: number;
        success: boolean;
        removedFromTimeline?: boolean;
        readonlyTasksRemoved?: number;
        error?: string;
      }> = [];
      for (const cleanerId of cleanerIds) {
        try {
          const response = await apiRequest("POST", "/api/remove-cleaner-from-selected", {
            cleanerId,
            date: workDate,
            scope: scopeValue,
            modified_by: currentUser.username || 'unknown'
          });
          const data = await response.json();
          results.push({
            cleanerId,
            success: Boolean(data?.success),
            removedFromTimeline: data?.removedFromTimeline,
            readonlyTasksRemoved: data?.readonlyTasksRemoved,
            error: data?.error || data?.message,
          });
        } catch (error: any) {
          results.push({
            cleanerId,
            success: false,
            error: error?.message || "Impossibile rimuovere il cleaner",
          });
        }
      }
      return results;
    },
    onSuccess: async (results) => {
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
      if (onTaskMoved) {
        onTaskMoved();
      }

      await Promise.all([
        loadTimelineCleaners(),
        loadTimelineData(),
        loadCleaners(true),
      ]);

      const ok = results.filter((r) => r.success);
      const failed = results.filter((r) => !r.success);
      const keptOnTimeline = ok.filter((r) => !r.removedFromTimeline).length;
      const fullyRemoved = ok.filter((r) => r.removedFromTimeline).length;

      if (ok.length > 0) {
        toast({
          title: ok.length === 1 ? "Cleaner rimosso" : "Cleaners rimossi",
          description:
            `${ok.length} ${ok.length === 1 ? "cleaner rimosso" : "cleaners rimossi"} dalla convocazione.` +
            (keptOnTimeline > 0
              ? ` ${keptOnTimeline} ${keptOnTimeline === 1 ? "resta" : "restano"} in timeline con le task modificabili.`
              : "") +
            (fullyRemoved > 0
              ? ` ${fullyRemoved} ${fullyRemoved === 1 ? "è stato rimosso" : "sono stati rimossi"} completamente (nessuna task modificabile).`
              : ""),
          variant: "success",
        });
      }
      if (failed.length > 0) {
        toast({
          title: "Errore",
          description: `Impossibile rimuovere ${failed.length} cleaner.`,
          variant: "destructive",
        });
      }

      setShowRemoveCleanersDialog(false);
      setCleanerIdsToRemove([]);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile rimuovere i cleaners convocati",
        variant: "destructive",
      });
    },
  });

  const isTimelineInteractionDisabled =
    isReadOnly ||
    isLoadingDragDrop ||
    removeCleanerMutation.isPending ||
    removeSelectedCleanersMutation.isPending;

  // In sola visualizzazione (data storica o giornata operativa iniziata) anche il roster è bloccato.
  const isRosterEditDisabled = isReadOnly;
  const rosterEditDisabledTitle = isOperationalDayStarted
    ? "Giornata operativa iniziata: modalità sola visualizzazione"
    : "Non disponibile in modalità storico (data passata)";

  // Mutation per aggiungere un cleaner alla timeline
  const addCleanerMutation = useMutation({
    mutationFn: async (cleanerId: number) => {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await apiRequest("POST", "/api/add-cleaner-to-timeline", {
        cleanerId,
        date: workDate,
        scope: scopeValue,
        modified_by: currentUser.username || 'unknown'
      });
      return await response.json();
    },
    onSuccess: async (data, cleanerId) => {
      if (onTaskMoved) {
        onTaskMoved();
      }

      // Con il sistema per coppie (task, cleaner), non serve invalidare nulla:
      // le nuove coppie non sono ackate di default

      // Ricarica ENTRAMBI i file per sincronizzare la vista
      await Promise.all([
        loadCleaners(),
        loadTimelineCleaners()
      ]);
      // Aggiorna i dati della timeline per mostrare i metadata aggiornati
      await loadTimelineData();

      // Ricarica anche le task se necessario
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks(true);
      }

      // IMPORTANTE: ricarica timeline PRIMA di ricalcolare gli available
      // Questo previene race conditions tra cache e stato locale
      await new Promise(resolve => setTimeout(resolve, 100)); // Small delay per sync

      // Trova il cleaner appena aggiunto per mostrare nome e cognome
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const cleanersResponse = await fetch(withScope(`/api/selected-cleaners?date=${dateStr}`), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const cleanersData = await cleanersResponse.json();
      const addedCleaner = cleanersData.cleaners.find((c: any) => c.id === cleanerId);
      const cleanerName = addedCleaner ? `${addedCleaner.name} ${addedCleaner.lastname}` : `ID ${cleanerId}`;

      toast({
        title: "Cleaner aggiunto",
        description: `${cleanerName} è stato aggiunto alla selezione`,
        variant: "success",
      });
      setIsAddCleanerDialogOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile aggiungere il cleaner alla timeline",
        variant: "destructive",
      });
    },
  });

  // Mutation per scambiare task tra cleaners
  const swapCleanersMutation = useMutation({
    mutationFn: async ({ sourceCleanerId, destCleanerId }: { sourceCleanerId: number; destCleanerId: number }) => {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await apiRequest("POST", "/api/swap-cleaners-tasks", {
        sourceCleanerId,
        destCleanerId,
        date: workDate,
        modified_by: currentUser.username || 'unknown',
        scope: scopeValue,
      });
      return await response.json();
    },
    onSuccess: async (data, variables) => {
      if (onTaskMoved) {
        onTaskMoved();
      }

      // Ricarica i task per mostrare immediatamente lo swap
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
      await loadTimelineCleaners();
      await loadCleaners();
      // Aggiorna i dati della timeline per mostrare i metadata aggiornati
      await loadTimelineData();

      // Trova i nomi dei cleaner coinvolti
      const sourceCleaner = cleaners.find(c => c.id === variables.sourceCleanerId);
      const destCleaner = cleaners.find(c => c.id === variables.destCleanerId);

      const sourceCleanerName = sourceCleaner ? `${sourceCleaner.name} ${sourceCleaner.lastname}` : `ID ${variables.sourceCleanerId}`;
      const destCleanerName = destCleaner ? `${destCleaner.name} ${destCleaner.lastname}` : `ID ${variables.destCleanerId}`;

      toast({
        title: "Successo",
        description: `Task di ${sourceCleanerName} scambiate con successo con le task di ${destCleanerName}`,
        variant: "success",
      });
      setSelectedSwapCleaner("");
      setIsModalOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Errore nello scambio delle task",
        variant: "destructive",
      });
    },
  });

  const handleSwapCleaners = () => {
    if (!selectedSwapCleaner || !selectedCleaner) return;

    const destCleanerId = parseInt(selectedSwapCleaner, 10);

    swapCleanersMutation.mutate({
      sourceCleanerId: selectedCleaner.id,
      destCleanerId: destCleanerId,
    });
  };

  // Trova lo start time minimo tra tutti i cleaner e arrotonda la griglia all'ora intera.
  const getGlobalStartTime = () => {
    if (allCleanersToShow.length === 0) return formatTimelineSlot(DEFAULT_TIMELINE_START_MINUTES);

    const cleanerStartMinutes = allCleanersToShow
      .map(c => parseTimelineClockToMinutes(c.start_time) ?? DEFAULT_TIMELINE_START_MINUTES);
    const startMinutes = cleanerStartMinutes.length > 0
      ? Math.min(...cleanerStartMinutes)
      : DEFAULT_TIMELINE_START_MINUTES;

    return formatTimelineSlot(roundDownToHour(startMinutes));
  };

  const globalStartTime = getGlobalStartTime();
  const timelineStartMinutes = parseTimelineClockToMinutes(globalStartTime) ?? DEFAULT_TIMELINE_START_MINUTES;

  const shortestTaskMinutes = React.useMemo(() => {
    const validDurations = timelineAssignedTasks
      .map(task => getTimelineTaskDurationMinutes(task as any))
      .filter(duration => Number.isFinite(duration) && duration > 0);

    return validDurations.length > 0
      ? Math.min(...validDurations)
      : FALLBACK_SHORTEST_TASK_MINUTES;
  }, [timelineAssignedTasks]);

  const minimumTimelinePxPerMinute = MIN_TIMELINE_TASK_WIDTH_PX / shortestTaskMinutes;

  const timelineEndMinutes = React.useMemo(() => {
    const cleanerStartById = new Map<number, number>();
    for (const cleaner of allCleanersToShow) {
      cleanerStartById.set(
        Number(cleaner.id),
        parseTimelineClockToMinutes(cleaner.start_time) ?? timelineStartMinutes
      );
    }

    const endCandidates: number[] = [];

    for (const task of timelineAssignedTasks) {
      const taskObj = task as any;
      const duration = getTimelineTaskDurationMinutes(taskObj);
      if (!Number.isFinite(duration) || duration <= 0) continue;

      const startMinutes = parseTimelineClockToMinutes(
        taskObj.start_time || taskObj.fw_start_time || taskObj.startTime
      );
      const endMinutes = parseTimelineClockToMinutes(taskObj.end_time || taskObj.endTime);

      if (endMinutes !== null) {
        endCandidates.push(endMinutes);
      } else if (startMinutes !== null) {
        endCandidates.push(startMinutes + duration);
      }
    }

    const tasksByCleaner = new Map<number, any[]>();
    for (const task of timelineAssignedTasks) {
      const cleanerId = Number((task as any).assignedCleaner);
      if (!Number.isFinite(cleanerId)) continue;
      const cleanerTasks = tasksByCleaner.get(cleanerId) ?? [];
      cleanerTasks.push(task as any);
      tasksByCleaner.set(cleanerId, cleanerTasks);
    }

    for (const [cleanerId, cleanerTasks] of tasksByCleaner) {
      let cursor = cleanerStartById.get(cleanerId) ?? timelineStartMinutes;

      const sortedTasks = [...cleanerTasks].sort((a, b) => {
        const seqA = Number(a.sequence);
        const seqB = Number(b.sequence);
        if (Number.isFinite(seqA) && Number.isFinite(seqB)) return seqA - seqB;

        const timeA = parseTimelineClockToMinutes(a.start_time || a.fw_start_time || a.startTime) ?? cursor;
        const timeB = parseTimelineClockToMinutes(b.start_time || b.fw_start_time || b.startTime) ?? cursor;
        return timeA - timeB;
      });

      sortedTasks.forEach((taskObj, index) => {
        const duration = getTimelineTaskDurationMinutes(taskObj);
        if (!Number.isFinite(duration) || duration <= 0) return;

        const explicitStart = parseTimelineClockToMinutes(
          taskObj.start_time || taskObj.fw_start_time || taskObj.startTime
        );

        if (explicitStart !== null) {
          cursor = Math.max(cursor, explicitStart);
        } else if (index > 0) {
          cursor += getTimelineTravelMinutes(taskObj);
        }

        cursor += duration;
        endCandidates.push(cursor);
      });
    }

    if (endCandidates.length === 0) return DEFAULT_TIMELINE_END_MINUTES;

    const latestEnd = Math.max(...endCandidates);
    // Dinamico sui task, ma almeno fino alle 18:00.
    return Math.max(
      DEFAULT_TIMELINE_END_MINUTES,
      timelineStartMinutes + 60,
      roundUpToHour(latestEnd + TIMELINE_END_BUFFER_MINUTES)
    );
  }, [allCleanersToShow, timelineAssignedTasks, timelineStartMinutes]);

  // Genera time slots globali basati sul range visibile dinamico.
  const generateGlobalTimeSlots = () => {
    const slots: string[] = [];
    const slotsCount = Math.max(1, Math.ceil((timelineEndMinutes - timelineStartMinutes) / 60));

    for (let idx = 0; idx < slotsCount; idx++) {
      slots.push(formatTimelineSlot(timelineStartMinutes + idx * 60));
    }

    return slots;
  };

  const getGlobalTimelineMinutes = () => Math.max(60, timelineEndMinutes - timelineStartMinutes);

  // Genera gli slot una volta sola
  const globalTimeSlots = generateGlobalTimeSlots();
  const globalTimelineMinutes = getGlobalTimelineMinutes();
  const minimumTimelineContentWidthPx = globalTimelineMinutes * minimumTimelinePxPerMinute;
  const timelineContentWidthPx = Math.max(
    timelineWidthPx,
    minimumTimelineContentWidthPx
  );
  const timelinePxPerMinute = timelineContentWidthPx / globalTimelineMinutes;
  const timelineScaledWidth = timelineContentWidthPx > 0 ? `${timelineContentWidthPx}px` : "100%";
  const timelineTaskWidthPx = timelineContentWidthPx;

  useEffect(() => {
    const tick = () => setRomeClockNow(getRomeClockNow());
    tick();
    const id = window.setInterval(tick, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const clockNowLineLeftPx = React.useMemo(() => {
    // In sviluppo: mostra la linea su qualsiasi data (utile per test).
    // In produzione: solo se la data selezionata è oggi (Europe/Rome).
    if (!import.meta.env.DEV && romeClockNow.dateStr !== workDate) return null;
    if (timelinePxPerMinute <= 0) return null;
    if (
      romeClockNow.minutes < timelineStartMinutes ||
      romeClockNow.minutes > timelineEndMinutes
    ) {
      return null;
    }
    return (romeClockNow.minutes - timelineStartMinutes) * timelinePxPerMinute;
  }, [
    romeClockNow.dateStr,
    romeClockNow.minutes,
    timelineEndMinutes,
    timelinePxPerMinute,
    timelineStartMinutes,
    workDate,
  ]);


// Helpers to render EO/HP/LP brackets above the time header
const timeToMinutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

const getTimelineStartMinutes = () => {
  // The grid starts from the first global slot, always HH:00
  const first = globalTimeSlots?.[0] ?? "10:00";
  return timeToMinutes(first);
};

const getTimelineEndMinutes = () => timelineEndMinutes;

const minutesToPct = (absoluteMinutes: number) => {
  const timelineStart = getTimelineStartMinutes();
  const timelineEnd = getTimelineEndMinutes();
  const total = timelineEnd - timelineStart;
  if (total <= 0) return 0;

  return ((absoluteMinutes - timelineStart) / total) * 100;
};

const buildBracePath = (x1: number, x2: number, yTop = 4, yBottom = 20) => {
  const w = Math.max(0.0001, x2 - x1);
  const curl = Math.min(4, w / 10);
  const xm = (x1 + x2) / 2;

  return [
    `M ${x1} ${yTop}`,
    `C ${x1} ${yTop}, ${x1} ${yTop + 6}, ${x1 + curl} ${yTop + 7}`,
    `C ${x1 + curl * 2} ${yTop + 8}, ${x1 + curl * 2} ${yBottom - 6}, ${xm} ${yBottom}`,
    `C ${x2 - curl * 2} ${yBottom - 6}, ${x2 - curl * 2} ${yTop + 8}, ${x2 - curl} ${yTop + 7}`,
    `C ${x2} ${yTop + 6}, ${x2} ${yTop}, ${x2} ${yTop}`,
  ].join(" ");
};

  // Esponi globalTimelineMinutes e globalTimeSlotsCount come variabili globali per permettere a TaskCard di usarle
  // IMPORTANTE: La griglia usa N slot, ma rappresenta N-1 intervalli. Per far corrispondere
  // la larghezza dei task alle colonne della griglia, usiamo N slot * 60 minuti come base.
  React.useEffect(() => {
    (window as any).globalTimelineMinutes = globalTimelineMinutes;
    (window as any).globalTimeSlotsCount = globalTimeSlots.length;
    (window as any).timelinePxPerMinute = timelinePxPerMinute;
    (window as any).minTimelineTaskWidthPx = MIN_TIMELINE_TASK_WIDTH_PX;
  }, [globalTimelineMinutes, globalTimeSlots.length, timelinePxPerMinute]);

  // Misura la larghezza della timeline row per TaskCard (state React → rerender)
  React.useEffect(() => {
    let resizeObserver: ResizeObserver | null = null;
    let attachTimer: ReturnType<typeof setTimeout> | null = null;

    const measureWidth = () => {
      if (timelineRowRef.current) {
        setTimelineWidthPx(timelineRowRef.current.offsetWidth);
      }
    };

    const attach = () => {
      const node = timelineRowRef.current;
      if (!node) return false;

      measureWidth();
      resizeObserver = new ResizeObserver(measureWidth);
      resizeObserver.observe(node);
      return true;
    };

    if (!attach()) {
      attachTimer = setTimeout(attach, 100);
    }

    window.addEventListener("resize", measureWidth);

    return () => {
      resizeObserver?.disconnect();
      if (attachTimer) clearTimeout(attachTimer);
      window.removeEventListener("resize", measureWidth);
    };
  }, [cleaners, isFullscreen, globalTimeSlots.length]);

  // Esponi gli start_time dei cleaner alla pagina per optimistic UI nel DnD
  // Quando droppi su un cleaner "vuoto", l'optimistic UI deve sapere da che ora parte
  React.useEffect(() => {
    const startTimeMap: Record<string, string> = {};
    for (const cleaner of allCleanersToShow) {
      const cleanerId = String(cleaner.id);
      startTimeMap[cleanerId] = cleaner.start_time || "10:00";
    }
    (window as any).__timelineCleanerStartTimes = startTimeMap;
  }, [allCleanersToShow]);

  const getCleanerColor = (cleanerId: number) => {
    // Colori distribuiti per massimo contrasto visivo
    const colors = [
      "#EF4444", "#3B82F6", "#22C55E", "#D946EF", "#F59E0B",
      "#8B5CF6", "#14B8A6", "#F97316", "#6366F1", "#84CC16",
      "#EC4899", "#0EA5E9", "#DC2626", "#10B981", "#A855F7",
      "#EAB308", "#06B6D4", "#F43F5E", "#2563EB", "#16A34A",
      "#C026D3", "#EA580C", "#7C3AED", "#0891B2", "#CA8A04",
      "#DB2777", "#4F46E5", "#65A30D", "#059669", "#9333EA",
      "#D97706", "#E11D48", "#0284C7", "#15803D", "#059669"
    ];
    return colors[cleanerId % colors.length];
  };

  const getCleanerDisplayData = (cleaner: Cleaner) => {
    return getCleanerDisplayDataByRaw(cleaner, cleaner.id);
  };

  const loadCleanersDirectory = async (ids: number[]) => {
    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const baseResponses = await Promise.all([
        fetch(`/api/cleaners?date=${dateStr}&scope=housekeeping`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        }),
        fetch(`/api/cleaners?date=${dateStr}&scope=office`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        }),
      ]);

      const basePayloads = await Promise.all(
        baseResponses.map(async (response) => (response.ok ? response.json() : { cleaners: [] }))
      );

      let resolvedPayload: any = { cleaners: [] };
      if (ids.length > 0) {
        const resolvedResponse = await fetch(`/api/cleaners-resolve?ids=${ids.join(",")}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });
        if (resolvedResponse.ok) {
          resolvedPayload = await resolvedResponse.json();
        }
      }

      const payloads = [...basePayloads, resolvedPayload];

      const mergedDirectory: Record<number, CleanerDirectoryEntry> = {};
      for (const payload of payloads) {
        const cleanersList = Array.isArray(payload?.cleaners) ? payload.cleaners : [];
        for (const cleaner of cleanersList) {
          const cleanerId = Number(cleaner?.id);
          if (!Number.isFinite(cleanerId)) continue;
          const current = mergedDirectory[cleanerId] || { id: cleanerId };
          mergedDirectory[cleanerId] = {
            id: cleanerId,
            name: current.name || String(cleaner?.name ?? "").trim() || undefined,
            lastname: current.lastname || String(cleaner?.lastname ?? "").trim() || undefined,
            alias: current.alias || String(cleaner?.alias ?? "").trim() || undefined,
            role: current.role || String(cleaner?.role ?? "").trim() || undefined,
          };
        }
      }

      setCleanersDirectory(mergedDirectory);
    } catch (error) {
      console.error("Errore nel caricamento directory cleaners:", error);
      setCleanersDirectory({});
    }
  };

  // Funzione per caricare i cleaner da API (PostgreSQL/MySQL)
  const loadCleaners = async (skipLoadSaved = false) => {
    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');

      // Carica sia selected_cleaners che timeline da API per verificare la sincronizzazione
      const [selectedResponse, timelineResponse] = await Promise.all([
        fetch(withScope(`/api/selected-cleaners?date=${dateStr}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        }),
        fetch(withScope(`/api/timeline?date=${dateStr}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        })
      ]);

      // Verifica selected_cleaners API
      if (!selectedResponse.ok) {
        console.warn(`HTTP error loading cleaners! status: ${selectedResponse.status}`);
        setCleaners([]);
        return;
      }

      const selectedData = await selectedResponse.json();
      console.log("Cleaners caricati da API:", selectedData);

      // Verifica se la timeline esiste e ha cleaners
      let timelineCleaners: any[] = [];
      if (timelineResponse.ok) {
        try {
          const timelineData = await timelineResponse.json();
          timelineCleaners = timelineData.cleaners_assignments?.map((c: any) => ({
            id: c.cleaner?.id,
            name: c.cleaner?.name,
            lastname: c.cleaner?.lastname,
            role: c.cleaner?.role,
          })).filter((c: any) => c.id) || [];
        } catch (e) {
          console.warn('Errore parsing timeline:', e);
        }
      }

      // Se selected_cleaners è vuoto MA la timeline ha cleaners,
      // usa quelli dalla timeline (caso di ritorno a data precedente)
      let cleanersList = selectedData.cleaners || [];
      // Nota: questa fallback è utile SOLO in read-only (date passate) quando
      // selected_cleaners non è presente ma la timeline ha dati. In modalità edit,
      // selected_cleaners vuoto è uno stato valido (es. dopo "Rimuovi tutti").
      if (!skipLoadSaved && isReadOnly && cleanersList.length === 0 && timelineCleaners.length > 0) {
        console.log(`⚠️ selected_cleaners vuoto ma timeline ha ${timelineCleaners.length} cleaners`);
        console.log('🔄 Caricamento cleaners dalla timeline per visualizzazione');

        // Carica i dati completi dei cleaners da API (PostgreSQL)
        const cleanersResponse = await fetch(withScope(`/api/cleaners?date=${format(selectedDate, 'yyyy-MM-dd')}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });
        if (cleanersResponse.ok) {
          const cleanersData = await cleanersResponse.json();
          const allCleaners = cleanersData.cleaners || [];

          cleanersList = timelineCleaners.map((tc: any) => {
            const fullData = allCleaners.find((c: any) => c.id === tc.id);
            return fullData || tc;
          });

          console.log(`✅ Caricati ${cleanersList.length} cleaners dalla timeline (PostgreSQL)`);
        }
      }

      setCleaners(cleanersList);
    } catch (error) {
      console.error("Errore nel caricamento dei cleaners selezionati:", error);
      setCleaners([]);
    }
  };

  const loadAliases = async () => {
    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const response = await fetch(`/api/cleaners-aliases?date=${dateStr}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      if (!response.ok) {
        console.warn('Alias non trovati in PostgreSQL, uso nomi default');
        return;
      }
      const aliasesData = await response.json();
      setCleanersAliases(aliasesData.aliases || {});
      console.log("Alias cleaners caricati da PostgreSQL:", aliasesData.aliases);
    } catch (error) {
      console.error("Errore nel caricamento degli alias:", error);
    }
  };

  // Funzione per caricare i dati della timeline (inclusi i metadata)
  const loadTimelineData = async () => {
    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const response = await fetch(withScope(`/api/timeline?date=${dateStr}`), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      if (!response.ok) {
        console.warn(`Timeline not found (${response.status}), using empty data`);
        setTimelineData(null);
        return;
      }
      const data = await response.json();
      setTimelineData(data);
    } catch (error) {
      console.error("Errore nel caricamento dei dati della timeline:", error);
      setTimelineData(null);
    }
  };

  useEffect(() => {
    loadCleaners();
    loadAliases();
    loadTimelineCleaners();
    loadTimelineData();
    loadCleanerLocks();
  }, []);

  useEffect(() => {
    const reloadTimelineRoster = async () => {
      await Promise.all([
        loadCleaners(),
        loadAliases(),
        loadTimelineCleaners(),
        loadTimelineData(),
        loadCleanerLocks(),
      ]);
    };
    (window as any).loadTimelineCleaners = loadTimelineCleaners;
    (window as any).loadSelectedCleaners = loadCleaners;
    (window as any).reloadTimelineRoster = reloadTimelineRoster;

    const onRefreshAssignments = () => {
      void reloadTimelineRoster();
    };
    window.addEventListener("refresh-assignments", onRefreshAssignments);
    return () => {
      window.removeEventListener("refresh-assignments", onRefreshAssignments);
    };
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        "wass.hk.showExecutionStatusColors",
        showExecutionStatusColors ? "1" : "0"
      );
    } catch {
      /* ignore */
    }
    (window as any).showHkExecutionStatusColors = showExecutionStatusColors;
    return () => {
      delete (window as any).showHkExecutionStatusColors;
    };
  }, [showExecutionStatusColors]);

  useEffect(() => {
    loadCleanersDirectory(cleanerDirectoryIds);
  }, [selectedDate, cleanerDirectoryIdsKey]);

  const handleCleanerClick = (cleaner: Cleaner, e?: React.MouseEvent) => {
    // Solo click singolo apre il dialog
    if (clickTimer) {
      // È un doppio click, annulla il click singolo
      clearTimeout(clickTimer);
      setClickTimer(null);

      // Gestione doppio click: filtro mappa
      if (filteredCleanerId === cleaner.id) {
        setFilteredCleanerId(null);
        (window as any).mapFilteredCleanerId = null;
        toast({
          title: "Filtro rimosso",
          description: "Ora visualizzi tutti gli appartamenti sulla mappa",
        });
      } else {
        setFilteredCleanerId(cleaner.id);
        (window as any).mapFilteredCleanerId = cleaner.id;
        toast({
          title: "Filtro attivato",
          description: `Visualizzi solo gli appartamenti di ${cleaner.name} ${cleaner.lastname}`,
        });
        openTimelineMapPanel();
      }
    } else {
      // Primo click: avvia timer
      const timer = setTimeout(() => {
        // Verifica se ci sono task incompatibili NON ancora ackate
        const cleanerRole = getCleanerDisplayDataByRaw(cleaner, cleaner.id).role;
        if (validationRules && cleanerRole && !isOfficeCleanerRole(cleanerRole)) {
          const cleanerTasks = tasks
            .filter(task => (task as any).assignedCleaner === cleaner.id)
            .map(normalizeTask);

          const incompatibleTasks = cleanerTasks.filter(task => {
            if (isReadonlyPreassignedTask(task)) return false;
            if (canCleanerHandleTaskSync(
              cleanerRole,
              task,
              validationRules,
            )) return false;
            const key = getIncompatibleKey(task, cleaner.id);
            return !acknowledgedIncompatibleAssignments.has(key);
          });

          if (incompatibleTasks.length > 0) {
            // Mostra dialog incompatibilità invece del modal normale
            const tasksInfo = incompatibleTasks.map(task => {
              const taskType = task.straordinaria ? 'Straordinaria' : task.premium ? 'Premium' : 'Standard';
              const aptType = (task as any).apt_type || (task as any).aptType || (task as any).type_apt || '';

              // Determina priorità dai campi canonici (priority/task_priority) con fallback ai flag legacy
              const rawPriority = String((task as any).priority || (task as any).task_priority || '').toLowerCase().trim();
              const isEarlyOut =
                rawPriority === 'early_out' ||
                rawPriority === 'early-out' ||
                rawPriority === 'eo' ||
                rawPriority.includes('early') ||
                Boolean((task as any).early_out || (task as any).earlyOut || (task as any).is_early_out);
              const isHighPriority =
                rawPriority === 'high_priority' ||
                rawPriority === 'high-priority' ||
                rawPriority === 'high' ||
                rawPriority === 'hp' ||
                Boolean((task as any).high_priority || (task as any).highPriority || (task as any).is_high_priority);
              const priority = isEarlyOut ? 'EO' : isHighPriority ? 'HP' : 'LP';

              let fullType = taskType;
              if (aptType) fullType += ` (Tipo ${aptType})`;
              fullType += ` [${priority}]`;

              return {
                logisticCode: task.name,
                taskType: fullType
              };
            });
            setIncompatibleDialog({ open: true, cleanerId: cleaner.id, tasks: tasksInfo });
            setClickTimer(null);
            return;
          }
        }

        // Singolo click: apri modal normale se non ci sono incompatibilità
        setSelectedCleaner(cleaner);
        // Inizializza l'alias dal cleanersAliases
        const currentAlias = cleanersAliases[cleaner.id]?.alias || "";
        setEditingAlias(currentAlias);
        // Inizializza lo start time
        setEditingStartTime(cleaner.start_time || "10:00");
        setIsModalOpen(true);
        setClickTimer(null);
      }, 250); // 250ms per distinguere singolo da doppio click

      setClickTimer(timer);
    }
  };

  // Funzione per caricare i cleaner disponibili (non già in timeline)
  const loadAvailableCleaners = async () => {
    setIsLoadingAvailableCleaners(true);
    try {
      // Non bloccare se l'estrazione fallisce - continua con i cleaners da PostgreSQL
      try {
        console.log(`🔄 Estrazione cleaners dal database per ${workDate}...`);
        const extractResponse = await fetch('/api/extract-cleaners-optimized', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: workDate, scope: scopeValue })
        });

        if (extractResponse.ok) {
          const extractResult = await extractResponse.json();
          if (extractResult.success) {
            console.log('✅ Cleaners estratti:', extractResult);
          } else {
            console.warn('⚠️ Estrazione non disponibile, uso cleaners da PostgreSQL');
          }
        }
      } catch (err) {
        console.warn('⚠️ Estrazione cleaners fallita (ADAM unavailable), proceedo con PostgreSQL');
      }

      // Carica tutti i cleaners per la data corrente da API (PostgreSQL)
      const cleanersResponse = await fetch(withScope(`/api/cleaners?date=${workDate}`), {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
        signal: AbortSignal.timeout(15000) // Timeout di 15 secondi
      });

      if (!cleanersResponse.ok) {
        console.error('Impossibile caricare cleaners da API');
        setAvailableCleaners([]);
        return;
      }

      const cleanersData = await cleanersResponse.json();
      const dateCleaners = cleanersData.cleaners || [];

      console.log(`✅ Cleaners trovati per ${workDate}:`, dateCleaners.length);

      // CRITICAL: Filtra cleaners già presenti in timeline (sia selezionati che rimossi)
      // Questo previene di avere duplicati (cleaner rimosso + stesso cleaner aggiunto)
      const selectedCleanerIds = new Set(cleaners.map(c => c.id));
      const timelineCleanerIds = new Set(
        (timelineCleaners || []).map(tc => tc.cleaner?.id).filter(Boolean)
      );

      const available = dateCleaners.filter((c: any) => {
        const isOfficeCleaner = String(c?.role || "").toLowerCase().includes("ufficio");
        const roleMatchesScope = isOfficeScope ? isOfficeCleaner : !isOfficeCleaner;
        return (
          c.active === true &&
          roleMatchesScope &&
          !selectedCleanerIds.has(c.id) &&
          !timelineCleanerIds.has(c.id) // NUOVO: escludi anche quelli già in timeline
        );
      });

      // Ordina per tipologia (Formatori → Straordinari → Premium → Standard)
      // e per ore della settimana (weekly_hours) DESC all'interno di ogni gruppo
      available.sort((a: any, b: any) => {
        const getPriority = (cleaner: any) => {
          // 1. Formatore (massima priorità)
          if (cleaner.role === "Formatore") return 1;
          // 2. Straordinario (role ha PRIORITÀ)
          if (cleaner.role === "Straordinario") return 2;
          // 3. Premium (solo se NON straordinario)
          if (cleaner.role === "Premium") return 3;
          // 4. Standard / qualsiasi altro
          return 4;
        };

        const priorityA = getPriority(a);
        const priorityB = getPriority(b);

        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }

        // Stessa tipologia → ordina per ore DESC.
        // Usa weekly_hours, se mancante fai fallback su counter_hours.
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

      console.log(`✅ Cleaners disponibili da aggiungere: ${available.length}`);
      setAvailableCleaners(available);
    } catch (error) {
      console.error('Errore nel caricamento dei cleaners disponibili:', error);
      setAvailableCleaners([]);
    } finally {
      setIsLoadingAvailableCleaners(false);
    }
  };

  // Handler per aprire il dialog di aggiunta cleaner
  const handleOpenAddCleanerDialog = async () => {
    if (isRosterEditDisabled) return;
    setIsAddCleanerDialogOpen(true); // Apri il dialog subito per mostrare loading
    await loadAvailableCleaners(); // Attendi il caricamento
  };

  // Handler per aggiungere/sostituire un cleaner
  const handleAddCleaner = (cleanerId: number, isAvailable: boolean) => {
    if (isRosterEditDisabled) return;

    // Trova il nome del cleaner per mostrarlo nel dialog
    const cleaner = availableCleaners.find(c => c.id === cleanerId);
    const cleanerName = cleaner ? `${cleaner.name} ${cleaner.lastname}` : `ID ${cleanerId}`;

    // Imposta il cleaner in pending
    setPendingCleaner(cleaner);

    // Usa start_time esistente del cleaner o default a "10:00"
    const defaultStartTime = cleaner?.start_time || "10:00";

    // Apri il dialog per richiedere lo start time
    setStartTimeDialog({
      open: true,
      cleanerId,
      cleanerName,
      isAvailable
    });
    setPendingStartTime(defaultStartTime); // Usa start_time del cleaner se disponibile
    setIsAddCleanerDialogOpen(false); // Chiudi il dialog di selezione cleaner
  };

  // Handler per confermare start time e aggiungere cleaner
  const handleConfirmStartTimeAndAdd = async () => {
    if (isRosterEditDisabled || !startTimeDialog.cleanerId) return;

    const cleanerId = startTimeDialog.cleanerId;

    try {
      // Salva lo start_time usando l'API dedicata
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await fetch('/api/update-cleaner-start-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId: cleanerId,
          startTime: pendingStartTime,
          date: workDate,
          scope: scopeValue,
          modified_by: currentUser.username || 'unknown'
        }),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio dello start time');
      }

      console.log(`✅ Start time ${pendingStartTime} salvato per cleaner ${cleanerId}`);
    } catch (error) {
      console.error("Errore nel salvataggio dello start time:", error);
      toast({
        title: "Errore",
        description: "Impossibile salvare lo start time",
        variant: "destructive",
      });
      return;
    }

    // Aggiorna lo stato locale SUBITO con il nuovo start time
    setAvailableCleaners(prev => prev.map(c =>
      c.id === cleanerId ? { ...c, start_time: pendingStartTime } : c
    ));

    // Se non disponibile, chiedi ulteriore conferma
    if (!startTimeDialog.isAvailable) {
      setConfirmUnavailableDialog({ open: true, cleanerId: cleanerId });
      return;
    }

    // Procedi con l'aggiunta del cleaner (che ora includerà lo start time)
    if ((window as any).setHasUnsavedChanges) {
      (window as any).setHasUnsavedChanges(true);
    }

    if (cleanerToReplace !== null) {
      removeCleanerMutation.mutate(cleanerToReplace, {
        onSuccess: () => {
          addCleanerMutation.mutate(cleanerId);
          setCleanerToReplace(null);
        }
      });
    } else {
      addCleanerMutation.mutate(cleanerId);
    }
    skipReopenAddCleanerOnStartTimeCloseRef.current = true;
    setIsAddCleanerDialogOpen(false);
    setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
    setPendingCleaner(null);
  };


  // Handler per confermare l'aggiunta di un cleaner non disponibile
  const handleConfirmAddUnavailableCleaner = async () => {
    if (isRosterEditDisabled) return;

    const cleanerId = confirmUnavailableDialog.cleanerId;
    if (cleanerId === null) return;

    skipReopenAddCleanerOnStartTimeCloseRef.current = true;
    setConfirmUnavailableDialog({ open: false, cleanerId: null });
    setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
    setIsAddCleanerDialogOpen(false);
    setPendingCleaner(null);

    try {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      await fetch('/api/update-cleaner-start-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId,
          startTime: pendingStartTime,
          date: workDate,
          scope: scopeValue,
          modified_by: currentUser.username || 'unknown',
        }),
      });
      console.log(`✅ Start time aggiornato per cleaner ${cleanerId}: ${pendingStartTime}`);
    } catch (error) {
      console.error("Errore nel salvataggio dello start time e disponibilità:", error);
    }

    setAvailableCleaners(prev => prev.map(c =>
      c.id === cleanerId ? { ...c, start_time: pendingStartTime, available: true } : c
    ));

    if ((window as any).setHasUnsavedChanges) {
      (window as any).setHasUnsavedChanges(true);
    }
    if (cleanerToReplace !== null) {
      removeCleanerMutation.mutate(cleanerToReplace, {
        onSuccess: () => {
          addCleanerMutation.mutate(cleanerId);
          setCleanerToReplace(null);
        }
      });
    } else {
      addCleanerMutation.mutate(cleanerId);
    }
  };

  // Handler per confermare la rimozione di un cleaner
  const handleConfirmRemoveCleaner = () => {
    if (isRosterEditDisabled) return;

    if (confirmRemovalDialog.cleanerId !== null) {
      removeCleanerMutation.mutate(confirmRemovalDialog.cleanerId);
      setConfirmRemovalDialog({ open: false, cleanerId: null });
    }
  };

  // Apri dialog modifica alias
  const handleOpenAliasDialog = (cleaner: Cleaner) => {
    const currentAlias = cleanersAliases[cleaner.id]?.alias || "";
    setEditingAlias(currentAlias);
    setAliasDialog({
      open: true,
      cleanerId: cleaner.id,
      cleanerName: `${cleaner.name} ${cleaner.lastname}`
    });
  };

  // Apri dialog modifica start time
  const handleOpenStartTimeDialog = (cleaner: Cleaner) => {
    const currentStartTime = cleaner.start_time || "10:00";
    setEditingStartTime(currentStartTime);
    setStartTimeEditDialog({
      open: true,
      cleanerId: cleaner.id,
      cleanerName: `${cleaner.name} ${cleaner.lastname}`
    });
  };

  const handleOpenEndTimeDialog = (cleaner: Cleaner) => {
    const currentEndTime = cleaner.end_time || "20:00";
    setEditingEndTime(currentEndTime);
    setEndTimeEditDialog({
      open: true,
      cleanerId: cleaner.id,
      cleanerName: `${cleaner.name} ${cleaner.lastname}`
    });
  };

  // Salva l'alias modificato
  const handleSaveAlias = async () => {
    if (!aliasDialog.cleanerId) return;
    setIsSavingAlias(true);
    try {
      const response = await fetch('/api/update-cleaner-alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId: aliasDialog.cleanerId,
          alias: editingAlias,
        }),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio dell\'alias');
      }

      const result = await response.json();

      // Ricarica gli alias dal file aggiornato
      await loadAliases();

      toast({
        title: "Alias salvato",
        description: `L'alias è stato aggiornato con successo.`,
        variant: "success",
      });

      // Chiudi il dialog
      setAliasDialog({ open: false, cleanerId: null, cleanerName: '' });

    } catch (error: any) {
      console.error("Errore nel salvataggio dell'alias:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare l'alias",
        variant: "destructive",
      });
    } finally {
      setIsSavingAlias(false);
    }
  };

  // Salva lo start time modificato
  const handleSaveStartTime = async () => {
    if (!startTimeEditDialog.cleanerId) return;

    // Valida il formato dell'orario
    if (!/^\d{2}:\d{2}$/.test(editingStartTime)) {
      toast({
        variant: "destructive",
        title: "⚠️ Formato orario non valido",
        description: "Inserisci un orario nel formato HH:mm (es. 10:00)"
      });
      return;
    }

    setIsSavingStartTime(true);
    try {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await fetch('/api/update-cleaner-start-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId: startTimeEditDialog.cleanerId,
          startTime: editingStartTime,
          date: workDate,
          scope: scopeValue,
          modified_by: currentUser.username || 'unknown'
        }),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio dello start time');
      }

      // Aggiorna lo stato locale
      setCleaners(prev => prev.map(c =>
        c.id === startTimeEditDialog.cleanerId ? { ...c, start_time: editingStartTime } : c
      ));

      // Aggiorna anche selectedCleaner se è lo stesso
      if (selectedCleaner && selectedCleaner.id === startTimeEditDialog.cleanerId) {
        setSelectedCleaner({ ...selectedCleaner, start_time: editingStartTime });
      }

      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }

      toast({
        title: "Start Time salvato",
        description: `Orario di inizio aggiornato a ${editingStartTime}`,
        variant: "success",
      });

      // Chiudi il dialog
      setStartTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' });

    } catch (error: any) {
      console.error("Errore nel salvataggio dello start time:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare lo start time",
        variant: "destructive",
      });
    } finally {
      setIsSavingStartTime(false);
    }
  };

  const persistFirstApartmentStart = async (
    cleanerId: number,
    taskId: string | number,
    startTime: string | null,
  ) => {
    setIsSavingFirstAptTime(true);
    try {
      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/reschedule-first-task", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cleanerId,
          taskId,
          startTime,
          date: workDate,
          scope: scopeValue,
          modified_by: currentUser.username || "unknown",
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || result.message || "Errore nello spostamento dell'orario");
      }
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error.message || "Impossibile spostare l'inizio del primo appartamento",
        variant: "destructive",
      });
    } finally {
      setFirstAptTimeShiftPreview(null);
      setIsSavingFirstAptTime(false);
    }
  };

  const handleSaveEndTime = async () => {
    if (!endTimeEditDialog.cleanerId) return;

    if (!/^\d{2}:\d{2}$/.test(editingEndTime)) {
      toast({
        variant: "destructive",
        title: "⚠️ Formato orario non valido",
        description: "Inserisci un orario nel formato HH:mm (es. 20:00)"
      });
      return;
    }

    setIsSavingEndTime(true);
    try {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await fetch('/api/update-cleaner-end-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId: endTimeEditDialog.cleanerId,
          endTime: editingEndTime,
          date: workDate,
          scope: scopeValue,
          modified_by: currentUser.username || 'unknown'
        }),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.message || 'Errore nel salvataggio dell\'end time');
      }

      setCleaners(prev => prev.map(c =>
        c.id === endTimeEditDialog.cleanerId ? { ...c, end_time: editingEndTime } : c
      ));

      if (selectedCleaner && selectedCleaner.id === endTimeEditDialog.cleanerId) {
        setSelectedCleaner({ ...selectedCleaner, end_time: editingEndTime });
      }

      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }

      toast({
        title: "End Time salvato",
        description: `Orario di fine aggiornato a ${editingEndTime}`,
        variant: "success",
      });

      setEndTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' });

    } catch (error: any) {
      console.error("Errore nel salvataggio dell'end time:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare l'end time",
        variant: "destructive",
      });
    } finally {
      setIsSavingEndTime(false);
    }
  };

  // Calcola la larghezza dinamica della colonna cleaners in base all'alias più lungo
  const calculateCleanerColumnWidth = () => {
    // Mantieni una colonna stabile anche quando non ci sono cleaner selezionati,
    // così la griglia oraria non si "sposta" visivamente.
    if (allCleanersToShow.length === 0) return 128;

    const maxLength = allCleanersToShow.reduce((max, cleaner) => {
      const alias = cleanersAliases[cleaner.id]?.alias || `${cleaner.name ?? ""} ${cleaner.lastname ?? ""}`.trim();
      return Math.max(max, alias.length);
    }, 0);

    // Formula: larghezza base + (caratteri * pixel per carattere)
    // Mantiene la colonna dinamica sul nome più lungo, evitando spazio vuoto eccessivo.
    const baseWidth = 44; // padding e margini
    const charWidth = 7; // circa 7px per carattere con font bold 13px
    const badgeSpace = 20; // spazio per il badge P/F

    return Math.max(128, baseWidth + (maxLength * charWidth) + badgeSpace);
  };

  const cleanerColumnWidth = calculateCleanerColumnWidth();

  // Gestione fullscreen
  const toggleFullscreen = async () => {
    if (!timelineRef.current) return;

    try {
      if (!isFullscreen) {
        // Entra in fullscreen
        if (timelineRef.current.requestFullscreen) {
          await timelineRef.current.requestFullscreen();
        }
      } else {
        // Esci da fullscreen
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (error) {
      console.error('Errore fullscreen:', error);
      toast({
        title: "Errore",
        description: "Impossibile attivare/disattivare la modalità a schermo intero",
        variant: "destructive",
      });
    }
  };

  // Listener per cambiamenti fullscreen
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);



  const handleResetAssignments = async () => {
    try {
      setIsResetting(true);

      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');

      const response = await fetchWithOperation('reset-timeline', withScope('/api/reset-timeline-assignments'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: workDate,
          modified_by: currentUser.username || 'unknown'
        })
      });

      if (!response.ok) {
        throw new Error('Errore durante il reset');
      }

      onWaveAssignStateReset?.();

      // Svuota subito la timeline in UI, così l'utente vede l'effetto
      setTimelineData(null);
      setLastSavedFilename(null);
      localStorage.removeItem('last_saved_assignment');
      (window as any).setHasUnsavedChanges?.(true);

      // Una SOLA pipeline di reload dei dati.
      // Deve riallineare task + cleaners (timeline e selected) per replicare
      // il comportamento di un refresh pagina completo.
      await (window as any).reloadAllTasks?.();
      await loadTimelineCleaners();
      await loadCleaners();
      await loadTimelineData();

      toast({
        title: "Reset completato",
        description: "Timeline svuotata, task tornate nei containers",
        variant: "success",
      });
    } catch (error: any) {
      if (error.message.includes("Operazione annullata")) {
        console.log('ℹ️ Reset annullato - richiesta più recente in corso');
        return;
      }
      console.error('Errore nel reset:', error);
      toast({
        title: "Errore",
        description: "Errore durante il reset delle assegnazioni",
        variant: "destructive",
      });
    } finally {
      setIsResetting(false);
    }
  };


  // [DEPRECATED] handleConfirmAssignments rimosso - salvataggio automatico su MySQL

  const [lastSavedFilename, setLastSavedFilename] = useState<string | null>(null);

  const loadTimelineCleaners = async (onLoadComplete?: () => void) => {
    try {
      const dateStr = format(selectedDate, 'yyyy-MM-dd');
      const response = await fetch(withScope(`/api/timeline?date=${dateStr}`), {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
      if (!response.ok) {
        console.warn(`Timeline not found (${response.status}), using empty timeline`);
        setTimelineCleaners([]);
        // Attendi il prossimo frame del browser prima di chiamare il callback
        if (onLoadComplete) {
          await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
          onLoadComplete();
        }
        return;
      }

      const timelineData = await response.json();
      const timelineCleanersList = timelineData.cleaners_assignments || [];
      setTimelineCleaners(timelineCleanersList);
      
      // CRITICAL: Attendi il prossimo frame del browser per assicurarti che React abbia completato il render
      if (onLoadComplete) {
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        onLoadComplete();
      }
    } catch (error) {
      console.error("Errore nel caricamento timeline cleaners:", error);
      setTimelineCleaners([]);
      // Attendi il prossimo frame del browser prima di chiamare il callback
      if (onLoadComplete) {
        await new Promise(resolve => requestAnimationFrame(() => resolve(null)));
        onLoadComplete();
      }
    }
  };

  // Nota: il tracking delle modifiche avviene SOLO tramite onTaskMoved
  // chiamato esplicitamente durante drag-and-drop e altre azioni utente

  // --- NORMALIZZAZIONI TIMELINE ---
  // NON normalizzare task.type - lo determiniamo dai flag
  const normalizeTask = (task: any) => {
    // Normalizza SOLO i flag straordinaria/premium, NON il type
    const isPremium = Boolean(task.premium);
    const isStraordinaria = Boolean(task.straordinaria) || isContinuazioneStraordinariaTask(task);

    // Normalizza confirmed_operation
    const rawConfirmed = task.confirmed_operation;
    const isConfirmedOperation =
      typeof rawConfirmed === "boolean"
        ? rawConfirmed
        : typeof rawConfirmed === "number"
          ? rawConfirmed !== 0
          : typeof rawConfirmed === "string" && rawConfirmed
            ? ["true", "1", "yes"].includes(rawConfirmed.toLowerCase().trim())
            : false;

    return {
      ...task,
      // NON sovrascrivere task.type - lascialo undefined se non esiste
      premium: isPremium,
      straordinaria: isStraordinaria,
      confirmed_operation: isConfirmedOperation,
    };
  };

  // Gestione toast per incompatibilità task-cleaner (con sistema per coppie)
  useEffect(() => {
    if (!validationRules) return;

    const incompatibleAssignments: Array<{ cleanerId: number; cleanerName: string; role: string; taskNames: string }> = [];

    allCleanersToShow.forEach(cleaner => {
      if (removedCleanerIds.has(cleaner.id)) return;
      const cleanerDisplay = getCleanerDisplayDataByRaw(cleaner, cleaner.id);
      const cleanerRole = cleanerDisplay.role;
      if (!cleanerRole || isOfficeCleanerRole(cleanerRole)) return;

      const cleanerTasks = tasks
        .filter(task => (task as any).assignedCleaner === cleaner.id)
        .map(normalizeTask);

      // CRITICAL: Verifica TUTTE le task incompatibili, ignorando lo stato di acknowledge
      // L'acknowledge serve solo per non mostrare il dialog al click, NON per nascondere i toast
      const incompatibleTasks = cleanerTasks.filter(task => {
        if (isReadonlyPreassignedTask(task)) return false;
        return !canCleanerHandleTaskSync(
          cleanerRole,
          task,
          validationRules,
        );
      });

      if (incompatibleTasks.length > 0) {
        incompatibleAssignments.push({
          cleanerId: cleaner.id,
          cleanerName: cleanerDisplay.fullName || cleanerDisplay.primaryLabel,
          role: cleanerRole,
          taskNames: incompatibleTasks.map(t => t.name).join(', ')
        });
      }
    });

    // Mostra toast SEMPRE per incompatibilità, resettando i toast mostrati ad ogni cambio
    shownToastsRef.current.clear();

    if (incompatibleAssignments.length > 0) {
      incompatibleAssignments.forEach(assignment => {
        // Crea una chiave univoca per questo toast
        const toastKey = `${assignment.cleanerId}-${assignment.taskNames}`;

        // Mostra solo se non è già stato mostrato in questo ciclo
        if (!shownToastsRef.current.has(toastKey)) {
          shownToastsRef.current.add(toastKey);

          toast({
            title: "⚠️ Assegnazione incompatibile",
            description: `${assignment.cleanerName} (${assignment.role}) ha task incompatibili: ${assignment.taskNames}`,
            variant: "default",
            className: "bg-yellow-200 dark:bg-yellow-800 border-2 border-yellow-600 dark:border-yellow-500 text-yellow-900 dark:text-yellow-50 shadow-lg",
          });
        }
      });
    }
  }, [validationRules, allCleanersToShow, tasks, removedCleanerIds, toast]);

  // Funzione per verificare SE esistono assegnazioni salvate (senza caricarle)
  const checkSavedAssignmentExists = async () => {
    try {
      const response = await fetch('/api/check-saved-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: workDate })
      });

      if (response.ok) {
        const result = await response.json();
        if (result.found && result.formattedDateTime) {
          setLastSavedFilename(result.formattedDateTime);
          localStorage.setItem('last_saved_assignment', result.formattedDateTime);
        } else {
          setLastSavedFilename(null);
          localStorage.removeItem('last_saved_assignment');
        }
      }
    } catch (error) {
      console.error("Errore nel controllo delle assegnazioni salvate:", error);
    }
  };

  // Variabile per determinare se ci sono task assegnate (per mostrare/nascondere pulsante conferma)
  const hasAssignedTasks = tasks.some(task => (task as any).assignedCleaner !== undefined);

  // Verifica se la timeline ha task assegnate - usa ENTRAMBE le fonti:
  // 1. timelineData dal server (può essere stale dopo reset)
  // 2. tasks array (sempre aggiornato con optimistic updates)
  const hasTasksInTimeline = 
    timelineData?.cleaners_assignments?.some((ca: any) => ca.tasks && ca.tasks.length > 0) || 
    tasks.some(task => (task as any).assignedCleaner !== undefined && (task as any).assignedCleaner !== null);

  // Mutation per rimuovere task dalla timeline
  const removeTaskMutation = useMutation({
    mutationFn: async ({ taskId, logisticCode }: { taskId: number | string; logisticCode: number | string }) => {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await apiRequest("POST", "/api/remove-timeline-assignment", {
        taskId,
        logisticCode,
        date: workDate,
        modified_by: currentUser.username || 'unknown'
      });
      return await response.json();
    },
    onSuccess: async (data) => {
      if (onTaskMoved) onTaskMoved();
      if ((window as any).setHasUnsavedChanges) (window as any).setHasUnsavedChanges(true);
      await loadTimelineCleaners(); // Ricarica i cleaners della timeline
      await loadTimelineData(); // Aggiorna i metadata
      toast({
        title: "Task rimossa",
        description: "Task rimossa dalla timeline",
        variant: "success",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile rimuovere la task",
        variant: "destructive",
      });
    },
  });


  // Funzione per il trasferimento dei dati ad ADAM
  const handleTransferToAdam = async () => {
    try {
      setIsTransferringToAdam(true);
      setShowAdamTransferDialog(false); // Chiudi il dialog di conferma

      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      // Leggi le pending_edits da sessionStorage
      const pendingEdits = JSON.parse(sessionStorage.getItem('pending_task_edits') || '{}');

      // CRITICAL: Salva prima TUTTE le modifiche pendenti su PostgreSQL
      if (Object.keys(pendingEdits).length > 0) {
        console.log(`💾 Salvando ${Object.keys(pendingEdits).length} task modificate su PostgreSQL...`);
        for (const [taskKey, edit] of Object.entries(pendingEdits)) {
          try {
            const taskEdit = edit as any;
            const updateResponse = await fetch('/api/update-task-details', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                taskId: taskEdit.taskId,
                logisticCode: taskEdit.logisticCode,
                checkoutDate: taskEdit.checkoutDate,
                checkoutTime: taskEdit.checkoutTime,
                checkinDate: taskEdit.checkinDate,
                checkinTime: taskEdit.checkinTime,
                cleaningTime: taskEdit.cleaningTime,
                paxIn: taskEdit.paxIn,
                paxOut: taskEdit.paxOut,
                operationId: taskEdit.operationId,
                customerNote: taskEdit.customerNote,
                date: workDate,
                modified_by: currentUser.username || 'system',
                scope: scopeValue,
              }),
            });
            const updateResult = await updateResponse.json();
            if (updateResult.success) {
              console.log(`✅ Task ${taskEdit.logisticCode} salvata su PostgreSQL`);
            }
          } catch (editError: any) {
            console.error(`⚠️ Errore salvaggio task ${taskKey}:`, editError.message);
          }
        }
      }

      toast({
        title: "Trasferimento in corso...",
        description: "Invio dati al database ADAM",
        variant: "default",
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 secondi timeout

      const response = await fetch('/api/transfer-to-adam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: workDate,
          username: currentUser.username || 'system',
          pendingTaskEdits: pendingEdits, // Passa le modifiche pendenti
          scope: scopeValue,
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();

      if (result.success) {
        // Pulisci sessionStorage dopo il trasferimento riuscito
        sessionStorage.removeItem('pending_task_edits');
        // Aggiorna il timestamp dell'ultimo trasferimento
        setLastAdamTransfer(new Date().toISOString());
        toast({
          title: "✅ Trasferimento completato",
          description: result.message || `Task aggiornate sul database ADAM`,
        });
      } else {
        toast({
          title: "❌ Errore trasferimento",
          description: result.message || "Errore durante il trasferimento",
          variant: "destructive",
        });
      }
    } catch (error: any) {
      console.error('Errore trasferimento ADAM:', error);
      let errorMessage = "Impossibile comunicare con il server";

      if (error.name === 'AbortError') {
        errorMessage = "Timeout: il server impiega troppo tempo a rispondere";
      } else if (error.message) {
        errorMessage = error.message;
      }

      toast({
        title: "❌ Errore connessione",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsTransferringToAdam(false);
    }
  };

  return (
    <>
      <div
        ref={timelineRef}
        className={cn(
          "bg-custom-blue-light rounded-lg border-2 border-custom-blue shadow-sm relative overflow-hidden",
          isFullscreen && "fixed inset-0 z-50 overflow-auto",
          className
        )}
      >
        {/* Loading overlay durante drag&drop, rimozione cleaner, refresh ADAM, ecc. */}
        {(isLoadingDragDrop || removeCleanerMutation.isPending || removeSelectedCleanersMutation.isPending) && (
          <div className="absolute inset-0 bg-black/20 dark:bg-black/40 rounded-lg flex items-center justify-center z-40 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
              <p className="text-sm font-medium text-foreground">
                {loadingMessage ||
                  (removeCleanerMutation.isPending || removeSelectedCleanersMutation.isPending
                    ? "Aggiornamento timeline..."
                    : "La timeline sta ragionando...")}
              </p>
            </div>
          </div>
        )}
      
          <div className="px-4 py-4 border-b border-border">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <div>
              <h2 className="text-xl font-bold text-foreground flex items-center">
                <CalendarIcon className="w-5 h-5 mr-2 text-custom-blue" />
                {isOfficeScope ? "Timeline Ufficio" : "Timeline Housekeeping"} - {allCleanersToShow.length} Cleaners
              </h2>
            </div>
            <div className="flex items-center gap-3 print:hidden">
              {!isOfficeScope && (
                <>
                  <div className="flex items-center gap-2">
                    <Label
                      htmlFor="execution-status-colors-switch"
                      className="cursor-pointer whitespace-nowrap text-sm font-medium leading-none text-custom-blue"
                    >
                      Colori stato
                    </Label>
                    <Switch
                      id="execution-status-colors-switch"
                      checked={showExecutionStatusColors}
                      onCheckedChange={(checked) => setShowExecutionStatusColors(Boolean(checked))}
                      className="h-6 w-11 border-2 border-custom-blue data-[state=unchecked]:bg-sky-200 data-[state=checked]:bg-[hsl(199,89%,48%)] dark:data-[state=unchecked]:bg-sky-900/50 dark:data-[state=checked]:bg-[hsl(217,91%,53%)]"
                      title={
                        showExecutionStatusColors
                          ? "Mostra i task colorati in base a in corso / completato"
                          : "Mostra i task con il colore normale"
                      }
                      data-testid="switch-execution-status-colors"
                    />
                  </div>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-yellow-500 hover:text-yellow-600 hover:bg-yellow-500/10"
                      aria-label="Info visualizzazione task brevi"
                    >
                      <AlertCircle className="w-4 h-4" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    className="w-80 text-sm leading-relaxed"
                  >
                    Sui task sotto l&apos;ora, check-out/in e codice cliente restano
                    nascosti: passa il cursore sulla card per vederli.
                  </PopoverContent>
                </Popover>
                </>
              )}
              <Button
                onClick={() => setLocation(isOfficeScope ? '/convocazioni?kind=office' : '/convocazioni')}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 border-2 border-custom-blue"
                disabled={isRosterEditDisabled}
                title={isRosterEditDisabled ? rosterEditDisabledTitle : undefined}
              >
                <Users className="w-4 h-4" />
                Convocazioni
              </Button>
              <Button
                onClick={() => setShowResetDialog(true)}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 border-2 border-custom-blue"
                disabled={isReadOnly || !hasTasksInTimeline || isResetting}
                title={!hasTasksInTimeline ? "Nessuna task assegnata nella timeline" : "Reset delle assegnazioni"}
              >
                {isResetting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {!isResetting && <RotateCcw className="w-4 h-4" />}
                Reset Assegnazioni
              </Button>
            </div>
          </div>
        </div>
        <div className="flex min-h-0 flex-col overflow-hidden px-1 pt-4 pb-4">

          <TimelineHorizontalScrollbar
            labelColumnWidth={cleanerColumnWidth}
            contentWidth={timelineScaledWidth}
            registerRef={registerTimelineScrollRef}
            onScroll={handleTimelineScroll}
          />

{/* Graffe fasce orarie (EO / HP / LP) sopra gli orari */}
<div className="flex items-stretch mb-0 px-1 h-[40px]">
  {/* colonna pulsante / nome cleaner (vuota per allineamento) */}
  <div
    className="flex-shrink-0 h-full print:hidden"
    style={{ width: `${cleanerColumnWidth}px` }}
  />
  {/* area timeline (stessa larghezza della griglia orari) */}
  <div
    ref={registerTimelineScrollRef}
    onScroll={handleTimelineScroll}
    onPointerDown={handleTimelinePointerDown}
    onPointerMove={handleTimelinePointerMove}
    onPointerUp={stopTimelinePan}
    onPointerCancel={stopTimelinePan}
    className="timeline-center-scroll min-w-0 flex-1 h-full"
  >
    {priorityWindows && (
    <div className="relative h-full" style={{ width: timelineScaledWidth, minWidth: "100%" }}>
      {(() => {
        const hpStartMin = timeToMinutes(priorityWindows.hpStart);
        const hpEndMin = timeToMinutes(priorityWindows.hpEnd);

        const hp1 = clamp(minutesToPct(hpStartMin), 0, 100);
        const hp2 = clamp(minutesToPct(hpEndMin), 0, 100);

        const lp1 = clamp(minutesToPct(hpEndMin), 0, 100);
        const lp2 = 100;

        // Due piani:
        // - LP più su (top più piccolo)
        // - EO + HP più giù (top più grande)
        const TOP_LP = 2;    // LP resta nel contenitore scrollabile senza essere tagliato
        const TOP_MAIN = 18; // EO/HP restano allineati ma completamente visibili

        // EO deve seguire sempre l'inizio visibile della timeline:
        // se la timeline si estende verso sinistra, anche il bracket EO si estende.
        const eoLeft = 0;

        const windows = [
          { key: "LP", left: lp1, right: lp2, top: TOP_LP, opacity: 0.65 },
          { key: "EO", left: eoLeft, right: hp1, top: TOP_MAIN, opacity: 0.85 },
          { key: "HP", left: hp1, right: hp2, top: TOP_MAIN, opacity: 0.75 },
        ];

        return windows.map((w) => {
          const width = Math.max(0, w.right - w.left);
          if (width < 2) return null;

          const hideLabel = width < 6;

          return (
            <div
              key={w.key}
              className="absolute"
              style={{
                left: `${w.left}%`,
                width: `${width}%`,
                top: `${w.top}px`,
                opacity: w.opacity,
              }}
            >
              <div className="relative h-[20px]">
                {/* linea orizzontale */} 
                <div className="absolute left-0 right-0 top-[10px] border-t border-slate-500/60 dark:border-white/60" />

                {/* tacche verticali ai bordi */}
                <div className="absolute left-0 top-[6px] h-[8px] border-l border-slate-500/60 dark:border-white/60" />
                <div className="absolute right-0 top-[6px] h-[8px] border-r border-slate-500/60 dark:border-white/60" />

                {/* label centrata */}
                {!hideLabel && (
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
                )}
              </div>
            </div>
          );
        });
      })()}
    </div>
  )}
  </div>

  {/* colonna ore lavorate (vuota per allineamento) */}
  <div className="flex-shrink-0 w-20 h-full" />
</div>

          {/* Header con orari - unico per tutti i cleaner */}
          <div className="relative z-20 flex items-stretch my-0.5 px-1 h-[40px]">
            <div
              className="relative z-10 flex-shrink-0 p-1 flex items-center justify-center h-full overflow-visible print:hidden translate-y-2"
              style={{ width: `${cleanerColumnWidth}px` }}
            >
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-[38px] z-0"
              >
                <svg className="h-full w-full" viewBox="0 0 160 38" preserveAspectRatio="none">
                  <path
                    d="M0,38 C16,38 30,34 44,26 C54,20 60,14 68,10 C72,8 76,7 80,7 C84,7 88,8 92,10 C100,14 106,20 116,26 C130,34 144,38 160,38 Z"
                    fill="rgba(239,68,68,0.14)"
                  />
                </svg>
              </div>
              <Button
                onClick={() => {
                  setCleanerIdsToRemove([]);
                  setShowRemoveCleanersDialog(true);
                }}
                variant="ghost"
                size="sm"
                disabled={
                  isRosterEditDisabled ||
                  cleaners.length === 0 ||
                  removeSelectedCleanersMutation.isPending
                }
                className={cn(
                  "absolute inset-x-0 bottom-0 z-10 h-[38px] w-full rounded-none border-0 bg-transparent p-0",
                  "text-red-700 dark:text-red-400 hover:bg-transparent hover:text-red-700 dark:hover:text-red-400"
                )}
                aria-label="Rimuovi cleaners convocati"
                title={
                  isRosterEditDisabled
                    ? rosterEditDisabledTitle
                    : cleaners.length === 0
                      ? "Nessun cleaner convocato da rimuovere"
                      : `Rimuovi convocati (${cleaners.length})`
                }
              >
                <UserMinus className="w-4 h-4" />
              </Button>
            </div>
            <div className="relative min-w-0 flex-1 h-full overflow-visible">
              {globalTimeSlots[0] && (
                <span
                  className={cn(
                    "pointer-events-none absolute left-0 top-[14px] z-30 inline-flex -translate-x-1/2 flex-col items-center gap-0.5 rounded bg-custom-blue-light px-1 text-[13px] font-medium tabular-nums leading-none text-foreground whitespace-nowrap",
                    timelineScrollLeft > 0 && "invisible"
                  )}
                >
                  <span>{globalTimeSlots[0]}</span>
                </span>
              )}
              <div
                ref={(node) => {
                  timelineRowRef.current = node;
                  registerTimelineScrollRef(node);
                }}
                onScroll={handleTimelineScroll}
                onPointerDown={handleTimelinePointerDown}
                onPointerMove={handleTimelinePointerMove}
                onPointerUp={stopTimelinePan}
                onPointerCancel={stopTimelinePan}
                className="timeline-center-scroll h-full w-full"
              >
                <div
                  className="relative h-full grid"
                  style={{ width: timelineScaledWidth, gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}
                >
                {globalTimeSlots.map((slot, idx) => (
                  <div
                    key={idx}
                    className="relative h-full"
                  >
                    <span
                      className={cn(
                        "absolute top-[14px] z-30 inline-flex flex-col items-center gap-0.5 rounded bg-custom-blue-light px-1 text-[13px] font-medium tabular-nums leading-none text-foreground whitespace-nowrap",
                        idx === 0 ? "invisible -translate-x-1/2" : "-translate-x-1/2"
                      )}
                      style={{ left: "0px" }}
                    >
                      <span>{slot}</span>
                    </span>
                    <div
                      className="absolute top-[30px] h-[8px] border-l border-slate-500/60 dark:border-white/60 z-10"
                      style={{ left: "0px" }}
                    />
                  </div>
                ))}
                {clockNowLineLeftPx != null && (
                  <HousekeepingClockNowLine
                    leftPx={clockNowLineLeftPx}
                    label={romeClockNow.label}
                    showLabel
                  />
                )}
                </div>
              </div>
            </div>
            <div className="flex-shrink-0 w-20 h-full text-center text-[13px] font-medium text-foreground border-l border-border/70 px-1 flex items-center justify-center">
              Ore lavorate
            </div>
          </div>

          {/* Righe cleaners + scrollbar/footer attaccati in fondo al contenuto */}
          <div className="timeline-rows-scroll relative z-0 min-h-0 flex-none overflow-x-hidden overflow-y-auto px-1 pb-0 pt-2">
            {allCleanersToShow.length === 0 && !isRosterEditDisabled ? (
              <div className="mb-0.5 flex min-w-0">
                <div className="flex min-w-0 flex-1 items-center justify-center rounded-lg border-2 border-yellow-300 bg-yellow-100 dark:border-yellow-700 dark:bg-yellow-950/50 h-64">
                  <div className="text-center p-6">
                    <Users className="mx-auto h-12 w-12 text-yellow-600 dark:text-yellow-400 mb-3" />
                    <h3 className="text-lg font-semibold text-yellow-800 dark:text-yellow-200 mb-2">
                      Nessun cleaner convocato
                    </h3>
                    <p className="text-yellow-700 dark:text-yellow-300">
                      Vai alla pagina Convocazioni per selezionare i cleaner da convocare
                    </p>
                  </div>
                </div>
                <div className="w-20 flex-shrink-0" aria-hidden />
              </div>
            ) : allCleanersToShow.length === 0 && isRosterEditDisabled ? (
              <div className="mb-0.5 flex min-w-0">
                <div className="flex min-w-0 flex-1 items-center justify-center rounded-lg border-2 border-red-300 bg-red-50 dark:border-blue-800 dark:bg-red-950/20 h-64">
                  <div className="text-center p-6">
                    <CalendarIcon className="mx-auto h-12 w-12 text-red-600 dark:text-red-400 mb-3" />
                    <h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
                      Nessuna assegnazione presente per questa data
                    </h3>
                    <p className="text-red-700 dark:text-red-300">
                      Non sono disponibili dati salvati per questa data passata
                    </p>
                  </div>
                </div>
                <div className="w-20 flex-shrink-0" aria-hidden />
              </div>
            ) : (
              allCleanersToShow.map((cleaner, index) => {
                const color = getCleanerColor(cleaner.id);
                const droppableId = `cleaner-${cleaner.id}`;
                const cleanerDisplay = getCleanerDisplayData(cleaner as Cleaner);
                const cleanerRole = cleanerDisplay.role;

                // Trova tutte le task assegnate a questo cleaner
                const cleanerTasks = tasks.filter(task =>
                  (task as any).assignedCleaner === cleaner.id
                ).map(normalizeTask); // Applica la normalizzazione qui

                // Durante il drag: nascondi travel/checkout così i task possono riordinarsi in modo ottimistico
                const hideRouteSpacers =
                  activeDragCleanerId === cleaner.id ||
                  draggingOverCleanerId === cleaner.id;

                const isRemoved = removedCleanerIds.has(cleaner.id);

                // Verifica se ci sono task incompatibili per questo cleaner
                // Controlla ogni coppia (task, cleaner) invece del solo cleanerId
                const hasIncompatibleTasks = validationRules && cleanerRole && !isOfficeCleanerRole(cleanerRole)
                  ? cleanerTasks.some(task => {
                      if (isReadonlyPreassignedTask(task)) return false;
                      if (canCleanerHandleTaskSync(
                        cleanerRole,
                        task,
                        validationRules,
                      )) return false;
                      const key = getIncompatibleKey(task, cleaner.id);
                      return !acknowledgedIncompatibleAssignments.has(key);
                    })
                  : false;

                // Usa la timeline globale
                const cleanerStartTime = cleaner.start_time || "10:00";

                return (
                  <div key={cleaner.id} className="mb-0.5 flex h-[50px] min-w-0 overflow-hidden">
                    {/* Info cleaner */}
                    <div
                      className={cn(
                        "flex-shrink-0 flex items-center overflow-hidden rounded-md border border-border/60 bg-custom-blue-light cursor-pointer hover:bg-muted/35 transition-colors",
                        filteredCleanerId === cleaner.id &&
                          "ring-2 ring-inset ring-blue-500 border-blue-500",
                        hasIncompatibleTasks &&
                          !isRemoved &&
                          "ring-2 ring-inset ring-yellow-500 border-yellow-500 animate-pulse"
                      )}
                      style={{
                        width: `${cleanerColumnWidth}px`,
                        userSelect: "none",
                        opacity: isRemoved ? 0.7 : 1,
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        if (isRemoved) {
                          // Cleaner rimosso: apri dialog sostituzione
                          setCleanerToReplace(cleaner.id);
                          loadAvailableCleaners();
                          setIsAddCleanerDialogOpen(true);
                        } else {
                          // Cleaner attivo: gestione normale (singolo/doppio click)
                          handleCleanerClick(cleaner, e);
                        }
                      }}
                      title={isRemoved ? "Cleaner rimosso - Click per sostituire" : hasIncompatibleTasks ? "⚠️ Cleaner con task incompatibili" : "Click: dettagli | Doppio click: filtra mappa"}
                    >
                      {!isRemoved && (
                        <div
                          className={cn(
                            "flex-shrink-0 self-center my-[2px] ml-[2px] h-[calc(100%-4px)] rounded-sm",
                            CLEANER_BOX_VARIANT === "left-bar" ? "w-1.5" : "w-7"
                          )}
                          style={{ backgroundColor: getPersonnelHexColor(cleaner.id, "housekeeping") }}
                        />
                      )}
                      <div className="min-w-0 w-full flex items-center gap-2 px-2">
                        <div className="truncate font-semibold text-[13px] leading-none flex-1">
                          {cleanerDisplay.primaryLabel.toUpperCase()}
                        </div>
                        {isRemoved && (
                          <div className="bg-red-600 text-white font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            RIMOSSO
                          </div>
                        )}
                        {/* Lucchetto per cleaner bloccati */}
                        {!isRemoved && lockedCleaners.has(cleaner.id) && (
                          <div className="flex-shrink-0 mr-1">
                            <Lock className="w-3 h-3 text-gray-600 dark:text-gray-400" />
                          </div>
                        )}
                        {/* Se straordinario, mostra SOLO badge S */}
                        {!isRemoved && cleanerRole === "Straordinario" ? (
                          <div className="bg-red-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            S
                          </div>
                        ) : (
                          /* Altrimenti mostra badge role normale */
                          <>
                            {!isRemoved && cleanerRole === "Premium" && (
                              <div className="bg-yellow-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                P
                              </div>
                            )}
                            {!isRemoved && cleanerRole === "Formatore" && (
                              <div className="bg-orange-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                F
                              </div>
                            )}
                            {!isRemoved && cleanerRole === "Ufficio" && (
                              <div className="bg-sky-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                U
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {/* Timeline per questo cleaner - area unica droppable */}
                    {(() => {
                      const cleanerTasks = tasks
                        .filter((task) =>
                          (task as any).assignedCleaner === cleaner.id
                        )
                        .map(normalizeTask)
                        .sort((a, b) => {
                          const taskA = a as any;
                          const taskB = b as any;

                          if (taskA.sequence !== undefined && taskB.sequence !== undefined) {
                            return taskA.sequence - taskB.sequence;
                          }

                          const timeA = taskA.start_time || taskA.fw_start_time || taskA.startTime || "00:00";
                          const timeB = taskB.start_time || taskB.fw_start_time || taskB.startTime || "00:00";
                          return timeA.localeCompare(timeB);
                        });
                      const itemIds = cleanerTasks.map((task) =>
                        taskDndId("housekeeping", getTaskDndKey(task), cleaner.id, "timeline")
                      );

                      return (
                        <DndDroppableSortableContainer
                          scope="housekeeping"
                          type="timeline"
                          staffId={cleaner.id}
                          itemIds={itemIds}
                          insertIndex={cleanerTasks.length}
                          disabled={isTimelineInteractionDisabled}
                          orientation="horizontal"
                          data-testid={`timeline-cleaner-${cleaner.id}`}
                          data-cleaner-id={cleaner.id}
                          innerRef={registerTimelineScrollRef}
                          onScroll={handleTimelineScroll}
                          onPointerDown={handleTimelinePointerDown}
                          onPointerMove={handleTimelinePointerMove}
                          onPointerUp={stopTimelinePan}
                          onPointerCancel={stopTimelinePan}
                          className="timeline-center-scroll relative min-w-0 min-h-[45px] flex-1 border-l border-border bg-background"
                        >
                          {(() => {
                            return (
                        <div
                          className="contents"
                        >
                          {/* Griglia oraria di sfondo (solo visiva) con alternanza colori */}
                          <div
                            className="absolute inset-y-0 left-0 pointer-events-none"
                            style={{ width: timelineScaledWidth, display: 'grid', gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}
                          >
                            {globalTimeSlots.map((slot, idx) => {
                              const isEvenHour = idx % 2 === 0;
                              return (
                                <div
                                  key={idx}
                                  className={`border-r border-border ${
                                    isEvenHour
                                      ? 'bg-blue-50/30 dark:bg-blue-950/10'
                                      : 'bg-sky-100/30 dark:bg-sky-900/10'
                                  }`}
                                  title={slot}
                                ></div>
                              );
                            })}
                            {clockNowLineLeftPx != null && (
                              <HousekeepingClockNowLine leftPx={clockNowLineLeftPx} />
                            )}
                          </div>

                          {/* Task posizionate in sequenza con indicatori di travel time */}
                          <div className="relative z-10 flex items-center h-full" style={{ minHeight: '45px', width: timelineScaledWidth, minWidth: "100%" }}>
                            {(() => {
                              // Optimistic insert gap sulla riga target quando l'item
                              // non è nel SortableContext (cross-cleaner o assign da container).
                              const isExternalAssignTargetRow =
                                hideRouteSpacers &&
                                draggingOverCleanerId === cleaner.id &&
                                activeDragCleanerId == null &&
                                lastValidDragIndex != null;
                              const isCrossCleanerTargetRow =
                                (hideRouteSpacers &&
                                  draggingOverCleanerId === cleaner.id &&
                                  activeDragCleanerId != null &&
                                  activeDragCleanerId !== cleaner.id &&
                                  lastValidDragIndex != null) ||
                                isExternalAssignTargetRow;
                              const isCrossCleanerSourceRow =
                                hideRouteSpacers &&
                                activeDragCleanerId === cleaner.id &&
                                draggingOverCleanerId != null &&
                                draggingOverCleanerId !== cleaner.id;
                              const crossCleanerInsertWidthPx = Math.max(
                                15 * timelinePxPerMinute,
                                COMPACT_DRAG_MIN_TIMELINE_TASK_WIDTH_PX,
                              );
                              const renderCrossCleanerInsertSlot = (atIndex: number) =>
                                isCrossCleanerTargetRow &&
                                lastValidDragIndex === atIndex ? (
                                  <div
                                    key={`cross-insert-${cleaner.id}-${atIndex}`}
                                    className="flex-shrink-0"
                                    style={{
                                      width: `${crossCleanerInsertWidthPx}px`,
                                      minHeight: "50px",
                                    }}
                                    aria-hidden
                                  />
                                ) : null;

                              return (
                                <>
                                  {cleanerTasks.map((task, idx) => {
                                    const taskObj = task as any;

                                    // Per il drag and drop, usa l'indice locale (idx) non globalIndex
                                    // React-beautiful-dnd richiede indici sequenziali 0,1,2,3... per ogni Droppable

                                    // Leggi travel_time dalla task normalizzata (che viene da timeline_assignments.json)
                                    // Prova sia travel_time che travelTime per compatibilità
                                    let travelTime = 0;
                                    if (taskObj.travel_time !== undefined && taskObj.travel_time !== null) {
                                      travelTime = typeof taskObj.travel_time === 'number'
                                        ? taskObj.travel_time
                                        : parseInt(String(taskObj.travel_time), 10);
                                    } else if (taskObj.travelTime !== undefined && taskObj.travelTime !== null) {
                                      travelTime = typeof taskObj.travelTime === 'number'
                                        ? taskObj.travelTime
                                        : parseInt(String(taskObj.travelTime), 10);
                                    }

                                    // Se il parsing fallisce, usa 0
                                    if (isNaN(travelTime)) {
                                      travelTime = 0;
                                    }

                                    // Helper: normalizza date "2025-12-15T..." -> "2025-12-15"
                                    const normDate = (d?: string | null) => (d ? String(d).slice(0, 10) : null);
                                    const parseClockToMinutes = (value?: string | null) => {
                                      if (!value) return null;
                                      const parts = String(value).split(':');
                                      if (parts.length < 2) return null;
                                      const hours = Number(parts[0]);
                                      const minutes = Number(parts[1]);
                                      if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
                                      return (hours * 60) + minutes;
                                    };

                                    // Usa sequence se disponibile, altrimenti fallback su idx+1
                                    const seq = (taskObj as any).sequence ?? (idx + 1);

                                    // Calcola offset iniziale: per la prima task usa SEMPRE lo start_time della task
                                    // (quando presente), così la posizione riflette il dato reale calcolato dal backend.
                                    let timeOffset = 0;
                                    if (seq === 1) {
                                      const gridStartMinutes = timeToMinutes(globalTimeSlots[0] || "10:00");
                                      const previewMinutes =
                                        firstAptTimeShiftPreview?.cleanerId === cleaner.id
                                          ? firstAptTimeShiftPreview.startMinutes
                                          : null;
                                      const taskStartMinutes = previewMinutes ?? parseClockToMinutes(
                                        taskObj.start_time || taskObj.fw_start_time || taskObj.startTime
                                      );
                                      const cleanerStartMinutes = parseClockToMinutes(cleanerStartTime);
                                      const firstBlockStartMinutes = taskStartMinutes ?? cleanerStartMinutes ?? gridStartMinutes;

                                      if (firstBlockStartMinutes > gridStartMinutes) {
                                        timeOffset = firstBlockStartMinutes - gridStartMinutes;
                                      }
                                    }

                                    // Calcola le larghezze con la stessa scala temporale usata da task e griglia.
                                    const effectiveTravelMinutes =
                                      seq >= 2 && travelTime > 0
                                        ? travelTime
                                        : 0;
                                    const travelWidthPx = effectiveTravelMinutes > 0 && timelinePxPerMinute > 0
                                      ? effectiveTravelMinutes * timelinePxPerMinute
                                      : 0;
                                    const initialOffsetWidthPx = seq === 1 && timeOffset > 0 && timelinePxPerMinute > 0
                                      ? timeOffset * timelinePxPerMinute
                                      : 0;
                                    const shouldShowInitialOffset = true;

                                    // CRITICAL FIX: Calcola il "waitingGap" per task con sequence >= 2
                                    // Il waitingGap rappresenta l'attesa del cleaner quando arriva prima che l'appartamento si liberi
                                    // IMPORTANTE: Mostra il waitingGap SOLO se la task corrente ha un checkout_time reale
                                    let waitingGap = 0;
                                    if (seq >= 2 && taskObj.start_time && taskObj.checkout_time) {
                                      // CRITICAL: L'array è ordinato per sequence, quindi idx-1 è la vera task precedente
                                      const prevTask = idx > 0 ? cleanerTasks[idx - 1] as any : null;

                                      const workDateStr = workDate;

                                      // CRITICAL: Normalizza le date per evitare mismatch di formato (es. "2025-12-15T00:00:00Z" vs "2025-12-15")
                                      const prevTaskDate = normDate(prevTask?.checkin_date);
                                      const prevTaskHasDifferentDate = !!(prevTaskDate && prevTaskDate !== workDateStr);
                                      
                                      if (prevTask && prevTask.end_time && !prevTaskHasDifferentDate) {
                                        // Calcola la fine prevista: end_time della task precedente + travel_time
                                        const [prevEndH, prevEndM] = prevTask.end_time.split(':').map(Number);
                                        const prevEndMinutes = prevEndH * 60 + prevEndM;
                                        const expectedStartMinutes = prevEndMinutes + travelTime;

                                        // Calcola lo start effettivo di questa task
                                        const [taskStartH, taskStartM] = taskObj.start_time.split(':').map(Number);
                                        const actualStartMinutes = taskStartH * 60 + taskStartM;

                                        // Se lo start effettivo è DOPO quello previsto, c'è un gap (attesa)
                                        if (actualStartMinutes > expectedStartMinutes) {
                                          waitingGap = actualStartMinutes - expectedStartMinutes;
                                        }
                                      }
                                    }
                                    const waitingGapWidthPx = waitingGap > 0 && timelinePxPerMinute > 0
                                      ? waitingGap * timelinePxPerMinute
                                      : 0;

                                    // Chiave univoca per task collaborative: include cleaner.id
                                    const taskId = taskObj.task_id || taskObj.id;
                                    const uniqueKey = `${taskId}-cleaner-${cleaner.id}`;
                                    const taskKey = getTaskDndKey(task);
                                    const dndId = taskDndId("housekeeping", taskKey, cleaner.id, "timeline");
                                    const dndData: AppDndItem = {
                                      kind: "task",
                                      scope: "housekeeping",
                                      taskId: taskKey,
                                      index: idx,
                                      initialIndex: idx,
                                      from: {
                                        type: "timeline",
                                        staffId: cleaner.id,
                                      },
                                    };

                                    // Verifica compatibilità task-cleaner
                                    const isIncompatible = validationRules && cleanerRole && !isOfficeCleanerRole(cleanerRole)
                                      ? !isReadonlyPreassignedTask(task) && !canCleanerHandleTaskSync(
                                          cleanerRole,
                                          task,
                                          validationRules,
                                        )
                                      : false;

                                    return (
                                      <React.Fragment key={uniqueKey}>
                                        {/* Offset iniziale prima della prima task - FUORI dal Draggable */}
                                        {seq === 1 && initialOffsetWidthPx > 0 && shouldShowInitialOffset && (
                                          <div
                                            className="flex-shrink-0"
                                            style={{ width: `${initialOffsetWidthPx}px`, minHeight: '50px' }}
                                            aria-hidden="true"
                                          />
                                        )}

                                        {/* Travel time marker - FUORI dal Draggable (solo per sequence >= 2) */}
                                        {!hideRouteSpacers && seq >= 2 && travelTime > 0 && travelWidthPx > 0 && (
                                          <div
                                            className="flex flex-shrink-0 cursor-pointer items-center"
                                            style={{ width: `${travelWidthPx}px`, minHeight: '50px' }}
                                            title={`${travelTime} min`}
                                          >
                                            <div
                                              aria-hidden
                                              className="h-0.5 w-full bg-slate-500/55 dark:bg-slate-400/40"
                                            />
                                          </div>
                                        )}

                                        {/* Waiting gap spacer - FUORI dal Draggable (solo per sequence >= 2) */}
                                        {!hideRouteSpacers && seq >= 2 && waitingGap > 0 && waitingGapWidthPx > 0 && (
                                          <div
                                            className="flex items-center justify-center flex-shrink-0 py-3 bg-amber-100/50 dark:bg-amber-900/20 border-y border-dashed border-amber-400"
                                            style={{ width: `${waitingGapWidthPx}px`, minHeight: '50px' }}
                                            title={`Attesa checkout: ${waitingGap} min`}
                                          >
                                            <svg
                                              width="16"
                                              height="16"
                                              viewBox="0 0 24 24"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="2"
                                              className="text-amber-600 dark:text-amber-400 flex-shrink-0"
                                            >
                                              <circle cx="12" cy="12" r="10"/>
                                              <polyline points="12,6 12,12 16,14"/>
                                            </svg>
                                          </div>
                                        )}

                                        {renderCrossCleanerInsertSlot(idx)}

                                        {/* TaskCard: in DnD tutti a 15'; lo slot di insert segue la card */}
                                        <FirstApartmentTimeShift
                                          enabled={
                                            seq === 1 &&
                                            !hideRouteSpacers &&
                                            !isTimelineInteractionDisabled &&
                                            !isReadonlyPreassignedTask(task)
                                          }
                                          isPinned={Boolean(taskObj.manual_start_time)}
                                          startTime={
                                            taskObj.start_time ||
                                            taskObj.fw_start_time ||
                                            taskObj.startTime
                                          }
                                          cleanerStartTime={cleanerStartTime}
                                          cleanerEndTime={cleaner.end_time || "20:00"}
                                          pxPerMinute={timelinePxPerMinute}
                                          leftSpacePx={initialOffsetWidthPx}
                                          disabled={isSavingFirstAptTime}
                                          onPreview={(startMinutes) =>
                                            setFirstAptTimeShiftPreview({
                                              cleanerId: cleaner.id,
                                              startMinutes,
                                            })
                                          }
                                          onCommit={(nextStart) =>
                                            persistFirstApartmentStart(
                                              cleaner.id,
                                              taskObj.task_id || taskObj.id,
                                              nextStart,
                                            )
                                          }
                                          onReset={() =>
                                            persistFirstApartmentStart(
                                              cleaner.id,
                                              taskObj.task_id || taskObj.id,
                                              null,
                                            )
                                          }
                                          onCancel={() => setFirstAptTimeShiftPreview(null)}
                                        >
                                        <SortableTaskCard
                                          key={uniqueKey}
                                          dndId={dndId}
                                          dndData={dndData}
                                          draggingOpacity={0}
                                          hideWhileDragging
                                          collapsePullPx={
                                            isCrossCleanerSourceRow
                                              ? crossCleanerInsertWidthPx
                                              : 0
                                          }
                                          task={task}
                                          index={idx}
                                          workDate={workDate}
                                          isInTimeline={true}
                                          allTasks={cleanerTasks}
                                          isDragDisabled={isTimelineInteractionDisabled}
                                          isReadOnly={isReadOnly}
                                          timelineWidthPx={timelineTaskWidthPx}
                                          timelinePxPerMinute={timelinePxPerMinute}
                                          minTimelineTaskWidthPx={
                                            hideRouteSpacers
                                              ? COMPACT_DRAG_MIN_TIMELINE_TASK_WIDTH_PX
                                              : MIN_TIMELINE_TASK_WIDTH_PX
                                          }
                                          compactAdamTimelineUi={hideRouteSpacers}
                                          isHighlighted={highlightedTaskIds.has(String(task.id))}
                                          cleanerId={cleaner.id}
                                          showExecutionStatusColors={showExecutionStatusColors}
                                        />
                                        </FirstApartmentTimeShift>
                                      </React.Fragment>
                                    );
                                  })}
                                  {renderCrossCleanerInsertSlot(cleanerTasks.length)}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                            );
                          })()}
                        </DndDroppableSortableContainer>
                      );
                    })()}
                    {/* Colonna ore totali lavorate */}
                    <div className="flex-shrink-0 w-20 h-[50px] flex items-center justify-center border-l border-border bg-sky-100/30 dark:bg-sky-900/10 text-center">
                      {(() => {
                        const cleanerTasks = tasks.filter(task =>
                          (task as any).assignedCleaner === cleaner.id
                        );
                        const totalMinutes = cleanerTasks.reduce((sum, task) => {
                          const ct = (task as any).cleaning_time || (task as any).cleaningTime || 0;
                          return sum + (typeof ct === 'number' ? ct : parseInt(ct, 10) || 0);
                        }, 0);
                        const hours = Math.floor(totalMinutes / 60);
                        const minutes = totalMinutes % 60;
                        return (
                          <span className="text-[13px] font-medium tabular-nums text-foreground">
                            {hours}:{String(minutes).padStart(2, '0')}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                );
              })
            )}

            {/* Scrollbar (solo se serve overflow) + riga + / Salvato / Trasferisci */}
            <div className="relative z-20 -mx-1 flex shrink-0 flex-col bg-custom-blue-light">
              <TimelineHorizontalScrollbar
                labelColumnWidth={cleanerColumnWidth}
                contentWidth={timelineScaledWidth}
                registerRef={registerTimelineScrollRef}
                onScroll={handleTimelineScroll}
              />
              <div className="relative flex h-[40px] shrink-0 items-stretch px-1">
                <div
                  className="relative flex-shrink-0 overflow-visible print:hidden"
                  style={{ width: `${cleanerColumnWidth}px` }}
                >
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 z-0"
                  >
                    <svg className="h-full w-full" viewBox="0 0 160 38" preserveAspectRatio="none">
                      <path
                        d="M0,0 C16,0 30,4 44,12 C54,18 60,24 68,28 C72,30 76,31 80,31 C84,31 88,30 92,28 C100,24 106,18 116,12 C130,4 144,0 160,0 Z"
                        fill="rgba(59,130,246,0.12)"
                      />
                    </svg>
                  </div>
                  <Button
                    onClick={() => {
                      setCleanerToReplace(null);
                      handleOpenAddCleanerDialog();
                    }}
                    variant="ghost"
                    size="sm"
                    className="absolute inset-0 z-10 h-full w-full rounded-none border-0 bg-transparent p-0 text-custom-blue hover:bg-transparent hover:text-custom-blue dark:hover:text-custom-blue"
                    disabled={isRosterEditDisabled}
                    aria-label="Aggiungi cleaner"
                    title={isRosterEditDisabled ? rosterEditDisabledTitle : "Aggiungi cleaner"}
                  >
                    <UserPlus className="w-4 h-4" />
                  </Button>
                </div>
                <div className="grid h-full flex-1 grid-cols-[1fr_auto] items-center pl-2 pr-0">
                  <div className="col-start-2 flex items-center gap-3 justify-self-end print:hidden">
                    {onOperationalDayToggle && (
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor="operational-day-switch"
                          className="cursor-pointer whitespace-nowrap text-sm font-medium leading-none text-custom-blue"
                        >
                          Inizio giornata operativa
                        </Label>
                        <Switch
                          id="operational-day-switch"
                          checked={isOperationalDayStarted}
                          onCheckedChange={(checked) => onOperationalDayToggle(Boolean(checked))}
                          disabled={isOperationalDaySwitchDisabled}
                          className="h-6 w-11 border-2 border-custom-blue data-[state=unchecked]:bg-sky-200 data-[state=checked]:bg-[hsl(199,89%,48%)] dark:data-[state=unchecked]:bg-sky-900/50 dark:data-[state=checked]:bg-[hsl(217,91%,53%)]"
                          data-testid="switch-operational-day"
                        />
                      </div>
                    )}
                  <Button
                    onClick={() => setShowAdamTransferDialog(true)}
                    size="sm"
                    variant="outline"
                    className="h-[38px] border-2 border-custom-blue px-3"
                    disabled={isReadOnly || !hasTasksInTimeline || isTransferringToAdam}
                    title={
                      isReadOnly
                        ? "Non puoi trasferire in modalità storico"
                        : !hasTasksInTimeline
                          ? "Nessuna task assegnata nella timeline"
                          : "Trasferisci le assegnazioni sul database ADAM"
                    }
                    data-testid="button-transfer-adam"
                  >
                    {isTransferringToAdam ? (
                      <RefreshCw className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <svg className="mr-1 h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                      </svg>
                    )}
                    {isTransferringToAdam ? "Trasferimento..." : "Trasferisci su ADAM"}
                  </Button>
                  </div>
                </div>
                <div
                  className="pointer-events-none absolute inset-y-0 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap text-sm font-medium leading-none text-slate-600 dark:text-slate-300"
                  data-testid="indicator-adam-last-save"
                >
                  <CheckCircle className="h-4 w-4 text-custom-blue" />
                  <span>
                    {lastAdamTransfer ? `Salvato il ${(() => {
                      const d = new Date(lastAdamTransfer);
                      const day = String(d.getDate()).padStart(2, '0');
                      const month = String(d.getMonth() + 1).padStart(2, '0');
                      const year = d.getFullYear();
                      const hours = String(d.getHours()).padStart(2, '0');
                      const minutes = String(d.getMinutes()).padStart(2, '0');
                      return `${day}/${month}/${year} alle ${hours}:${minutes}`;
                    })()}` : "Nessun salvataggio su ADAM"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Incompatible Tasks Warning Dialog */}
      <Dialog open={incompatibleDialog.open} onOpenChange={(open) => !open && setIncompatibleDialog({ open: false, cleanerId: null, tasks: [] })}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-yellow-600 dark:text-yellow-400 flex items-center gap-2">
              ⚠️ Attenzione: Task Incompatibili
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-base space-y-3">
                {incompatibleDialog.cleanerId && (() => {
                  const cleaner = allCleanersToShow.find(c => c.id === incompatibleDialog.cleanerId);
                  const cleanerDisplay = cleaner ? getCleanerDisplayDataByRaw(cleaner, cleaner.id) : null;
                  return cleaner ? (
                    <>
                      <p className="font-semibold text-foreground">
                        Il cleaner <span className="text-black dark:text-white">{cleanerDisplay?.fullName || cleanerDisplay?.primaryLabel}</span> ({cleanerDisplay?.role || cleaner.role}) ha delle task non compatibili con il suo ruolo:
                      </p>
                      <ul className="list-disc list-inside space-y-2 pl-2">
                        {incompatibleDialog.tasks.map((task, idx) => (
                          <li key={idx} className="text-foreground">
                            Task <span className="font-bold text-red-600">{task.logisticCode}</span> di tipo <span className="font-bold">{task.taskType}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null;
                })()}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end mt-4">
            <Button
              onClick={() => {
                if (incompatibleDialog.cleanerId) {
                  const cleanerId = incompatibleDialog.cleanerId;
                  const cleaner = allCleanersToShow.find(c => c.id === incompatibleDialog.cleanerId);
                  const cleanerRole = cleaner ? getCleanerDisplayDataByRaw(cleaner, cleaner.id).role : "";

                  if (cleaner && validationRules && cleanerRole && !isOfficeCleanerRole(cleanerRole)) {
                    // Recupera tutte le task di questo cleaner
                    const cleanerTasks = tasks
                      .filter(task => (task as any).assignedCleaner === cleanerId)
                      .map(normalizeTask);

                    // Aggiungi tutte le coppie (task incompatibile, cleaner) al Set
                    setAcknowledgedIncompatibleAssignments(prev => {
                      const next = new Set(prev);

                      cleanerTasks.forEach(task => {
                        if (!canCleanerHandleTaskSync(
                          cleanerRole,
                          task,
                          validationRules,
                        )) {
                          const key = getIncompatibleKey(task, cleanerId);
                          next.add(key);
                        }
                      });

                      return next;
                    });
                  }
                }
                setIncompatibleDialog({ open: false, cleanerId: null, tasks: [] });
              }}
              variant="outline"
              className="border-2 border-custom-blue"
            >
              Ho capito
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Alias Edit Dialog */}
      <Dialog open={aliasDialog.open} onOpenChange={(open) => !open && setAliasDialog({ open: false, cleanerId: null, cleanerName: '' })}>
        <DialogContent className="sm:max-md" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Alias
            </DialogTitle>
            <DialogDescription>
              Stai modificando l'alias di <strong>{aliasDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Nuovo Alias
              </label>
              <Input
                value={editingAlias}
                onChange={(e) => setEditingAlias(e.target.value)}
                placeholder="Inserisci alias"
                className="w-full"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveAlias();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAliasDialog({ open: false, cleanerId: null, cleanerName: '' })}
              disabled={isSavingAlias}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveAlias}
              disabled={isSavingAlias}
              className="border-2 border-custom-blue"
            >
              {isSavingAlias ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Salvataggio...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Salva
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Start Time Edit Dialog */}
      <Dialog open={startTimeEditDialog.open} onOpenChange={(open) => !open && setStartTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' })}>
        <DialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Modifica start time</DialogTitle>
            <DialogDescription>
              Orario di inizio per <strong>{startTimeEditDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <span className="text-sm font-semibold text-muted-foreground mb-2 block">Start time</span>
              <div className="flex items-center justify-center gap-1 bg-background border-2 border-custom-blue rounded-lg px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = editingStartTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes - 30;
                    if (totalMinutes < 0) totalMinutes += 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setEditingStartTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">−</span>
                </Button>
                <span className="text-lg font-mono font-bold min-w-[60px] text-center">{editingStartTime}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = editingStartTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes + 30;
                    if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setEditingStartTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">+</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">Intervalli di 30 minuti (+ / −)</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStartTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' })}
              className="border-2 border-custom-blue"
              disabled={isSavingStartTime}
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSaveStartTime()}
              disabled={isSavingStartTime}
              className="border-2 border-custom-blue"
            >
              {isSavingStartTime ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Salvataggio…
                </>
              ) : (
                "Salva"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* End Time Edit Dialog */}
      <Dialog open={endTimeEditDialog.open} onOpenChange={(open) => !open && setEndTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' })}>
        <DialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Modifica end time</DialogTitle>
            <DialogDescription>
              Orario di fine per <strong>{endTimeEditDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <span className="text-sm font-semibold text-muted-foreground mb-2 block">End time</span>
              <div className="flex items-center justify-center gap-1 bg-background border-2 border-custom-blue rounded-lg px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = editingEndTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes - 30;
                    if (totalMinutes < 0) totalMinutes += 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setEditingEndTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">−</span>
                </Button>
                <span className="text-lg font-mono font-bold min-w-[60px] text-center">{editingEndTime}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = editingEndTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes + 30;
                    if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setEditingEndTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">+</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">Intervalli di 30 minuti (+ / −)</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEndTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' })}
              className="border-2 border-custom-blue"
              disabled={isSavingEndTime}
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSaveEndTime()}
              disabled={isSavingEndTime}
              className="border-2 border-custom-blue"
            >
              {isSavingEndTime ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Salvataggio…
                </>
              ) : (
                "Salva"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Cleaner Removal */}
      <Dialog
        open={confirmRemovalDialog.open}
        onOpenChange={(open) =>
          setConfirmRemovalDialog((prev) => ({
            open,
            cleanerId: open ? prev.cleanerId : null,
          }))
        }
      >
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle>Conferma Rimozione Cleaner</DialogTitle>
            <DialogDescription>
              Sei sicuro di voler rimuovere "{confirmRemovalDialog.cleanerId !== null ? (() => {
                const cleaner = allCleanersToShow.find(c => c.id === confirmRemovalDialog.cleanerId);
                return cleaner ? `${cleaner.name} ${cleaner.lastname}` : 'Unknown';
              })() : ''}" dalla selezione? Le task modificabili rimarranno in timeline finché non verrà sostituito; se ha solo task read-only, verranno rimosse insieme al cleaner.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setConfirmRemovalDialog({ open: false, cleanerId: null })}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              onClick={handleConfirmRemoveCleaner}
              variant="outline"
              disabled={
                isRosterEditDisabled ||
                confirmRemovalDialog.cleanerId === null ||
                removeCleanerMutation.isPending
              }
              className="border-2 border-custom-blue hover:bg-accent hover:text-accent-foreground"
            >
              Conferma Rimozione
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog per rimuovere cleaners convocati (stesso stile di Aggiungi Cleaner) */}
      <Dialog
        open={showRemoveCleanersDialog}
        onOpenChange={(open) => {
          setShowRemoveCleanersDialog(open);
          if (!open) setCleanerIdsToRemove([]);
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Rimuovi Cleaner dalla Timeline</DialogTitle>
            <DialogDescription>
              Seleziona uno o più cleaners convocati da rimuovere. Le task modificabili restano in timeline finché non vengono riassegnate; se un cleaner ha solo task read-only, spariscono insieme a lui.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between mt-4 mb-2">
            <p className="text-sm text-muted-foreground">
              {cleanerIdsToRemove.length} selezionat{cleanerIdsToRemove.length === 1 ? "o" : "i"} su {cleaners.length}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-custom-blue"
              disabled={cleaners.length === 0 || removeSelectedCleanersMutation.isPending}
              onClick={() => {
                if (cleanerIdsToRemove.length === cleaners.length) {
                  setCleanerIdsToRemove([]);
                } else {
                  setCleanerIdsToRemove(cleaners.map((c) => Number(c.id)).filter((id) => Number.isFinite(id)));
                }
              }}
            >
              {cleanerIdsToRemove.length === cleaners.length && cleaners.length > 0
                ? "Deseleziona tutti"
                : "Seleziona tutti"}
            </Button>
          </div>
          <div className="space-y-2">
            {cleaners.length === 0 ? (
              <div className="flex min-h-[min(50vh,280px)] flex-col items-center justify-center py-8 px-2">
                <p className="text-muted-foreground text-center">Nessun cleaner convocato da rimuovere.</p>
              </div>
            ) : (
              [...cleaners]
                .sort((a, b) => {
                  const labelA = `${a.lastname || ""} ${a.name || ""}`.trim();
                  const labelB = `${b.lastname || ""} ${b.name || ""}`.trim();
                  return labelA.localeCompare(labelB, "it", { sensitivity: "base" });
                })
                .map((cleaner) => {
                  const isSelected = cleanerIdsToRemove.includes(cleaner.id);
                  return (
                    <div
                      key={cleaner.id}
                      className={`flex items-center justify-between p-3 border rounded-lg cursor-pointer ${
                        isSelected
                          ? "bg-accent border-custom-blue"
                          : "hover:bg-accent"
                      }`}
                      onClick={() => {
                        setCleanerIdsToRemove((prev) =>
                          prev.includes(cleaner.id)
                            ? prev.filter((id) => id !== cleaner.id)
                            : [...prev, cleaner.id]
                        );
                      }}
                      data-testid={`remove-cleaner-option-${cleaner.id}`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => {
                            setCleanerIdsToRemove((prev) =>
                              prev.includes(cleaner.id)
                                ? prev.filter((id) => id !== cleaner.id)
                                : [...prev, cleaner.id]
                            );
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <div className="min-w-0">
                          <p className="font-semibold">
                            {cleaner.name} {cleaner.lastname}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {cleaner.role} • Contratto: {cleaner.contract_type} • {Number(cleaner.counter_hours || 0).toFixed(2)}h
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {cleaner.role === "Formatore" && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                            Formatore
                          </span>
                        )}
                        {cleaner.role === "Standard" && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                            Standard
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
                        {cleaner.role === "Ufficio" && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200 border-sky-300 dark:border-sky-700">
                            Ufficio
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
            )}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => {
                setShowRemoveCleanersDialog(false);
                setCleanerIdsToRemove([]);
              }}
              disabled={removeSelectedCleanersMutation.isPending}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              onClick={() => removeSelectedCleanersMutation.mutate(cleanerIdsToRemove)}
              disabled={
                isRosterEditDisabled ||
                cleanerIdsToRemove.length === 0 ||
                removeSelectedCleanersMutation.isPending
              }
              className="border-2 border-custom-blue hover:bg-accent hover:text-accent-foreground"
            >
              {removeSelectedCleanersMutation.isPending ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Rimozione...
                </>
              ) : cleanerIdsToRemove.length === 0 ? (
                "Rimuovi selezionati"
              ) : (
                `Rimuovi selezionati (${cleanerIdsToRemove.length})`
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Cleaner Dialog */}
      <Dialog open={isAddCleanerDialogOpen} onOpenChange={(open) => {
        setIsAddCleanerDialogOpen(open);
        if (!open) {
          setCleanerToReplace(null);
          setConfirmUnavailableDialog({ open: false, cleanerId: null }); // Chiudi anche il dialog di conferma
          setPendingCleaner(null); // Clear pending cleaner when dialog is closed
        }
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {cleanerToReplace ? "Sostituisci Cleaner Rimosso" : "Aggiungi Cleaner alla Timeline"}
            </DialogTitle>
            <DialogDescription>
              {cleanerToReplace ? (
                <>
                  Sostituendo <strong>
                    {(() => {
                      const removedCleaner = allCleanersToShow.find(c => c.id === cleanerToReplace);
                      return removedCleaner
                        ? `${removedCleaner.name} ${removedCleaner.lastname}`
                        : `ID ${cleanerToReplace}`;
                    })()}
                  </strong> - Le sue task verranno assegnate al nuovo cleaner
                </>
              ) : (
                "Seleziona un cleaner disponibile da aggiungere alla timeline"
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-4">
            {isLoadingAvailableCleaners ? (
              <div className="flex min-h-[min(50vh,280px)] flex-col items-center justify-center gap-3 py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-custom-blue" />
                <p className="text-muted-foreground text-center">Caricamento cleaners disponibili...</p>
              </div>
            ) : availableCleaners.length === 0 ? (
              <div className="flex min-h-[min(50vh,280px)] flex-col items-center justify-center py-8 px-2">
                <p className="text-muted-foreground text-center">Nessun cleaner disponibile per questo scope.</p>
              </div>
            ) : (
              availableCleaners.map((cleaner) => {
                const isAvailable = cleaner.available !== false;

                return (
                  <div
                    key={cleaner.id}
                    className={`flex items-center justify-between p-3 border rounded-lg cursor-pointer ${
                      !isAvailable ? 'opacity-70 hover:opacity-80' : 'hover:bg-accent'
                    }`}
                    onClick={() => handleAddCleaner(cleaner.id, isAvailable)}
                    data-testid={`cleaner-option-${cleaner.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-semibold">
                          {cleaner.name} {cleaner.lastname}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {cleaner.role} • Contratto: {cleaner.contract_type} • {Number(cleaner.counter_hours || 0).toFixed(2)}h
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!isAvailable && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                          Non disponibile
                        </span>
                      )}
                      {cleaner.role === "Formatore" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                          Formatore
                        </span>
                      )}
                      {cleaner.role === "Standard" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                          Standard
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
                      {cleaner.role === "Ufficio" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200 border-sky-300 dark:border-sky-700">
                          Ufficio
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog per richiedere start time */}
      <Dialog open={startTimeDialog.open} onOpenChange={(open) => {
        if (!open) {
          setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
          if (skipReopenAddCleanerOnStartTimeCloseRef.current) {
            skipReopenAddCleanerOnStartTimeCloseRef.current = false;
            return;
          }
          setIsAddCleanerDialogOpen(true);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Inserisci Start Time</DialogTitle>
            <DialogDescription>
              Inserisci l'orario di inizio per <strong>{startTimeDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Start Time
              </label>
              <div className="flex items-center justify-center gap-1 bg-background border-2 border-custom-blue rounded-lg px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingStartTime.split(':').map(Number);
                    let totalMinutes = hours * 60 + minutes - 30;
                    if (totalMinutes < 0) totalMinutes += 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                    setPendingStartTime(newTime);
                  }}
                >
                  <span className="text-lg font-bold">−</span>
                </Button>
                <span className="text-lg font-mono font-bold min-w-[60px] text-center">
                  {pendingStartTime}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingStartTime.split(':').map(Number);
                    let totalMinutes = hours * 60 + minutes + 30;
                    if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                    setPendingStartTime(newTime);
                  }}
                >
                  <span className="text-lg font-bold">+</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Usa i pulsanti + e − per regolare a intervalli di 30 minuti
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
                setIsAddCleanerDialogOpen(true);
              }}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleConfirmStartTimeAndAdd}
              disabled={isRosterEditDisabled}
              className="border-2 border-custom-blue"
            >
              Conferma e Aggiungi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Unavailable Cleaners */}
      <Dialog open={confirmUnavailableDialog.open} onOpenChange={(open) => setConfirmUnavailableDialog({ open, cleanerId: null })}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle>Conferma Aggiunta Cleaner</DialogTitle>
            <DialogDescription>
              Il cleaner selezionato "{confirmUnavailableDialog.cleanerId ? (() => {
                const cleaner = availableCleaners.find(c => c.id === confirmUnavailableDialog.cleanerId);
                return cleaner ? `${cleaner.name} ${cleaner.lastname}` : 'Unknown';
              })() : ''}" non è attualmente disponibile. Vuoi comunque aggiungerlo?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmUnavailableDialog({ open: false, cleanerId: null })}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleConfirmAddUnavailableCleaner}
              disabled={isRosterEditDisabled}
              className="border-2 border-custom-blue"
            >
              Conferma e Aggiungi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cleaner Details Dialog */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent
          className={cn(
            "sm:max-w-2xl max-h-[80vh] overflow-y-auto",
            // LIGHT: bianco
            "bg-white",
            // DARK: stesso background del dialog Dettagli Task (quello di default di shadcn: bg-background)
            "dark:bg-background",
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                Dettagli Cleaner #{selectedCleaner?.id}
                {selectedCleaner && (
                  <>
                    {/* Se straordinario, mostra SOLO badge straordinario (priorità assoluta) */}
                    {getCleanerDisplayData(selectedCleaner).role === "Straordinario" ? (
                      <span className="px-2 py-0.5 rounded border font-medium text-sm bg-red-600/30 text-gray-900 dark:bg-red-500/40 dark:text-red-200 border-red-700 dark:border-red-400">
                        Straordinario
                      </span>
                    ) : (
                      /* Altrimenti mostra badge role normale */
                      <>
                        {getCleanerDisplayData(selectedCleaner).role === "Formatore" ? (
                          <span className="px-2 py-0.5 rounded border font-medium text-sm bg-orange-600/30 text-gray-900 dark:bg-orange-500/40 dark:text-orange-200 border-orange-700 dark:border-orange-400">
                            Formatore
                          </span>
                        ) : getCleanerDisplayData(selectedCleaner).role === "Premium" ? (
                          <span className="px-2 py-0.5 rounded border font-medium text-sm bg-yellow-600/30 text-gray-900 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-700 dark:border-yellow-400">
                            Premium
                          </span>
                        ) : getCleanerDisplayData(selectedCleaner).role === "Ufficio" ? (
                          <span className="px-2 py-0.5 rounded border font-medium text-sm bg-sky-600/30 text-gray-900 dark:bg-sky-500/40 dark:text-sky-200 border-sky-700 dark:border-sky-400">
                            Ufficio
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded border font-medium text-sm bg-green-600/30 text-gray-900 dark:bg-green-500/40 dark:text-green-200 border-green-700 dark:border-green-400">
                            Standard
                          </span>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>

              {selectedCleaner && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  disabled={isReadOnly || isSavingCleanerLock}
                  onClick={async () => {
                    if (!selectedCleaner) return;
                    const cleanerId = selectedCleaner.id;
                    const nextLocked = !lockedCleaners.has(cleanerId);

                    // optimistic UI
                    setLockedCleaners(prev => {
                      const next = new Set(prev);
                      if (nextLocked) next.add(cleanerId);
                      else next.delete(cleanerId);
                      return next;
                    });

                    setIsSavingCleanerLock(true);
                    try {
                      const response = await fetch('/api/cleaner-locks/set', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          date: workDate,
                          cleanerId,
                          isLocked: nextLocked
                        })
                      });
                      const data = await response.json();
                      if (!response.ok || !data?.success) {
                        throw new Error(data?.error || 'Impossibile salvare blocco cleaner');
                      }

                      toast({
                        title: nextLocked ? "Cleaner bloccato" : "Cleaner sbloccato",
                        description: `Cleaner #${cleanerId} ${nextLocked ? 'escluso' : 'riammesso'} per ${workDate}`,
                        variant: "success",
                      });
                    } catch (error: any) {
                      // revert optimistic UI
                      setLockedCleaners(prev => {
                        const next = new Set(prev);
                        if (nextLocked) next.delete(cleanerId);
                        else next.add(cleanerId);
                        return next;
                      });
                      toast({
                        title: "Errore",
                        description: error?.message || "Impossibile aggiornare lock del cleaner",
                        variant: "destructive",
                      });
                    } finally {
                      setIsSavingCleanerLock(false);
                    }
                  }}
                >
                  {lockedCleaners.has(selectedCleaner?.id) ? (
                    <Lock className="h-4 w-4 stroke-[2.5]" />
                  ) : (
                    <Unlock className="h-4 w-4 stroke-[2.5]" />
                  )}
                </Button>
              )}
            </DialogTitle>
          </DialogHeader>

          {selectedCleaner && (
            <div className="space-y-4 text-gray-900 dark:text-foreground">
              <div className="grid grid-cols-4 gap-x-6 gap-y-4">
                {/* Alias (LARGO 2/4) */}
                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1 flex items-center gap-1">
                    Alias
                    {!isReadOnly && <Pencil className="w-3 h-3 text-gray-700 dark:text-muted-foreground/60" />}
                  </p>
                  <p
                    className={`text-sm p-2 rounded border ${
                      !isReadOnly ? "cursor-pointer hover:bg-muted/50 border-border hover:border-custom-blue" : "border-border"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) handleOpenAliasDialog(selectedCleaner);
                    }}
                  >
                    {getCleanerDisplayData(selectedCleaner).primaryLabel}
                  </p>
                </div>

                {/* Nome (1/4) */}
                <div className="col-span-1">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">Nome</p>
                  <Input
                    value={getCleanerDisplayData(selectedCleaner).name.toUpperCase()}
                    readOnly
                    className={displayInputClass}
                  />
                </div>

                {/* Cognome (1/4) */}
                <div className="col-span-1">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">Cognome</p>
                  <Input
                    value={getCleanerDisplayData(selectedCleaner).lastname.toUpperCase()}
                    readOnly
                    className={displayInputClass}
                  />
                </div>

                {/* Giorni lavorati (2/4) */}
                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">Giorni lavorati</p>
                  <div className={cn("flex items-center h-9 min-h-9", displayInputClass)}>
                    <span className="text-sm tabular-nums">
                      {selectedCleaner.counter_days ?? ""}
                    </span>
                    {selectedCleaner.show_plus_one && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-sm font-semibold text-yellow-600 dark:text-yellow-500 ml-1">
                            (+1)
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>In programma per questa data ma report non ancora compilato</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>

                {/* Ore lavorate (2/4) */}
                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">
                    Ore lavorate questa settimana
                  </p>
                  <Input
                    value={String(selectedCleaner.counter_hours ?? "")}
                    readOnly
                    className={displayInputClass}
                  />
                </div>

                {/* Start Time (1/4) + End Time (1/4) — metà sinistra */}
                <div className="col-span-1">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1 flex items-center gap-1">
                    Start Time
                    {!isReadOnly && <Pencil className="w-3 h-3 text-gray-700 dark:text-muted-foreground/60" />}
                  </p>
                  <p
                    className={`text-sm p-2 rounded border ${
                      !isReadOnly ? "cursor-pointer hover:bg-muted/50 border-border hover:border-custom-blue" : "border-border"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) handleOpenStartTimeDialog(selectedCleaner);
                    }}
                  >
                    {selectedCleaner.start_time || "10:00"}
                  </p>
                </div>

                <div className="col-span-1">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1 flex items-center gap-1">
                    End Time
                    {!isReadOnly && <Pencil className="w-3 h-3 text-gray-700 dark:text-muted-foreground/60" />}
                  </p>
                  <p
                    className={`text-sm p-2 rounded border ${
                      !isReadOnly ? "cursor-pointer hover:bg-muted/50 border-border hover:border-custom-blue" : "border-border"
                    }`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) handleOpenEndTimeDialog(selectedCleaner);
                    }}
                  >
                    {selectedCleaner.end_time || "20:00"}
                  </p>
                </div>

                {/* Tipo contratto (2/4) — metà destra */}
                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">Tipo contratto</p>
                  <Input
                    value={String(selectedCleaner.contract_type ?? "")}
                    readOnly
                    className={displayInputClass}
                  />
                </div>
              </div>

              {/* Sezione Scambia Cleaner */}
              <div className="border-t pt-4 mt-4">
                <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-3">Scambia Cleaner</p>
                <p className="text-xs text-gray-700 dark:text-muted-foreground mb-3">
                  Seleziona un altro cleaner per scambiare le task assegnate.
                </p>
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <Select
                      value={selectedSwapCleaner}
                      onValueChange={setSelectedSwapCleaner}
                      disabled={swapCleanersMutation.isPending || isReadOnly}
                    >
                      <SelectTrigger data-testid="select-swap-cleaner">
                        <SelectValue placeholder="Seleziona cleaner..." />
                      </SelectTrigger>
                      <SelectContent>
                        {cleaners
                          .filter((c) => c.id !== selectedCleaner.id)
                          .map((cleaner) => (
                            <SelectItem
                              key={cleaner.id}
                              value={String(cleaner.id)}
                              data-testid={`option-cleaner-${cleaner.id}`}
                            >
                              {getCleanerDisplayData(cleaner).primaryLabel}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={handleSwapCleaners}
                    disabled={!selectedSwapCleaner || swapCleanersMutation.isPending || isReadOnly}
                    variant="default"
                    className="flex gap-2"
                    data-testid="button-swap-cleaner"
                  >
                    {swapCleanersMutation.isPending ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Scambio...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        Scambia
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Sezione Rimuovi Cleaner */}
              <div className="border-t pt-4 mt-4">
                <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-3">Rimuovi Cleaner</p>
                <p className="text-xs text-gray-700 dark:text-muted-foreground mb-3">
                  Il cleaner sarà rimosso dalla selezione, ma le sue task rimarranno in timeline. Sarà necessario assegnarle a un
                  altro cleaner.
                </p>
                <Button
                  onClick={() => {
                    setConfirmRemovalDialog({ open: true, cleanerId: selectedCleaner.id });
                    setIsModalOpen(false);
                  }}
                  disabled={removeCleanerMutation.isPending || isRosterEditDisabled}
                  variant="destructive"
                  className="w-full"
                  data-testid="button-remove-cleaner"
                >
                  Rimuovi dalla selezione
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog di conferma per il trasferimento su ADAM */}
      <AlertDialog open={showAdamTransferDialog} onOpenChange={setShowAdamTransferDialog}>
        <AlertDialogContent className="sm:max-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <CheckCircle className="w-5 h-5" />
              Conferma Trasferimento su ADAM
            </AlertDialogTitle>
            <AlertDialogDescription>
              <p className="text-base text-foreground font-semibold mb-3">
                Salvando su ADAM eventuali assegnazioni salvate precedentemente in questa data, VERRANNO SOVRASCRITTE!
              </p>
              <p className="text-sm text-muted-foreground">
                Sei sicuro di voler procedere? Questa azione è irreversibile.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setShowAdamTransferDialog(false)}
              className="border-2 border-custom-blue"
            >
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTransferToAdam}
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Conferma Trasferimento
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog di conferma per il reset assegnazioni */}
      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent className="sm:max-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <RotateCcw className="w-5 h-5" />
              Conferma Reset Assegnazioni
            </AlertDialogTitle>
            <AlertDialogDescription>
              <p className="text-base text-foreground font-semibold mb-3">
                Tutte le task assegnate nella timeline verranno riportate nei containers originali (Early Out, High Priority, Low Priority).
              </p>
              <p className="text-sm text-muted-foreground">
                Sei sicuro di voler procedere? Questa azione è irreversibile.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setShowResetDialog(false)}
              className="border-2 border-custom-blue"
            >
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowResetDialog(false);
                handleResetAssignments();
              }}
              disabled={isResetting}
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Ho capito
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog per l'Optimizer */}
      <Dialog open={showOptimizerDialog} onOpenChange={setShowOptimizerDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-green-600 dark:text-green-400">
              <Zap className="w-5 h-5" />
              Auto-Assegnazione Intelligente
            </DialogTitle>
            <DialogDescription>
              L'ottimizzatore assegnerà automaticamente le task ai cleaners selezionati, 
              rispettando le finestre orarie di priorità e ottimizzando i tempi di viaggio.
            </DialogDescription>
          </DialogHeader>
          
          {optimizerResult ? (
            <div className="space-y-4">
              <div className={`p-4 rounded-lg border-2 ${optimizerResult.status === 'success' ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-700' : 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-700'}`}>
                <h4 className={`font-semibold mb-2 ${optimizerResult.status === 'success' ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                  {optimizerResult.status === 'success' ? '✓ Ottimizzazione completata!' : '✗ Errore durante l\'ottimizzazione'}
                </h4>
                {optimizerResult.summary && (
                  <div className="text-sm space-y-1">
                    <p><strong>Task processate:</strong> {optimizerResult.summary.totalTasksProcessed}</p>
                    <p><strong>Task assegnate:</strong> {optimizerResult.summary.tasksAssigned}</p>
                    <p><strong>Task non assegnate:</strong> {optimizerResult.summary.tasksUnassigned}</p>
                    <p><strong>Cleaners utilizzati:</strong> {optimizerResult.summary.cleanersUsed}</p>
                    <p className="text-muted-foreground"><strong>Tempo:</strong> {(optimizerResult.totalDurationMs / 1000).toFixed(2)}s</p>
                  </div>
                )}
                {optimizerResult.error && (
                  <p className="text-red-600 dark:text-red-400 text-sm mt-2">{optimizerResult.error}</p>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    setOptimizerResult(null);
                    setShowOptimizerDialog(false);
                    window.dispatchEvent(new CustomEvent('refresh-assignments'));
                  }}
                  className="border-2 border-green-500 dark:border-green-600"
                >
                  Chiudi e Aggiorna
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg border border-yellow-300 dark:border-yellow-700">
                <p className="text-sm text-yellow-700 dark:text-yellow-300">
                  <strong>Nota:</strong> Le task già assegnate (locked) non verranno modificate. 
                  Solo le task nei containers verranno elaborate.
                </p>
              </div>
              
              <div className="flex justify-end gap-2">
                <Button 
                  variant="outline" 
                  onClick={() => setShowOptimizerDialog(false)}
                  disabled={isRunningOptimizer}
                  className="border-2 border-custom-blue"
                >
                  Annulla
                </Button>
                <Button 
                  onClick={async () => {
                    setIsRunningOptimizer(true);
                    setOptimizerResult(null);
                    try {
                      const response = await fetch('/api/optimizer/run-all', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ 
                          date: workDate,
                          skipPhase4: false,
                          applyToProduction: true
                        })
                      });
                      const result = await response.json();
                      setOptimizerResult(result);
                      if (result.success) {
                        toast({
                          title: "Ottimizzazione completata",
                          description: `${result.summary?.tasksAssigned || 0} task assegnate automaticamente`,
                        });
                      } else {
                        toast({
                          title: "Errore ottimizzazione",
                          description: result.error || "Si è verificato un errore",
                          variant: "destructive"
                        });
                      }
                    } catch (error: any) {
                      setOptimizerResult({ 
                        status: 'failed', 
                        error: error.message || "Errore di connessione" 
                      });
                      toast({
                        title: "Errore",
                        description: error.message || "Impossibile eseguire l'ottimizzazione",
                        variant: "destructive"
                      });
                    } finally {
                      setIsRunningOptimizer(false);
                    }
                  }}
                  disabled={isRunningOptimizer}
                  className="bg-green-600 hover:bg-green-700 text-white"
                >
                  {isRunningOptimizer ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Ottimizzazione in corso...
                    </>
                  ) : (
                    <>
                      <Zap className="mr-2 h-4 w-4" />
                      Avvia Ottimizzatore
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}




