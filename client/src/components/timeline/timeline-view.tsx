import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar as CalendarIcon, RotateCcw, Users, RefreshCw, UserPlus, UserMinus, Maximize2, Minimize2, Check, CheckCircle, Save, Pencil, ChevronLeft, ChevronRight, Loader2, Zap, Lock, Unlock } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import * as React from "react";
import { Droppable, Draggable } from "react-beautiful-dnd";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { fetchWithOperation } from "@/lib/operationManager";
import { useToast } from "@/hooks/use-toast";
import TaskCard from "@/components/drag-drop/task-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocation } from 'wouter';
import { format } from 'date-fns';
import { loadValidationRules, canCleanerHandleTaskSync } from "@/lib/taskValidation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getCleanerHexColor } from "@/lib/cleaner-colors";
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
  hasUnsavedChanges?: boolean; // Stato delle modifiche non salvate dal parent
  onTaskMoved?: () => void; // Callback quando una task viene spostata
  /** Dopo reset assegnazioni: ripristina stato pulsanti Assegna EO → HP → LP nel parent */
  onWaveAssignStateReset?: () => void;
  isReadOnly?: boolean; // Modalità read-only: disabilita tutte le modifiche
  isLoadingDragDrop?: boolean; // Mostra loading overlay durante drag&drop
  lastValidDragIndex?: number | null; // Indice valido durante il drag (da container verso timeline)
  draggingOverCleanerId?: number | null; // ID del cleaner su cui si sta trascinando
  searchTask?: string; // Ricerca task per ID, logistic code, address o customer reference
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
  show_plus_one?: boolean;
}

export default function TimelineView({
  personnel,
  tasks,
  hasUnsavedChanges = false,
  onTaskMoved,
  onWaveAssignStateReset,
  isReadOnly = false,
  isLoadingDragDrop = false,
  lastValidDragIndex = null,
  draggingOverCleanerId = null,
  searchTask = "",
}: TimelineViewProps) {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    // Leggi la data dal parametro URL se presente
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date');

    if (dateParam) {
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
  const [selectedCleaner, setSelectedCleaner] = useState<Cleaner | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedSwapCleaner, setSelectedSwapCleaner] = useState<string>("");
  const [filteredCleanerId, setFilteredCleanerId] = useState<number | null>(null);
  const [clickTimer, setClickTimer] = useState<NodeJS.Timeout | null>(null);
  const [cleanersAliases, setCleanersAliases] = useState<Record<number, {alias: string}>>({});
  const [isAddCleanerDialogOpen, setIsAddCleanerDialogOpen] = useState(false);
  const [availableCleaners, setAvailableCleaners] = useState<Cleaner[]>([]);
  const [cleanerToReplace, setCleanerToReplace] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
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

  // Stato per tracciare acknowledge per coppie (task, cleaner)
  type IncompatibleKey = string; // chiave del tipo `${taskId}-${cleanerId}`
  const [acknowledgedIncompatibleAssignments, setAcknowledgedIncompatibleAssignments] = useState<Set<IncompatibleKey>>(new Set());

  // Helper per costruire la chiave univoca task-cleaner
  const getIncompatibleKey = (task: any, cleanerId: number): IncompatibleKey => {
    const taskId = task.task_id ?? task.id ?? task.logisticCode;
    return `${taskId}-${cleanerId}`;
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
  const isTimelineInteractionDisabled = isReadOnly;
  const [editingAlias, setEditingAlias] = useState<string>("");
  const [isSavingAlias, setIsSavingAlias] = useState(false);
  const [isSavingCleanerLock, setIsSavingCleanerLock] = useState(false);
  const [isLoadingAvailableCleaners, setIsLoadingAvailableCleaners] = useState(false);
  const [aliasDialog, setAliasDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string }>({ open: false, cleanerId: null, cleanerName: '' });
  const [editingStartTime, setEditingStartTime] = useState<string>("10:00");
  const [startTimeEditDialog, setStartTimeEditDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string }>({ open: false, cleanerId: null, cleanerName: '' });
  const [isSavingStartTime, setIsSavingStartTime] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [isTransferringToAdam, setIsTransferringToAdam] = useState(false);
  const [showOptimizerDialog, setShowOptimizerDialog] = useState(false);
  const [isRunningOptimizer, setIsRunningOptimizer] = useState(false);
  const [optimizerResult, setOptimizerResult] = useState<any>(null);
  const [showClearAllSelectedCleanersDialog, setShowClearAllSelectedCleanersDialog] = useState(false);

  // Stato per le regole di validazione task-cleaner
  const [validationRules, setValidationRules] = useState<any>(null);

  // Ref per tracciare i toast già mostrati (previene duplicati)
  const shownToastsRef = useRef<Set<string>>(new Set());

  // Normalizza la data da localStorage per coerenza ovunque
  const workDate = localStorage.getItem('selected_work_date') || (() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  })();

  // Carica le regole di validazione una sola volta all'init
  useEffect(() => {
    loadValidationRules().then(rules => {
      setValidationRules(rules);
    }).catch(err => {
      console.error('Failed to load validation rules:', err);
      setValidationRules(null); // Fallback permissive
    });
  }, []);

  // EO, HP, LP brackets for priority windows
  type PriorityWindows = {
    EO: { start: string; end: string };
    HP: { start: string; end: string };
    LP: { start: string; end?: string | null };
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
  
        // Struttura presa da app_settings.json nel DB:
        // s["early-out"].eo_start_time / eo_end_time
        // s["high-priority"].hp_start_time / hp_end_time
        // low-priority potrebbe esserci o no (nel tuo repo lato server esiste come chiave)
        const eoStart = s?.["early-out"]?.eo_start_time;
        const eoEnd = s?.["early-out"]?.eo_end_time;
  
        const hpStart = s?.["high-priority"]?.hp_start_time;
        const hpEnd = s?.["high-priority"]?.hp_end_time;
  
        const lpStart =
          s?.["low-priority"]?.lp_start_time
          // fallback sensato se non c’è low-priority nel JSON:
          ?? hpEnd
          ?? hpStart;
  
        if (eoStart && eoEnd && hpStart && hpEnd && lpStart) {
          setPriorityWindows({
            EO: { start: eoStart, end: eoEnd },
            HP: { start: hpStart, end: hpEnd },
            // LP tipicamente “da lpStart in poi”
            LP: { start: lpStart, end: null },
          });
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
  const timelineRowRef = useRef<HTMLDivElement>(null);

  // Carica anche i cleaner dalla timeline.json per mostrare quelli nascosti
  // DEVE essere definito PRIMA di allCleanersToShow che lo usa
  const [timelineCleaners, setTimelineCleaners] = useState<any[]>([]);

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

    return combined;
  }, [cleaners, timelineCleaners]);

  // Crea Set di ID cleaner rimossi per facile lookup
  const removedCleanerIds = React.useMemo(() => {
    const selectedIds = new Set(cleaners.map(c => c.id));
    return new Set(
      timelineCleaners
        .filter(tc => tc.tasks && tc.tasks.length > 0 && !selectedIds.has(tc.cleaner?.id))
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
        ? `${selectedCleaner?.name} ${selectedCleaner?.lastname} è stato rimosso completamente (nessuna task).`
        : `${selectedCleaner?.name} ${selectedCleaner?.lastname} è è stato rimosso dalla selezione. Le sue task rimangono in timeline.`;

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

  // Mutation per svuotare tutti i cleaners convocati (selected_cleaners) per la data corrente
  const clearAllSelectedCleanersMutation = useMutation({
    mutationFn: async () => {
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await apiRequest("POST", "/api/save-selected-cleaners", {
        cleaners: [],
        total_selected: 0,
        date: workDate,
        scope: scopeValue,
        action_type: "CLEAR_ALL",
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

      // Ricarica timeline e selected_cleaners per riflettere lo svuotamento
      await Promise.all([
        loadTimelineCleaners(),
        loadTimelineData(),
        loadCleaners(true),
      ]);

      toast({
        title: "Cleaners convocati rimossi",
        description: "La selezione dei cleaners convocati è stata svuotata per questa data.",
        variant: "success",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile rimuovere tutti i cleaners convocati",
        variant: "destructive",
      });
    },
  });

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

  // Trova lo start time minimo tra tutti i cleaner
  const getGlobalStartTime = () => {
    if (allCleanersToShow.length === 0) return "10:00";

    const startTimes = allCleanersToShow.map(c => c.start_time || "10:00");
    const minTime = startTimes.reduce((min, current) => {
      const [minH, minM] = min.split(':').map(Number);
      const [curH, curM] = current.split(':').map(Number);
      const minMinutes = minH * 60 + minM;
      const curMinutes = curH * 60 + curM;
      return curMinutes < minMinutes ? current : min;
    });

    return minTime;
  };

  // Genera time slots globali basati sullo start time minimo (solo orari interi)
  const generateGlobalTimeSlots = () => {
    const globalStartTime = getGlobalStartTime();
    const [startHour, startMin] = globalStartTime.split(':').map(Number);

    // Arrotonda all'ora intera precedente per iniziare sempre da un'ora intera
    const startHourRounded = startMin > 0 ? startHour : startHour;
    const endHour = 19; // Fine fissa alle 19:00

    const slots: string[] = [];

    // Genera slot ogni ora fino alle 19:00 (solo orari interi)
    for (let hour = startHourRounded; hour <= endHour; hour++) {
      slots.push(`${String(hour).padStart(2, '0')}:00`);
    }

    return slots;
  };

  // Calcola i minuti totali della timeline globale (in base all'ora ARROTONDATA per match con la griglia)
  const getGlobalTimelineMinutes = () => {
    const globalStartTime = getGlobalStartTime();
    const [startHour, startMin] = globalStartTime.split(':').map(Number);

    // CRITICAL: Usa l'ora arrotondata (come la griglia visiva) per calcolare i minuti
    const startHourRounded = startMin > 0 ? startHour : startHour;
    const startMinutes = startHourRounded * 60; // Parte dall'ora intera
    const endMinutes = 19 * 60; // 19:00
    return endMinutes - startMinutes;
  };

  // Genera gli slot una volta sola
  const globalTimeSlots = generateGlobalTimeSlots();
  const globalTimelineMinutes = getGlobalTimelineMinutes();
  const globalStartTime = getGlobalStartTime();


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

const getTimelineEndMinutes = () => 19 * 60; // 19:00 fixed end

const minutesToPct = (absoluteMinutes: number) => {
  if (!globalTimeSlots?.length) return 0;

  const timelineStart = timeToMinutes(globalTimeSlots[0]);
  const timelineEnd = timelineStart + globalTimeSlots.length * 60;

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
  }, [globalTimelineMinutes, globalTimeSlots.length]);

  // Misura la larghezza della timeline row per TaskCard (state React → rerender)
  React.useEffect(() => {
    const measureWidth = () => {
      if (timelineRowRef.current) {
        const width = timelineRowRef.current.offsetWidth;
        setTimelineWidthPx(width);
      }
    };

    measureWidth();
    window.addEventListener('resize', measureWidth);

    // Rimisura dopo un breve delay per catturare layout post-render
    const timer = setTimeout(measureWidth, 100);

    return () => {
      window.removeEventListener('resize', measureWidth);
      clearTimeout(timer);
    };
  }, [cleaners, isFullscreen]);

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

  const isIdPlaceholder = (value: string | undefined | null, cleanerId: number) => {
    const normalized = String(value ?? "").trim();
    if (!normalized) return false;
    return normalized.toUpperCase() === `ID ${cleanerId}` || /^ID\s+\d+$/i.test(normalized);
  };

  const getCleanerDisplayData = (cleaner: Cleaner) => {
    const aliasEntry = cleanersAliases[cleaner.id];
    const cleanerAlias = typeof cleaner.alias === "string" ? cleaner.alias.trim() : "";
    const alias = (aliasEntry?.alias || cleanerAlias || "").trim();

    const rawName = String(cleaner.name ?? "").trim();
    const rawLastname = String(cleaner.lastname ?? "").trim();

    const name = isIdPlaceholder(rawName, cleaner.id) ? "" : rawName;
    const lastname = rawLastname || aliasEntry?.lastname || "";
    const fallbackName = aliasEntry?.name || "";
    const resolvedName = name || fallbackName;
    const fullName = `${resolvedName} ${lastname}`.trim();
    const primaryLabel = alias || fullName || `ID ${cleaner.id}`;

    return {
      alias,
      name: resolvedName,
      lastname,
      fullName,
      primaryLabel,
    };
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
    loadTimelineData(); // Carica i dati della timeline anche qui
    loadCleanerLocks();

    // Esponi le funzioni per ricaricare i cleaners
    (window as any).loadTimelineCleaners = loadTimelineCleaners;
    (window as any).loadSelectedCleaners = loadCleaners;
  }, []);

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
      }
    } else {
      // Primo click: avvia timer
      const timer = setTimeout(() => {
        // Verifica se ci sono task incompatibili NON ancora ackate
        if (validationRules && cleaner?.role) {
          const cleanerTasks = tasks
            .filter(task => (task as any).assignedCleaner === cleaner.id)
            .map(normalizeTask);

          const incompatibleTasks = cleanerTasks.filter(task => {
            if (canCleanerHandleTaskSync(
              cleaner.role,
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

              // Determina priorità
              const isEarlyOut = Boolean((task as any).early_out || (task as any).earlyOut || (task as any).is_early_out);
              const isHighPriority = Boolean((task as any).high_priority || (task as any).highPriority || (task as any).is_high_priority);
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
    setIsAddCleanerDialogOpen(true); // Apri il dialog subito per mostrare loading
    await loadAvailableCleaners(); // Attendi il caricamento
  };

  // Handler per aggiungere/sostituire un cleaner
  const handleAddCleaner = (cleanerId: number, isAvailable: boolean) => {
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
    if (!startTimeDialog.cleanerId) return; // Ensure we have a cleaner ID

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

    if (cleanerToReplace) {
      removeCleanerMutation.mutate(cleanerToReplace, {
        onSuccess: () => {
          addCleanerMutation.mutate(cleanerId);
          setCleanerToReplace(null);
        }
      });
    } else {
      addCleanerMutation.mutate(cleanerId);
    }
    setIsAddCleanerDialogOpen(false);
    setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true }); // Chiudi il dialog dello start time
    setPendingCleaner(null); // Clear pending cleaner
  };


  // Handler per confermare l'aggiunta di un cleaner non disponibile
  const handleConfirmAddUnavailableCleaner = async () => {
    if (confirmUnavailableDialog.cleanerId) {
      // Prima salva lo start time aggiornato
      try {
        const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
        await fetch('/api/update-cleaner-start-time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cleanerId: confirmUnavailableDialog.cleanerId,
            startTime: pendingStartTime,
            date: workDate,
            scope: scopeValue,
            modified_by: currentUser.username || 'unknown',
          }),
        });
        console.log(`✅ Start time aggiornato per cleaner ${confirmUnavailableDialog.cleanerId}: ${pendingStartTime}`);
      } catch (error) {
        console.error("Errore nel salvataggio dello start time e disponibilità:", error);
      }

      // Aggiorna lo stato locale per riflettere la modifica
      setAvailableCleaners(prev => prev.map(c =>
        c.id === confirmUnavailableDialog.cleanerId ? { ...c, start_time: pendingStartTime, available: true } : c
      ));


      // Chiudi il dialog di conferma e procedi con l'aggiunta
      setConfirmUnavailableDialog({ open: false, cleanerId: null });

      // Procedi con l'aggiunta/sostituzione come al solito
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
      if (cleanerToReplace) {
        removeCleanerMutation.mutate(cleanerToReplace, {
          onSuccess: () => {
            addCleanerMutation.mutate(confirmUnavailableDialog.cleanerId!);
            setCleanerToReplace(null);
          }
        });
      } else {
        addCleanerMutation.mutate(confirmUnavailableDialog.cleanerId!);
      }
      setIsAddCleanerDialogOpen(false); // Chiudi anche il dialog di aggiunta
      setPendingCleaner(null); // Clear pending cleaner
    }
  };

  // Handler per confermare la rimozione di un cleaner
  const handleConfirmRemoveCleaner = () => {
    if (confirmRemovalDialog.cleanerId) {
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

  // Calcola la larghezza dinamica della colonna cleaners in base all'alias più lungo
  const calculateCleanerColumnWidth = () => {
    if (cleaners.length === 0) return 96; // default 24 (w-24 = 96px)

    const maxLength = cleaners.reduce((max, cleaner) => {
      const alias = cleanersAliases[cleaner.id]?.alias ||
                    `${cleaner.name} ${cleaner.lastname}`;
      return Math.max(max, alias.length);
    }, 0);

    // Formula: larghezza base + (caratteri * pixel per carattere)
    // Aggiungi spazio extra per il badge
    const baseWidth = 60; // padding e margini
    const charWidth = 7.5; // circa 7.5px per carattere con font bold 13px
    const badgeSpace = 30; // spazio per il badge P/F

    return Math.max(96, baseWidth + (maxLength * charWidth) + badgeSpace);
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

      const response = await fetchWithOperation('reset-timeline', '/api/reset-timeline-assignments', {
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

      // Una SOLA pipeline di reload dei dati
      await (window as any).reloadAllTasks?.();
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
      const response = await fetch(withScope(`/api/timeline?date=${dateStr}`));
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
    const isStraordinaria = Boolean(task.straordinaria);

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

  // Funzione per verificare se un task viola la sua finestra temporale di priorità
  // EO: 10:00-10:59, HP: 11:00-15:30, LP: >= 11:00
  const isPriorityWindowViolation = (task: any): boolean => {
    const priority = task.priority;
    const startTimeStr = task.start_time;
    
    if (!priority || !startTimeStr) return false;
    
    // Normalizza priority per gestire TUTTI i formati possibili:
    // DB: early_out, high_priority, low_priority, high, low
    // Container: early-out, high, low
    // Possibili varianti: EO, HP, LP (abbreviazioni)
    const p = String(priority).toLowerCase().trim();
    
    // Determina il tipo di priorità
    let priorityType: 'eo' | 'hp' | 'lp' | null = null;
    
    if (p === 'early_out' || p === 'early-out' || p === 'eo' || p.includes('early')) {
      priorityType = 'eo';
    } else if (p === 'high_priority' || p === 'high-priority' || p === 'high' || p === 'hp') {
      priorityType = 'hp';
    } else if (p === 'low_priority' || p === 'low-priority' || p === 'low' || p === 'lp') {
      priorityType = 'lp';
    }
    
    if (!priorityType) return false;
    
    // Parse start_time (formato HH:MM:SS o HH:MM)
    const timeParts = startTimeStr.split(':');
    if (timeParts.length < 2) return false;
    const hours = parseInt(timeParts[0], 10);
    const minutes = parseInt(timeParts[1], 10);
    if (isNaN(hours) || isNaN(minutes)) return false;
    const startMinutes = hours * 60 + minutes;
    
    // Finestre temporali (in minuti dalla mezzanotte)
    const EO_START = 10 * 60;      // 10:00 = 600
    const EO_END = 10 * 60 + 59;   // 10:59 = 659
    const HP_START = 11 * 60;      // 11:00 = 660
    const HP_END = 15 * 60 + 30;   // 15:30 = 930
    const LP_START = 11 * 60;      // 11:00 = 660
    
    if (priorityType === 'eo') {
      return startMinutes < EO_START || startMinutes > EO_END;
    } else if (priorityType === 'hp') {
      return startMinutes < HP_START || startMinutes > HP_END;
    } else if (priorityType === 'lp') {
      return startMinutes < LP_START;
    }
    
    return false;
  };

  // Gestione toast per incompatibilità task-cleaner (con sistema per coppie)
  useEffect(() => {
    if (!validationRules) return;

    const incompatibleAssignments: Array<{ cleanerId: number; cleanerName: string; role: string; taskNames: string }> = [];

    allCleanersToShow.forEach(cleaner => {
      if (removedCleanerIds.has(cleaner.id)) return;
      if (!cleaner.role) return;

      const cleanerTasks = tasks
        .filter(task => (task as any).assignedCleaner === cleaner.id)
        .map(normalizeTask);

      // CRITICAL: Verifica TUTTE le task incompatibili, ignorando lo stato di acknowledge
      // L'acknowledge serve solo per non mostrare il dialog al click, NON per nascondere i toast
      const incompatibleTasks = cleanerTasks.filter(task => {
        return !canCleanerHandleTaskSync(
          cleaner.role,
          task,
          validationRules,
        );
      });

      if (incompatibleTasks.length > 0) {
        incompatibleAssignments.push({
          cleanerId: cleaner.id,
          cleanerName: `${cleaner.name} ${cleaner.lastname}`,
          role: cleaner.role,
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
        className={`bg-custom-blue-light rounded-lg border-2 border-custom-blue shadow-sm relative ${isFullscreen ? 'fixed inset-0 z-50 overflow-auto' : ''}`}
      >
        {/* Loading overlay durante drag&drop e rimozione cleaner */}
        {(isLoadingDragDrop || removeCleanerMutation.isPending || clearAllSelectedCleanersMutation.isPending) && (
          <div className="absolute inset-0 bg-black/20 dark:bg-black/40 rounded-lg flex items-center justify-center z-40 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
              <p className="text-sm font-medium text-foreground">La timeline sta ragionando...</p>
            </div>
          </div>
        )}
      
          <div className="px-4 py-4 border-b border-border">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <div>
              <h2 className="text-xl font-bold text-foreground flex items-center">
                <CalendarIcon className="w-5 h-5 mr-2 text-custom-blue" />
                {isOfficeScope ? "Timeline Ufficio" : "Timeline Housekeeping"} - {cleaners.length} Cleaners
              </h2>
            </div>
            <div className="flex gap-3 print:hidden">
              <Button
                onClick={() => setLocation(isOfficeScope ? '/convocazioni?kind=office' : '/convocazioni')}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 border-2 border-custom-blue"
                disabled={isReadOnly}
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
        <div className="px-4 pt-4 pb-4 overflow-x-auto">

{/* Graffe fasce orarie (EO / HP / LP) sopra gli orari */}
<div className="flex items-stretch mb-1 px-4 h-[26px]">
  {/* colonna pulsante / nome cleaner (vuota per allineamento) */}
  <div
    className="flex-shrink-0 h-full print:hidden"
    style={{ width: `${cleanerColumnWidth}px` }}
  />
  {/* area timeline (stessa larghezza della griglia orari) */}
  <div className="flex-1 h-full relative">
    {priorityWindows && (
    <div className="absolute inset-0">
      {(() => {
        const eo1 = clamp(minutesToPct(timeToMinutes(priorityWindows.EO.start)), 0, 100);
        const eo2 = clamp(minutesToPct(timeToMinutes(priorityWindows.EO.end)), 0, 100);

        const hp1 = clamp(minutesToPct(timeToMinutes(priorityWindows.HP.start)), 0, 100);
        const hp2 = clamp(minutesToPct(timeToMinutes(priorityWindows.HP.end)), 0, 100);

        const lp1 = clamp(minutesToPct(timeToMinutes(priorityWindows.LP.start)), 0, 100);
        const lp2 = 100;

        // Due piani:
        // - LP più su (top più piccolo)
        // - EO + HP più giù (top più grande)
        const TOP_LP = -6;   // più su (LP)
        const TOP_MAIN = 12; // EO/HP un filo più giù

        const windows = [
          { key: "LP", left: lp1, right: lp2, top: TOP_LP, opacity: 0.65 },
          { key: "EO", left: eo1, right: eo2, top: TOP_MAIN, opacity: 0.85 },
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
          <div className="flex items-stretch mb-2 px-4 h-[44px]">
            <div
              className="flex-shrink-0 p-1 flex items-center justify-center h-full print:hidden"
              style={{ width: `${cleanerColumnWidth}px` }}
            >
              <Button
                onClick={() => setShowClearAllSelectedCleanersDialog(true)}
                variant="ghost"
                size="sm"
                disabled={
                  isReadOnly ||
                  cleaners.length === 0 ||
                  hasTasksInTimeline ||
                  clearAllSelectedCleanersMutation.isPending
                }
                className={cn(
                  "w-full h-full border-2",
                  "border-red-600 dark:border-red-500",
                  "text-red-700 dark:text-red-200",
                  "hover:bg-red-50 dark:hover:bg-red-950/30"
                )}
                aria-label="Rimuovi tutti i cleaners convocati"
                title={
                  isReadOnly
                    ? "Non disponibile in modalità storico (data passata)"
                    : cleaners.length === 0
                      ? "Nessun cleaner convocato da rimuovere"
                      : hasTasksInTimeline
                        ? "Disabilitato: ci sono task nella timeline"
                        : `Rimuovi tutti i convocati (${cleaners.length})`
                }
              >
                <UserMinus className="w-5 h-5" />
              </Button>
            </div>
            <div
              ref={timelineRowRef}
              className="flex-1 h-full"
              style={{ display: 'grid', gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}
            >
              {globalTimeSlots.map((slot, idx) => (
                <div
                  key={idx}
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

          {/* Righe dei cleaners - mostra solo se ci sono cleaners selezionati */}
          <div className="flex-1 overflow-auto px-4 pb-4 pt-1">
            {allCleanersToShow.length === 0 && !isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-yellow-100 dark:bg-yellow-950/50 border-2 border-yellow-300 dark:border-yellow-700 rounded-lg">
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
            ) : allCleanersToShow.length === 0 && isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-red-50 dark:bg-red-950/20 border-2 border-red-300 dark:border-blue-800 rounded-lg">
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
            ) : (
              allCleanersToShow.map((cleaner, index) => {
                const color = getCleanerColor(cleaner.id);
                const droppableId = `cleaner-${cleaner.id}`;

                // Trova tutte le task assegnate a questo cleaner
                const cleanerTasks = tasks.filter(task =>
                  (task as any).assignedCleaner === cleaner.id
                ).map(normalizeTask); // Applica la normalizzazione qui

                const isRemoved = removedCleanerIds.has(cleaner.id);

                // Verifica se ci sono task incompatibili per questo cleaner
                // Controlla ogni coppia (task, cleaner) invece del solo cleanerId
                const hasIncompatibleTasks = validationRules && cleaner?.role
                  ? cleanerTasks.some(task => {
                      if (canCleanerHandleTaskSync(
                        cleaner.role,
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
                  <div key={cleaner.id} className="flex mb-0.5">
                    {/* Info cleaner */}
                    <div
                      className="flex-shrink-0 p-1 flex items-center border-2 border-custom-blue bg-custom-blue/10 cursor-pointer hover:opacity-90 transition-opacity"
                      style={{
                        width: `${cleanerColumnWidth}px`,
                        boxShadow: hasIncompatibleTasks && !isRemoved
                          ? '0 0 0 3px #EAB308, 0 0 20px 5px rgba(234, 179, 8, 0.6), inset 0 0 15px rgba(234, 179, 8, 0.3)'
                          : filteredCleanerId === cleaner.id ? '0 0 0 3px #3B82F6, 0 0 20px 5px rgba(59, 130, 246, 0.5)' : 'none',
                        transform: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 'scale(1.05)' : 'none',
                        zIndex: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 20 : 'auto',
                        position: 'relative',
                        userSelect: 'none',
                        opacity: isRemoved ? 0.7 : 1,
                        animation: hasIncompatibleTasks && !isRemoved ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : 'none'
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
                      <div className="w-full flex items-center gap-2">
                        {/* Pallino colorato identificativo */}
                        {!isRemoved && (
                          <div
                            className="flex-shrink-0 w-3 h-3 rounded-full"
                            style={{ backgroundColor: getCleanerHexColor(cleaner.id) }}
                          />
                        )}
                        <div className="break-words font-bold text-[13px] flex-1">
                          {getCleanerDisplayData(cleaner).primaryLabel.toUpperCase()}
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
                        {!isRemoved && cleaner.role === "Straordinario" ? (
                          <div className="bg-red-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            S
                          </div>
                        ) : (
                          /* Altrimenti mostra badge role normale */
                          <>
                            {!isRemoved && cleaner.role === "Premium" && (
                              <div className="bg-yellow-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                P
                              </div>
                            )}
                            {!isRemoved && cleaner.role === "Formatore" && (
                              <div className="bg-orange-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                F
                              </div>
                            )}
                            {!isRemoved && cleaner.role === "Ufficio" && (
                              <div className="bg-sky-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                U
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {/* Timeline per questo cleaner - area unica droppable */}
                    <Droppable
                      droppableId={`timeline-${cleaner.id}`}
                      direction="horizontal"
                      isDropDisabled={isTimelineInteractionDisabled}
                    >
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.droppableProps}
                          data-testid={`timeline-cleaner-${cleaner.id}`}
                          data-cleaner-id={cleaner.id}
                          className={`relative min-h-[45px] flex-1 border-l border-border transition-colors duration-200 ${
                            snapshot.isDraggingOver
                              ? 'bg-blue-200/40 dark:bg-blue-900/40 border-l-2 border-blue-400 dark:border-blue-600'
                              : 'bg-background'
                          }`}
                          style={{
                            zIndex: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 15 : 'auto'
                          }}
                        >
                          {/* Griglia oraria di sfondo (solo visiva) con alternanza colori */}
                          <div className="absolute inset-0 pointer-events-none" style={{ display: 'grid', gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}>
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
                          </div>

                          {/* Task posizionate in sequenza con indicatori di travel time */}
                          <div className="relative z-10 flex items-center h-full" style={{ minHeight: '45px' }}>
                            {(() => {
                              // Calcola l'array delle task per questo cleaner una sola volta
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
                                      const taskStartMinutes = parseClockToMinutes(
                                        taskObj.start_time || taskObj.fw_start_time || taskObj.startTime
                                      );
                                      const cleanerStartMinutes = parseClockToMinutes(cleanerStartTime);
                                      const firstBlockStartMinutes = taskStartMinutes ?? cleanerStartMinutes ?? gridStartMinutes;

                                      if (firstBlockStartMinutes > gridStartMinutes) {
                                        timeOffset = firstBlockStartMinutes - gridStartMinutes;
                                      }
                                    }

                                    // Calcola larghezza EFFETTIVA in base ai minuti reali di travel_time
                                    // Usa la stessa base di calcolo dei task (slot * 60 minuti virtuali)
                                    const effectiveTravelMinutes = seq >= 2 && travelTime > 0 && !snapshot.isDraggingOver ? travelTime : 0;
                                    const virtualMinutes = globalTimeSlots.length * 60;
                                    const timelineWidth = timelineWidthPx || 0;
                                    const travelWidthPx = effectiveTravelMinutes > 0 && virtualMinutes > 0 && timelineWidth > 0
                                      ? (effectiveTravelMinutes / virtualMinutes) * timelineWidth
                                      : 0;
                                    const initialOffsetWidthPx = seq === 1 && timeOffset > 0 && virtualMinutes > 0 && timelineWidth > 0
                                      ? (timeOffset / virtualMinutes) * timelineWidth
                                      : 0;
                                    const shouldShowInitialOffset =
                                      !snapshot.isDraggingOver && !Boolean(snapshot.draggingFromThisWith);

                                    // CRITICAL FIX: Calcola il "waitingGap" per task con sequence >= 2
                                    // Il waitingGap rappresenta l'attesa del cleaner quando arriva prima che l'appartamento si liberi
                                    // IMPORTANTE: Mostra il waitingGap SOLO se la task corrente ha un checkout_time reale
                                    let waitingGap = 0;
                                    if (seq >= 2 && taskObj.start_time && taskObj.checkout_time && !snapshot.isDraggingOver) {
                                      // CRITICAL: L'array è ordinato per sequence, quindi idx-1 è la vera task precedente
                                      const prevTask = idx > 0 ? cleanerTasks[idx - 1] as any : null;

                                      const workDateStr = localStorage.getItem('selected_work_date') || format(new Date(), 'yyyy-MM-dd');

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
                                    const waitingGapWidthPx = waitingGap > 0 && virtualMinutes > 0 && timelineWidth > 0
                                      ? (waitingGap / virtualMinutes) * timelineWidth
                                      : 0;

                                    // Chiave univoca per task collaborative: include cleaner.id
                                    const taskId = taskObj.task_id || taskObj.id;
                                    const uniqueKey = `${taskId}-cleaner-${cleaner.id}`;

                                    // Verifica compatibilità task-cleaner
                                    const isIncompatible = validationRules && cleaner?.role
                                      ? !canCleanerHandleTaskSync(
                                          cleaner.role,
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
                                            style={{ width: `${initialOffsetWidthPx}px`, minHeight: '45px' }}
                                            aria-hidden="true"
                                          />
                                        )}

                                        {/* Travel time marker - FUORI dal Draggable (solo per sequence >= 2) */}
                                        {seq >= 2 && travelTime > 0 && travelWidthPx > 0 && (
                                          <div
                                            className="flex items-center justify-center flex-shrink-0 py-3"
                                            style={{ width: `${travelWidthPx}px`, minHeight: '50px' }}
                                            title={`${travelTime} min`}
                                          >
                                            <svg
                                              width="20"
                                              height="20"
                                              viewBox="0 0 24 24"
                                              fill="currentColor"
                                              className="flex-shrink-0"
                                              style={{ color: getCleanerHexColor(cleaner.id) }}
                                            >
                                              <path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/>
                                            </svg>
                                          </div>
                                        )}

                                        {/* Waiting gap spacer - FUORI dal Draggable (solo per sequence >= 2) */}
                                        {seq >= 2 && waitingGap > 0 && waitingGapWidthPx > 0 && (
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

                                        {/* TaskCard: non deve mai sparire */}
                                        <TaskCard
                                          key={uniqueKey}
                                          task={task}
                                          index={idx}
                                          isInTimeline={true}
                                          allTasks={cleanerTasks}
                                          isDragDisabled={isTimelineInteractionDisabled}
                                          isReadOnly={isReadOnly}
                                          timelineWidthPx={timelineWidthPx}
                                          isHighlighted={highlightedTaskIds.has(String(task.id))}
                                          cleanerId={cleaner.id}
                                          isPriorityWindowViolation={isPriorityWindowViolation(task)}
                                        />
                                      </React.Fragment>
                                    );
                                  })}
                                  {/* Placeholder esattamente come nei container */}
                                  {provided.placeholder}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      )}
                    </Droppable>
                    {/* Colonna ore totali lavorate */}
                    <div className="flex-shrink-0 w-20 flex items-center justify-center border-l border-border bg-sky-100/30 dark:bg-sky-900/10 text-center">
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
                          <span className="text-xs font-semibold text-foreground">
                            {hours}:{String(minutes).padStart(2, '0')}
                          </span>
                        );
                      })()}
                    </div>
                  </div>
                );
              })
            )}

            {/* Riga finale con pulsanti */}
            <div className="pt-2"></div>
              <div className="flex items-stretch mb-2 h-[44px]">
                {/* Pulsante + sotto il nome dell'ultimo cleaner */}
                <div
                  className="flex-shrink-0 p-1 flex items-center justify-center h-full"
                  style={{ width: `${cleanerColumnWidth}px` }}
                >
                  <Button
                    onClick={() => {
                      setCleanerToReplace(null);
                      handleOpenAddCleanerDialog();
                    }}
                    variant="ghost"
                    size="sm"
                    className="w-full h-full border-2 border-custom-blue"
                    disabled={isReadOnly}
                  >
                    <UserPlus className="w-5 h-5" />
                  </Button>
                </div>
                {/* Pulsanti nella riga finale */}
                <div className="flex-1 p-1 flex gap-2 h-full">
                  {!isReadOnly && (
                    <div
                      className="flex-1 h-full flex items-center justify-center gap-2 px-4 py-2 rounded-md border-2 border-custom-blue bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200"
                      data-testid="indicator-autosave"
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span className="text-sm font-medium">Salvataggio automatico attivo</span>
                    </div>
                  )}
                  {isReadOnly && (
                    <Button
                      disabled
                      variant="outline"
                      className="flex-1 h-full border-2 border-custom-blue bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 cursor-default"
                    >
                      📜 Sei in modalità storico
                    </Button>
                  )}
                  <Button
                    onClick={() => setShowAdamTransferDialog(true)}
                    size="sm"
                    variant="outline"
                    className="h-full px-3 border-2 border-custom-blue"
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
            {lastAdamTransfer && (
              <div className="flex justify-center px-1 pb-1">
                <span className="text-xs text-muted-foreground">
                  Ultimo salvataggio su ADAM: {(() => {
                    const d = new Date(lastAdamTransfer);
                    const day = String(d.getDate()).padStart(2, '0');
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const year = d.getFullYear();
                    const hours = String(d.getHours()).padStart(2, '0');
                    const minutes = String(d.getMinutes()).padStart(2, '0');
                    return `${day}/${month}/${year} - ${hours}:${minutes}`;
                  })()}
                </span>
              </div>
            )}
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
                  return cleaner ? (
                    <>
                      <p className="font-semibold text-foreground">
                        Il cleaner <span className="text-black dark:text-white">{cleaner.name} {cleaner.lastname}</span> ({cleaner.role}) ha delle task non compatibili con il suo ruolo:
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

                  if (cleaner && validationRules) {
                    // Recupera tutte le task di questo cleaner
                    const cleanerTasks = tasks
                      .filter(task => (task as any).assignedCleaner === cleanerId)
                      .map(normalizeTask);

                    // Aggiungi tutte le coppie (task incompatibile, cleaner) al Set
                    setAcknowledgedIncompatibleAssignments(prev => {
                      const next = new Set(prev);

                      cleanerTasks.forEach(task => {
                        if (!canCleanerHandleTaskSync(
                          cleaner.role,
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
        <DialogContent className="sm:max-md" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Start Time
            </DialogTitle>
            <DialogDescription>
              Stai modificando l'orario di inizio di <strong>{startTimeEditDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Nuovo Start Time
              </label>
              <Input
                type="time"
                value={editingStartTime}
                onChange={(e) => setEditingStartTime(e.target.value)}
                placeholder="Inserisci orario (HH:mm)"
                className="w-full"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveStartTime();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStartTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' })}
              disabled={isSavingStartTime}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveStartTime}
              disabled={isSavingStartTime}
              className="border-2 border-custom-blue"
            >
              {isSavingStartTime ? (
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

      {/* Confirmation Dialog for Cleaner Removal */}
      <Dialog open={confirmRemovalDialog.open} onOpenChange={(open) => setConfirmRemovalDialog({ open, cleanerId: null })}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle>Conferma Rimozione Cleaner</DialogTitle>
            <DialogDescription>
              Sei sicuro di voler rimuovere "{confirmRemovalDialog.cleanerId ? (() => {
                const cleaner = allCleanersToShow.find(c => c.id === confirmRemovalDialog.cleanerId);
                return cleaner ? `${cleaner.name} ${cleaner.lastname}` : 'Unknown';
              })() : ''}" dalla selezione? Le sue task rimarranno in timeline finché non verrà sostituito.
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
              className="border-2 border-custom-blue hover:bg-accent hover:text-accent-foreground"
            >
              Conferma Rimozione
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
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-custom-blue mr-2" />
                <p className="text-muted-foreground">Caricamento cleaners disponibili...</p>
              </div>
            ) : availableCleaners.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <p className="text-muted-foreground">Nessun cleaner disponibile per questo scope.</p>
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
          // Riapri il dialog di selezione cleaner se l'utente annulla
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
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setConfirmUnavailableDialog({ open: false, cleanerId: null })}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              onClick={handleConfirmAddUnavailableCleaner}
              className="bg-custom-blue hover:bg-custom-blue/90 text-white"
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
                    {selectedCleaner.role === "Straordinario" ? (
                      <span className="px-2 py-0.5 rounded border font-medium text-sm bg-red-600/30 text-gray-900 dark:bg-red-500/40 dark:text-red-200 border-red-700 dark:border-red-400">
                        Straordinario
                      </span>
                    ) : (
                      /* Altrimenti mostra badge role normale */
                      <>
                        {selectedCleaner.role === "Formatore" ? (
                          <span className="px-2 py-0.5 rounded border font-medium text-sm bg-orange-600/30 text-gray-900 dark:bg-orange-500/40 dark:text-orange-200 border-orange-700 dark:border-orange-400">
                            Formatore
                          </span>
                        ) : selectedCleaner.role === "Premium" ? (
                          <span className="px-2 py-0.5 rounded border font-medium text-sm bg-yellow-600/30 text-gray-900 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-700 dark:border-yellow-400">
                            Premium
                          </span>
                        ) : selectedCleaner.role === "Ufficio" ? (
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

                {/* Start Time (2/4) */}
                <div className="col-span-2">
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

                {/* Tipo contratto (2/4) */}
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
                  disabled={removeCleanerMutation.isPending || isReadOnly}
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

      {/* Dialog di conferma per rimuovere tutti i cleaners convocati */}
      <AlertDialog open={showClearAllSelectedCleanersDialog} onOpenChange={setShowClearAllSelectedCleanersDialog}>
        <AlertDialogContent className="sm:max-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <UserMinus className="w-5 h-5" />
              Rimuovere tutti i cleaners convocati?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <p className="text-base text-foreground font-semibold mb-3">
              Questa azione svuota la selezione dei cleaners convocati per questa data.
              </p>
              <p className="text-sm text-muted-foreground">
              Sei sicuro di voler procedere? Questa azione è irreversibile.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setShowClearAllSelectedCleanersDialog(false)}
              className="border-2 border-custom-blue"
            >
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowClearAllSelectedCleanersDialog(false);
                clearAllSelectedCleanersMutation.mutate();
              }}
              disabled={clearAllSelectedCleanersMutation.isPending}
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Conferma rimozione
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