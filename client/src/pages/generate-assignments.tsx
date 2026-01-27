import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import MapSection from "@/components/map/map-section";
import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";

const DEBUG = false;
const dlog = (...args: any[]) => DEBUG && console.log(...args);
import { ThemeToggle } from "@/components/theme-toggle";
import { CalendarIcon, Users, RefreshCw, Settings, HelpCircle, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useLocation, Link } from 'wouter';
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

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
}

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

// Indice per id (1:1)
function indexById(list: Task[]): Map<string, Task> {
  const m = new Map<string, Task>();
  for (const t of list) {
    const tid = getTaskId(t);
    if (tid) m.set(tid, t);
  }
  return m;
}

// Helper per verificare se una data è nel passato
const isDateInPast = (date: Date): boolean => {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalizza a inizio giornata per confronto
  const targetDate = new Date(date);
  targetDate.setHours(0, 0, 0, 0);
  return targetDate < today;
};



// MultiSelect Context per gestire selezione multipla task
interface MultiSelectContextType {
  isMultiSelectMode: boolean;
  selectedTasks: Array<{taskId: string; order: number}>;
  toggleMode: () => void;
  toggleTask: (taskId: string) => void;
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
  
  // Traccia il cleaner su cui si sta trascinando per posizionare il placeholder
  const [draggingOverCleanerId, setDraggingOverCleanerId] = useState<number | null>(null);

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

  const toggleTask = useCallback((taskId: string, container: string) => {
    setSelectedTasks(prev => {
      const existing = prev.find(t => t.taskId === taskId);
      if (existing) {
        return prev.filter(t => t.taskId !== taskId);
      } else {
        const maxOrder = prev.length > 0 ? Math.max(...prev.map(t => t.order)) : 0;
        return [...prev, { taskId, order: maxOrder + 1, container }];
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

  // Stati di caricamento
  const [isExtracting, setIsExtracting] = useState(true);
  const [extractionStep, setExtractionStep] = useState<string>("Inizializzazione...");
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isTransferringToAdam, setIsTransferringToAdam] = useState(false);
  const [lastSavedTimestamp, setLastSavedTimestamp] = useState<string | null>(null); // Renamed from lastSavedAssignment
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Nuova variabile di stato per gestire il caricamento generale
  const [isLoading, setIsLoading] = useState(false);
  
  // Stati per pulsanti Assegna e Refresh Containers
  const [isAssigning, setIsAssigning] = useState(false);
  const [isRefreshingContainers, setIsRefreshingContainers] = useState(false);

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
        body: JSON.stringify({ date: dateStr })
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
        const timelineResponse = await fetch(`/api/timeline?date=${dateStr}`, {
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
      const isPastDate = targetDate < today;
      const isCurrentDate = targetDate.getTime() === today.getTime();

      // CRITICAL: Verifica SE esistono assegnazioni salvate per questa data
      const checkResponse = await fetch('/api/check-saved-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
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
          body: JSON.stringify({ date: dateStr })
        });

        const loadResult = await loadResponse.json();

        if (loadResult.success && loadResult.found) {
          console.log(`✅ Assegnazioni salvate caricate automaticamente per ${dateStr}`);
          setLastSavedTimestamp(checkResult.formattedDateTime || null);

          // CRITICAL: Verifica che la timeline sia valida prima di caricare
          const timelineCheckResponse = await fetch(`/api/timeline?date=${dateStr}`, {
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
          setIsTimelineReadOnly(isPastDate);
          if (isPastDate) {
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
          if (isPastDate) {
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
          const timelineResponse = await fetch(`/api/timeline?date=${dateStr}`, {
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
        if (isPastDate) {
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
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const targetDate = new Date(date);
      targetDate.setHours(0, 0, 0, 0);

      if (targetDate >= today) {
        console.log("Fallback: estrazione per data presente/futura");
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
        body: JSON.stringify({ date: dateStr, created_by: currentUsername })
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
      console.log(`📅 Initial mount - trigger: "initial"`);
      refreshAssignments("initial", selectedDate);
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
    return {
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
      straordinaria: rawTask.straordinaria ?? (rawTask as any).is_straordinaria,
      confirmed_operation: rawTask.confirmed_operation,
      checkout_date: (rawTask as any).checkout_date,
      checkout_time: rawTask.checkout_time,
      checkin_date: (rawTask as any).checkin_date,
      checkin_time: rawTask.checkin_time,
      pax_in: rawTask.pax_in,
      pax_out: rawTask.pax_out,
      operation_id: rawTask.operation_id,
      customer_name: (rawTask as any).customer_name,
      customer_reference: rawTask.customer_reference,
      type_apt: (rawTask as any).type_apt,
      locked: (rawTask as any).locked,
      locked_reason: (rawTask as any).locked_reason,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
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
        fetch(`/api/containers?date=${dateStr}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        }),
        fetch(`/api/timeline?date=${dateStr}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        })
      ]);

      if (!containersResponse.ok) {
        throw new Error('Errore nel caricamento dei containers');
      }

      const containersData = await containersResponse.json();

      // Carica da /api/timeline (DB source) con gestione errori robusta
      let timelineAssignmentsData = {
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
              timelineAssignmentsData = { metadata: {}, cleaners_assignments: [] };
            } else {
              timelineAssignmentsData = JSON.parse(timelineText);
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
          timelineAssignmentsData = { metadata: {}, cleaners_assignments: [] };
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
              priority: task.priority || 'low_priority'
            };

            // Chiave composita per supportare collaborazione (stesso task su più cleaners)
            const compositeKey = `${taskId}-${cleanerId}`;
            assignedTaskIds.add(taskId); // Per filtrare containers
            timelineAssignmentsMap.set(compositeKey, taskWithAssignment);
            timelineTasks.push(taskWithAssignment as Task);
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
            priority: a.priority || 'low_priority'
          };
          const compositeKey = `${taskId}-${cleanerId}`;
          assignedTaskIds.add(taskId);
          timelineAssignmentsMap.set(compositeKey, taskWithAssignment);
          timelineTasks.push(taskWithAssignment as Task);
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
            straordinaria: timelineAssignment.straordinaria,
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
            straordinaria: timelineAssignment.straordinaria !== undefined ? timelineAssignment.straordinaria : (baseTask as any).straordinaria,
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





  // Funzione per assegnare le task Early Out alla timeline
  const assignEarlyOutToTimeline = async () => {
    try {
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // Get current user from localStorage
      const userStr = localStorage.getItem('user');
      const currentUser = userStr ? JSON.parse(userStr) : null;
      const username = currentUser?.username || 'unknown';

      const response = await fetch("/api/assign-early-out-to-timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: dateStr,
          created_by: username
        }),
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: "Early Out Assegnati!",
          description: result.message,
          duration: 3000,
        });

        scheduleManualRefresh(0); // PATCH D: non blocca UI
      } else {
        toast({
          title: "Errore",
          description: result.message || "Errore durante l'assegnazione",
          variant: "destructive",
          duration: 3000,
        });
      }
    } catch (error: any) {
      console.error("Errore nell'assegnazione Early Out:", error);
      toast({
        title: "Errore",
        description: error.message || "Errore durante l'assegnazione Early Out",
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  // Funzione per assegnare le task High Priority alla timeline
  const assignHighPriorityToTimeline = async () => {
    try {
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // Get current user from localStorage
      const userStr = localStorage.getItem('user');
      const currentUser = userStr ? JSON.parse(userStr) : null;
      const username = currentUser?.username || 'unknown';

      const response = await fetch("/api/assign-high-priority-to-timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: dateStr,
          created_by: username
        }),
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: "High Priority Assegnati!",
          description: result.message,
          duration: 3000,
        });

        scheduleManualRefresh(0); // PATCH D: non blocca UI
      } else {
        toast({
          title: "Errore",
          description: result.message || "Errore durante l'assegnazione",
          variant: "destructive",
          duration: 3000,
        });
      }
    } catch (error: any) {
      console.error("Errore nell'assegnazione High Priority:", error);
      toast({
        title: "Errore",
        description: error.message || "Errore durante l'assegnazione High Priority",
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  // Funzione per assegnare le task Low Priority alla timeline
  const assignLowPriorityToTimeline = async () => {
    try {
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // Get current user from localStorage
      const userStr = localStorage.getItem('user');
      const currentUser = userStr ? JSON.parse(userStr) : null;
      const username = currentUser?.username || 'unknown';

      const response = await fetch("/api/assign-low-priority-to-timeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: dateStr,
          created_by: username
        }),
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: "Low Priority Assegnati!",
          description: result.message,
          duration: 3000,
        });

        scheduleManualRefresh(0); // PATCH D: non blocca UI
      } else {
        toast({
          title: "Errore",
          description: result.message || "Errore durante l'assegnazione",
          variant: "destructive",
          duration: 3000,
        });
      }
    } catch (error: any) {
      console.error("Errore nell'assegnazione Low Priority:", error);
      toast({
        title: "Errore",
        description: error.message || "Errore durante l'assegnazione Low Priority",
        variant: "destructive",
        duration: 3000,
      });
    }
  };

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
          modified_by: currentUser.username || 'unknown',
          modification_type: modificationType
        }),
      });
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        // Gestione errore 423 (Task bloccata)
        if (response.status === 423) {
          throw new Error(errData.locked_reason || 'Task bloccata: impossibile assegnare');
        }
        throw new Error(`Errore nel salvataggio dell'assegnazione: ${errData.error || response.statusText}`);
      }
      console.log(`Assegnazione salvata: taskId=${taskId}, logisticCode=${logisticCode}`);
    } catch (error) {
      console.error('Errore nella chiamata API di salvataggio timeline:', error);
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
        body: JSON.stringify({ taskId, logisticCode, date: dateStr }),
      });
      if (!response.ok) {
        console.error('Errore nella rimozione dell\'assegnazione dalla timeline');
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

  // helper: estrae l'id cleaner dal droppableId della timeline (es: "timeline-24")
  const parseCleanerId = (droppableId: string) => {
    if (!droppableId) return null;
    if (droppableId.startsWith('timeline-')) {
      const n = Number(droppableId.slice('timeline-'.length));
      return Number.isFinite(n) ? n : null;
    }
    return null;
  };

  // Helper per estrarre container key
  const parseContainerKey = (droppableId: string | undefined | null): "early_out" | "high_priority" | "low_priority" | null => {
    if (!droppableId) return null;
    if (droppableId === "early-out") return "early_out";
    if (droppableId === "high") return "high_priority";
    if (droppableId === "low") return "low_priority";
    return null;
  };

  const onDragUpdate = (update: any) => {
    const { destination } = update;

    if (!destination) {
      setDragSequencePreview(null);
      setLastValidDragIndex(null);
      setDraggingOverCleanerId(null);
      return;
    }

    const toCleanerId = parseCleanerId(destination.droppableId);

    // Mostriamo il numero di sequenza solo quando siamo sulla timeline di un cleaner
    if (toCleanerId === null) {
      setDragSequencePreview(null);
      setLastValidDragIndex(null);
      setDraggingOverCleanerId(null);
      return;
    }

    // CRITICAL: Salva l'indice valido durante il drag per evitare bug con destination.index inaffidabile
    setLastValidDragIndex(destination.index);
    setDraggingOverCleanerId(toCleanerId);
    setDragSequencePreview({
      // index è 0-based, mostrato come 1-based
      sequenceIndex: destination.index + 1,
    });
  };

  const onDragEnd = async (result: any) => {
    setDragSequencePreview(null);
    setLastValidDragIndex(null);
    setDraggingOverCleanerId(null);

    const { destination, source, draggableId } = result;
    
    // Estrai container e cleaner ID dalle destinazioni
    const toContainer = parseContainerKey(destination?.droppableId);
    const toCleanerId = parseCleanerId(destination?.droppableId);
    const fromContainer = parseContainerKey(source?.droppableId);
    const fromCleanerId = parseCleanerId(source?.droppableId);

    try {
      // niente destinazione => niente da fare (e NON mostrare overlay)
      if (!destination) {
        return;
      }

      // se posizione identica, esci
      if (
        destination.droppableId === source.droppableId &&
        destination.index === source.index
      ) {
        return;
      }

      // solo ora ha senso mostrare overlay
      setIsLoadingDragDrop(true);

      // CRITICAL: Blocca drag simultanei (con timeout di sicurezza di 10 secondi)
      if (isDraggingRef.current) {
        console.log("⚠️ Drag già in corso, operazione annullata per prevenire conflitti");
        toast({
          title: "Operazione in corso",
          description: "Attendi il completamento del movimento precedente",
          variant: "warning",
          duration: 2000,
        });
        return;
      }

      // draggableId formato: "{taskId}-cleaner-{cleanerId}" o "{taskId}" (containers)
      // Estrai solo il taskId dalla chiave composita
      const taskId = draggableId.includes('-cleaner-') 
        ? draggableId.split('-cleaner-')[0] 
        : draggableId;
      const task = allTasksWithAssignments.find(t => String(t.id) === String(taskId));
      const logisticCode = task?.name; // name contiene il logistic_code

      // ENFORCEMENT: Se la task è bloccata, non permettere spostamento in timeline
      if (task && (task as any).locked && !fromCleanerId) {
        console.log(`🔒 Task ${taskId} è bloccata, spostamento annullato`);
        toast({
          title: "Task bloccata",
          description: (task as any).locked_reason || "Questa task non può essere assegnata",
          variant: "destructive",
        });
        return;
      }

      // Se la timeline è read-only, non permettere modifiche
      if (isTimelineReadOnly) {
        console.log("Timeline è READ-ONLY, spostamento annullato.");
        toast({
          title: "Operazione non permessa",
          description: "La timeline è in sola visualizzazione per questa data.",
          variant: "warning",
        });
        return;
      }

      // Imposta lock con timeout di sicurezza (10 secondi)
      isDraggingRef.current = true;
      if (dragTimeoutRef.current) {
        clearTimeout(dragTimeoutRef.current);
      }
      dragTimeoutRef.current = setTimeout(() => {
        console.log("⏰ Timeout sicurezza: rilascio lock drag forzato");
        isDraggingRef.current = false;
        setIsLoadingDragDrop(false);
      }, 10000);
      // 🔹 Ramo TIMELINE (drag tra cleaners o riordino nello stesso cleaner)

      // Caso: Riordino nella stessa timeline
      if (fromCleanerId === toCleanerId && fromCleanerId !== null) {
        console.log(`🔄 Riordino task ${taskId} per cleaner ${toCleanerId} da ${source.index} a ${destination.index}`);

        try {
          await reorderTimelineAssignment(taskId, logisticCode, toCleanerId, source.index, destination.index);

          // CRITICAL: Marca modifiche dopo riordino
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          // Ricarica i dati dal server (server-driven approach)
          await refreshAssignments("manual");

          toast({
            title: "Task riordinata",
            description: `Task ${logisticCode} spostata nella posizione ${destination.index + 1}`,
            variant: "success",
          });
        } catch (err) {
          console.error("Errore nel riordino:", err);
          toast({
            title: "Errore",
            description: "Impossibile riordinare la task.",
            variant: "destructive",
          });
        } finally {
          // Rilascia lock indipendentemente dall'esito
          isDraggingRef.current = false;
          if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
          setIsLoadingDragDrop(false);
        }
        return;
      }

      // Spostamento tra cleaners diversi
      if (fromCleanerId !== null && toCleanerId !== null && fromCleanerId !== toCleanerId) {
        // CRITICAL: Usa lastValidDragIndex salvato durante onDragUpdate per evitare bug di posizionamento
        const correctIndex = lastValidDragIndex !== null ? lastValidDragIndex : destination.index;
        dlog(`🔄 Spostamento task ${taskId} da cleaner ${fromCleanerId} a cleaner ${toCleanerId} @ index ${correctIndex}`);

        try {
          // Usa l'endpoint corretto per spostare tra cleaners
          const dateStr = format(selectedDate, "yyyy-MM-dd");
          const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
          const response = await fetch('/api/move-task-between-cleaners', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              taskId,
              logisticCode,
              sourceCleanerId: fromCleanerId,
              destCleanerId: toCleanerId,
              destIndex: correctIndex,
              date: dateStr,
              modified_by: currentUser.username || 'unknown'
            }),
          });

          if (!response.ok) {
            // Gestione errore 423 (Task bloccata)
            if (response.status === 423) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.locked_reason || 'Task bloccata: impossibile assegnare');
            }
            throw new Error('Errore nello spostamento tra cleaners');
          }

          // CRITICAL: Marca modifiche dopo spostamento
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          // Ricarica i dati dal server (server-driven approach)
          await refreshAssignments("manual");

          // PATCH C: Usa ID nel toast invece di fetch
          const toCleanerName = `ID ${toCleanerId}`;

          toast({
            title: "Task spostata",
            description: `Task ${logisticCode} assegnata a ${toCleanerName}`,
            variant: "success",
          });
        } catch (err) {
          console.error("Errore nello spostamento:", err);
          toast({
            title: "Errore",
            description: "Impossibile spostare la task.",
            variant: "destructive",
          });
        } finally {
          // Rilascia lock indipendentemente dall'esito
          isDraggingRef.current = false;
          if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
          setIsLoadingDragDrop(false);
        }
        return;
      }


      // 🔸 BATCH MOVE: Se multi-select è attivo, ci sono task selezionate, E la task trascinata è tra quelle selezionate
      const isDraggedTaskSelected = selectedTasks.some(st => st.taskId === taskId);

      if (isAnyMultiSelectActive && selectedTasks.length > 0 && isDraggedTaskSelected && toCleanerId !== null && !toContainer) {
        // CRITICAL: Usa lastValidDragIndex salvato durante onDragUpdate per evitare bug di posizionamento
        const correctBatchIndex = lastValidDragIndex !== null ? lastValidDragIndex : destination.index;
        dlog(`🔄 BATCH MOVE CROSS-CONTAINER: Spostamento di ${selectedTasks.length} task selezionate a cleaner ${toCleanerId} @ index ${correctBatchIndex}`);

        // ENFORCEMENT: Filtra task locked dalla selezione batch
        const unlockedSelectedTasks = selectedTasks.filter(st => {
          const t = allTasksWithAssignments.find(task => String(task.id) === st.taskId);
          return t && !(t as any).locked;
        });
        const lockedCount = selectedTasks.length - unlockedSelectedTasks.length;
        
        if (unlockedSelectedTasks.length === 0) {
          toast({
            title: "Tutte le task selezionate sono bloccate",
            description: "Sblocca le task per poterle assegnare",
            variant: "destructive",
          });
          isDraggingRef.current = false;
          if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
          setIsLoadingDragDrop(false);
          return;
        }
        
        if (lockedCount > 0) {
          toast({
            title: "Alcune task ignorate",
            description: `${lockedCount} task bloccate sono state ignorate`,
            variant: "warning",
          });
        }

        const taskIds = unlockedSelectedTasks.map(st => st.taskId);
        const numTasks = unlockedSelectedTasks.length;

        try {
          // PATCH C: Usa ID nel toast invece di fetch
          const cleanerName = `ID ${toCleanerId}`;

          // Ordina le task selezionate (non locked) per ordine di selezione
          const sortedTasks = [...unlockedSelectedTasks].sort((a, b) => a.order - b.order);

          // Sposta ciascuna task in sequenza alla destinazione
          let currentIndex = correctBatchIndex;
          for (const selectedTask of sortedTasks) {
            const taskItem = allTasksWithAssignments.find(t => String(t.id) === selectedTask.taskId);
            if (taskItem) {
              await saveTaskAssignment(selectedTask.taskId, toCleanerId, taskItem.name, currentIndex);
              currentIndex++; // Incrementa l'indice per la prossima task
            }
          }

          // Pulisci selezione
          setSelectedTasks([]);

          // Marca modifiche
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          // Ricarica i dati dal server (server-driven approach)
          await refreshAssignments("manual");

          toast({
            title: "Task assegnate",
            description: `${numTasks} task cross-container assegnate a ${cleanerName}`,
            variant: "success",
          });
        } catch (err) {
          console.error("Errore nello spostamento batch:", err);
          toast({
            title: "Errore",
            description: "Impossibile spostare le task selezionate.",
            variant: "destructive",
          });
        } finally {
          // Rilascia lock indipendentemente dall'esito
          isDraggingRef.current = false;
          if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
          setIsLoadingDragDrop(false);
        }
        return;
      }

      // ✅ NUOVO CASO: da container (early/high/low) → timeline di un cleaner

      if (!fromCleanerId && fromContainer && toCleanerId !== null && !toContainer) {
        // CRITICAL: Usa lastValidDragIndex salvato durante onDragUpdate per evitare bug di posizionamento
        const correctIndex = lastValidDragIndex !== null ? lastValidDragIndex : destination.index;
        dlog(`🔄 Spostamento da container ${fromContainer} a cleaner ${toCleanerId} @ index ${correctIndex}`);

        try {
          // PATCH C: Usa ID nel toast invece di fetch
          const cleanerName = `ID ${toCleanerId}`;

          // Salva in timeline.json (rimuove automaticamente da containers.json)
          await saveTaskAssignment(taskId, toCleanerId, logisticCode, correctIndex);

          // CRITICAL: Marca modifiche dopo drag-and-drop da container
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          // Ricarica i dati dal server (server-driven approach)
          await refreshAssignments("manual");

          toast({
            title: "Task assegnata",
            description: `Task ${logisticCode} assegnata a ${cleanerName}`,
            variant: "success",
          });
        } catch (err) {
          console.error("Errore nell'assegnazione:", err);
          toast({
            title: "Errore",
            description: "Impossibile assegnare la task.",
            variant: "destructive",
          });
        } finally {
          // Rilascia lock indipendentemente dall'esito
          isDraggingRef.current = false;
          if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
          setIsLoadingDragDrop(false);
        }
        return;
      }

      // Caso: Da timeline a container
      if (fromCleanerId !== null && toContainer && !toCleanerId) { // Aggiunto !toCleanerId per evitare sovrapposizioni
        dlog(`🔄 Spostamento da cleaner ${fromCleanerId} a container ${toContainer}`);

        try {
          // Rimuovi da timeline.json
          await removeTimelineAssignment(taskId, logisticCode);

          // CRITICAL: Marca modifiche dopo rimozione da timeline
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          // Ricarica i dati dal server (server-driven approach)
          await refreshAssignments("manual");
        } catch (err) {
          console.error("Errore nella rimozione:", err);
          toast({
            title: "Errore",
            description: "Impossibile rimuovere la task dalla timeline.",
            variant: "destructive",
          });
        } finally {
          isDraggingRef.current = false;
          if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
          setIsLoadingDragDrop(false);
        }
        return;
      }

    } catch (error) {
      console.error('Errore nello spostamento:', error);
      toast({
        title: "Errore",
        description: "Errore nello spostamento della task",
        variant: "destructive",
      });
    } finally {
      // CRITICAL: Rilascia SEMPRE il loader e il lock, indipendentemente da come si esce
      isDraggingRef.current = false;
      if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
      setIsLoadingDragDrop(false);
    }
  };

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
  const isHistoricalMode = isDateInPast(selectedDate);

  // Filtra le task non assegnate
  const unassignedTasks = allTasksWithAssignments.filter(task => !task.assignedCleaner);
  const hasAssignedTasks = allTasksWithAssignments.some(task => task.assignedCleaner);

  // Mostra loader durante l'estrazione
  if (isExtracting || isLoadingTasks || isLoading) {
    return (
      <div className="bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary"></div>
          </div>
          <h2 className="text-2xl font-bold text-foreground">
            {isExtracting ? "Estrazione Dati in Corso" : isLoadingTasks ? "Caricamento Task" : "Caricamento Dati"}
          </h2>
          <p className="text-muted-foreground">{extractionStep}</p>
          <div className="flex items-center justify-center space-x-2 text-sm text-muted-foreground">
            {isExtracting && (
              <>
                <span className="inline-block w-2 h-2 bg-primary rounded-full animate-pulse"></span>
                <span>Step 1/2: Estrazione dal database</span>
              </>
            )}
            {isLoadingTasks && (
              <>
                <span className="inline-block w-2 h-2 bg-primary rounded-full animate-pulse"></span>
                <span>Step 2/2: Caricamento nei contenitori</span>
              </>
            )}
            {isLoading && (
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

  // Definisci la funzione handleDateSelect qui, se non è già definita
  const handleDateSelect = (date: Date | undefined) => {
    if (date) {
      setSelectedDate(date);
    }
  };

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="w-full px-4 py-6">
        <div className="mb-6 flex justify-between items-center flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl flex items-center gap-2 font-bold text-foreground">
              GENERA ASSEGNAZIONI del
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
          <div className="flex items-center gap-3">
            <Link href={`/unconfirmed-tasks?date=${format(selectedDate, "yyyy-MM-dd")}`}>
              <Button variant="outline" size="icon" className="rounded-full" title="Task Non Confermate" data-testid="link-unconfirmed-tasks">
                <HelpCircle className="h-5 w-5" />
              </Button>
            </Link>
            <ThemeToggle />
          </div>
        </div>

        <MultiSelectContext.Provider value={multiSelectContextValue}>
          <DragDropContext
            onDragEnd={onDragEnd}
            onDragUpdate={onDragUpdate}
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
              <div className="flex items-center flex-shrink-0 bg-custom-blue rounded-md overflow-hidden border-2 border-gray-300 dark:border-gray-600">
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    setIsRefreshingContainers(true);
                    const year = selectedDate.getFullYear();
                    const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
                    const day = String(selectedDate.getDate()).padStart(2, '0');
                    const dateStr = `${year}-${month}-${day}`;
                    
                    const response = await fetch('/api/containers/refresh', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ date: dateStr })
                    });
                    
                    if (!response.ok) throw new Error('Errore durante il refresh');
                    
                    toast({
                      variant: "success",
                      title: "Containers aggiornati",
                      description: "I dati dei task sono stati aggiornati da ADAM",
                    });
                    await reloadAllTasks();
                  } catch (error) {
                    toast({
                      variant: "destructive",
                      title: "Errore",
                      description: "Errore durante il refresh dei containers",
                    });
                  } finally {
                    setIsRefreshingContainers(false);
                  }
                }}
                disabled={isRefreshingContainers || isTimelineReadOnly}
                className="flex items-center rounded-none text-black dark:text-white hover:bg-custom-blue/80 px-3"
              >
                {isRefreshingContainers ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
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
                disabled={isAssigning || isTimelineReadOnly}
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
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6 w-full">
                  <PriorityColumn
                    title="EARLY OUT"
                    priority="early-out"
                    tasks={earlyOutTasks}
                    droppableId="early-out"
                    icon="clock"
                    assignAction={assignEarlyOutToTimeline}
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
                    containerMultiSelectState={getContainerMultiSelectState('low_priority')}
                    highlightedTaskIds={highlightedLowPriority}
                  />
                </div>
              );
            })()}

          <div className="mt-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
              {/* Timeline View */}
              <div data-print-timeline>
                <TimelineView
                  personnel={[]}
                  tasks={allTasksWithAssignments}
                  hasUnsavedChanges={hasUnsavedChanges}
                  onTaskMoved={handleTaskMoved}
                  isReadOnly={isTimelineReadOnly}
                  isLoadingDragDrop={isLoadingDragDrop}
                  lastValidDragIndex={lastValidDragIndex}
                  draggingOverCleanerId={draggingOverCleanerId}
                  searchTask={searchTask}
                />
              </div>
            </div>

            <div className="space-y-6">
              <MapSection tasks={allTasksWithAssignments} />

              {/* Pannello Statistiche Task */}
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
                  {/* Totale Task */}
                  <div className="bg-blue-100 dark:bg-blue-950/50 rounded-lg p-3 border-2 border-blue-300 dark:border-blue-700">
                    <div className="text-xs text-blue-700 dark:text-blue-300 font-medium mb-1">Totale</div>
                    <div className="text-2xl font-bold text-blue-800 dark:text-blue-200">
                      {allTasksWithAssignments.length}
                    </div>
                  </div>

                  {/* Premium */}
                  <div className="bg-yellow-100 dark:bg-yellow-950/50 rounded-lg p-3 border-2 border-yellow-300 dark:border-yellow-700">
                    <div className="text-xs text-yellow-700 dark:text-yellow-300 font-medium mb-1">Premium</div>
                    <div className="text-2xl font-bold text-yellow-800 dark:text-yellow-200">
                      {allTasksWithAssignments.filter(t => !t.straordinaria && t.premium).length}
                    </div>
                  </div>

                  {/* Standard */}
                  <div className="bg-green-100 dark:bg-green-950/50 rounded-lg p-3 border-2 border-green-300 dark:border-green-700">
                    <div className="text-xs text-green-700 dark:text-green-300 font-medium mb-1">Standard</div>
                    <div className="text-2xl font-bold text-green-800 dark:text-green-200">
                      {allTasksWithAssignments.filter(t => !t.straordinaria && !t.premium).length}
                    </div>
                  </div>

                  {/* Straordinarie */}
                  <div className="bg-red-100 dark:bg-red-950/50 rounded-lg p-3 border-2 border-red-300 dark:border-red-700">
                    <div className="text-xs text-red-700 dark:text-red-300 font-medium mb-1">Straordinarie</div>
                    <div className="text-2xl font-bold text-red-800 dark:text-red-200">
                      {allTasksWithAssignments.filter(t => t.straordinaria).length}
                    </div>
                  </div>

                  {/* Non Assegnate */}
                  <div className="bg-gray-100 dark:bg-gray-950/50 rounded-lg p-3 border-2 border-gray-300 dark:border-gray-700 col-span-2 text-center">
                    <div className="text-xs text-gray-700 dark:text-gray-300 font-medium mb-1">Non Assegnate</div>
                    <div className="text-2xl font-bold text-gray-800 dark:text-gray-200">
                      {unassignedTasks.length}
                    </div>
                  </div>
                </div>
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
        </DragDropContext>
        </MultiSelectContext.Provider>
      </div>
    </div>
  );
}