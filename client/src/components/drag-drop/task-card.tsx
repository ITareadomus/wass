import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { TaskType as Task } from "@shared/schema";
import {
  pickLogisticsViolationFields,
  shouldBlinkLogisticsTimelineTask,
} from "@shared/logistics-scheduling-constraints";
import {
  resolveLogisticsTaskKind,
  type LogisticsTaskKind,
} from "@shared/logistics-task-kind";
import {
  DIALOG_SECTION_CORNER_BADGE_WRAP_CLASS,
  LOGISTICS_KIND_BADGE_LABEL,
  LogisticsKindAddBadge,
  LogisticsKindBadge,
  LogisticsKindPickerDialog,
  LogisticsSequenceBadge,
  logisticsKindStripeClass,
} from "@/lib/logistics-task-kind-ui";
import { format, parseISO } from "date-fns";
import { it } from "date-fns/locale";
import { fetchWithOperation } from '@/lib/operationManager';
import { openTimelineMapPanel } from "@/lib/timeline-map-panel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Calendar as CalendarPicker } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { HelpCircle, ChevronLeft, ChevronRight, Save, Pencil, Calendar as CalendarIcon, Lock, LockOpen, Users, UserPlus, Trash2, RefreshCw, Truck, Building2, User } from "lucide-react";
import { CleanerSelectorDialog } from "@/components/dialogs/cleaner-selector-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { isContinuazioneStraordinariaTask } from "@/lib/taskValidation";
import {
  getHousekeepingTypeTier,
  type HousekeepingTypeTier,
} from "@/lib/housekeeping-intervention-type";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Normalizza la chiave di una task indipendentemente dal campo usato
const getTaskKey = (t: any) => String(t?.id ?? t?.task_id ?? t?.logistic_code ?? "");

// Chiave di navigazione per il dialog (evita collisioni su task_id duplicati).
const getTaskNavigationKey = (t: any, listIndex?: number) =>
  `${getTaskKey(t)}::${String((t as any)?.sequence ?? "")}::${String(listIndex ?? "")}`;

// Legge le pending edits da sessionStorage
const getPendingEdits = (): Record<string, any> => {
  try {
    return JSON.parse(sessionStorage.getItem('pending_task_edits') || '{}');
  } catch {
    return {};
  }
};

// Applica le pending edits a una task per la visualizzazione
const applyPendingEdits = (task: any): any => {
  const taskKey = getTaskKey(task);
  const pendingEdits = getPendingEdits();
  const edits = pendingEdits[taskKey];
  
  if (!edits) return task;
  
  // CRITICAL: Per operation_id, usa il flag operationIdModified per sapere se è stato modificato
  // Se operationIdModified è true, usa il valore (anche se null)
  // Se operationIdModified è false/undefined, usa il valore originale
  const operationIdToUse = edits.operationIdModified 
    ? edits.operationId 
    : task.operation_id;
  
  // Crea una copia della task con le modifiche applicate
  return {
    ...task,
    checkout_date: edits.checkoutDate !== undefined ? edits.checkoutDate : task.checkout_date,
    checkout_time: edits.checkoutTime !== undefined ? edits.checkoutTime : task.checkout_time,
    checkin_date: edits.checkinDate !== undefined ? edits.checkinDate : task.checkin_date,
    checkin_time: edits.checkinTime !== undefined ? edits.checkinTime : task.checkin_time,
    pax_in: edits.paxIn !== undefined ? edits.paxIn : task.pax_in,
    operation_id: operationIdToUse,
    // Converti cleaningTime in duration formato "H.MM"
    duration: edits.cleaningTime !== undefined 
      ? `${Math.floor(edits.cleaningTime / 60)}.${String(edits.cleaningTime % 60).padStart(2, '0')}`
      : task.duration,
    _hasPendingEdits: true, // Flag per indicare che ha modifiche pendenti
  };
};

// Normalizza data nel formato YYYY-MM-DD per il picker HTML5
const normalizeDate = (dateStr: any): string => {
  if (!dateStr) return "";
  try {
    // Se è già nel formato YYYY-MM-DD, ritorna così
    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }
    // Prova a convertire da vari formati
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch (e) {
    // Silenziosamente fallisce
  }
  return "";
};

// Normalizza ora nel formato HH:MM per il picker HTML5
const normalizeTime = (timeStr: any): string => {
  if (!timeStr) return "";
  try {
    // Se è già nel formato HH:MM, ritorna così
    if (typeof timeStr === 'string' && /^\d{2}:\d{2}$/.test(timeStr)) {
      return timeStr;
    }
    // Se è HH:MM:SS, rimuovi i secondi
    if (typeof timeStr === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(timeStr)) {
      return timeStr.substring(0, 5);
    }
  } catch (e) {
    // Silenziosamente fallisce
  }
  return "";
};

const PREASSIGNED_REASON_NORMAL = "preassigned_enable_wass";
const PREASSIGNED_REASON_READONLY = "preassigned_enable_wass_readonly";
type PreAssignedMode = "normal" | "readonly";

const normalizeReasons = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const reason of value) {
    const normalized = String(reason ?? "").trim();
    if (!normalized) continue;
    out.add(normalized);
  }
  return Array.from(out);
};

const resolvePreAssignedModeFromTask = (task: any): PreAssignedMode | null => {
  const explicit = String(task?.preAssignedMode ?? "").trim().toLowerCase();
  if (explicit === "readonly") return "readonly";
  if (explicit === "normal") return "normal";
  const reasons = normalizeReasons(task?.reasons);
  if (reasons.includes(PREASSIGNED_REASON_READONLY)) return "readonly";
  if (reasons.includes(PREASSIGNED_REASON_NORMAL)) return "normal";
  return null;
};

interface MultiSelectContextType {
  isMultiSelectMode: boolean;
  selectedTasks: Array<{ taskId: string; order: number; container?: string }>;
  toggleMode: () => void;
  toggleTask: (taskId: string, container?: string) => void;
  clearSelection: () => void;
  isTaskSelected: (taskId: string) => boolean;
  getTaskOrder: (taskId: string) => number | undefined;
}

export interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
  allTasks?: Task[];
  currentContainer?: 'early-out' | 'high' | 'low' | string;
  isDuplicate?: boolean;
  isDragDisabled?: boolean;
  isReadOnly?: boolean;
  multiSelectContext?: MultiSelectContextType | null;
  isIncompatible?: boolean;
  timelineWidthPx?: number;
  timelinePxPerMinute?: number;
  minTimelineTaskWidthPx?: number;
  dragOverlayWidthPx?: number;
  travelTime?: number;
  travelWidthPx?: number;
  waitingGap?: number;
  waitingGapWidthPx?: number;
  isHighlighted?: boolean;
  cleanerId?: number | null;
  draggableId?: string;
  dragWrapper?: "none";
  externalIsDragging?: boolean;
  externalDragHandleProps?: React.HTMLAttributes<HTMLDivElement> &
    React.RefAttributes<HTMLDivElement>;
  /** housekeeping → /api/operations (enable_wass); logistics → enable_wass_route */
  operationsScope?: "housekeeping" | "office" | "logistics";
  /**
   * Solo housekeeping/office: durante il DnD timeline, card compatte a 15 min
   * con solo codice ADAM (come la timeline logistica).
   */
  compactAdamTimelineUi?: boolean;
  /** Solo timeline logistica: nome driver (colonna sinistra). Non usare per HK — lì sarebbe il cleaner. */
  timelineRowStaffDisplayLabel?: string | null;
  /** Dopo mutazione timeline logistica (es. tipologia manuale). */
  onLogisticsTimelineMutated?: () => void;
}

function getTaskMapMarkerId(task: Task): string {
  const collaboratorIds = (task as any).collaborator_ids as number[] | null;
  const isCollaborativeTask = collaboratorIds && Array.isArray(collaboratorIds) && collaboratorIds.length > 1;
  const assignedCleaner = (task as any).assignedCleaner as number | null;
  const baseTaskId = String(
    (task as any).task_id ?? (task as any).taskId ?? (task as any).id ?? task.name ?? ""
  );
  return isCollaborativeTask && assignedCleaner != null
    ? `${baseTaskId}:${assignedCleaner}`
    : baseTaskId;
}

interface AssignedTask {
  task_id: number;
  logistic_code: number;
  start_time: string;
  end_time: string;
  travel_time?: number;
}

const LOGISTICS_ADAM_MAX_FONT_PX = 10;
const LOGISTICS_ADAM_MIN_FONT_PX = 8;
const LOGISTICS_ADAM_BASE_SCALE = 0.82;
const LOGISTICS_ADAM_MIN_SCALE = 0.58;
const LOGISTICS_ADAM_HEIGHT_BOOST = 1.12;
const LOGISTICS_ADAM_FIT_SAFETY_PX = 3;

function LogisticsAdamCodeLabel({ code }: { code: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [labelStyle, setLabelStyle] = useState<{ fontSize: number; scaleX: number }>({
    fontSize: LOGISTICS_ADAM_MAX_FONT_PX,
    scaleX: LOGISTICS_ADAM_BASE_SCALE,
  });

  const fitLabel = useCallback(() => {
    const container = containerRef.current;
    const text = textRef.current;
    if (!container || !text) return;

    const available = container.clientWidth;
    if (available <= 0) return;

    const targetWidth = Math.max(available - LOGISTICS_ADAM_FIT_SAFETY_PX, 1);

    const measureAt = (fontSize: number) => {
      text.style.fontSize = `${fontSize}px`;
      text.style.transform = "scale(1)";
      text.style.transformOrigin = "center";
      void text.offsetWidth;
      return text.getBoundingClientRect().width;
    };

    let chosenFont = LOGISTICS_ADAM_MIN_FONT_PX;
    for (
      let fontSize = LOGISTICS_ADAM_MAX_FONT_PX;
      fontSize >= LOGISTICS_ADAM_MIN_FONT_PX;
      fontSize -= 0.5
    ) {
      if (measureAt(fontSize) <= targetWidth) {
        chosenFont = fontSize;
        break;
      }
    }

    const measuredWidth = measureAt(chosenFont);
    const fitScale = targetWidth / Math.max(measuredWidth, 1);
    const chosenScale = Math.max(
      LOGISTICS_ADAM_MIN_SCALE,
      Math.min(LOGISTICS_ADAM_BASE_SCALE, fitScale)
    );

    setLabelStyle((prev) =>
      prev.fontSize === chosenFont && prev.scaleX === chosenScale
        ? prev
        : { fontSize: chosenFont, scaleX: chosenScale }
    );
  }, [code]);

  useLayoutEffect(() => {
    fitLabel();
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => fitLabel());
    observer.observe(container);
    return () => observer.disconnect();
  }, [fitLabel, code]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-y-0 left-[8px] right-[1px] z-30 flex items-center justify-center overflow-hidden"
    >
      <span
        ref={textRef}
        className="inline-block max-w-full whitespace-nowrap text-center font-extrabold leading-none tracking-[-0.04em] text-foreground drop-shadow-[0_1px_1px_rgba(255,255,255,0.85)] dark:drop-shadow-[0_1px_1px_rgba(0,0,0,0.85)]"
        style={{
          fontSize: `${labelStyle.fontSize}px`,
          transform: `scale(${labelStyle.scaleX}, ${labelStyle.scaleX * LOGISTICS_ADAM_HEIGHT_BOOST})`,
          transformOrigin: "center",
        }}
      >
        {code}
      </span>
    </div>
  );
}

export default function TaskCard({
  task,
  index,
  isInTimeline = false,
  allTasks = [],
  currentContainer = '',
  isDuplicate = false,
  isDragDisabled = false,
  isReadOnly = false,
  multiSelectContext = null,
  isIncompatible = false,
  timelineWidthPx = 0,
  timelinePxPerMinute = 0,
  minTimelineTaskWidthPx = 0,
  dragOverlayWidthPx,
  travelTime = 0,
  travelWidthPx = 0,
  waitingGap = 0,
  waitingGapWidthPx = 0,
  isHighlighted = false,
  cleanerId = null,
  externalIsDragging = false,
  externalDragHandleProps,
  operationsScope = "housekeeping",
  compactAdamTimelineUi = false,
  timelineRowStaffDisplayLabel = null,
  onLogisticsTimelineMutated,
}: TaskCardProps) {
  console.log('🔧 TaskCard render - isReadOnly:', isReadOnly, 'for task:', task.name);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showDissolveDialog, setShowDissolveDialog] = useState(false);
  const [isCollaborationDetailsOpen, setIsCollaborationDetailsOpen] = useState(false);
  const [isDissolvingCollaboration, setIsDissolvingCollaboration] = useState(false);
  
  const [clickTimer, setClickTimer] = useState<NodeJS.Timeout | null>(null);

  const displayInputClass =
  "h-9 border-transparent bg-transparent shadow-none focus-visible:ring-0 px-0 pointer-events-none select-none";

const displayClickableInputClass =
  "h-9 border-transparent bg-transparent shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:outline-none focus:border-transparent px-0";

  const isOfficeScope = (() => {
    if (operationsScope === "office") return true;
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("scope") === "office";
  })();

  // Carica le operazioni da API (DB)
  const { data: operationsData } = useQuery<{
    active_operations: { id: number; name: string; enable_wass?: boolean; enable_wass_readonly?: boolean }[];
  }>({
    queryKey: ["/api/operations", operationsScope, isOfficeScope ? "office" : "default"],
    queryFn: async () => {
      const q =
        operationsScope === "logistics"
          ? "?for=logistics"
          : isOfficeScope
            ? "?scope=office"
            : "";
      const response = await fetch(`/api/operations${q}`);
      if (!response.ok) throw new Error("Failed to fetch operations");
      return response.json();
    },
    staleTime: 60000,
  });

  const officeOperationNames: Record<number, string> = {
    15: "PULIZIA UFFICI/ALTRO",
    38: "PULIZIA UFFICI/ALTRO STRAORDINARIA",
  };
  const defaultOperationNames: Record<number, string> = {
    1: "FERMATA",
    2: "PARTENZA",
    3: "PULIZIA STRAORDINARIA",
    4: "RIPASSO",
  };

  const selectableOperations = (operationsData?.active_operations || []).filter(
    (op) => isOfficeScope || op.enable_wass !== false
  );

  const operationNames: Record<number, string> = operationsData?.active_operations?.reduce(
    (acc, op) => ({ ...acc, [op.id]: op.name }),
    isOfficeScope ? ({ ...officeOperationNames } as Record<number, string>) : defaultOperationNames
  ) || (isOfficeScope
    ? { ...officeOperationNames }
    : defaultOperationNames);

  const normalizeOperationName = (name: string | null | undefined) =>
    (name || "").toLowerCase().trim();

  const CORE_WASS_OPERATION_IDS = new Set([1, 2, 3, 4, 37]);
  const CORE_WASS_OPERATION_NAMES = new Set([
    "fermata",
    "partenza",
    "pulizia straordinaria",
    "ripasso",
    "continuazione ps",
  ]);

  const getOperationNameFromTask = (taskObj: any) => {
    const opId = taskObj?.operation_id;
    if (opId == null) return "";
    return operationNames[opId] || "";
  };

  const isOfficeOtherOperation = (taskObj: any) =>
    normalizeOperationName(getOperationNameFromTask(taskObj)) === "pulizia uffici/altro";

  const isOfficeStraordinariaOperation = (taskObj: any) =>
    ["pulizia uffici straordinaria", "pulizia uffici/altro straordinaria"].includes(
      normalizeOperationName(getOperationNameFromTask(taskObj))
    );

  const isRipassoOperation = (taskObj: any) => {
    const opId = Number(taskObj?.operation_id);
    if (opId === 4) return true;
    const n = normalizeOperationName(getOperationNameFromTask(taskObj));
    return n.includes("ripasso");
  };

  const getInterventionLabel = (taskObj: any): string => {
    const explicitName = String(
      taskObj?.operation_name ??
      taskObj?.operationName ??
      taskObj?.operation_label ??
      ""
    ).trim();
    if (explicitName) return explicitName;

    const fromOperationMap = String(getOperationNameFromTask(taskObj) || "").trim();
    if (fromOperationMap) return fromOperationMap;

    const opId = Number(taskObj?.operation_id);
    if (Number.isFinite(opId)) return `Intervento ${opId}`;

    return "Intervento extra";
  };

  const getExternalInterventionBadgeLabel = (
    taskObj: any,
    isStraordinariaTask: boolean,
    isPremiumTask: boolean
  ): string | null => {
    if (isStraordinariaTask || isPremiumTask) return null;

    const normalizedName = normalizeOperationName(
      String(
        taskObj?.operation_name ??
        taskObj?.operationName ??
        taskObj?.operation_label ??
        getOperationNameFromTask(taskObj) ??
        ""
      )
    );
    const opId = Number(taskObj?.operation_id);
    const hasExternalOperationId = Number.isFinite(opId) && !CORE_WASS_OPERATION_IDS.has(opId);
    const hasExternalOperationName =
      normalizedName.length > 0 && !CORE_WASS_OPERATION_NAMES.has(normalizedName);

    if (!hasExternalOperationId && !hasExternalOperationName) return null;

    return getInterventionLabel(taskObj).toUpperCase();
  };

  const [isMapFiltered, setIsMapFiltered] = useState(false);
  
  // Estrai locked e locked_reason dal task per dependency stabili
  const taskLocked = (task as any).locked ?? false;
  const taskLockedReason = (task as any).locked_reason ?? '';
  const preAssignedMode = resolvePreAssignedModeFromTask(task);
  const isPreAssigned = preAssignedMode === "readonly" || preAssignedMode === "normal";
  const isPreAssignedReadonly = preAssignedMode === "readonly";
  const isTaskReadOnly = isReadOnly || isPreAssignedReadonly;
  
  // Stato per blocco task
  const [isLocked, setIsLocked] = useState(taskLocked);
  const [lockedReason, setLockedReason] = useState(taskLockedReason);
  const [isEditingReason, setIsEditingReason] = useState(false);

  // Sincronizza isLocked quando il task cambia (es. dopo ricaricamento containers)
  useEffect(() => {
    setIsLocked(taskLocked);
    setLockedReason(taskLockedReason);
  }, [taskLocked, taskLockedReason, task.id]);

  // Usa il context multi-select dalla prop (solo per container, non timeline)
  const isMultiSelectMode = multiSelectContext?.isMultiSelectMode ?? false;
  const isSelected = multiSelectContext?.isTaskSelected(String(task.id)) ?? false; // Pass String ID
  const selectionOrder = multiSelectContext?.getTaskOrder(String(task.id)); // Pass String ID

  // Sincronizza con il filtro mappa per evidenziazione
  useEffect(() => {
    const checkMapFilter = setInterval(() => {
      const currentFilteredTaskId = (window as any).mapFilteredTaskId;
      // Per task collaborativi usa ID composto taskId:cleanerId.
      const markerId = getTaskMapMarkerId(task);
      
      const shouldBeFiltered = currentFilteredTaskId === markerId;
      if (shouldBeFiltered !== isMapFiltered) {
        setIsMapFiltered(shouldBeFiltered);
      }
    }, 100);

    return () => clearInterval(checkMapFilter);
  }, [task.id, isMapFiltered, task]);

  // Gestisce il click sulla card: se multi-select toggle selezione, altrimenti apri modale
  const handleCardClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // In multi-select mode nei container: toggle selezione invece di aprire modale
    if (isMultiSelectMode && !isInTimeline && multiSelectContext) {
      multiSelectContext.toggleTask(String(task.id), currentContainer);
      return;
    }

    // Gestione doppio click per mostrare task sulla mappa
    if (clickTimer) {
      // Doppio click rilevato
      clearTimeout(clickTimer);
      setClickTimer(null);

      // Toggle filtro mappa per questa task (attiva/disattiva animazione)
      // Per task collaborativi usa ID composto "taskId:cleanerId" per identificare il marker specifico
      const markerId = getTaskMapMarkerId(task);
      
      const currentFilteredTaskId = (window as any).mapFilteredTaskId;
      if (currentFilteredTaskId === markerId) {
        // Spegni animazione
        (window as any).mapFilteredTaskId = null;
      } else {
        // Accendi animazione
        (window as any).mapFilteredTaskId = markerId;
        openTimelineMapPanel();
      }
    } else {
      // Primo click: avvia timer
      const timer = setTimeout(() => {
        // Singolo click: apri modale
        setIsModalOpen(true);
        setClickTimer(null);
      }, 250);

      setClickTimer(timer);
    }
  };

  const [currentTaskId, setCurrentTaskId] = useState(getTaskNavigationKey(task, index));
  const [assignmentTimes, setAssignmentTimes] = useState<{ start_time?: string; end_time?: string; travel_time?: number }>({});
  const [logisticsDriverBadge, setLogisticsDriverBadge] = useState<string | null>(null);
  const [resolvedLogisticsDriverTaskKey, setResolvedLogisticsDriverTaskKey] = useState<string>("");
  const [logisticsHousekeepingCleanerLabel, setLogisticsHousekeepingCleanerLabel] = useState<string | null>(null);
  const [logisticsHousekeepingCleanerId, setLogisticsHousekeepingCleanerId] = useState<number | null>(null);
  const [logisticsHousekeepingSequence, setLogisticsHousekeepingSequence] = useState<number | null>(null);
  const [logisticsHousekeepingStartTime, setLogisticsHousekeepingStartTime] = useState<string | null>(null);
  const [logisticsHousekeepingEndTime, setLogisticsHousekeepingEndTime] = useState<string | null>(null);
  const [logisticsHousekeepingTravelTime, setLogisticsHousekeepingTravelTime] = useState<number | null>(null);
  const [logisticsTimelineSequence, setLogisticsTimelineSequence] = useState<number | null>(null);
  const [logisticsTimelineStartTime, setLogisticsTimelineStartTime] = useState<string | null>(null);
  const [logisticsTimelineEndTime, setLogisticsTimelineEndTime] = useState<string | null>(null);
  const [logisticsTimelineTravelTime, setLogisticsTimelineTravelTime] = useState<number | null>(null);
  const [logisticsHousekeepingNotes, setLogisticsHousekeepingNotes] = useState<string | null>(null);
  const [customerNotesByTaskKey, setCustomerNotesByTaskKey] = useState<Record<string, string>>({});
  const [logisticsStructureBeds, setLogisticsStructureBeds] = useState<{
    single_beds: number | null;
    double_beds: number | null;
    single_sofabeds: number | null;
    double_sofabeds: number | null;
  } | null>(null);
  const [logisticsStructureAlertKeys, setLogisticsStructureAlertKeys] = useState<number | null>(null);
  const [resolvedHousekeepingTaskKey, setResolvedHousekeepingTaskKey] = useState<string>("");
  /** Evita reset API ad ogni re-render se la chiave task è la stessa (displayTask spesso nuovo per riferimento). */
  const lastLogisticsDriverFetchTaskKeyRef = useRef<string>("");
  const lastHousekeepingDetailsFetchTaskKeyRef = useRef<string>("");
  const lastCollaboratorsTaskIdRef = useRef<number | null>(null);
  const initializedEditFieldsTaskKeyRef = useRef<string>("");
  const isLogisticsTimelineDetails = operationsScope === "logistics" && isInTimeline;
  /** Timeline logistica (sempre) o HK in DnD: card 15' + solo codice ADAM */
  const showCompactAdamTimelineUi =
    isInTimeline &&
    (operationsScope === "logistics" || compactAdamTimelineUi);
  const isHousekeepingDetails = operationsScope === "housekeeping";
  const isHousekeepingTimelineDetails = operationsScope === "housekeeping" && isInTimeline;
  const isLogisticsDetails = operationsScope === "logistics";
  // Dialog completo in tutte le pagine non-office (timeline + containers).
  const isTimelineDetailsDialog = !isOfficeScope;
  const { toast } = useToast();

  // Handler per toggle blocco task
  const handleToggleLock = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newLocked = !isLocked;
    const newReason = newLocked ? lockedReason : '';
    
    // Ottieni la data selezionata da localStorage
    const selectedWorkDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
    
    // Usa task_id se disponibile, altrimenti task.id
    const taskId = (task as any).task_id || task.id;
    
    try {
      const response = await fetch('/api/lock-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: taskId,
          logistic_code: task.name,
          locked: newLocked,
          locked_reason: newReason,
          date: selectedWorkDate,
        }),
      });
      
      if (response.ok) {
        setIsLocked(newLocked);
        if (!newLocked) {
          setLockedReason('');
          setIsEditingReason(false);
        }
        toast({
          title: newLocked ? "Task bloccata" : "Task sbloccata",
          description: newLocked ? "La task non può essere assegnata o trascinata" : "La task è ora disponibile",
        });
        // Ricarica i container per aggiornare lo stato del pulsante Assegna
        if ((window as any).reloadAllTasks) {
          await (window as any).reloadAllTasks();
        }
      }
    } catch (error) {
      console.error('Errore nel blocco task:', error);
      toast({
        title: "Errore",
        description: "Impossibile modificare lo stato del blocco",
        variant: "destructive",
      });
    }
  };

  const handleSaveLockedReason = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Ottieni la data selezionata da localStorage
    const selectedWorkDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
    
    // Usa task_id se disponibile, altrimenti task.id
    const taskId = (task as any).task_id || task.id;
    
    try {
      const response = await fetch('/api/lock-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: taskId,
          logistic_code: task.name,
          locked: isLocked,
          locked_reason: lockedReason,
          date: selectedWorkDate,
        }),
      });
      
      if (response.ok) {
        setIsEditingReason(false);
        toast({
          title: "Motivo salvato",
          description: "Il motivo del blocco è stato aggiornato",
        });
      }
    } catch (error) {
      console.error('Errore nel salvataggio motivo:', error);
    }
  };

  // Handler per aggiungere collaboratori a task esistente in timeline
  const handleCollaboratorSelection = async (selectedCleanerIds: number[]) => {
    if (selectedCleanerIds.length === 0) return;
    
    const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
    const taskId = (task as any).task_id || task.id;
    
    setIsCollaboratorLoading(true);
    
    try {
      // Aggiungi collaboratori a task esistente in timeline
      for (const cleanerId of selectedCleanerIds) {
        const response = await fetch(`/api/tasks/${taskId}/collaborators/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: workDate,
            cleanerId: cleanerId,
          }),
        });
        
        const data = await response.json();
        
        if (response.status === 409) {
          toast({
            title: "Collisione oraria",
            description: data.message || "Il collaboratore ha già task che si sovrappongono",
            variant: "destructive",
          });
          continue;
        }
        
        if (!response.ok) {
          throw new Error(data.error || "Errore nell'aggiunta collaboratore");
        }
      }
      
      toast({
        title: "Collaboratori aggiunti",
        description: `${selectedCleanerIds.length} cleaner(s) aggiunti alla task`,
      });
      
      // Chiudi dialog e modale
      setIsCleanerSelectorOpen(false);
      setIsModalOpen(false);
      
      // IMPORTANTE: Prima ricarica i selected_cleaners (per includere auto-convocati)
      if ((window as any).loadSelectedCleaners) {
        await (window as any).loadSelectedCleaners();
      }
      
      // Poi ricarica timeline e containers
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
      
    } catch (error: any) {
      console.error('Errore nella gestione collaboratori:', error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile completare l'operazione",
        variant: "destructive",
      });
    } finally {
      setIsCollaboratorLoading(false);
    }
  };

  // Apri il dialog per aggiungere collaboratori (solo timeline)
  const openAddCollaboratorDialog = () => {
    setIsCleanerSelectorOpen(true);
  };

  // Stati per editing - ora un set di campi invece di uno solo
  const [editingFields, setEditingFields] = useState<Set<'duration' | 'checkout' | 'checkin' | 'paxin' | 'operation'>>(new Set());
  const [editedCheckoutDate, setEditedCheckoutDate] = useState("");
  const [editedCheckoutTime, setEditedCheckoutTime] = useState("");
  const [editedCheckinDate, setEditedCheckinDate] = useState("");
  const [editedCheckinTime, setEditedCheckinTime] = useState("");
  const [editedDuration, setEditedDuration] = useState("");
  const [editedPaxIn, setEditedPaxIn] = useState("");
  const [editedOperationId, setEditedOperationId] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Stato per il dialog Modifica Pax-In (stesso stile di Alias/Start Time in Dettagli Cleaner)
  const [paxInDialogOpen, setPaxInDialogOpen] = useState(false);
  const [editingPaxInInDialog, setEditingPaxInInDialog] = useState("");
  const [isSavingPaxIn, setIsSavingPaxIn] = useState(false);
  const [customerNoteDialogOpen, setCustomerNoteDialogOpen] = useState(false);
  const [logisticsKindPickerOpen, setLogisticsKindPickerOpen] = useState(false);
  const [isSavingLogisticsKind, setIsSavingLogisticsKind] = useState(false);
  const [logisticsKindOverridesByTaskId, setLogisticsKindOverridesByTaskId] = useState<
    Record<
      string,
      {
        kind: LogisticsTaskKind;
        source: "manual";
      }
    >
  >({});
  const [editingCustomerNoteInDialog, setEditingCustomerNoteInDialog] = useState("");
  const [isSavingCustomerNote, setIsSavingCustomerNote] = useState(false);

  // Dialog Check-out (data + orario)
  const [checkoutDialogOpen, setCheckoutDialogOpen] = useState(false);
  const [checkoutDatePickerOpen, setCheckoutDatePickerOpen] = useState(false);
  const [editingCheckoutDateInDialog, setEditingCheckoutDateInDialog] = useState("");
  const [editingCheckoutTimeInDialog, setEditingCheckoutTimeInDialog] = useState("");
  const [isSavingCheckout, setIsSavingCheckout] = useState(false);

  // Dialog Check-in (data + orario)
  const [checkinDialogOpen, setCheckinDialogOpen] = useState(false);
  const [checkinDatePickerOpen, setCheckinDatePickerOpen] = useState(false);
  const [editingCheckinDateInDialog, setEditingCheckinDateInDialog] = useState("");
  const [editingCheckinTimeInDialog, setEditingCheckinTimeInDialog] = useState("");
  const [isSavingCheckin, setIsSavingCheckin] = useState(false);

  // Dialog Tipologia intervento
  const [operationDialogOpen, setOperationDialogOpen] = useState(false);
  const [editingOperationIdInDialog, setEditingOperationIdInDialog] = useState("");
  const [isSavingOperation, setIsSavingOperation] = useState(false);
  
  // Stato per il dialog di selezione collaboratori
  const [isCleanerSelectorOpen, setIsCleanerSelectorOpen] = useState(false);
  const [isCollaboratorLoading, setIsCollaboratorLoading] = useState(false);
  
  // Stato per forzare re-render quando pending edits cambiano
  const [pendingEditsVersion, setPendingEditsVersion] = useState(0);

  // Stato per i collaboratori caricati
  const [taskCollaborators, setTaskCollaborators] = useState<any[]>([]);
  const [isLoadingCollabs, setIsLoadingCollabs] = useState(false);

  // CRITICAL: Applica le pending edits alla task per la visualizzazione nella card
  const taskWithPendingEdits = React.useMemo(() => applyPendingEdits(task), [task, pendingEditsVersion]);

  // Determina le task navigabili in base al contesto
  const getNavigableTasks = (): Task[] => {
    if (isInTimeline) {
      const taskAssignedCleaner = (task as any).assignedCleaner;
      const allHaveAssigned = allTasks.every(t => (t as any).assignedCleaner != null);
      return allHaveAssigned
        ? allTasks.filter(t => (t as any).assignedCleaner === taskAssignedCleaner)
        : allTasks; // fallback, le tasks che arrivano da TimelineView sono già del cleaner corrente
    } else {
      return allTasks.filter(t => t.priority === task.priority);
    }
  };

  // CRITICAL: Memoizza navigableTasks per evitare ricalcoli che causano mismatch
  const navigableTasks = React.useMemo(() => {
    const tasks = allTasks.filter(t => {
      const sameCleaner = (t as any).assignedCleaner === (task as any).assignedCleaner;
      // NON escludere task senza assignedCleaner: basta che sia lo stesso cleaner della corrente
      return sameCleaner;
    });
    // Mappa con una chiave consistente e univoca anche in presenza di task_id duplicati
    return tasks.map((t, idx) => ({
      ...t,
      __key: getTaskNavigationKey(t, idx),
      __taskKey: getTaskKey(t),
    }));
  }, [allTasks, task]);

  // Trova l'indice effettivo della task nel cleaner
  const { currentIndex, effectiveCurrentId, currentTaskInNavigable, displayTask, canGoPrev, canGoNext } = React.useMemo(() => {
    const normalizedCurrentId = currentTaskId ? String(currentTaskId) : null;
    const normalizedTaskId = getTaskNavigationKey(task, index);
    const normalizedPlainTaskId = getTaskKey(task);

    // CRITICAL: Cerca l'indice della task corrente (quella cliccata)
    let currIdx = navigableTasks.findIndex(t => (t as any).__key === (normalizedCurrentId || normalizedTaskId));

    // Se non trovato, usa l'indice della task originale
    if (currIdx === -1) {
      currIdx = navigableTasks.findIndex(t => (t as any).__key === normalizedTaskId);
    }
    if (currIdx === -1) {
      currIdx = navigableTasks.findIndex(t => (t as any).__taskKey === normalizedPlainTaskId);
    }

    // Se ancora non trovato, usa 0 come fallback
    const safeIdx = currIdx >= 0 ? currIdx : 0;
    const effId = currIdx >= 0 ? (navigableTasks[currIdx] as any).__key : normalizedTaskId;
    const curr = navigableTasks[safeIdx];
    // CRITICAL: Applica le pending edits per la visualizzazione immediata
    const disp = applyPendingEdits(curr || task);

    const prev = safeIdx > 0;
    const next = safeIdx < navigableTasks.length - 1;

    return {
      currentIndex: safeIdx,
      effectiveCurrentId: effId,
      currentTaskInNavigable: curr,
      displayTask: disp,
      canGoPrev: prev,
      canGoNext: next
    };
  }, [navigableTasks, currentTaskId, task, index, pendingEditsVersion]);

  const dialogTaskKey = getTaskKey(displayTask) || getTaskKey(task);
  const dialogTaskIdRaw =
    (displayTask as any).task_id ??
    (displayTask as any).id ??
    (task as any).task_id ??
    (task as any).id;
  const dialogTaskId = Number(dialogTaskIdRaw);
  const dialogLogisticCodeRaw =
    (displayTask as any).logistic_code ??
    (displayTask as any).name ??
    (task as any).logistic_code ??
    (task as any).name ??
    "";
  const dialogStructureIdRaw =
    (displayTask as any).structure_id ??
    (displayTask as any).structureId ??
    (task as any).structure_id ??
    (task as any).structureId ??
    "";

  // Carica i dettagli della collaborazione per la task attualmente mostrata nel dialog.
  useEffect(() => {
    let cancelled = false;

    const fetchCollaborators = async () => {
      if (!isModalOpen) {
        if (!cancelled) {
          lastCollaboratorsTaskIdRef.current = null;
          setTaskCollaborators([]);
          setIsLoadingCollabs(false);
        }
        return;
      }

      if (!Number.isFinite(dialogTaskId)) {
        if (!cancelled) {
          lastCollaboratorsTaskIdRef.current = null;
          setTaskCollaborators([]);
          setIsLoadingCollabs(false);
        }
        return;
      }

      if (!cancelled) {
        const taskChanged = lastCollaboratorsTaskIdRef.current !== dialogTaskId;
        lastCollaboratorsTaskIdRef.current = dialogTaskId;
        setIsLoadingCollabs(true);
        if (taskChanged) {
          setTaskCollaborators([]);
        }
      }

      try {
        const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
        const response = await fetch(`/api/tasks/${dialogTaskId}/collaborators?date=${workDate}`);
        const data = await response.json().catch(() => ({}));
        if (cancelled) return;
        if (data.success) {
          setTaskCollaborators(Array.isArray(data.collaborators) ? data.collaborators : []);
        } else {
          setTaskCollaborators([]);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Errore caricamento collaboratori:", error);
          setTaskCollaborators([]);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCollabs(false);
        }
      }
    };

    void fetchCollaborators();
    return () => {
      cancelled = true;
    };
  }, [isModalOpen, dialogTaskId]);

  console.log('🔍 Stato navigazione:', {
    currentTaskId,
    effectiveCurrentId,
    navigableTasksCount: navigableTasks.length,
    currentIndex: currentIndex,
    canGoPrev: canGoPrev,
    canGoNext: canGoNext
  });

  const handlePrevTask = () => {
    if (canGoPrev && currentIndex > 0) {
      const prevTask = navigableTasks[currentIndex - 1];
      setCurrentTaskId((prevTask as any).__key);
    }
  };

  const handleNextTask = () => {
    if (canGoNext && currentIndex < navigableTasks.length - 1) {
      const nextTask = navigableTasks[currentIndex + 1];
      setCurrentTaskId((nextTask as any).__key);
    }
  };

  // Reset editingFields quando il modal si chiude o quando diventa readonly
  useEffect(() => {
    if (!isModalOpen || isTaskReadOnly) {
      setEditingFields(new Set());
    }
  }, [isModalOpen, isTaskReadOnly]);

  // All'apertura del modal, allinea sempre la task corrente a quella cliccata.
  // Evita che un currentTaskId stale faccia aprire sempre la stessa task.
  useEffect(() => {
    if (isModalOpen) {
      setCurrentTaskId(getTaskNavigationKey(task, index));
    }
  }, [isModalOpen, task, index]);

  // Helper per toggleare un campo in editing
  const toggleEditingField = (field: 'duration' | 'checkout' | 'checkin' | 'paxin' | 'operation') => {
    setEditingFields(prev => {
      const newSet = new Set(prev);
      if (newSet.has(field)) {
        newSet.delete(field);
      } else {
        newSet.add(field);
      }
      return newSet;
    });
  };

  // Inizializza i campi quando il modale si apre o quando displayTask cambia
  // MA NON se l'utente sta già modificando campi o se è readonly
  useEffect(() => {
    if (isModalOpen && editingFields.size === 0 && !isTaskReadOnly) {
      const shouldInit =
        initializedEditFieldsTaskKeyRef.current !== dialogTaskKey ||
        initializedEditFieldsTaskKeyRef.current === "";
      if (!shouldInit) {
        return;
      }
      initializedEditFieldsTaskKeyRef.current = dialogTaskKey;
      console.log('🔓 Modale aperto per task:', {
        taskId: task.id,
        allTasksCount: allTasks?.length || 0,
        allTasksIds: allTasks?.map(t => getTaskKey(t)) || [],
        isInTimeline,
        currentContainer
      });

      // Inizializza campi editabili con i valori attuali della task visualizzata (normalizzati)
      setEditedCheckoutDate(normalizeDate((displayTask as any).checkout_date));
      setEditedCheckoutTime(normalizeTime((displayTask as any).checkout_time));
      setEditedCheckinDate(normalizeDate((displayTask as any).checkin_date));
      setEditedCheckinTime(normalizeTime((displayTask as any).checkin_time));

      // Converti duration da "1.30" a "90" minuti
      const duration = displayTask.duration || "0.0";
      const [hours, mins] = duration.split('.').map(Number);
      const totalMinutes = (hours || 0) * 60 + (mins || 0);
      setEditedDuration(totalMinutes.toString());

      // Inizializza pax-in
      setEditedPaxIn(String((displayTask as any).pax_in || 0));

      // Inizializza operation_id
      setEditedOperationId(String((displayTask as any).operation_id || ""));
    }
  }, [isModalOpen, dialogTaskKey, editingFields.size, isTaskReadOnly]);

  useEffect(() => {
    if (!isModalOpen) {
      initializedEditFieldsTaskKeyRef.current = "";
    }
  }, [isModalOpen]);

  // DEBUG: verifica se displayTask è corretto
  useEffect(() => {
    const effectiveTaskKey = String(effectiveCurrentId || "").split("::")[0] || "";
    if (getTaskKey(displayTask) !== effectiveTaskKey) {
      console.warn('⚠️ MISMATCH: displayTask.id !== effectiveCurrentId', {
        displayTaskId: getTaskKey(displayTask),
        effectiveCurrentId: effectiveCurrentId,
        displayTaskName: (displayTask as any).logistic_code || displayTask.name,
        allTasksIds: allTasks.map(t => getTaskKey(t))
      });
    }
  }, [displayTask, effectiveCurrentId, allTasks]);

  // DEBUG: Log per verificare i flag della task durante navigazione
  useEffect(() => {
    if (isModalOpen) {
      console.log(`Task ${(displayTask as any).logistic_code || displayTask.name}:`, {
        premium: displayTask.premium,
        straordinaria: displayTask.straordinaria,
        currentTaskId: effectiveCurrentId
      });
    }
  }, [effectiveCurrentId, isModalOpen, displayTask]);

  // Evita autofocus automatico quando si apre il dialog dettagli.
  useEffect(() => {
    if (!isModalOpen) return;
    const rafId = window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      active?.blur();
    });
    return () => window.cancelAnimationFrame(rafId);
  }, [isModalOpen]);

  // Normalizza confirmed_operation da boolean/number/string a boolean sicuro
  // CRITICAL: Se l'utente ha modificato operation_id tramite pending edits, considera confermato
  // Questo distingue tra operation_id=2 di default (sistema) e operation_id=2 scelto manualmente
  const taskKeyForConfirm = getTaskKey(task);
  const pendingEditsForTask = getPendingEdits()[taskKeyForConfirm];
  // Usa il flag operationIdModified per determinare se l'utente ha modificato l'operazione
  // Se l'utente seleziona "Nessuna operazione" (null), operationIdModified è true ma operationId è null
  // In quel caso NON è confermato, il punto di domanda rimane
  const hasPendingOperationEdit = pendingEditsForTask?.operationIdModified === true && pendingEditsForTask?.operationId !== null;
  
  const rawConfirmed = (task as any).confirmed_operation; // Usa task originale per confirmed_operation
  const originalConfirmed = 
    typeof rawConfirmed === "boolean"
      ? rawConfirmed
      : typeof rawConfirmed === "number"
        ? rawConfirmed !== 0
        : typeof rawConfirmed === "string"
          ? ["true", "1", "yes"].includes(rawConfirmed.toLowerCase().trim())
          : false;
  
  // Confermato se: utente ha modificato manualmente operation_id (con valore non-null) O confirmed_operation originale è true
  const isConfirmedOperation = hasPendingOperationEdit || originalConfirmed;

  // Determina il tipo della CARD dai flag dell'oggetto *task* (non quelli della navigazione nel modale)

  const HOUSEKEEPING_STRIPE_CLASS: Record<HousekeepingTypeTier, string> = {
    straordinaria: "bg-red-500",
    premium: "bg-yellow-500",
    standard: "bg-green-500",
    altro: "bg-gray-400",
  };

  const HOUSEKEEPING_BADGE_CLASS: Record<HousekeepingTypeTier, string> = {
    straordinaria: "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500",
    premium:
      "bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400",
    standard:
      "bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400",
    altro: "bg-gray-500/20 text-gray-700 dark:text-gray-300 border-gray-500 dark:border-gray-400",
  };

  const HOUSEKEEPING_CORNER_BADGE_CLASS: Record<HousekeepingTypeTier, string> = {
    straordinaria: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 border-red-500",
    premium:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400",
    standard:
      "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200 border-green-600 dark:border-green-400",
    altro: "bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300 border-gray-400 dark:border-gray-500",
  };

  const cardHousekeepingTier = getHousekeepingTypeTier(task, operationNames);

  // Il modale invece usa displayTask (vedi più sotto)

  const getTaskTypeStyle = (isStraord: boolean, isPrem: boolean) => {
    if (isStraord) {
      return { label: "STRAORDINARIA" };
    }
    if (isPrem) {
      return { label: "PREMIUM" };
    }
    return { label: "STANDARD" };
  };

  const cardTaskAny = task as any;
  const cardTaskIdKey = String(cardTaskAny.task_id ?? cardTaskAny.id ?? "");
  const cardLogisticsKindOverride = logisticsKindOverridesByTaskId[cardTaskIdKey];
  const cardLogisticsTaskKind =
    operationsScope === "logistics"
      ? resolveLogisticsTaskKind({
          logisticsTaskKind:
            cardLogisticsKindOverride?.kind ?? cardTaskAny.logistics_task_kind,
          logisticsTaskKindSource:
            cardLogisticsKindOverride?.source ?? cardTaskAny.logistics_task_kind_source,
          cleanerId: cardTaskAny.cleaner_id ?? null,
          cleanerSequence: cardTaskAny.cleaner_sequence ?? null,
          premium: task.premium,
          paxIn: cardTaskAny.pax_in,
        })
      : null;

  const categoryStripeClass =
    operationsScope === "logistics"
      ? logisticsKindStripeClass(cardLogisticsTaskKind)
      : HOUSEKEEPING_STRIPE_CLASS[cardHousekeepingTier];

  const cardLogisticsSequenceRaw =
    operationsScope === "logistics"
      ? cardTaskAny.sequence ??
        cardTaskAny.logistics_sequence ??
        cardTaskAny.logisticsSequence
      : null;
  const cardLogisticsSequenceNum = Number(cardLogisticsSequenceRaw);
  const cardLogisticsSequence =
    operationsScope === "logistics" &&
    Number.isFinite(cardLogisticsSequenceNum) &&
    cardLogisticsSequenceNum > 0
      ? cardLogisticsSequenceNum
      : operationsScope === "logistics" && isInTimeline
        ? index + 1
        : null;
  const cardLogisticsSequenceLabel =
    cardLogisticsSequence != null ? String(cardLogisticsSequence) : null;

  // Nei container: sfondo pagina per contrasto con la colonna; in timeline resta custom-blue-light.
  const cardSurfaceClass =
    isLocked && !isInTimeline
      ? "bg-muted/80 border-border/60 opacity-70"
      : !isInTimeline
        ? "bg-background border-border shadow-sm"
        : "bg-custom-blue-light border-border/60";

  useEffect(() => {
    if (!isModalOpen) return;
    const taskObj = displayTask as any;
    const nextStart = taskObj.start_time ?? taskObj.startTime;
    const nextEnd = taskObj.end_time ?? taskObj.endTime;
    const nextTravel = taskObj.travel_time ?? taskObj.travelTime;
    setAssignmentTimes((prev) => {
      if (
        prev.start_time === nextStart &&
        prev.end_time === nextEnd &&
        prev.travel_time === nextTravel
      ) {
        return prev;
      }
      return {
        start_time: nextStart,
        end_time: nextEnd,
        travel_time: nextTravel,
      };
    });
  }, [isModalOpen, dialogTaskKey]);

  useEffect(() => {
    let cancelled = false;

    const loadLogisticsDriverBadge = async () => {
      if (!isTimelineDetailsDialog || !isModalOpen) {
        if (!cancelled) {
          lastLogisticsDriverFetchTaskKeyRef.current = "";
          setResolvedLogisticsDriverTaskKey("");
          setLogisticsDriverBadge(null);
          setLogisticsTimelineSequence(null);
          setLogisticsTimelineStartTime(null);
          setLogisticsTimelineEndTime(null);
          setLogisticsTimelineTravelTime(null);
          setLogisticsHousekeepingNotes(null);
          setLogisticsStructureBeds(null);
          setLogisticsStructureAlertKeys(null);
        }
        return;
      }

      const detailsTaskKey = dialogTaskKey;
      if (!Number.isFinite(dialogTaskId)) {
        if (!cancelled) {
          lastLogisticsDriverFetchTaskKeyRef.current = detailsTaskKey;
          setResolvedLogisticsDriverTaskKey(detailsTaskKey);
          setLogisticsDriverBadge(null);
          setLogisticsTimelineSequence(null);
          setLogisticsTimelineStartTime(null);
          setLogisticsTimelineEndTime(null);
          setLogisticsTimelineTravelTime(null);
          setLogisticsHousekeepingNotes(null);
          setLogisticsStructureBeds(null);
          setLogisticsStructureAlertKeys(null);
        }
        return;
      }

      const dateStr =
        localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];

      try {
        if (!cancelled) {
          const taskKeyChanged = lastLogisticsDriverFetchTaskKeyRef.current !== detailsTaskKey;
          lastLogisticsDriverFetchTaskKeyRef.current = detailsTaskKey;
          if (taskKeyChanged) {
            setLogisticsDriverBadge(null);
            setLogisticsTimelineSequence(null);
            setLogisticsTimelineStartTime(null);
            setLogisticsTimelineEndTime(null);
            setLogisticsTimelineTravelTime(null);
            setLogisticsHousekeepingNotes(null);
            setLogisticsStructureBeds(null);
            setLogisticsStructureAlertKeys(null);
          }
        }

        const res = await fetch(
          `/api/logistics-task-driver-details?date=${encodeURIComponent(dateStr)}&taskId=${encodeURIComponent(String(dialogTaskId))}&driverId=${encodeURIComponent(String(cleanerId ?? ""))}&structureId=${encodeURIComponent(String(dialogStructureIdRaw))}`,
          { cache: "no-store" }
        );
        if (cancelled) return;

        const json = res.ok ? await res.json().catch(() => ({})) : {};
        const badge = String(json?.driverBadge ?? "").trim();
        const logisticsSeqNum = Number(json?.sequence);
        const logisticsStartText = String(json?.startTime ?? "").trim();
        const logisticsEndText = String(json?.endTime ?? "").trim();
        const logisticsTravelNum = Number(json?.travelTime);
        const housekeepingNotesText = String(json?.housekeepingNotes ?? "").trim();
        const bedsRaw = json?.structureBeds;
        const alertKeysRaw = Number(json?.structureAlertKeys);
        setResolvedLogisticsDriverTaskKey(detailsTaskKey);
        setLogisticsDriverBadge(badge || null);
        setLogisticsTimelineSequence(Number.isFinite(logisticsSeqNum) ? logisticsSeqNum : null);
        setLogisticsTimelineStartTime(logisticsStartText || null);
        setLogisticsTimelineEndTime(logisticsEndText || null);
        setLogisticsTimelineTravelTime(Number.isFinite(logisticsTravelNum) ? logisticsTravelNum : null);
        setLogisticsHousekeepingNotes(housekeepingNotesText || null);
        setLogisticsStructureBeds(
          bedsRaw && typeof bedsRaw === "object"
            ? {
                single_beds: Number.isFinite(Number(bedsRaw.single_beds)) ? Number(bedsRaw.single_beds) : null,
                double_beds: Number.isFinite(Number(bedsRaw.double_beds)) ? Number(bedsRaw.double_beds) : null,
                single_sofabeds: Number.isFinite(Number(bedsRaw.single_sofabeds)) ? Number(bedsRaw.single_sofabeds) : null,
                double_sofabeds: Number.isFinite(Number(bedsRaw.double_sofabeds)) ? Number(bedsRaw.double_sofabeds) : null,
              }
            : null
        );
        setLogisticsStructureAlertKeys(Number.isFinite(alertKeysRaw) ? alertKeysRaw : null);
      } catch {
        if (!cancelled) {
          setResolvedLogisticsDriverTaskKey(detailsTaskKey);
          setLogisticsDriverBadge(null);
          setLogisticsTimelineSequence(null);
          setLogisticsTimelineStartTime(null);
          setLogisticsTimelineEndTime(null);
          setLogisticsTimelineTravelTime(null);
          setLogisticsHousekeepingNotes(null);
          setLogisticsStructureBeds(null);
          setLogisticsStructureAlertKeys(null);
        }
      }
    };

    void loadLogisticsDriverBadge();
    return () => {
      cancelled = true;
    };
  }, [isTimelineDetailsDialog, isModalOpen, cleanerId, dialogTaskId, dialogTaskKey, dialogStructureIdRaw]);

  useEffect(() => {
    let cancelled = false;

    const loadHousekeepingCleanerLabel = async () => {
      if (!isTimelineDetailsDialog || !isModalOpen) {
        if (!cancelled) {
          lastHousekeepingDetailsFetchTaskKeyRef.current = "";
          setResolvedHousekeepingTaskKey("");
          setLogisticsHousekeepingCleanerLabel(null);
          setLogisticsHousekeepingCleanerId(null);
          setLogisticsHousekeepingSequence(null);
          setLogisticsHousekeepingStartTime(null);
          setLogisticsHousekeepingEndTime(null);
          setLogisticsHousekeepingTravelTime(null);
        }
        return;
      }

      const detailsTaskKey = dialogTaskKey;
      const hasTaskId = String(dialogTaskIdRaw ?? "").trim().length > 0;
      const hasLogisticCode = String(dialogLogisticCodeRaw ?? "").trim().length > 0;

      if (!hasTaskId && !hasLogisticCode) {
        if (!cancelled) {
          lastHousekeepingDetailsFetchTaskKeyRef.current = detailsTaskKey;
          setResolvedHousekeepingTaskKey(detailsTaskKey);
          setLogisticsHousekeepingCleanerLabel(null);
          setLogisticsHousekeepingCleanerId(null);
          setLogisticsHousekeepingSequence(null);
          setLogisticsHousekeepingStartTime(null);
          setLogisticsHousekeepingEndTime(null);
          setLogisticsHousekeepingTravelTime(null);
        }
        return;
      }

      const dateStr =
        localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];

      if (!cancelled) {
        const taskKeyChanged = lastHousekeepingDetailsFetchTaskKeyRef.current !== detailsTaskKey;
        lastHousekeepingDetailsFetchTaskKeyRef.current = detailsTaskKey;
        if (taskKeyChanged) {
          setLogisticsHousekeepingCleanerLabel(null);
          setLogisticsHousekeepingCleanerId(null);
          setLogisticsHousekeepingSequence(null);
          setLogisticsHousekeepingStartTime(null);
          setLogisticsHousekeepingEndTime(null);
          setLogisticsHousekeepingTravelTime(null);
        }
      }

      try {
        const res = await fetch(
          `/api/logistics-task-housekeeping-cleaner?date=${encodeURIComponent(dateStr)}&taskId=${encodeURIComponent(String(dialogTaskIdRaw ?? ""))}&logisticCode=${encodeURIComponent(String(dialogLogisticCodeRaw ?? ""))}`,
          { cache: "no-store" }
        );
        const json = res.ok ? await res.json().catch(() => ({})) : {};
        if (cancelled) return;

        const label = String(json?.cleanerLabel ?? "").trim();
        setResolvedHousekeepingTaskKey(detailsTaskKey);
        setLogisticsHousekeepingCleanerLabel(label || null);
        const rawCleanerId = json?.cleanerId;
        const cleanerIdNum =
          rawCleanerId === null || rawCleanerId === undefined || rawCleanerId === ""
            ? NaN
            : Number(rawCleanerId);
        setLogisticsHousekeepingCleanerId(Number.isFinite(cleanerIdNum) ? cleanerIdNum : null);
        const rawSeq = json?.sequence;
        const sequenceNum =
          rawSeq === null || rawSeq === undefined || rawSeq === "" ? NaN : Number(rawSeq);
        setLogisticsHousekeepingSequence(Number.isFinite(sequenceNum) ? sequenceNum : null);
        const startTimeText = String(json?.startTime ?? "").trim();
        const endTimeText = String(json?.endTime ?? "").trim();
        const rawTravel = json?.travelTime;
        const travelNum = rawTravel === null || rawTravel === undefined || rawTravel === "" ? NaN : Number(rawTravel);
        setLogisticsHousekeepingStartTime(startTimeText || null);
        setLogisticsHousekeepingEndTime(endTimeText || null);
        setLogisticsHousekeepingTravelTime(Number.isFinite(travelNum) ? travelNum : null);
      } catch {
        if (!cancelled) {
          setResolvedHousekeepingTaskKey(detailsTaskKey);
          setLogisticsHousekeepingCleanerLabel(null);
          setLogisticsHousekeepingCleanerId(null);
          setLogisticsHousekeepingSequence(null);
          setLogisticsHousekeepingStartTime(null);
          setLogisticsHousekeepingEndTime(null);
          setLogisticsHousekeepingTravelTime(null);
        }
      }
    };

    void loadHousekeepingCleanerLabel();
    return () => {
      cancelled = true;
    };
  }, [isTimelineDetailsDialog, isModalOpen, dialogTaskKey, dialogTaskIdRaw, dialogLogisticCodeRaw]);

  // Supporto navigazione con frecce da tastiera
  useEffect(() => {
    if (!isModalOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && canGoPrev) {
        handlePrevTask();
      }
      if (e.key === "ArrowRight" && canGoNext) {
        handleNextTask();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, canGoPrev, canGoNext, currentIndex, navigableTasks]);

  const handleSaveChanges = async () => {
    try {
      setIsSaving(true);

      // Validazione: checkout - se hai ora, devi avere anche data
      if (editingFields.has('checkout')) {
        const hasCheckoutDate = !!editedCheckoutDate;
        const hasCheckoutTime = !!editedCheckoutTime;
        // Non puoi avere ora senza data, ma puoi avere data senza ora
        if (hasCheckoutTime && !hasCheckoutDate) {
          toast({
            title: "Errore di validazione",
            description: "Check-out: se inserisci l'orario, devi inserire anche la data",
            variant: "destructive",
          });
          setIsSaving(false);
          return;
        }
      }

      // Validazione: checkin - se hai ora, devi avere anche data
      if (editingFields.has('checkin')) {
        const hasCheckinDate = !!editedCheckinDate;
        const hasCheckinTime = !!editedCheckinTime;
        // Non puoi avere ora senza data, ma puoi avere data senza ora
        if (hasCheckinTime && !hasCheckinDate) {
          toast({
            title: "Errore di validazione",
            description: "Check-in: se inserisci l'orario, devi inserire anche la data",
            variant: "destructive",
          });
          setIsSaving(false);
          return;
        }
      }

      // Validazione: il check-in non può essere precedente al check-out (solo se entrambi sono riempiti)
      if (editedCheckoutDate && editedCheckoutTime && editedCheckinDate && editedCheckinTime) {
        const checkoutDateTime = new Date(`${editedCheckoutDate}T${editedCheckoutTime}:00`);
        const checkinDateTime = new Date(`${editedCheckinDate}T${editedCheckinTime}:00`);

        if (checkinDateTime < checkoutDateTime) {
          toast({
            title: "Errore di validazione",
            description: "Il check-in non può essere precedente al check-out",
            variant: "destructive",
          });
          setIsSaving(false);
          return;
        }
      }

      // Validazione: durata pulizia deve essere > 0
      if (editingFields.has('duration') && parseInt(editedDuration) <= 0) {
        toast({
          title: "Errore di validazione",
          description: "La durata della pulizia deve essere maggiore di 0 minuti",
          variant: "destructive",
        });
        setIsSaving(false);
        return;
      }

      // Validazione: pax-in deve essere >= 0
      if (editingFields.has('paxin') && parseInt(editedPaxIn) < 0) {
        toast({
          title: "Errore di validazione",
          description: "Il numero di ospiti non può essere negativo",
          variant: "destructive",
        });
        setIsSaving(false);
        return;
      }

      const taskKey = getTaskKey(displayTask);
      
      // Gestisce operation_id: "none" = null (scelta esplicita di nessuna operazione)
      // Altrimenti parseInt, se è un numero valido
      const operationIdValue = editedOperationId === "none" 
        ? null 
        : (parseInt(editedOperationId) || null);
      
      const pendingEdits = {
        taskId: taskKey,
        logisticCode: displayTask.name,
        checkoutDate: editedCheckoutDate || null,  // null se vuoto
        checkoutTime: editedCheckoutTime || null,  // null se vuoto
        checkinDate: editedCheckinDate || null,    // null se vuoto
        checkinTime: editedCheckinTime || null,    // null se vuoto
        cleaningTime: parseInt(editedDuration),
        paxIn: parseInt(editedPaxIn),
        paxOut: displayTask.pax_out,
        operationId: operationIdValue,
        // CRITICAL: Flag per indicare che l'utente ha modificato operation_id
        // Questo distingue tra "non modificato" e "impostato a null esplicitamente"
        operationIdModified: editingFields.has('operation'),
      };

      // Salva in sessionStorage per UI ottimistica
      const existingEdits = JSON.parse(sessionStorage.getItem('pending_task_edits') || '{}');
      existingEdits[taskKey] = { ...(existingEdits[taskKey] || {}), ...pendingEdits };
      sessionStorage.setItem('pending_task_edits', JSON.stringify(existingEdits));

      // CRITICAL: Salva anche su PostgreSQL (ma NON su ADAM) 
      // ADAM verrà aggiornato solo con "Trasferisci su ADAM"
      const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      
      const response = await fetch('/api/update-task-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: (displayTask as any).task_id || displayTask.id,
          logisticCode: displayTask.name,
          checkoutDate: editedCheckoutDate || null,
          checkoutTime: editedCheckoutTime || null,
          checkinDate: editedCheckinDate || null,
          checkinTime: editedCheckinTime || null,
          cleaningTime: parseInt(editedDuration),
          paxIn: parseInt(editedPaxIn),
          operationId: operationIdValue,
          date: workDate,
          modified_by: currentUser.username || 'unknown',
          skipAdam: true  // NON propagare su ADAM, solo PostgreSQL
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Errore nel salvataggio su PostgreSQL');
      }

      toast({
        title: "Modifiche salvate",
        description: "I campi della task sono stati salvati. Premi 'Trasferisci su ADAM' per sincronizzare.",
      });

      setEditingFields(new Set());
      // CRITICAL: Incrementa versione per forzare re-render con i nuovi valori
      setPendingEditsVersion(v => v + 1);
      setIsModalOpen(false);
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }

    } catch (error: any) {
      console.error("Errore nella preparazione:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile preparare le modifiche",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenPaxInDialog = () => {
    setEditingPaxInInDialog(String((displayTask as any).pax_in ?? 0));
    setPaxInDialogOpen(true);
  };

  const handleOpenCustomerNoteDialog = () => {
    setEditingCustomerNoteInDialog(customerNoteDisplayText);
    setCustomerNoteDialogOpen(true);
  };

  const handleSaveCustomerNote = async () => {
    setIsSavingCustomerNote(true);
    try {
      const normalized = editingCustomerNoteInDialog.trim();
      const taskIdRaw =
        (displayTask as any).task_id ??
        (displayTask as any).id ??
        (task as any).task_id ??
        (task as any).id;
      const numericTaskId = Number(taskIdRaw);
      if (!Number.isFinite(numericTaskId)) {
        throw new Error("Task ID non valido");
      }
      const logisticCodeRaw =
        (displayTask as any).logistic_code ??
        (displayTask as any).name ??
        (task as any).logistic_code ??
        (task as any).name ??
        null;
      const dateStr =
        localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];
      const taskKey = getTaskKey(displayTask);
      const duration = displayTask.duration || "0.0";
      const [hours, mins] = duration.split(".").map(Number);
      const cleaningTime = (hours || 0) * 60 + (mins || 0);
      const operationIdValue = (displayTask as any).operation_id != null
        ? (displayTask as any).operation_id
        : (editedOperationId === "none" ? null : (parseInt(editedOperationId, 10) || null));
      const pendingEdits = {
        taskId: taskKey,
        logisticCode: displayTask.name,
        checkoutDate: (displayTask as any).checkout_date ?? null,
        checkoutTime: (displayTask as any).checkout_time ?? null,
        checkinDate: (displayTask as any).checkin_date ?? null,
        checkinTime: (displayTask as any).checkin_time ?? null,
        cleaningTime,
        paxIn: (displayTask as any).pax_in,
        paxOut: (displayTask as any).pax_out,
        operationId: operationIdValue,
        operationIdModified: editingFields.has("operation"),
        customerNote: normalized,
      };
      const existingEdits = JSON.parse(sessionStorage.getItem("pending_task_edits") || "{}");
      existingEdits[taskKey] = { ...(existingEdits[taskKey] || {}), ...pendingEdits };
      sessionStorage.setItem("pending_task_edits", JSON.stringify(existingEdits));

      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-task-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: numericTaskId,
          logisticCode: logisticCodeRaw,
          customerNote: normalized,
          date: dateStr,
          modified_by: currentUser.username || "unknown",
          skipAdam: true,
        }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error || "Impossibile salvare la nota del cliente");
      }
      setCustomerNotesByTaskKey((prev) => ({ ...prev, [currentDetailsTaskKey]: normalized }));
      setLogisticsHousekeepingNotes(normalized);
      toast({
        title: "Note del cliente aggiornate",
        description: "Valore salvato. Premi 'Trasferisci su ADAM' per sincronizzare.",
      });
      setCustomerNoteDialogOpen(false);
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error?.message || "Impossibile salvare le note del cliente",
        variant: "destructive",
      });
    } finally {
      setIsSavingCustomerNote(false);
    }
  };

  const handleSavePaxIn = async () => {
    const value = parseInt(editingPaxInInDialog, 10);
    if (isNaN(value) || value < 0) {
      toast({
        title: "Errore di validazione",
        description: "Il numero di ospiti (Pax-In) deve essere un numero ≥ 0",
        variant: "destructive",
      });
      return;
    }
    setIsSavingPaxIn(true);
    try {
      const taskKey = getTaskKey(displayTask);
      const duration = displayTask.duration || "0.0";
      const [hours, mins] = duration.split(".").map(Number);
      const cleaningTime = (hours || 0) * 60 + (mins || 0);
      const operationIdValue = (displayTask as any).operation_id != null
        ? (displayTask as any).operation_id
        : (editedOperationId === "none" ? null : (parseInt(editedOperationId, 10) || null));

      const pendingEdits = {
        taskId: taskKey,
        logisticCode: displayTask.name,
        checkoutDate: (displayTask as any).checkout_date ?? null,
        checkoutTime: (displayTask as any).checkout_time ?? null,
        checkinDate: (displayTask as any).checkin_date ?? null,
        checkinTime: (displayTask as any).checkin_time ?? null,
        cleaningTime,
        paxIn: value,
        paxOut: (displayTask as any).pax_out,
        operationId: operationIdValue,
        operationIdModified: editingFields.has("operation"),
      };
      const existingEdits = JSON.parse(sessionStorage.getItem("pending_task_edits") || "{}");
      existingEdits[taskKey] = { ...(existingEdits[taskKey] || {}), ...pendingEdits };
      sessionStorage.setItem("pending_task_edits", JSON.stringify(existingEdits));

      const workDate = localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];
      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-task-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: (displayTask as any).task_id || displayTask.id,
          logisticCode: displayTask.name,
          checkoutDate: (displayTask as any).checkout_date ?? null,
          checkoutTime: (displayTask as any).checkout_time ?? null,
          checkinDate: (displayTask as any).checkin_date ?? null,
          checkinTime: (displayTask as any).checkin_time ?? null,
          cleaningTime,
          paxIn: value,
          operationId: operationIdValue,
          date: workDate,
          modified_by: currentUser.username || "unknown",
          skipAdam: true,
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Errore nel salvataggio");
      }
      toast({
        title: "Pax-In aggiornato",
        description: "Il valore è stato salvato. Premi 'Trasferisci su ADAM' per sincronizzare.",
      });
      setPaxInDialogOpen(false);
      setPendingEditsVersion((v) => v + 1);
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare Pax-In",
        variant: "destructive",
      });
    } finally {
      setIsSavingPaxIn(false);
    }
  };

  const buildPayloadFromDisplayTask = (overrides: {
    checkoutDate?: string | null;
    checkoutTime?: string | null;
    checkinDate?: string | null;
    checkinTime?: string | null;
  }) => {
    const duration = displayTask.duration || "0.0";
    const [hours, mins] = duration.split(".").map(Number);
    const cleaningTime = (hours || 0) * 60 + (mins || 0);
    const operationIdValue = (displayTask as any).operation_id != null
      ? (displayTask as any).operation_id
      : (editedOperationId === "none" ? null : (parseInt(editedOperationId, 10) || null));
    return {
      taskKey: getTaskKey(displayTask),
      duration,
      cleaningTime,
      operationIdValue,
      checkoutDate: overrides.checkoutDate !== undefined ? overrides.checkoutDate : ((displayTask as any).checkout_date ?? null),
      checkoutTime: overrides.checkoutTime !== undefined ? overrides.checkoutTime : ((displayTask as any).checkout_time ?? null),
      checkinDate: overrides.checkinDate !== undefined ? overrides.checkinDate : ((displayTask as any).checkin_date ?? null),
      checkinTime: overrides.checkinTime !== undefined ? overrides.checkinTime : ((displayTask as any).checkin_time ?? null),
    };
  };

  const handleOpenCheckoutDialog = () => {
    setEditingCheckoutDateInDialog(normalizeDate((displayTask as any).checkout_date));
    setEditingCheckoutTimeInDialog(normalizeTime((displayTask as any).checkout_time));
    setCheckoutDialogOpen(true);
  };

  const handleSaveCheckout = async () => {
    const date = editingCheckoutDateInDialog.trim() || null;
    const time = editingCheckoutTimeInDialog.trim() || null;
    if (time && !date) {
      toast({
        title: "Errore di validazione",
        description: "Se inserisci l'orario, devi inserire anche la data.",
        variant: "destructive",
      });
      return;
    }
    setIsSavingCheckout(true);
    try {
      const payload = buildPayloadFromDisplayTask({
        checkoutDate: date,
        checkoutTime: time,
      });
      const pendingEdits = {
        taskId: payload.taskKey,
        logisticCode: displayTask.name,
        checkoutDate: payload.checkoutDate,
        checkoutTime: payload.checkoutTime,
        checkinDate: payload.checkinDate,
        checkinTime: payload.checkinTime,
        cleaningTime: payload.cleaningTime,
        paxIn: (displayTask as any).pax_in,
        paxOut: (displayTask as any).pax_out,
        operationId: payload.operationIdValue,
        operationIdModified: editingFields.has("operation"),
      };
      const existingEdits = JSON.parse(sessionStorage.getItem("pending_task_edits") || "{}");
      existingEdits[payload.taskKey] = { ...(existingEdits[payload.taskKey] || {}), ...pendingEdits };
      sessionStorage.setItem("pending_task_edits", JSON.stringify(existingEdits));

      const workDate = localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];
      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-task-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: (displayTask as any).task_id || displayTask.id,
          logisticCode: displayTask.name,
          checkoutDate: payload.checkoutDate,
          checkoutTime: payload.checkoutTime,
          checkinDate: payload.checkinDate,
          checkinTime: payload.checkinTime,
          cleaningTime: payload.cleaningTime,
          paxIn: (displayTask as any).pax_in,
          operationId: payload.operationIdValue,
          date: workDate,
          modified_by: currentUser.username || "unknown",
          skipAdam: true,
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Errore nel salvataggio");
      }
      toast({
        title: "Check-out aggiornato",
        description: "Data e orario salvati. Premi 'Trasferisci su ADAM' per sincronizzare.",
      });
      setCheckoutDialogOpen(false);
      setPendingEditsVersion((v) => v + 1);
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare Check-out",
        variant: "destructive",
      });
    } finally {
      setIsSavingCheckout(false);
    }
  };

  const handleOpenCheckinDialog = () => {
    setEditingCheckinDateInDialog(normalizeDate((displayTask as any).checkin_date));
    setEditingCheckinTimeInDialog(normalizeTime((displayTask as any).checkin_time));
    setCheckinDialogOpen(true);
  };

  const handleSaveCheckin = async () => {
    const date = editingCheckinDateInDialog.trim() || null;
    const time = editingCheckinTimeInDialog.trim() || null;
    if (time && !date) {
      toast({
        title: "Errore di validazione",
        description: "Se inserisci l'orario, devi inserire anche la data.",
        variant: "destructive",
      });
      return;
    }
    const checkoutDate = (displayTask as any).checkout_date ?? null;
    const checkoutTime = (displayTask as any).checkout_time ?? null;
    if (date && time && checkoutDate && checkoutTime) {
      const checkinDt = new Date(`${date}T${time}:00`);
      const checkoutDt = new Date(`${checkoutDate}T${checkoutTime}:00`);
      if (checkinDt < checkoutDt) {
        toast({
          title: "Errore di validazione",
          description: "Il check-in non può essere precedente al check-out.",
          variant: "destructive",
        });
        return;
      }
    }
    setIsSavingCheckin(true);
    try {
      const payload = buildPayloadFromDisplayTask({
        checkinDate: date,
        checkinTime: time,
      });
      const pendingEdits = {
        taskId: payload.taskKey,
        logisticCode: displayTask.name,
        checkoutDate: payload.checkoutDate,
        checkoutTime: payload.checkoutTime,
        checkinDate: payload.checkinDate,
        checkinTime: payload.checkinTime,
        cleaningTime: payload.cleaningTime,
        paxIn: (displayTask as any).pax_in,
        paxOut: (displayTask as any).pax_out,
        operationId: payload.operationIdValue,
        operationIdModified: editingFields.has("operation"),
      };
      const existingEdits = JSON.parse(sessionStorage.getItem("pending_task_edits") || "{}");
      existingEdits[payload.taskKey] = { ...(existingEdits[payload.taskKey] || {}), ...pendingEdits };
      sessionStorage.setItem("pending_task_edits", JSON.stringify(existingEdits));

      const workDate = localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];
      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-task-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: (displayTask as any).task_id || displayTask.id,
          logisticCode: displayTask.name,
          checkoutDate: payload.checkoutDate,
          checkoutTime: payload.checkoutTime,
          checkinDate: payload.checkinDate,
          checkinTime: payload.checkinTime,
          cleaningTime: payload.cleaningTime,
          paxIn: (displayTask as any).pax_in,
          operationId: payload.operationIdValue,
          date: workDate,
          modified_by: currentUser.username || "unknown",
          skipAdam: true,
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Errore nel salvataggio");
      }
      toast({
        title: "Check-in aggiornato",
        description: "Data e orario salvati. Premi 'Trasferisci su ADAM' per sincronizzare.",
      });
      setCheckinDialogOpen(false);
      setPendingEditsVersion((v) => v + 1);
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare Check-in",
        variant: "destructive",
      });
    } finally {
      setIsSavingCheckin(false);
    }
  };

  const handleOpenOperationDialog = () => {
    const opId = (displayTask as any).operation_id;
    setEditingOperationIdInDialog(opId != null ? String(opId) : "none");
    setOperationDialogOpen(true);
  };

  const handleSaveOperation = async () => {
    const operationIdValue = editingOperationIdInDialog === "none"
      ? null
      : (parseInt(editingOperationIdInDialog, 10) || null);
    setIsSavingOperation(true);
    try {
      const payload = buildPayloadFromDisplayTask({});
      const pendingEdits = {
        taskId: payload.taskKey,
        logisticCode: displayTask.name,
        checkoutDate: payload.checkoutDate,
        checkoutTime: payload.checkoutTime,
        checkinDate: payload.checkinDate,
        checkinTime: payload.checkinTime,
        cleaningTime: payload.cleaningTime,
        paxIn: (displayTask as any).pax_in,
        paxOut: (displayTask as any).pax_out,
        operationId: operationIdValue,
        operationIdModified: true,
      };
      const existingEdits = JSON.parse(sessionStorage.getItem("pending_task_edits") || "{}");
      existingEdits[payload.taskKey] = { ...(existingEdits[payload.taskKey] || {}), ...pendingEdits };
      sessionStorage.setItem("pending_task_edits", JSON.stringify(existingEdits));

      const workDate = localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];
      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-task-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: (displayTask as any).task_id || displayTask.id,
          logisticCode: displayTask.name,
          checkoutDate: payload.checkoutDate,
          checkoutTime: payload.checkoutTime,
          checkinDate: payload.checkinDate,
          checkinTime: payload.checkinTime,
          cleaningTime: payload.cleaningTime,
          paxIn: (displayTask as any).pax_in,
          operationId: operationIdValue,
          date: workDate,
          modified_by: currentUser.username || "unknown",
          skipAdam: true,
        }),
      });
      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Errore nel salvataggio");
      }
      toast({
        title: "Tipologia intervento aggiornata",
        description: "Modifica salvata. Premi 'Trasferisci su ADAM' per sincronizzare.",
      });
      setOperationDialogOpen(false);
      setPendingEditsVersion((v) => v + 1);
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare la tipologia intervento",
        variant: "destructive",
      });
    } finally {
      setIsSavingOperation(false);
    }
  };

  const handleSelectLogisticsKind = async (kind: LogisticsTaskKind) => {
    if (!Number.isFinite(dialogTaskId)) {
      toast({
        title: "Errore",
        description: "Task non valida",
        variant: "destructive",
      });
      return;
    }

    setIsSavingLogisticsKind(true);
    try {
      const workDate =
        localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];
      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-logistics-task-kind", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: workDate,
          taskId: dialogTaskId,
          kind,
          modified_by: currentUser.username || "unknown",
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        throw new Error(result.error || "Errore nel salvataggio");
      }

      setLogisticsKindOverridesByTaskId((prev) => ({
        ...prev,
        [displayTaskIdKey]: {
          kind,
          source: "manual",
        },
      }));
      setLogisticsKindPickerOpen(false);
      toast({
        title: "Tipologia logistica salvata",
        description: LOGISTICS_KIND_BADGE_LABEL[kind],
      });
      onLogisticsTimelineMutated?.();
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare la tipologia logistica",
        variant: "destructive",
      });
    } finally {
      setIsSavingLogisticsKind(false);
    }
  };

  // Calcola la larghezza in base alla durata
  const calculateWidth = (duration: string | undefined, forTimeline: boolean) => {
    const safeDuration = duration || "0.0";
    const parts = safeDuration.split(".");
    const hours = parseInt(parts[0] || "0");
    const minutes = parts[1] ? parseInt(parts[1]) : 0;
    const totalMinutes = hours * 60 + minutes;

    // Se 0 minuti, usa fallback di 60 minuti
    const effectiveMinutes = totalMinutes === 0 ? 60 : totalMinutes;

    if (forTimeline) {
      if (timelinePxPerMinute > 0) {
        const widthPx = effectiveMinutes * timelinePxPerMinute;
        return `${Math.max(widthPx, minTimelineTaskWidthPx)}px`;
      }

      // Usa la larghezza della timeline in pixel (passata da timeline-view via props)
      const timelineWidth = timelineWidthPx || 0;
      const slotsCount = (window as any).globalTimeSlotsCount || 10;
      const globalMinutes = Number((window as any).globalTimelineMinutes);
      const virtualMinutes =
        Number.isFinite(globalMinutes) && globalMinutes > 0
          ? globalMinutes
          : slotsCount * 60;

      if (timelineWidth > 0) {
        let widthPx = (effectiveMinutes / virtualMinutes) * timelineWidth;
        if (operationsScope === "logistics") {
          widthPx *= 1.08;
        }
        return `${widthPx}px`;
      } else {
        // Fallback a percentuale se larghezza non disponibile
        let widthPercentage = (effectiveMinutes / virtualMinutes) * 100;
        if (operationsScope === "logistics") {
          widthPercentage *= 1.08;
        }
        return `${widthPercentage}%`;
      }
    } else {
      // Per le colonne di priorità:
      // Se la task è < 60 minuti, usa sempre 60 minuti (larghezza di 1 ora)
      const displayMinutes = effectiveMinutes < 60 ? 60 : effectiveMinutes;
      const halfHours = Math.ceil(displayMinutes / 30);
      // Larghezza per mezz'ora + base fissa che riserva lo spazio della colonna
      // orari (check-in/out posizionati in absolute a destra), così il customer
      // reference non ci finisce sotto.
      const baseWidth = halfHours * 54 + 56;
      return `${baseWidth}px`;
    }
  };

  // LOGISTICS (sempre) / HK durante DnD: in timeline ogni task vale 15 minuti (solo UI)
  const effectiveDurationForUi = showCompactAdamTimelineUi
    ? "0.15"
    : (task.duration || "0.0");

  // Mostra sempre le frecce check-in/out (anche in timeline per task < 1h)
  const shouldShowCheckInOutArrows = true;
  // Fallback tooltip disabilitato: gli orari restano sempre sulla card
  const shouldShowTooltipTimes = false;
  const cardTooltipAddressLabel =
    String(displayTask.address ?? "").trim().toUpperCase() || "INDIRIZZO NON DISPONIBILE";
  const cardTooltipClientAlias = String(displayTask.alias ?? "").trim();
  const cardTooltipAddressLine =
    operationsScope === "logistics" && isInTimeline && cardTooltipClientAlias
      ? `${cardTooltipAddressLabel} - ${cardTooltipClientAlias}`
      : cardTooltipAddressLabel;

  // Verifica violazioni temporali (considerando le date!)
  // In timeline la barra deve riflettere la task che rappresenta (task), non la task nel dialog (displayTask)
  const logisticsViolationInput =
    operationsScope === "logistics" && isInTimeline
      ? pickLogisticsViolationFields((task as Record<string, unknown>) ?? null)
      : null;

  const isOverdue = (() => {
    const taskForBar = isInTimeline ? task : displayTask;
    const taskObj = taskForBar as any;

    if (!isInTimeline) return false;

    if (operationsScope === "logistics") {
      const selectedWorkDate = localStorage.getItem("selected_work_date");
      if (!selectedWorkDate || !logisticsViolationInput) return false;
      return shouldBlinkLogisticsTimelineTask(logisticsViolationInput, selectedWorkDate);
    }

    // Housekeeping / office: regole esistenti
    const startTime = normalizeTime(
      assignmentTimes.start_time || taskObj.start_time || taskObj.startTime
    );
    const endTime = normalizeTime(
      assignmentTimes.end_time || taskObj.end_time || taskObj.endTime
    );
    const checkoutTime = normalizeTime(taskObj.checkout_time);
    const checkinTime = normalizeTime(taskObj.checkin_time);
    const checkoutDate = normalizeDate(taskObj.checkout_date);
    const checkinDate = normalizeDate(taskObj.checkin_date);

    if (startTime && checkoutTime && checkoutDate) {
      const taskStartDateTime = new Date(checkoutDate + "T" + startTime + ":00");
      const checkoutDateTime = new Date(checkoutDate + "T" + checkoutTime + ":00");
      if (taskStartDateTime < checkoutDateTime) return true;
    }

    if (endTime && checkinTime && checkoutDate && checkinDate) {
      const checkoutDateTime = new Date(checkoutDate + "T" + endTime + ":00");
      const checkinDateTime = new Date(checkinDate + "T" + checkinTime + ":00");
      if (checkoutDateTime > checkinDateTime) return true;
    }

    if (startTime && checkinTime && checkoutDate && checkinDate) {
      const taskStartDateTime = new Date(checkoutDate + "T" + startTime + ":00");
      const checkinDateTime = new Date(checkinDate + "T" + checkinTime + ":00");
      if (taskStartDateTime >= checkinDateTime) return true;
    }

    return false;
  })();

  // Verifica se il check-in è per una data futura (rispetto alla data selezionata)
  // Include anche i casi dove l'orario non è migrato ma la data è futura
  const isFutureCheckin = (() => {
    const taskObj = taskWithPendingEdits as any;
    const checkinDate = taskObj.checkin_date;

    if (!checkinDate) return false;

    // Ottieni la data selezionata da localStorage
    const selectedWorkDate = localStorage.getItem('selected_work_date');
    if (!selectedWorkDate) return false;

    const [year, month, day] = selectedWorkDate.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day);
    selectedDate.setHours(0, 0, 0, 0);

    const normalizedCheckinDate = normalizeDate(checkinDate);
    if (!normalizedCheckinDate) return false;
    const checkin = new Date(normalizedCheckinDate);
    checkin.setHours(0, 0, 0, 0);

    return checkin > selectedDate;
  })();

  
  const checkoutTime = (taskWithPendingEdits as any).checkout_time as string | undefined;
  const checkinTime = (taskWithPendingEdits as any).checkin_time as string | undefined;

  const hasCheckout = Boolean(checkoutTime);
  const hasCheckinRow = Boolean(checkinTime) || isFutureCheckin; // riga check-in o calendario
  const rowsCount = (hasCheckout ? 1 : 0) + (hasCheckinRow ? 1 : 0);

  const hasSingleRow = rowsCount === 1;
  const hasCustomerRef = Boolean((task as any).customer_reference);

  // regola tua: se c’è customer_reference e c’è UN SOLO ORARIO -> in basso a destra
  const forceBottomRightSingleRow = hasSingleRow && hasCustomerRef;

  // classi posizione
  const timesPositionClass = forceBottomRightSingleRow
    ? "bottom-0.5 top-auto"
    : hasSingleRow
      ? "top-1/2 -translate-y-1/2"
      : "top-[5px]";

  const currentDetailsTaskKey = getTaskKey(displayTask) || getTaskKey(task);
  const taskAny = task as any;
  const logisticsAdamCode = String(
    taskAny.logistic_code ?? task.name ?? taskAny.logisticCode ?? taskAny.task_id ?? task.id ?? ""
  ).trim();
  const displayTaskAny = displayTask as any;
  const displayTaskIdKey = String(displayTaskAny.task_id ?? displayTaskAny.id ?? "");
  const displayLogisticsKindOverride = logisticsKindOverridesByTaskId[displayTaskIdKey];
  const modalTaskAny = isModalOpen ? displayTaskAny : taskAny;
  const bedsInfo =
    resolvedLogisticsDriverTaskKey === currentDetailsTaskKey ? logisticsStructureBeds : null;
  const effectiveStructureAlertKeys =
    resolvedLogisticsDriverTaskKey === currentDetailsTaskKey ? logisticsStructureAlertKeys : null;
  const bedsSummaryParts: string[] = [];
  const singleSofabeds = Number(bedsInfo?.single_sofabeds ?? 0);
  const doubleSofabeds = Number(bedsInfo?.double_sofabeds ?? 0);
  if (Number.isFinite(singleSofabeds) && singleSofabeds > 0) {
    bedsSummaryParts.push(
      `${singleSofabeds} ${singleSofabeds === 1 ? "divano letto singolo" : "divani letto singoli"}`
    );
  }
  if (Number.isFinite(doubleSofabeds) && doubleSofabeds > 0) {
    bedsSummaryParts.push(
      `${doubleSofabeds} ${doubleSofabeds === 1 ? "divano letto matrimoniale" : "divani letto matrimoniali"}`
    );
  }
  const bedsSummaryText = bedsSummaryParts.join(" • ");
  const parseTravelMinutes = (value: unknown): number | null => {
    if (value === null || value === undefined || value === "") return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  };
  const resolvedLogisticsStartTime =
    resolvedLogisticsDriverTaskKey === currentDetailsTaskKey ? logisticsTimelineStartTime : null;
  const resolvedLogisticsEndTime =
    resolvedLogisticsDriverTaskKey === currentDetailsTaskKey ? logisticsTimelineEndTime : null;
  const resolvedLogisticsTravelTime =
    resolvedLogisticsDriverTaskKey === currentDetailsTaskKey ? logisticsTimelineTravelTime : null;

  const logisticsTravelTimeRaw =
    resolvedLogisticsTravelTime ??
    modalTaskAny.logistics_travel_time ??
    modalTaskAny.logisticsTravelTime ??
    modalTaskAny.driver_travel_time ??
    modalTaskAny.driverTravelTime ??
    (isLogisticsTimelineDetails ? (modalTaskAny.travel_time ?? modalTaskAny.travelTime) : null) ??
    taskAny.logistics_travel_time ??
    taskAny.logisticsTravelTime ??
    taskAny.driver_travel_time ??
    taskAny.driverTravelTime ??
    (isLogisticsTimelineDetails ? (taskAny.travel_time ?? taskAny.travelTime) : null) ??
    displayTaskAny.logistics_travel_time ??
    displayTaskAny.logisticsTravelTime ??
    displayTaskAny.driver_travel_time ??
    displayTaskAny.driverTravelTime ??
    (isLogisticsTimelineDetails ? (displayTaskAny.travel_time ?? displayTaskAny.travelTime) : null) ??
    null;
  const logisticsTravelMinutes = parseTravelMinutes(logisticsTravelTimeRaw);

  // "Schedulato alle" nel box logistica deve usare solo dati logistici dedicati.
  // Evita fallback su driver_start_time (orario turno) e su start_time housekeeping.
  const logisticsScheduledAtRaw =
    resolvedLogisticsStartTime ??
    modalTaskAny.logistics_start_time ??
    modalTaskAny.logisticsStartTime ??
    modalTaskAny.logistics_scheduled_time ??
    modalTaskAny.logisticsScheduledTime ??
    (isLogisticsTimelineDetails ? (modalTaskAny.start_time ?? modalTaskAny.startTime) : null) ??
    taskAny.logistics_start_time ??
    taskAny.logisticsStartTime ??
    taskAny.logistics_scheduled_time ??
    taskAny.logisticsScheduledTime ??
    (isLogisticsTimelineDetails ? (taskAny.start_time ?? taskAny.startTime) : null) ??
    displayTaskAny.logistics_start_time ??
    displayTaskAny.logisticsStartTime ??
    displayTaskAny.logistics_scheduled_time ??
    displayTaskAny.logisticsScheduledTime ??
    (isLogisticsTimelineDetails ? (displayTaskAny.start_time ?? displayTaskAny.startTime) : null) ??
    null;
  const logisticsScheduledAt = String(logisticsScheduledAtRaw ?? "").trim();
  // "Schedulato entro le" = fine slot logistica (start + 15 min). Solo end_time task, non turno driver.
  const logisticsScheduledUntilRaw =
    resolvedLogisticsEndTime ??
    modalTaskAny.logistics_end_time ??
    modalTaskAny.logisticsEndTime ??
    (isLogisticsTimelineDetails ? (modalTaskAny.end_time ?? modalTaskAny.endTime) : null) ??
    taskAny.logistics_end_time ??
    taskAny.logisticsEndTime ??
    (isLogisticsTimelineDetails ? (taskAny.end_time ?? taskAny.endTime) : null) ??
    displayTaskAny.logistics_end_time ??
    displayTaskAny.logisticsEndTime ??
    (isLogisticsTimelineDetails ? (displayTaskAny.end_time ?? displayTaskAny.endTime) : null) ??
    null;
  const logisticsScheduledUntil = String(logisticsScheduledUntilRaw ?? "").trim();
  const fallbackTimelineSequence =
    (isLogisticsTimelineDetails
      ? (taskAny.sequence ??
        taskAny.logistics_sequence ??
        taskAny.logisticsSequence ??
        displayTaskAny.sequence ??
        displayTaskAny.logistics_sequence ??
        displayTaskAny.logisticsSequence)
      : null) ?? null;
  const effectiveLogisticsSequence = Number(logisticsTimelineSequence ?? fallbackTimelineSequence);
  const isSingleKeyStructure = Number(effectiveStructureAlertKeys) === 1;
  const effectiveLogisticsTaskKind =
    isLogisticsDetails || isHousekeepingTimelineDetails
      ? resolveLogisticsTaskKind({
        cleanerId:
          logisticsHousekeepingCleanerId ??
          cleanerId ??
          displayTaskAny.assignedCleaner ??
          displayTaskAny.cleaner_id ??
          null,
        cleanerSequence:
          logisticsHousekeepingSequence ??
          displayTaskAny.sequence ??
          displayTaskAny.cleaner_sequence ??
          null,
        premium: displayTask.premium,
        paxIn: displayTaskAny.pax_in,
        logisticsTaskKind:
          displayLogisticsKindOverride?.kind ?? displayTaskAny.logistics_task_kind,
        logisticsTaskKindSource:
          displayLogisticsKindOverride?.source ?? displayTaskAny.logistics_task_kind_source,
      })
    : null;

  const dialogDisplayIsPremium = Boolean(displayTask.premium);
  const dialogDisplayIsStraordinaria =
    Boolean(displayTask.straordinaria) ||
    isContinuazioneStraordinariaTask(displayTask) ||
    isOfficeStraordinariaOperation(displayTask);
  const dialogExternalBadgeLabel = getExternalInterventionBadgeLabel(
    displayTask,
    dialogDisplayIsStraordinaria,
    dialogDisplayIsPremium
  );
  const dialogHousekeepingTypeLabel = dialogExternalBadgeLabel
    ? dialogExternalBadgeLabel
    : isOfficeStraordinariaOperation(displayTask)
      ? "PULIZIA UFFICI STRAORDINARIA"
      : isOfficeOtherOperation(displayTask)
        ? "PULIZIA UFFICI"
        : isContinuazioneStraordinariaTask(displayTask)
          ? "CONTINUAZIONE PS"
          : getTaskTypeStyle(dialogDisplayIsStraordinaria, dialogDisplayIsPremium).label;
  const dialogHousekeepingTier = getHousekeepingTypeTier(displayTask, operationNames);
  const dialogHousekeepingTypeBadge = (
    <Badge
      variant="outline"
      className={cn(
        "text-xs shrink-0 px-2 py-0.5 rounded border font-medium",
        HOUSEKEEPING_BADGE_CLASS[dialogHousekeepingTier]
      )}
    >
      {dialogHousekeepingTypeLabel}
    </Badge>
  );
  const dialogHousekeepingCornerTypeBadge = (
    <Badge
      variant="outline"
      className={cn(
        "text-xs shrink-0 px-2 py-0.5 rounded border font-medium",
        HOUSEKEEPING_CORNER_BADGE_CLASS[dialogHousekeepingTier]
      )}
    >
      {dialogHousekeepingTypeLabel}
    </Badge>
  );
  const dialogLogisticsKindBadgeCorner =
    effectiveLogisticsTaskKind != null ? (
      <LogisticsKindBadge kind={effectiveLogisticsTaskKind} />
    ) : isLogisticsDetails && !isTaskReadOnly ? (
      <LogisticsKindAddBadge
        onClick={() => setLogisticsKindPickerOpen(true)}
        disabled={isSavingLogisticsKind}
      />
    ) : null;

  const logisticsAlertParts: string[] = [];
  if (isSingleKeyStructure) {
    logisticsAlertParts.push("Consegnare chiave al cleaner.");
  }
  if (effectiveLogisticsTaskKind === "pick-up") {
    logisticsAlertParts.push("Solo ritiro dello sporco, no borsone.");
  } else if (effectiveLogisticsTaskKind === "delivery") {
    logisticsAlertParts.push("Consegna dotazione o materiale al cleaner.");
  } else if (effectiveLogisticsTaskKind === "delivery/pick-up") {
    logisticsAlertParts.push("Consegna borsone e ritiro sporco al checkout.");
  }
  const alertText = logisticsAlertParts.join(" ");
  const notesText =
    resolvedLogisticsDriverTaskKey === currentDetailsTaskKey
      ? String(logisticsHousekeepingNotes ?? "").trim()
      : "";
  const overriddenCustomerNote = customerNotesByTaskKey[currentDetailsTaskKey];
  const customerNoteText = overriddenCustomerNote !== undefined ? overriddenCustomerNote : notesText;
  const customerNoteDisplayText = customerNoteText
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .trim();
  const logisticsHousekeepingAlias =
    taskAny.cleaner_alias ??
    taskAny.assigned_cleaner_alias ??
    displayTaskAny.cleaner_alias ??
    displayTaskAny.assigned_cleaner_alias ??
    "";
  const syncTimelineRowStaffLabel = String(timelineRowStaffDisplayLabel ?? "").trim();
  const effectiveDriverBadge =
    resolvedLogisticsDriverTaskKey === currentDetailsTaskKey ? logisticsDriverBadge : null;
  const effectiveHousekeepingLabel =
    resolvedHousekeepingTaskKey === currentDetailsTaskKey
      ? logisticsHousekeepingCleanerLabel
      : null;
  const effectiveHousekeepingSequence =
    resolvedHousekeepingTaskKey === currentDetailsTaskKey
      ? logisticsHousekeepingSequence
      : null;
  const effectiveHousekeepingStartTime =
    resolvedHousekeepingTaskKey === currentDetailsTaskKey
      ? logisticsHousekeepingStartTime
      : null;
  const effectiveHousekeepingEndTime =
    resolvedHousekeepingTaskKey === currentDetailsTaskKey
      ? logisticsHousekeepingEndTime
      : null;
  const effectiveHousekeepingTravelTime =
    resolvedHousekeepingTaskKey === currentDetailsTaskKey
      ? logisticsHousekeepingTravelTime
      : null;

  const isContainerDetails = !isInTimeline && !isOfficeScope;
  const effectiveHousekeepingLabelText = String(effectiveHousekeepingLabel ?? "").trim();
  const logisticsHousekeepingAliasText = String(logisticsHousekeepingAlias || "").trim();
  const logisticsAssignedTo =
    logisticsHousekeepingAliasText ||
    effectiveHousekeepingLabelText ||
    "non assegnato";
  // Su timeline housekeeping `timelineRowStaffDisplayLabel` è il cleaner: non va mai come "Autista - Veicolo".
  const logisticsDriverDisplayValue =
    String(effectiveDriverBadge ?? "").trim() ||
    (isLogisticsTimelineDetails ? syncTimelineRowStaffLabel : "") ||
    "non assegnato";
  const logisticsSequenceDisplayValue = String(
    logisticsTimelineSequence ?? fallbackTimelineSequence ?? "—"
  );
  const logisticsTravelDisplayValue =
    logisticsTravelMinutes !== null
      ? `${logisticsTravelMinutes} minuti`
      : "non assegnato";
  const logisticsScheduledDisplayValue = logisticsScheduledAt || "non assegnato";
  const logisticsScheduledUntilDisplayValue = logisticsScheduledUntil || "non assegnato";
  const logisticsAlertDisplayValue = alertText || "—";
  const logisticsBedsDisplayValue = bedsSummaryText || "—";
  const hasCollaboration = Number((displayTask as any).collaborator_count || 0) > 1;
  const displayPriorityRaw = String((displayTask as any).priority ?? "").toLowerCase();
  const isDisplayPriorityEarlyOut = ["early_out", "early-out", "earlyout", "eo"].includes(displayPriorityRaw);
  const isDisplayPriorityHigh = [
    "high_priority",
    "high-priority",
    "highpriority",
    "high",
    "hp",
  ].includes(displayPriorityRaw);
  const primaryCollaboratorLabel = (() => {
    const primary = taskCollaborators.find((c: any) => Boolean(c?.isPrimary));
    if (!primary) return "";
    return String(primary.alias ?? primary.name ?? (primary.id != null ? `Cleaner ${primary.id}` : "")).trim();
  })();
  const collaboratorLabels = taskCollaborators
    .map((c: any) => String(c?.alias ?? c?.name ?? (c?.id != null ? `Cleaner ${c.id}` : "")).trim())
    .filter((label: string) => label.length > 0);
  const allCollaboratorsLabel = collaboratorLabels.join(", ");
  const isLogisticsScope = operationsScope === "logistics";
  const cleanerDetailsAssignedTo = (() => {
    if (isLogisticsScope) {
      if (allCollaboratorsLabel) return allCollaboratorsLabel;
      return effectiveHousekeepingLabelText || logisticsHousekeepingAliasText || "non assegnato";
    }
    return primaryCollaboratorLabel ? primaryCollaboratorLabel : logisticsAssignedTo;
  })();
  const cleanerDetailsSequenceValue = (() => {
    if (isLogisticsScope) {
      return effectiveHousekeepingSequence != null && Number.isFinite(effectiveHousekeepingSequence)
        ? String(effectiveHousekeepingSequence)
        : "non assegnato";
    }
    return String(effectiveHousekeepingSequence ?? fallbackTimelineSequence ?? "non assegnato");
  })();
  const housekeepingTravelDisplayValue =
    isLogisticsScope
      ? effectiveHousekeepingTravelTime != null && Number.isFinite(effectiveHousekeepingTravelTime)
        ? `${effectiveHousekeepingTravelTime} minuti`
        : assignmentTimes.travel_time !== undefined && assignmentTimes.travel_time !== null
          ? `${assignmentTimes.travel_time} minuti`
          : "non assegnato"
      : assignmentTimes.travel_time !== undefined
        ? `${assignmentTimes.travel_time} minuti`
        : "non assegnato";
  const housekeepingStartDisplayValue =
    isLogisticsScope
      ? String(effectiveHousekeepingStartTime ?? "").trim() ||
        "non assegnato"
      : String(assignmentTimes.start_time ?? "non assegnato");
  const housekeepingEndDisplayValue =
    isLogisticsScope
      ? String(effectiveHousekeepingEndTime ?? "").trim() ||
        "non assegnato"
      : String(assignmentTimes.end_time ?? "non assegnato");

  const alignLogisticsHousekeepingRows = false;

  const housekeepingTimelineDetailRows = () => (
    <>
            {/* Prima riga: Codice ADAM | Cliente */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
              <div className="self-start">
                <p className="text-sm font-semibold text-muted-foreground">Codice ADAM</p>
                <Input
                  value={String(displayTask.name ?? "")}
                  readOnly
                  className={displayInputClass}
                  tabIndex={-1}
                  onFocus={(e) => e.currentTarget.blur()}
                />
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Cliente</p>
                <Input
                  value={String(displayTask.customer_name ?? "non migrato")}
                  readOnly
                  className={displayInputClass}
                  tabIndex={-1}
                  onFocus={(e) => e.currentTarget.blur()}
                />
              </div>
            </div>

            {/* Seconda riga: Indirizzo | Durata pulizia */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-start">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Indirizzo</p>
                <Input
                  value={String(displayTask.address?.toUpperCase() ?? "NON MIGRATO")}
                  readOnly
                  className={displayInputClass}
                  tabIndex={-1}
                  onFocus={(e) => e.currentTarget.blur()}
                />
              </div>
              <div className="self-start">
                <p className={cn("text-sm font-semibold text-muted-foreground", !isLogisticsTimelineDetails && "mb-1")}>Durata pulizia</p>
                <Input
                  value={`${(displayTask.duration || "0.0").replace(".", ":")} ore`}
                  readOnly
                  className={displayInputClass}
                  tabIndex={-1}
                  onFocus={(e) => e.currentTarget.blur()}
                />
              </div>
            </div>

            {/* Terza riga: Check-out - Check-in (click apre dialog come Pax-In) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <p className={cn("text-sm font-semibold text-muted-foreground flex items-center gap-1", !isLogisticsTimelineDetails && "mb-1")}>
                  Check-out
                  {!isTaskReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                <Input
                  readOnly
                  value={
                    (displayTask as any).checkout_date
                      ? `${new Date((displayTask as any).checkout_date).toLocaleDateString("it-IT", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}${
                          (displayTask as any).checkout_time
                            ? ` - ${(displayTask as any).checkout_time}`
                            : " - orario non migrato"
                        }`
                      : "non migrato"
                  }
                  className={
                    isTaskReadOnly
                      ? displayInputClass
                      : cn(displayClickableInputClass, "cursor-pointer hover:bg-muted/50")
                  }
                  tabIndex={isTaskReadOnly ? -1 : 0}
                  onFocus={(e) => {
                    if (isTaskReadOnly) e.currentTarget.blur();
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isTaskReadOnly) handleOpenCheckoutDialog();
                  }}
                />
              </div>

              <div>
                <p className={cn("text-sm font-semibold text-muted-foreground flex items-center gap-1", !isLogisticsTimelineDetails && "mb-1")}>
                  Check-in
                  {!isTaskReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                <Input
                  readOnly
                  value={
                    (displayTask as any).checkin_date
                      ? `${new Date((displayTask as any).checkin_date).toLocaleDateString("it-IT", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                        })}${
                          (displayTask as any).checkin_time
                            ? ` - ${(displayTask as any).checkin_time}`
                            : " - orario non migrato"
                        }`
                      : "non migrato"
                  }
                  className={
                    isTaskReadOnly
                      ? displayInputClass
                      : cn(displayClickableInputClass, "cursor-pointer hover:bg-muted/50")
                  }
                  tabIndex={isTaskReadOnly ? -1 : 0}
                  onFocus={(e) => {
                    if (isTaskReadOnly) e.currentTarget.blur();
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isTaskReadOnly) handleOpenCheckinDialog();
                  }}
                />
              </div>
            </div>

            {/* Quarta riga: Tipologia appartamento - Tipologia intervento */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Tipologia appartamento</p>
                <Input value={String((displayTask as any).type_apt ?? "non migrato")} readOnly className={displayInputClass} tabIndex={-1} onFocus={(e) => e.currentTarget.blur()} />
              </div>

              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Tipologia intervento
                  {!isTaskReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                <Input
                  readOnly
                  value={(() => {
                    const taskKeyDisplay = getTaskKey(displayTask);
                    const pendingEditsDisplay = getPendingEdits()[taskKeyDisplay];
                    const userChoseNone =
                      pendingEditsDisplay?.operationIdModified === true && pendingEditsDisplay?.operationId === null;

                    if (userChoseNone) return "— Nessuna operazione —";
                    if (!isConfirmedOperation) return "non migrato";
                    if ((displayTask as any).operation_id) return getInterventionLabel(displayTask);
                    return "-";
                  })()}
                  className={
                    isTaskReadOnly
                      ? displayInputClass
                      : cn(displayClickableInputClass, "cursor-pointer hover:bg-muted/50")
                  }
                  tabIndex={isTaskReadOnly ? -1 : 0}
                  onFocus={(e) => {
                    if (isTaskReadOnly) e.currentTarget.blur();
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isTaskReadOnly) handleOpenOperationDialog();
                  }}
                />
              </div>
            </div>

            {/* Quinta riga: Pax-In - Pax-Out */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Pax-In
                  {!isTaskReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                <Input
                  readOnly
                  value={String((displayTask as any).pax_in ?? "non migrato")}
                  className={
                    isTaskReadOnly
                      ? displayInputClass
                      : cn(displayClickableInputClass, "cursor-pointer hover:bg-muted/50")
                  }
                  tabIndex={isTaskReadOnly ? -1 : 0}
                  onFocus={(e) => {
                    if (isTaskReadOnly) e.currentTarget.blur();
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isTaskReadOnly) handleOpenPaxInDialog();
                  }}
                />
              </div>

              <div>
                <p className="text-sm font-semibold text-muted-foreground">Pax-Out</p>
                <Input value={String((displayTask as any).pax_out ?? "non migrato")} readOnly className={displayInputClass} tabIndex={-1} onFocus={(e) => e.currentTarget.blur()} />
              </div>
            </div>

            {/* Sesta riga: Travel Time - Start Time - End Time (Start/End nella colonna destra) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Travel Time</p>
                <Input
                  value={housekeepingTravelDisplayValue}
                  readOnly
                  className={displayInputClass}
                  tabIndex={-1}
                  onFocus={(e) => e.currentTarget.blur()}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Start Time</p>
                  <Input value={housekeepingStartDisplayValue} readOnly className={displayInputClass} tabIndex={-1} onFocus={(e) => e.currentTarget.blur()} />
                </div>

                <div>
                  <p className="text-sm font-semibold text-muted-foreground">End Time</p>
                  <Input value={housekeepingEndDisplayValue} readOnly className={displayInputClass} tabIndex={-1} onFocus={(e) => e.currentTarget.blur()} />
                </div>
              </div>
            </div>
    </>
  );

  const logisticsTimelineDetailFields = () => (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-start min-h-[56px]">
        <div>
          <p className="text-sm font-semibold text-muted-foreground">Autista - Veicolo</p>
          <p className="mt-[8px] text-sm font-normal min-w-0 max-w-full whitespace-normal break-words">
            {logisticsDriverDisplayValue}
          </p>
        </div>
        <div className="shrink-0 min-w-[56px]">
          <p className="text-sm font-semibold text-muted-foreground">Sequenza</p>
          <p className="mt-[8px] text-sm font-semibold text-center whitespace-nowrap">
            {logisticsSequenceDisplayValue}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 min-h-[56px]">
        <div className="text-center">
          <p className="text-sm font-semibold text-muted-foreground">Travel Time</p>
          <Input
            value={logisticsTravelDisplayValue}
            readOnly
            className={cn(displayInputClass, "text-center")}
            tabIndex={-1}
            onFocus={(e) => e.currentTarget.blur()}
          />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-muted-foreground">Start Time</p>
          <Input
            value={logisticsScheduledDisplayValue}
            readOnly
            className={cn(displayInputClass, "text-center")}
            tabIndex={-1}
            onFocus={(e) => e.currentTarget.blur()}
          />
        </div>
        <div className="text-center">
          <p className="text-sm font-semibold text-muted-foreground">End Time</p>
          <Input
            value={logisticsScheduledUntilDisplayValue}
            readOnly
            className={cn(displayInputClass, "text-center")}
            tabIndex={-1}
            onFocus={(e) => e.currentTarget.blur()}
          />
        </div>
      </div>

      <div className="grid min-h-[56px] grid-cols-1 gap-2">
        <div className="-mt-0.5">
          <p className="text-sm font-semibold text-muted-foreground">Messaggi di allerta</p>
          <Input
            value={logisticsAlertDisplayValue}
            readOnly
            className={displayInputClass}
            tabIndex={-1}
            onFocus={(e) => e.currentTarget.blur()}
          />
        </div>

        <div className="-mt-0.5">
          {/** In containers la nota cliente resta solo lettura; in timeline e' modificabile. */}
          {(() => {
            const canEditCustomerNote = !isTaskReadOnly && isInTimeline;
            return (
              <>
          <p className="text-sm font-semibold text-muted-foreground flex items-center gap-1">
            Note del cliente
            {canEditCustomerNote && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
          </p>
          <div
            className={
              !canEditCustomerNote
                ? "min-h-9 w-full rounded-md border-transparent bg-transparent px-0 py-1 text-sm text-foreground shadow-none select-none whitespace-pre-wrap break-words"
                : "min-h-9 w-full rounded-md border-transparent bg-transparent px-0 py-1 text-sm text-foreground shadow-none whitespace-pre-wrap break-words cursor-pointer hover:bg-muted/50"
            }
            tabIndex={canEditCustomerNote ? 0 : -1}
            onFocus={(e) => {
              if (!canEditCustomerNote) e.currentTarget.blur();
            }}
            onClick={(e) => {
              e.stopPropagation();
              if (canEditCustomerNote) handleOpenCustomerNoteDialog();
            }}
          >
            {customerNoteDisplayText || "—"}
          </div>
              </>
            );
          })()}
        </div>
      </div>

      <div className="min-h-[56px]">
        <p className="text-sm font-semibold text-muted-foreground">Divani letto</p>
        <div
          className="min-h-9 w-full rounded-md border-transparent bg-transparent px-0 py-1 text-sm text-foreground shadow-none select-none whitespace-normal break-words"
          tabIndex={-1}
        >
          {logisticsBedsDisplayValue}
        </div>
      </div>
    </>
  );

  const renderTaskCardContent = ({
    isDragging,
    dragHandleProps,
    draggableProps,
    draggableStyle,
    innerRef,
  }: {
    isDragging: boolean;
    dragHandleProps?:
      | (React.HTMLAttributes<HTMLDivElement> &
          React.RefAttributes<HTMLDivElement>)
      | null;
    draggableProps?: React.HTMLAttributes<HTMLDivElement>;
    draggableStyle?: React.CSSProperties;
    innerRef?: React.Ref<HTMLDivElement>;
  }) => {
    const cardWidth =
      typeof dragOverlayWidthPx === "number" && dragOverlayWidthPx > 0
        ? `${dragOverlayWidthPx}px`
        : calculateWidth(effectiveDurationForUi, isInTimeline);

    // Nei container gli orari check-in/out sono in absolute a destra: riserviamo
    // spazio sul contenuto così il customer reference non ci si sovrappone.
    const reserveTimesSpace =
      !isInTimeline &&
      shouldShowCheckInOutArrows &&
      (Boolean((taskWithPendingEdits as any).checkout_time) ||
        Boolean((taskWithPendingEdits as any).checkin_time) ||
        isFutureCheckin);

    return (
            <div
              ref={innerRef}
              {...draggableProps}
              style={{
                ...draggableStyle,
                zIndex: isDragging ? 9999 : 'auto',
              }}
              className={isInTimeline ? "flex items-center" : ""}
            >
          {/* Task card con drag handle */}
          <div {...(dragHandleProps ?? undefined)} className="focus-visible:outline-none">
            {/* Task card effettiva */}
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn(
                      cardSurfaceClass,
                      "rounded-md border transition-colors duration-200",
                      showCompactAdamTimelineUi ? "px-1 py-0" : "flex items-center px-2 py-1",
                      isSelected && isMultiSelectMode && !isInTimeline && "z-[1] ring-2 ring-sky-500 ring-inset",
                      isOverdue && isInTimeline && "animate-blink",
                      !isDragging && isMapFiltered && "task-border-map-filtered",
                      !isDragging && !isMapFiltered && isHighlighted && "task-border-search-highlighted",
                      "cursor-pointer flex-shrink-0 relative group"
                    )}
                    style={{
                      width: cardWidth,
                      minWidth: cardWidth,
                      maxWidth: cardWidth,
                      height: isInTimeline ? "40px" : undefined,
                      minHeight: "40px",
                      maxHeight: isInTimeline ? "40px" : undefined,
                      overflow: isInTimeline ? "visible" : undefined,
                      zIndex:
                        isDragging
                          ? 9999
                          : showCompactAdamTimelineUi
                            ? 20
                            : isMapFiltered
                              ? 10
                              : 'auto',
                    }}
                    data-dnd-task-card-surface="true"
                    data-testid={`task-card-${getTaskKey(task)}`}
                    onClick={(e) => {
                      if (!isDragging) {
                        handleCardClick(e);
                      }
                    }}
                  >
                    <div
                      className={`absolute left-[2px] top-[2px] bottom-[2px] w-1.5 rounded-sm ${categoryStripeClass}`}
                      aria-hidden="true"
                    />
                    {operationsScope === "logistics" && cardLogisticsSequenceLabel && (
                      <LogisticsSequenceBadge
                        sequence={cardLogisticsSequenceLabel}
                        className="absolute -top-1.5 -right-1.5 z-[65]"
                      />
                    )}
                    {showCompactAdamTimelineUi ? (
                      <LogisticsAdamCodeLabel code={logisticsAdamCode} />
                    ) : (
                      <>
                    {/* Selection indicator (top-left) */}
                    {isMultiSelectMode && !isInTimeline && (
                      <div className="absolute -top-1.5 -left-1 z-[60]">
                        <div
                          className={[
                            "w-4 h-4 rounded-full flex items-center justify-center",
                            "text-[10px] font-bold leading-none border-2 transition-all duration-150",
                            isSelected
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                            isSelected
                            ? "bg-sky-600 text-white border-sky-700 shadow-md"
                            : "bg-transparent text-sky-600 border-sky-600"                          
                          ].join(" ")}
                          onClick={(e) => {
                            e.stopPropagation();
                            multiSelectContext?.toggleTask(String(task.id), currentContainer);
                          }}
                          role="checkbox"
                          aria-checked={isSelected}
                        >
                          {isSelected ? selectionOrder : ""}
                        </div>
                      </div>
                    )}

                    {!isConfirmedOperation && !isSelected && (
                      <div className="absolute -top-1.5 -right-1.5 z-10">
                        <div className="w-4 h-4 rounded-full flex items-center justify-center bg-gray-900/75 text-white border-2 border-gray-700/80 shadow-md backdrop-blur-sm">
                          <HelpCircle className="w-3 h-3" strokeWidth={2.5} />
                        </div>
                      </div>
                    )}
                    {isPreAssigned && (
                      <div className="absolute -top-1.5 -right-1.5 z-[70]">
                        <div
                          className={[
                            "w-4 h-4 rounded-full flex items-center justify-center text-white border-2 shadow-md",
                            isPreAssignedReadonly
                              ? "bg-amber-600 border-amber-700"
                              : "bg-sky-500 border-sky-600",
                          ].join(" ")}
                        >
                          {isPreAssignedReadonly ? (
                            <Lock className="w-2.5 h-2.5" strokeWidth={2.5} />
                          ) : (
                            <LockOpen className="w-2.5 h-2.5" strokeWidth={2.5} />
                          )}
                        </div>
                      </div>
                    )}

                    {/* Frecce check-in e check-out */}
                    {shouldShowCheckInOutArrows &&
                      ((taskWithPendingEdits as any).checkout_time ||
                        (taskWithPendingEdits as any).checkin_time ||
                        isFutureCheckin) && (() => {
                        const hasCheckout = Boolean((taskWithPendingEdits as any).checkout_time);
                        const hasCheckin = Boolean((taskWithPendingEdits as any).checkin_time) || isFutureCheckin;

                        const linesCount = (hasCheckout ? 1 : 0) + (hasCheckin ? 1 : 0);
                        const isSingleLine = linesCount === 1;

                        const hasCustomerRef = Boolean((task as any).customer_reference);

                        // task.duration è tipo "1.30" => 1h 30m
                        const durationStr = String(effectiveDurationForUi ?? "0.0");
                        const [hStr, mStr] = durationStr.split(".");
                        const hours = Number(hStr || 0);
                        const mins = Number(mStr || 0);
                        const durationMinutes = hours * 60 + mins;

                        const isShortTask = durationMinutes < 90; // < 1:30

                        // Regola:
                        // - 2 orari -> top leggermente sotto il ?
                        // - 1 orario:
                        //    - se customer ref e task < 1:30 => bottom-right
                        //    - altrimenti => centrato
                        // - calendario solo: è comunque "1 linea" (hasCheckin true) quindi segue la stessa regola
                        const shouldBottomRightSingleLine = isSingleLine && hasCustomerRef && isShortTask;
                        const shouldCenterSingleLine = isSingleLine && !shouldBottomRightSingleLine;

                        return (
                          <div
                            className={[
                              "absolute right-1 z-30 whitespace-nowrap", // z più basso del ? (che è z-50)
                              "flex flex-col items-end gap-0.5 min-h-[28px]",
                              // posizione verticale
                              linesCount === 2
                                ? "inset-y-0 justify-center"
                                : shouldBottomRightSingleLine
                                  ? "bottom-[5px] justify-end"
                                  : "inset-y-0 justify-center",
                            ].join(" ")}
                          >
                            {hasCheckout && (
                              <div className="flex items-center gap-0.5 leading-none">
                                <span className="font-black text-[15px] leading-none text-[#257537]">↑</span>
                                <span className="text-[11px] leading-none text-[#137537] font-bold">
                                  {(taskWithPendingEdits as any).checkout_time}
                                </span>
                              </div>
                            )}

                            {hasCheckin && (
                              <div className="flex items-center gap-0.5 leading-none">
                                {isFutureCheckin ? (
                                  <>
                                    <CalendarIcon className="w-3.5 h-3.5 text-red-600" strokeWidth={2.5} />
                                    {(taskWithPendingEdits as any).checkin_time && (
                                      <span className="text-red-600 text-[11px] leading-none font-bold">
                                        {(taskWithPendingEdits as any).checkin_time}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  (taskWithPendingEdits as any).checkin_time && (
                                    <>
                                      <span className="text-red-600 font-black text-[15px] leading-none">↓</span>
                                      <span className="text-red-600 text-[11px] leading-none font-bold">
                                        {(taskWithPendingEdits as any).checkin_time}
                                      </span>
                                    </>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                    <div className={cn("flex flex-col items-start justify-center flex-1 min-w-0 gap-0.5 pl-2 overflow-visible", reserveTimesSpace ? "pr-[52px]" : "pr-1")}>
                      <div className="flex items-center gap-1 w-full min-w-0 overflow-visible">
                        <span
                          className="text-foreground font-extrabold text-[13px] leading-none shrink-0"
                          data-testid={`task-name-${getTaskKey(task)}`}
                        >
                          {task.name}
                        </span>
                        {(task as any).customer_reference && (
                          <span className="text-red-600 dark:text-red-400 font-bold text-[11px] whitespace-nowrap">
                            ({(task as any).customer_reference})
                          </span>
                        )}
                        {(task as any).collaborator_count > 1 && (
                          <Badge className="bg-purple-500 hover:bg-purple-600 px-0.5 py-0 h-3.5 flex items-center shrink-0">
                            <span className="text-[10px]">👥</span>
                          </Badge>
                        )}
                      </div>
                      {task.alias && (
                        <span className="opacity-80 leading-none text-foreground font-semibold text-[9px] whitespace-nowrap">
                          {task.alias}{(task as any).type_apt ? ` (${(task as any).type_apt})` : ''}
                        </span>
                      )}
                    </div>
                      </>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent
                  side="top"
                  className="z-[10000] max-w-xs text-base px-3 py-2 pointer-events-none"
                >
                  <div className="flex flex-col items-center gap-2">
                    <p className="font-semibold">{cardTooltipAddressLine}</p>
                    {shouldShowTooltipTimes && ((displayTask as any).checkout_time || (displayTask as any).checkin_time) && (
                      <div className="flex items-center gap-3 text-sm">
                        {(displayTask as any).checkout_time && (
                          <div className="flex items-center gap-1">
                            <span className="text-green-500">↑</span>
                            <span>{(displayTask as any).checkout_time}</span>
                          </div>
                        )}
                        {(displayTask as any).checkin_time && (
                          <div className="flex items-center gap-1">
                            <span className="text-red-500">↓</span>
                            <span>{(displayTask as any).checkin_time}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
              </div>
            </div>
          );
  };

  return (
    <>
      {renderTaskCardContent({
        isDragging: externalIsDragging,
        dragHandleProps: externalDragHandleProps,
      })}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent
          className={cn(
            "overflow-y-auto overflow-x-hidden",
            isTimelineDetailsDialog
              ? "w-[min(96vw,1280px)] max-w-[1280px] max-h-[85vh]"
              : "sm:max-w-xl max-h-[75vh]"
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <div className="flex items-center justify-between w-full">
              <Button
                variant="ghost"
                size="icon"
                onClick={handlePrevTask}
                disabled={!canGoPrev}
                className={cn("h-8 w-8", !canGoPrev && "opacity-30 cursor-not-allowed")}
                type="button"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>

              <DialogTitle className="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-2 text-center">
                Dettagli Task #{getTaskKey(displayTask)}
                {!isLogisticsDetails && !isHousekeepingDetails && dialogHousekeepingTypeBadge}
                {(displayTask as any).priority && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs shrink-0",
                      isDisplayPriorityEarlyOut
                        ? "bg-blue-500 text-white border-blue-700"
                        : isDisplayPriorityHigh
                          ? "bg-orange-500 text-white border-orange-700"
                          : "bg-gray-500 text-white border-gray-700"
                    )}
                  >
                    {isDisplayPriorityEarlyOut
                      ? "EO"
                      : isDisplayPriorityHigh
                        ? "HP"
                        : "LP"}
                  </Badge>
                )}
              </DialogTitle>

              <Button
                variant="ghost"
                size="icon"
                onClick={handleNextTask}
                disabled={!canGoNext}
                className={cn("h-8 w-8", !canGoNext && "opacity-30 cursor-not-allowed")}
                type="button"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          </DialogHeader>

          <div
            className={cn(
              "mt-3",
              isTimelineDetailsDialog &&
                cn(
                  "grid grid-cols-1 xl:grid-cols-[3fr_minmax(0,5fr)] gap-4 items-stretch"
                )
            )}
          >
            {isTimelineDetailsDialog && (
              <div className="flex h-full min-h-0 flex-col gap-6 self-stretch">
                {isTimelineDetailsDialog && (
                  <div className="relative flex-1 rounded-md border border-border bg-muted/20 p-3">
                    <div className="absolute -top-3 left-3 inline-flex items-center gap-1.5 rounded-t-md rounded-b-sm border border-border bg-background px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-foreground shadow-sm">
                      <Truck className="h-3.5 w-3.5 shrink-0" />
                      <span>Dettagli Logistica</span>
                    </div>
                    {dialogLogisticsKindBadgeCorner && (
                      <div className={DIALOG_SECTION_CORNER_BADGE_WRAP_CLASS}>
                        {dialogLogisticsKindBadgeCorner}
                      </div>
                    )}

                    <div className="grid gap-3 pt-2">{logisticsTimelineDetailFields()}</div>
                  </div>
                )}

                <div className="relative rounded-md border border-border bg-muted/20 p-3 flex-none mt-auto">
                  <div className="absolute -top-3 left-3 inline-flex items-center gap-1.5 rounded-t-md rounded-b-sm border border-border bg-background px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-foreground shadow-sm">
                    <User className="h-3.5 w-3.5 shrink-0" />
                    <span>Dettagli Cleaner</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground">Task assegnato a</p>
                      <Input
                        value={cleanerDetailsAssignedTo}
                        readOnly
                        className={displayInputClass}
                        tabIndex={-1}
                        onFocus={(e) => e.currentTarget.blur()}
                      />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-muted-foreground">Sequenza</p>
                      <Input
                        value={cleanerDetailsSequenceValue}
                        readOnly
                        className={displayInputClass}
                        tabIndex={-1}
                        onFocus={(e) => e.currentTarget.blur()}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div
              className={cn(
                isTimelineDetailsDialog
                  ? "relative min-h-0 min-w-0 rounded-md border border-border bg-muted/20 p-3 flex h-full flex-col self-stretch"
                  : "space-y-3"
              )}
            >
            {isTimelineDetailsDialog && (
              <div className="absolute -top-3 left-3 inline-flex items-center gap-1.5 rounded-t-md rounded-b-sm border border-border bg-background px-2.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-foreground shadow-sm">
                <Building2 className="h-3.5 w-3.5 shrink-0" />
                <span>{isLogisticsDetails || isHousekeepingDetails ? "Dettagli Housekeeping" : "Dettagli Task"}</span>
              </div>
            )}
            {(isLogisticsDetails || isHousekeepingDetails) && (
              <div className={DIALOG_SECTION_CORNER_BADGE_WRAP_CLASS}>{dialogHousekeepingCornerTypeBadge}</div>
            )}
            <div
              className={cn(
                isTimelineDetailsDialog && "flex flex-1 flex-col min-h-0 gap-3 pt-2",
                !isTimelineDetailsDialog && "space-y-3"
              )}
            >
              {housekeepingTimelineDetailRows()}
              {isTimelineDetailsDialog && (
                <div className="flex-1 min-h-[1px] shrink-0" aria-hidden="true" />
              )}
            </div>

            {/* Settima riga: Gestione Collaboratori - visibile anche in logistics (senza pulsante aggiunta) */}
            {isInTimeline && (
              <div className="pt-3 border-t mt-3">
                <div
                  className={cn(
                    "flex items-center justify-between mb-2 rounded-md px-2 py-1 transition-colors",
                    hasCollaboration && "cursor-pointer hover:bg-purple-50 dark:hover:bg-purple-900/20"
                  )}
                  role={hasCollaboration ? "button" : undefined}
                  tabIndex={hasCollaboration ? 0 : -1}
                  onClick={() => {
                    if (hasCollaboration) setIsCollaborationDetailsOpen(true);
                  }}
                  onKeyDown={(e) => {
                    if (!hasCollaboration) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setIsCollaborationDetailsOpen(true);
                    }
                  }}
                >
                  <div
                    className={cn(
                      "flex items-center gap-2 rounded px-1 py-0.5"
                    )}
                  >
                    <Users className="w-4 h-4 text-purple-600" />
                    <span className="text-sm font-semibold text-muted-foreground">
                      Collaboratori
                    </span>
                    {/* Lista collaboratori con alias con badge inline */}
                    {taskCollaborators.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 ml-1">
                        {taskCollaborators.map((collab) => (
                          <Badge 
                            key={collab.id} 
                            variant={collab.isPrimary ? "default" : "secondary"}
                            className={cn(
                              "text-[10px] px-1.5 py-0 h-5 flex items-center gap-1",
                              collab.isPrimary && "bg-blue-600 hover:bg-blue-700"
                            )}
                          >
                            {collab.alias || collab.name}
                            {collab.isPrimary && <span className="text-[9px] font-bold">(P)</span>}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {!isLogisticsTimelineDetails &&
                      (displayTask as any).collaborator_count > 1 &&
                      taskCollaborators.length === 0 && (
                      <Badge variant="secondary" className="text-xs">
                        {(displayTask as any).collaborator_count} cleaners
                      </Badge>
                      )}
                  </div>
                  {!isLogisticsTimelineDetails && (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openAddCollaboratorDialog();
                        }}
                        disabled={isTaskReadOnly}
                        className="flex items-center gap-1 border-2 border-purple-300 dark:border-purple-700 hover:bg-purple-50 dark:hover:bg-purple-900/20"
                      >
                        <UserPlus className="w-3 h-3" />
                        Aggiungi collaboratore
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}


            {/* Ottava riga: Blocco Task - solo nei container */}
            {!isInTimeline && (
              <div className="pt-3 border-t mt-3">
                <div className="flex items-center gap-3">
                  <Button
                    variant={isLocked ? "destructive" : "outline"}
                    size="sm"
                    onClick={handleToggleLock}
                    className="flex items-center gap-2"
                    data-testid={`lock-task-btn-${getTaskKey(task)}`}
                  >
                    {isLocked ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
                    {isLocked ? "Sblocca" : "Blocca"}
                  </Button>
                  {isLocked && (
                    <div className="flex-1">
                      <Input
                        type="text"
                        value={lockedReason}
                        onChange={(e) => setLockedReason(e.target.value)}
                        onBlur={() => handleSaveLockedReason({ stopPropagation: () => {} } as any)}
                        placeholder="Motivo del blocco..."
                        className="text-sm"
                        data-testid={`lock-reason-input-${getTaskKey(task)}`}
                      />
                    </div>
                  )}
                </div>
                {isLocked && (
                  <p className="text-xs text-red-600 mt-1">
                    Questa task non può essere assegnata o trascinata
                  </p>
                )}
              </div>
            )}

            {/* Pulsante Salva Modifiche */}
            {editingFields.size > 0 && !isTaskReadOnly && (
              <div className="pt-4 border-t mt-4 flex gap-2">
                <Button
                  onClick={handleSaveChanges}
                  disabled={isSaving}
                  className="flex-1"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {isSaving ? "Salvataggio..." : "Salva Modifiche"}
                </Button>
                <Button
                  onClick={() => {
                    setEditingFields(new Set());
                    // Ripristina i valori originali
                    setEditedCheckoutDate((displayTask as any).checkout_date || "");
                    setEditedCheckoutTime((displayTask as any).checkout_time || "");
                    setEditedCheckinDate((displayTask as any).checkin_date || "");
                    setEditedCheckinTime((displayTask as any).checkin_time || "");
                    const duration = displayTask.duration || "0.0";
                    const [hours, mins] = duration.split('.').map(Number);
                    const totalMinutes = (hours || 0) * 60 + (mins || 0);
                    setEditedDuration(totalMinutes.toString());
                    setEditedPaxIn(String((displayTask as any).pax_in || 0));
                    setEditedOperationId(String((displayTask as any).operation_id || ""));
                  }}
                  variant="outline"
                >
                  Annulla
                </Button>
              </div>
            )}

            </div>

          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog a scomparsa: dettagli collaborazione */}
      <Dialog open={isCollaborationDetailsOpen} onOpenChange={setIsCollaborationDetailsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Users className="w-4 h-4 text-purple-600" />
              Dettagli collaborazione
            </DialogTitle>
            <DialogDescription>
              Informazioni della collaborazione per la task <strong>#{getTaskKey(displayTask)}</strong>.
            </DialogDescription>
          </DialogHeader>
          {hasCollaboration ? (
            <div className="text-sm text-muted-foreground mt-2 p-3 bg-purple-50 dark:bg-purple-900/20 rounded border border-purple-300 dark:border-purple-700">
              <div className="flex items-center gap-2 mb-2">
                <Users className="w-4 h-4 text-purple-600" />
                <span className="font-semibold text-purple-700 dark:text-purple-300">
                  Collaborazione ({(displayTask as any).collaborator_count} cleaners)
                </span>
              </div>
              <p>
                <strong>Durata originale:</strong> {(() => {
                  const baseTime = (displayTask as any).base_cleaning_time || 0;
                  const hours = Math.floor(baseTime / 60);
                  const mins = baseTime % 60;
                  return `${hours}:${String(mins).padStart(2, '0')} ore`;
                })()}
              </p>
              <p>
                <strong>Durata per cleaner:</strong> {(displayTask.duration || "0.0").replace(".", ":")} ore
              </p>
              {(displayTask as any).is_primary && (
                <p className="text-blue-600 font-semibold mt-1">Questo cleaner è il Primary</p>
              )}
              {!isTaskReadOnly && (
                <Button
                  variant="destructive"
                  size="sm"
                  className="mt-3 w-full flex items-center justify-center gap-2"
                  onClick={() => {
                    setIsCollaborationDetailsOpen(false);
                    setShowDissolveDialog(true);
                  }}
                  disabled={isDissolvingCollaboration}
                >
                  <Trash2 className="w-4 h-4" />
                  {isDissolvingCollaboration ? "Rimozione..." : "Rimuovi collaborazione"}
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground mt-2">Nessuna collaborazione attiva per questa task.</p>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog Modifica Pax-In - stesso stile di Alias/Start Time in Dettagli Cleaner */}
      <Dialog open={paxInDialogOpen} onOpenChange={(open) => !open && setPaxInDialogOpen(false)}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Pax-In
            </DialogTitle>
            <DialogDescription>
              Task <strong>#{getTaskKey(displayTask)}</strong> — Inserisci il numero di ospiti (Pax-In).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Nuovo Pax-In
              </label>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={editingPaxInInDialog}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "");
                  setEditingPaxInInDialog(v);
                }}
                placeholder="0"
                className="w-full"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSavePaxIn();
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPaxInDialogOpen(false)}
              disabled={isSavingPaxIn}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSavePaxIn}
              disabled={isSavingPaxIn}
              className="border-2 border-custom-blue"
            >
              {isSavingPaxIn ? (
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

      <Dialog open={customerNoteDialogOpen} onOpenChange={(open) => !open && setCustomerNoteDialogOpen(false)}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Note del cliente
            </DialogTitle>
            <DialogDescription>
              Task <strong>#{getTaskKey(displayTask)}</strong> — Inserisci le note del cliente.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Note del cliente
              </label>
              <Textarea
                value={editingCustomerNoteInDialog}
                onChange={(e) => setEditingCustomerNoteInDialog(e.target.value)}
                placeholder="Inserisci le note..."
                className="w-full min-h-[120px]"
                autoFocus
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCustomerNoteDialogOpen(false)}
              disabled={isSavingCustomerNote}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveCustomerNote}
              disabled={isSavingCustomerNote}
              className="border-2 border-custom-blue"
            >
              {isSavingCustomerNote ? (
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

      {/* Dialog Modifica Check-out - stesso stile di Pax-In */}
      <Dialog open={checkoutDialogOpen} onOpenChange={(open) => !open && setCheckoutDialogOpen(false)}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Check-out
            </DialogTitle>
            <DialogDescription>
              Task <strong>#{getTaskKey(displayTask)}</strong> — Inserisci data e orario di check-out.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">Data</label>
              <Popover open={checkoutDatePickerOpen} onOpenChange={setCheckoutDatePickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {editingCheckoutDateInDialog
                      ? format(editingCheckoutDateInDialog.length === 10 ? parseISO(editingCheckoutDateInDialog) : new Date(editingCheckoutDateInDialog), "EEEE d MMMM yyyy", { locale: it })
                      : "Seleziona data"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <CalendarPicker
                    mode="single"
                    selected={editingCheckoutDateInDialog ? (editingCheckoutDateInDialog.length === 10 ? parseISO(editingCheckoutDateInDialog) : new Date(editingCheckoutDateInDialog)) : undefined}
                    onSelect={(d) => {
                      if (!d) return;
                      setEditingCheckoutDateInDialog(format(d, "yyyy-MM-dd"));
                      setCheckoutDatePickerOpen(false);
                    }}
                    locale={it}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">Orario</label>
              <div className="flex gap-2">
                <Select
                  value={(editingCheckoutTimeInDialog || "00:00").split(":")[0]}
                  onValueChange={(hour) => {
                    const [, m] = (editingCheckoutTimeInDialog || "00:00").split(":");
                    setEditingCheckoutTimeInDialog(`${hour}:${m || "00"}`);
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Ora" />
                  </SelectTrigger>
                  <SelectContent side="bottom" className="max-h-44">
                    {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
                      <SelectItem key={h} value={h}>{h}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={(editingCheckoutTimeInDialog || "00:00").split(":")[1] || "00"}
                  onValueChange={(minute) => {
                    const [h] = (editingCheckoutTimeInDialog || "00:00").split(":");
                    setEditingCheckoutTimeInDialog(`${h || "00"}:${minute}`);
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Min" />
                  </SelectTrigger>
                  <SelectContent side="bottom" className="max-h-44">
                    {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCheckoutDialogOpen(false)}
              disabled={isSavingCheckout}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveCheckout}
              disabled={isSavingCheckout}
              className="border-2 border-custom-blue"
            >
              {isSavingCheckout ? (
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

      {/* Dialog Modifica Check-in - stesso stile di Pax-In */}
      <Dialog open={checkinDialogOpen} onOpenChange={(open) => !open && setCheckinDialogOpen(false)}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Check-in
            </DialogTitle>
            <DialogDescription>
              Task <strong>#{getTaskKey(displayTask)}</strong> — Inserisci data e orario di check-in.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">Data</label>
              <Popover open={checkinDatePickerOpen} onOpenChange={setCheckinDatePickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {editingCheckinDateInDialog
                      ? format(editingCheckinDateInDialog.length === 10 ? parseISO(editingCheckinDateInDialog) : new Date(editingCheckinDateInDialog), "EEEE d MMMM yyyy", { locale: it })
                      : "Seleziona data"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-2" align="start">
                  <CalendarPicker
                    mode="single"
                    selected={editingCheckinDateInDialog ? (editingCheckinDateInDialog.length === 10 ? parseISO(editingCheckinDateInDialog) : new Date(editingCheckinDateInDialog)) : undefined}
                    onSelect={(d) => {
                      if (!d) return;
                      setEditingCheckinDateInDialog(format(d, "yyyy-MM-dd"));
                      setCheckinDatePickerOpen(false);
                    }}
                    locale={it}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">Orario</label>
              <div className="flex gap-2">
                <Select
                  value={(editingCheckinTimeInDialog || "00:00").split(":")[0]}
                  onValueChange={(hour) => {
                    const [, m] = (editingCheckinTimeInDialog || "00:00").split(":");
                    setEditingCheckinTimeInDialog(`${hour}:${m || "00"}`);
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Ora" />
                  </SelectTrigger>
                  <SelectContent side="bottom" className="max-h-44">
                    {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((h) => (
                      <SelectItem key={h} value={h}>{h}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={(editingCheckinTimeInDialog || "00:00").split(":")[1] || "00"}
                  onValueChange={(minute) => {
                    const [h] = (editingCheckinTimeInDialog || "00:00").split(":");
                    setEditingCheckinTimeInDialog(`${h || "00"}:${minute}`);
                  }}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Min" />
                  </SelectTrigger>
                  <SelectContent side="bottom" className="max-h-44">
                    {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((m) => (
                      <SelectItem key={m} value={m}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCheckinDialogOpen(false)}
              disabled={isSavingCheckin}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveCheckin}
              disabled={isSavingCheckin}
              className="border-2 border-custom-blue"
            >
              {isSavingCheckin ? (
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

      {/* Dialog scelta tipologia logistica (task non determinati) */}
      <LogisticsKindPickerDialog
        open={logisticsKindPickerOpen}
        onOpenChange={setLogisticsKindPickerOpen}
        taskLabel={`#${getTaskKey(displayTask)}`}
        onSelect={handleSelectLogisticsKind}
        isSaving={isSavingLogisticsKind}
      />

      {/* Dialog Modifica Tipologia intervento - stesso stile di Pax-In / Check-out / Check-in */}
      <Dialog open={operationDialogOpen} onOpenChange={(open) => !open && setOperationDialogOpen(false)}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Tipologia intervento
            </DialogTitle>
            <DialogDescription>
              Task <strong>#{getTaskKey(displayTask)}</strong> — Seleziona la tipologia di intervento.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Tipologia intervento
              </label>
              <Select
                value={editingOperationIdInDialog}
                onValueChange={setEditingOperationIdInDialog}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Seleziona operazione" />
                </SelectTrigger>
                <SelectContent side="bottom" className="max-h-44">
                  <SelectItem value="none">— Nessuna operazione —</SelectItem>
                  {selectableOperations.map((op) => (
                    <SelectItem key={op.id} value={String(op.id)}>
                      {op.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOperationDialogOpen(false)}
              disabled={isSavingOperation}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveOperation}
              disabled={isSavingOperation}
              className="border-2 border-custom-blue"
            >
              {isSavingOperation ? (
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

      {/* Dialog di conferma per dissoluzione collaborazione */}
      <AlertDialog open={showDissolveDialog} onOpenChange={setShowDissolveDialog}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <Trash2 className="w-5 h-5" />
              Conferma Rimozione Collaborazione
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="text-base text-foreground font-semibold mb-3">
                  La collaborazione verrà rimossa e la task tornerà nei containers con la durata originale.
                </p>
                <div className="bg-purple-50 dark:bg-purple-900/20 rounded p-3 mb-3 text-sm">
                  <p><strong>Durata originale:</strong> {(() => {
                    const baseTime = (displayTask as any).base_cleaning_time || 0;
                    const hours = Math.floor(baseTime / 60);
                    const mins = baseTime % 60;
                    return `${hours}:${String(mins).padStart(2, '0')} ore`;
                  })()}</p>
                  <p><strong>Durata attuale per cleaner:</strong> {(displayTask.duration || "0.0").replace(".", ":")} ore</p>
                  <p><strong>Cleaners coinvolti:</strong> {(displayTask as any).collaborator_count || 0}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setShowDissolveDialog(false)}
              className="border-2 border-purple-300 dark:border-purple-700"
              disabled={isDissolvingCollaboration}
            >
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
                const taskId = (displayTask as any).task_id || displayTask.id;
                
                setIsDissolvingCollaboration(true);
                
                try {
                  const response = await fetch(`/api/tasks/${taskId}/collaborators/dissolve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date: workDate })
                  });
                  
                  const result = await response.json();
                  
                  if (result.success) {
                    toast({
                      title: "Collaborazione rimossa",
                      description: `Task ${result.logisticCode} riportata in ${result.priority} con durata ${result.originalDuration} min`,
                    });
                    setShowDissolveDialog(false);
                    setIsModalOpen(false);
                    window.dispatchEvent(new CustomEvent('refresh-assignments'));
                  } else {
                    toast({
                      title: "Errore",
                      description: result.error || "Impossibile rimuovere la collaborazione",
                      variant: "destructive"
                    });
                  }
                } catch (error: any) {
                  toast({
                    title: "Errore",
                    description: error.message || "Errore nella rimozione della collaborazione",
                    variant: "destructive"
                  });
                } finally {
                  setIsDissolvingCollaboration(false);
                }
              }}
              disabled={isDissolvingCollaboration}
              className="bg-background hover:bg-accent text-foreground border-2 border-purple-300 dark:border-purple-700 shadow-sm"
            >
              {isDissolvingCollaboration ? "Rimozione..." : "Conferma Rimozione"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog per selezione collaboratori */}
      <CleanerSelectorDialog
        isOpen={isCleanerSelectorOpen}
        onClose={() => setIsCleanerSelectorOpen(false)}
        onConfirm={handleCollaboratorSelection}
        excludeCleanerId={(displayTask as any).cleaner_id || (displayTask as any).assignedCleaner}
        excludeCleanerIds={taskCollaborators.map((c: any) => Number(c.id)).filter((id: number) => Number.isFinite(id))}
        workDate={localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0]}
        title="Aggiungi Collaboratori"
        description="Seleziona uno o più cleaners da aggiungere come collaboratori a questa task"
        confirmLabel="Aggiungi"
        baseCleaningTime={(() => {
          const currentCount = (displayTask as any).collaborator_count || 1;
          let baseTime = (displayTask as any).base_cleaning_time;
          if (!baseTime) {
            const durationStr = displayTask.duration || "0.0";
            const [h, m] = durationStr.split('.').map(Number);
            baseTime = ((h || 0) * 60 + (m || 0)) * currentCount;
          }
          return baseTime;
        })()}
        existingCollaboratorCount={(displayTask as any).collaborator_count || 1}
        preselectedCleanerIds={[]}
        primaryCleanerId={
          (() => {
            const p = taskCollaborators.find((c: any) => Boolean(c?.isPrimary));
            return p ? Number(p.id) : null;
          })()
        }
        isLoading={isCollaboratorLoading}
      />
    </>
  );
}