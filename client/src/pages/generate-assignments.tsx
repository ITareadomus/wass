import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import MapSection from "@/components/map/map-section";
import { useState, useEffect, useRef, useCallback, createContext, useContext, useMemo } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { CalendarIcon, Users, RefreshCw, Settings } from "lucide-react";
import { useLocation } from 'wouter';
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

        // CRITICAL: Se la data salvata è nel PASSATO, usa OGGI invece
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        parsedDate.setHours(0, 0, 0, 0);

        if (parsedDate < today) {
          console.log(`⏰ Data salvata (${savedDate}) è nel passato, uso oggi`);
          return new Date();
        }

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

  // Stato per tracciare se è in corso un'operazione di drag-and-drop
  const [isDragging, setIsDragging] = useState<boolean>(false);

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

  // Stato per tracciare modifiche non salvate
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Stati di caricamento
  const [isExtracting, setIsExtracting] = useState(true);
  const [extractionStep, setExtractionStep] = useState<string>("Inizializzazione...");
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [lastSavedTimestamp, setLastSavedTimestamp] = useState<string | null>(null); // Renamed from lastSavedAssignment
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Nuova variabile di stato per gestire il caricamento generale
  const [isLoading, setIsLoading] = useState(false);

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

        // CRITICAL: Verifica e aggiorna la data in timeline.json dopo il caricamento
        const timelineResponse = await fetch(`/data/output/timeline.json?t=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });

        if (timelineResponse.ok) {
          const timelineData = await timelineResponse.json();
          if (timelineData.metadata?.date !== dateStr) {
            console.log(`🔄 Aggiornamento data in timeline.json da ${timelineData.metadata?.date} a ${dateStr}`);
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
    setIsLoading(true);

    try {
      if (trigger === "manual" || trigger === "manual-refresh") {
        // Refresh manuale dopo drag-and-drop: solo reload file, NO auto-load, NO extractData
        console.log('📂 Refresh manuale - solo reload file JSON (preserva timeline.json)');
        await loadTasks(true);
        return;
      }

      // Per initial e date-change, esegui auto-load completo
      await checkAndAutoLoadSavedAssignments(date);
    } catch (error) {
      console.error("Errore durante refreshAssignments:", error);
    } finally {
      setIsLoading(false);
    }
  };

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

          // CRITICAL: Verifica che timeline.json sia valido prima di caricare
          const timestamp = Date.now() + Math.random();
          const timelineCheckResponse = await fetch(`/data/output/timeline.json?t=${timestamp}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });

          if (timelineCheckResponse.ok) {
            const timelineText = await timelineCheckResponse.text();
            if (!timelineText.trim().startsWith('{') && !timelineText.trim().startsWith('[')) {
              console.error("❌ timeline.json corrotto dopo caricamento da Object Storage");
              toast({
                title: "Errore",
                description: "File timeline corrotto, riprova tra qualche secondo",
                variant: "destructive",
                duration: 5000
              });
              setIsExtracting(false);
              return;
            }
          }

          // Ricarica i task per mostrare i dati aggiornati
          await loadTasks(true);

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

          // Ricarica la timeline UI
          if ((window as any).loadTimelineCleaners) {
            console.log("🔄 Ricaricamento timeline cleaners dopo auto-load...");
            await (window as any).loadTimelineCleaners();
          }

          // CRITICAL: Dopo aver caricato assegnazioni salvate, NON ci sono modifiche
          setHasUnsavedChanges(false);

          setExtractionStep("Assegnazioni caricate!");
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

        // Verifica se esiste timeline.json locale (non salvata)
        try {
          const timelineResponse = await fetch(`/data/output/timeline.json?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });

          if (timelineResponse.ok) {
            const timelineData = await timelineResponse.json();
            const hasLocalAssignments = timelineData.cleaners_assignments?.length > 0;

            if (hasLocalAssignments && timelineData.metadata?.date === dateStr) {
              console.log("✅ Timeline.json locale esistente con assegnazioni - mantieni senza resettare");

              // Carica solo i task senza estrarre
              await loadTasks(true);
              setExtractionStep("Dati caricati!");
              await new Promise(resolve => setTimeout(resolve, 100));
              setIsExtracting(false);
              return;
            }
          }
        } catch (err) {
          console.log("Timeline.json locale non trovata o vuota, procedo con estrazione");
        }

        // SOLO date STRETTAMENTE passate sono read-only
        if (isPastDate) {
          console.log("🔒 Data passata senza assegnazioni - modalità READ-ONLY");
          setIsTimelineReadOnly(true);
        } else {
          console.log("✏️ Data presente/futura - modalità EDITABILE");
          setIsTimelineReadOnly(false);
        }
        await extractData(date);
      }
    } catch (error) {
      console.error("Errore nella verifica assegnazioni salvate:", error);
      // Fallback: procedi con estrazione normale
      await extractData(date);
    }
  };


  // Funzione per estrarre i dati dal database (quando NON esistono assegnazioni salvate)
  const extractData = async (date: Date) => {
    try {
      setIsExtracting(true);
      setExtractionStep("Estrazione dati dal database...");

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      console.log("Estrazione dati per data:", dateStr);

      // Ottieni username corrente
      const currentUsername = getCurrentUsername();

      // Resetta la timeline
      await fetch('/api/reset-timeline-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr, created_by: currentUsername })
      });

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
      await new Promise(resolve => setTimeout(resolve, 500));
      await loadTasks();

      setExtractionStep("Task caricati!");
      await new Promise(resolve => setTimeout(resolve, 100));

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

    // CRITICAL: Carica automaticamente SOLO se:
    // 1. È il primo montaggio (isInitialMount = true)
    // 2. OPPURE la data è cambiata rispetto alla precedente
    const shouldLoad = isInitialMount || (prevDateRef.current !== null && prevDateRef.current !== currentDateStr);

    if (shouldLoad) {
      // Determina il trigger corretto
      const trigger = isInitialMount ? "initial" : "date-change";
      console.log(`📅 Data changed o initial mount - trigger: "${trigger}"`);
      refreshAssignments(trigger, selectedDate);
      prevDateRef.current = currentDateStr;
    }

    // Reset isInitialMount dopo la prima chiamata
    if (isInitialMount) {
      setIsInitialMount(false);
      prevDateRef.current = currentDateStr;
    }
  }, [selectedDate, isInitialMount]);





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
      type_apt: (rawTask as any).type_apt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  };

  // Carica i task dai file JSON (SENZA rieseguire extract-data)
  const loadTasks = async (skipExtraction: boolean = false) => {
    try {
      setIsLoadingTasks(true);
      setExtractionStep("Caricamento task nei contenitori...");

      const dateStr = format(selectedDate, "yyyy-MM-dd");

      // Aggiungi timestamp UNIVOCO per evitare QUALSIASI cache
      const timestamp = Date.now() + Math.random();

      console.log("🔄 Caricamento task dai file JSON (timestamp: ${timestamp})...");

      const [containersResponse, timelineResponse] = await Promise.all([
        fetch(`/data/output/containers.json?t=${timestamp}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        }),
        fetch(`/data/output/timeline.json?t=${timestamp}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        })
      ]);

      if (!containersResponse.ok) {
        throw new Error('Errore nel caricamento del file containers.json');
      }

      const containersText = await containersResponse.text();

      // Verifica che il contenuto sia JSON valido
      if (!containersText.trim().startsWith('{') && !containersText.trim().startsWith('[')) {
        console.error('❌ containers.json corrotto, non è JSON:', containersText.substring(0, 100));
        throw new Error('containers.json corrotto - riprova tra qualche secondo');
      }

      const containersData = JSON.parse(containersText);

      // Carica da timeline.json con gestione errori robusta
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
              console.warn('Timeline.json corrotto, non è JSON:', timelineText.substring(0, 100));
              timelineAssignmentsData = { metadata: {}, cleaners_assignments: [] };
            } else {
              timelineAssignmentsData = JSON.parse(timelineText);
              console.log("Timeline assignments data:", timelineAssignmentsData);
              console.log("Cleaners assignments count:", timelineAssignmentsData.cleaners_assignments?.length || 0);
              console.log("Total tasks in timeline:", timelineAssignmentsData.cleaners_assignments?.reduce((sum: number, c: any) => sum + (c.tasks?.length || 0), 0) || 0);
            }
          } else {
            console.warn('Timeline file is not JSON, using empty timeline');
          }
        } catch (e) {
          console.error('Errore parsing timeline.json:', e);
          // In caso di errore, usa timeline vuota
          timelineAssignmentsData = { metadata: {}, cleaners_assignments: [] };
        }
      } else {
        console.warn(`Timeline file not found (${timelineResponse.status}), using empty timeline`);
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

      console.log("Task convertiti - Early:", initialEarlyOut.length, "High:", initialHigh.length, "Low:", initialLow.length);

      // Costruisci la mappa task_id -> assegnazione dalla timeline
      const timelineAssignmentsMap = new Map();
      const timelineTasks: Task[] = [];

      if (timelineAssignmentsData.cleaners_assignments) {
        console.log('📋 Caricamento da cleaners_assignments:', timelineAssignmentsData.cleaners_assignments.length);
        for (const cleanerEntry of timelineAssignmentsData.cleaners_assignments) {
          if (!cleanerEntry.cleaner || !cleanerEntry.cleaner.id) {
            console.warn('⚠️ Trovata entry senza cleaner, salto:', cleanerEntry);
            continue;
          }

          console.log(`   Cleaner ${cleanerEntry.cleaner.id} (${cleanerEntry.cleaner.name}) ha ${cleanerEntry.tasks?.length || 0} task`);
          for (const task of cleanerEntry.tasks || []) {
            const taskId = String(task.task_id);
            const taskLC = String(task.logistic_code);
            console.log(`      → Task ${taskLC} (ID: ${taskId}) assegnata a cleaner ${cleanerEntry.cleaner.id}`);

            const taskWithAssignment = {
              ...task,
              id: task.task_id || task.id,
              name: String(task.logistic_code),
              assignedCleaner: cleanerEntry.cleaner.id,
              cleanerId: cleanerEntry.cleaner.id,
              sequence: task.sequence,
              priority: task.priority || 'low_priority'
            };

            timelineAssignmentsMap.set(taskId, taskWithAssignment);
            timelineTasks.push(taskWithAssignment as Task);
          }
        }
      } else if (timelineAssignmentsData.assignments) {
        // Vecchia struttura piatta (fallback)
        console.log('📋 Caricamento da assignments (vecchia struttura):', timelineAssignmentsData.assignments.length);
        for (const a of timelineAssignmentsData.assignments) {
          const taskWithAssignment = {
            ...a,
            id: a.task_id || a.id,
            name: String(a.logistic_code),
            assignedCleaner: a.cleanerId || a.cleaner_id,
            priority: a.priority || 'low_priority'
          };
          timelineAssignmentsMap.set(String(a.task_id), taskWithAssignment);
          timelineTasks.push(taskWithAssignment as Task);
        }
      }

      console.log("✅ Task assegnate nella timeline (task_id):", Array.from(timelineAssignmentsMap.keys()));
      console.log("✅ Timeline tasks array length:", timelineTasks.length);


      // Filtra le task già presenti nella timeline dai container usando l'id univoco
      const filteredEarlyOut = initialEarlyOut.filter(task => {
        const tid = String(task.id);
        const isAssigned = timelineAssignmentsMap.has(tid);
        if (isAssigned) {
          console.log(`Task ${task.name} (ID: ${tid}) filtrata da Early Out (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredHigh = initialHigh.filter(task => {
        const tid = String(task.id);
        const isAssigned = timelineAssignmentsMap.has(tid);
        if (isAssigned) {
          console.log(`Task ${task.name} (ID: ${tid}) filtrata da High Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredLow = initialLow.filter(task => {
        const tid = String(task.id);
        const isAssigned = timelineAssignmentsMap.has(tid);
        if (isAssigned) {
          console.log(`Task ${task.name} (ID: ${tid}) filtrata da Low Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      console.log("Task dopo filtro - Early:", filteredEarlyOut.length, "High:", filteredHigh.length, "Low:", filteredLow.length);

      // AGGIORNA GLI STATI IN MODO SINCRONIZZATO
      setEarlyOutTasks(filteredEarlyOut);
      setHighPriorityTasks(filteredHigh);
      setLowPriorityTasks(filteredLow);

      console.log(`📊 SINCRONIZZAZIONE CONTAINERS:`);
      console.log(`   - Early Out: ${filteredEarlyOut.length} task (filtrate ${initialEarlyOut.length - filteredEarlyOut.length})`);
      console.log(`   - High Priority: ${filteredHigh.length} task (filtrate ${initialHigh.length - filteredHigh.length})`);
      console.log(`   - Low Priority: ${filteredLow.length} task (filtrate ${initialLow.length - filteredLow.length})`);
      console.log(`   - Timeline ha ${timelineAssignmentsMap.size} task assegnate`);

      // Debug: mostra alcune task assegnate
      const assignedTasks = Array.from(timelineAssignmentsMap.values());
      if (assignedTasks.length > 0) {
        console.log(`📌 Esempio task assegnate (prime 3):`, assignedTasks.slice(0, 3).map(t => ({
          id: t.task_id,
          logistic_code: t.logistic_code,
          cleanerId: t.cleanerId,
          sequence: t.sequence,
          start_time: t.start_time
        })));
      }

      // Crea l'array unificato usando dedupe per id (non per logisticCode!)
      const tasksWithAssignments: Task[] = [];

      // CRITICAL: usa Set per tracciare id già inseriti
      const addedIds = new Set<string>();

      // Aggiungi task NON assegnate dai containers
      for (const task of [...filteredEarlyOut, ...filteredHigh, ...filteredLow]) {
        const tid = String(task.id);
        if (!addedIds.has(tid)) {
          tasksWithAssignments.push(task);
          addedIds.add(tid);
        }
      }

      // Aggiungi SOLO task che sono effettivamente in timeline.json con i loro dati completi
      console.log(`🔄 Elaborazione ${timelineAssignmentsMap.size} task dalla timeline...`);
      for (const [taskId, timelineAssignment] of timelineAssignmentsMap.entries()) {
        // Trova la task originale dai containers usando l'id univoco
        const originalTask = [...initialEarlyOut, ...initialHigh, ...initialLow].find(
          t => String(t.id) === String(taskId)
        );

        console.log(`   → Task ${timelineAssignment.logistic_code} (ID: ${taskId}):`, {
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
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          const taskLogCode = getLogisticCode(baseTask);
          console.log(`➕ Aggiungendo task ${taskLogCode} dalla timeline a cleaner ${timelineAssignment.cleanerId} con sequence ${timelineAssignment.sequence}`);

          // IMPORTANTE: Assicurati che assignedCleaner sia propagato correttamente
          const taskWithAssignment = {
            ...baseTask,
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

          tasksWithAssignments.push(taskWithAssignment);
        }
      }

      // DEDUPE finale per id prima di salvare lo stato
      const dedupedTasks = dedupeById(tasksWithAssignments);

      console.log(`📊 SINCRONIZZAZIONE TIMELINE:`);
      console.log(`   - Task totali (prima dedupe): ${tasksWithAssignments.length}`);
      console.log(`   - Task totali (dopo dedupe): ${dedupedTasks.length}`);
      console.log(`   - Task assegnate: ${dedupedTasks.filter(t => (t as any).assignedCleaner).length}`);
      console.log(`   - Task nei containers: ${dedupedTasks.filter(t => !(t as any).assignedCleaner).length}`);

      setAllTasksWithAssignments(dedupedTasks);

      setIsLoadingTasks(false);
      setExtractionStep("Task caricati con successo!");

      console.log(`✅ SINCRONIZZAZIONE COMPLETATA - Containers e Timeline allineati con i file JSON`);
    } catch (error) {
      console.error("Errore nel caricamento dei task:", error);
      setIsLoadingTasks(false);
      setExtractionStep("Errore nel caricamento dei task");
    }
  };

  // Funzione esposta per ricaricare i task e le assegnazioni
  const reloadAllTasks = async () => {
    await refreshAssignments("manual");
  };





  // Funzione per assegnare le task Early Out alla timeline
  const assignEarlyOutToTimeline = async () => {
    try {
      // Format date in local timezone to avoid UTC shift
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // VALIDAZIONE: Verifica che ci siano cleaner convocati
      const selectedCleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const selectedCleanersData = await selectedCleanersResponse.json();

      if (!selectedCleanersData.cleaners || selectedCleanersData.cleaners.length === 0) {
        toast({
          title: "Errore: Nessun cleaner convocato",
          description: "Devi prima convocare almeno un cleaner nella sezione Convocazioni",
          variant: "destructive",
          duration: 5000,
        });
        return;
      }

      console.log(`📅 Assegnazione EO per data: ${dateStr}`);
      console.log(`📅 selectedDate oggetto:`, selectedDate);
      console.log(`📅 Invio data al backend:`, dateStr);

      const response = await fetch('/api/assign-early-out-to-timeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      const result = await response.json();

      if (result.success) {
        // CRITICAL: Marca modifiche dopo assegnazione automatica
        setHasUnsavedChanges(true);
        handleTaskMoved();

        toast({
          title: "Early Out Assegnati!",
          description: result.message,
          duration: 3000,
        });

        // Ricarica i task per mostrare le assegnazioni nella timeline
        await refreshAssignments("manual");
      } else {
        throw new Error(result.message || 'Errore sconosciuto');
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
      // Format date in local timezone to avoid UTC shift
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // VALIDAZIONE: Verifica che ci siano cleaner convocati
      const selectedCleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const selectedCleanersData = await selectedCleanersResponse.json();

      if (!selectedCleanersData.cleaners || selectedCleanersData.cleaners.length === 0) {
        toast({
          title: "Errore: Nessun cleaner convocato",
          description: "Devi prima convocare almeno un cleaner nella sezione Convocazioni",
          variant: "destructive",
          duration: 5000,
        });
        return;
      }

      console.log(`📅 Assegnazione HP per data: ${dateStr}`);
      console.log(`📅 selectedDate oggetto:`, selectedDate);
      console.log(`📅 Invio data al backend:`, dateStr);

      const response = await fetch('/api/assign-high-priority-to-timeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      const result = await response.json();

      if (result.success) {
        // CRITICAL: Marca modifiche dopo assegnazione automatica
        setHasUnsavedChanges(true);
        handleTaskMoved();

        toast({
          title: "High Priority Assegnati!",
          description: result.message,
          duration: 3000,
        });

        // Ricarica i task per riflettere le nuove assegnazioni
        if ((window as any).reloadAllTasks) {
          console.log('🔄 Ricaricamento task dopo assegnazione HP...');
          await (window as any).reloadAllTasks();
          console.log('✅ Task ricaricati con successo');
        }
      } else {
        throw new Error(result.message || 'Errore sconosciuto');
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
      // Format date in local timezone to avoid UTC shift
      const year = selectedDate.getFullYear();
      const month = String(selectedDate.getMonth() + 1).padStart(2, '0');
      const day = String(selectedDate.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // VALIDAZIONE: Verifica che ci siano cleaner convocati
      const selectedCleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const selectedCleanersData = await selectedCleanersResponse.json();

      if (!selectedCleanersData.cleaners || selectedCleanersData.cleaners.length === 0) {
        toast({
          title: "Errore: Nessun cleaner convocato",
          description: "Devi prima convocare almeno un cleaner nella sezione Convocazioni",
          variant: "destructive",
          duration: 5000,
        });
        return;
      }

      console.log(`📅 Assegnazione LP per data: ${dateStr}`);
      console.log(`📅 selectedDate oggetto:`, selectedDate);
      console.log(`📅 Invio data al backend:`, dateStr);

      const response = await fetch('/api/assign-low-priority-to-timeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      const result = await response.json();

      if (result.success) {
        // CRITICAL: Marca modifiche dopo assegnazione automatica
        setHasUnsavedChanges(true);
        handleTaskMoved();

        toast({
          title: "Low Priority Assegnati!",
          description: result.message,
          duration: 3000,
        });

        // Ricarica i task per riflettere le nuove assegnazioni
        if ((window as any).reloadAllTasks) {
          console.log('🔄 Ricaricamento task dopo assegnazione LP...');
          await (window as any).reloadAllTasks();
          console.log('✅ Task ricaricati con successo');
        }
      } else {
        throw new Error(result.message || 'Errore sconosciuto');
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

      // Determina la priorità originale della task usando l'id
      let priority = 'low_priority'; // default
      if (earlyOutTasks.find(t => String(t.id) === String(taskId))) {
        priority = 'early_out';
      } else if (highPriorityTasks.find(t => String(t.id) === String(taskId))) {
        priority = 'high_priority';
      }

      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      const response = await fetch("/api/save-timeline-assignment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taskId: task.id,
          logisticCode: task.name,
          cleanerId: cleanerId,
          dropIndex: dropIndex,
          taskData: task,
          priority: priority,
          date: dateStr,
          modified_by: currentUser.username || 'unknown'
        }),
      });
      if (!response.ok) {
        console.error('Errore nel salvataggio dell\'assegnazione nella timeline');
      } else {
        console.log(`Assegnazione salvata: taskId=${taskId}, logisticCode=${logisticCode}`);
      }
    } catch (error) {
      console.error('Errore nella chiamata API di salvataggio timeline:', error);
    }
  };

  const reorderTimelineAssignment = async (taskId: string, cleanerId: number, logisticCode: string, fromIndex: number, toIndex: number) => {
    try {
      const dateStr = format(selectedDate, "yyyy-MM-dd");
      const response = await fetch('/api/reorder-timeline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr, cleanerId, taskId, logisticCode, fromIndex, toIndex }),
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

  const onDragEnd = async (result: any) => {
    const { destination, source, draggableId } = result;

    // niente destinazione => niente da fare
    if (!destination) return;

    // se posizione identica, esci
    if (
      destination.droppableId === source.droppableId &&
      destination.index === source.index
    ) {
      return;
    }

    // CRITICAL: Blocca drag simultanei
    if (isDragging) {
      console.log("⚠️ Drag già in corso, operazione annullata per prevenire conflitti");
      toast({
        title: "Operazione in corso",
        description: "Attendi il completamento del movimento precedente",
        variant: "warning",
        duration: 2000,
      });
      return;
    }

    // draggableId è sempre l'id univoco della task
    const taskId = draggableId;
    const task = allTasksWithAssignments.find(t => String(t.id) === String(taskId));
    const logisticCode = task?.name; // name contiene il logistic_code

    // Se la timeline è read-only, non permettere modifiche
    if (isTimelineReadOnly) {
      console.log("Timeline è READ-ONLY, spostamento annullato.");
      toast({
        title: "Operazione non permessa",
        description: "La timeline è in sola visualizzazione per questa data.",
        variant: "warning",
      });
      // Opzionale: annulla visivamente il drag (anche se react-beautiful-dnd potrebbe gestirlo)
      return;
    }

    // Imposta lock
    setIsDragging(true);

    try {
      // 🔹 Ramo TIMELINE (drag tra cleaners o riordino nello stesso cleaner)
      const fromCleanerId = parseCleanerId(source.droppableId);
      const toCleanerId = parseCleanerId(destination.droppableId);

      // ✅ NUOVO CASO: da container (early/high/low) → timeline di un cleaner
      const fromContainer = parseContainerKey(source.droppableId);
      const toContainer = parseContainerKey(destination.droppableId);

      // 🔸 BATCH MOVE: Se multi-select è attivo, ci sono task selezionate, E la task trascinata è tra quelle selezionate
      const isDraggedTaskSelected = selectedTasks.some(st => st.taskId === taskId);

      if (isAnyMultiSelectActive && selectedTasks.length > 0 && isDraggedTaskSelected && toCleanerId !== null && !toContainer) {
        console.log(`🔄 BATCH MOVE CROSS-CONTAINER: Spostamento di ${selectedTasks.length} task selezionate a cleaner ${toCleanerId}`);

        try {
          // Carica i dati del cleaner
          const cleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });
          const cleanersData = await cleanersResponse.json();
          const cleaner = cleanersData.cleaners.find((c: any) => c.id === toCleanerId);
          const cleanerName = cleaner ? `${cleaner.name} ${cleaner.lastname}` : `ID ${toCleanerId}`;

          // Ordina le task selezionate per ordine di selezione
          const sortedTasks = [...selectedTasks].sort((a, b) => a.order - b.order);

          // Sposta ciascuna task in sequenza alla destinazione
          let currentIndex = destination.index;
          for (const selectedTask of sortedTasks) {
            const task = allTasksWithAssignments.find(t => String(t.id) === selectedTask.taskId);
            if (task) {
              await saveTaskAssignment(selectedTask.taskId, toCleanerId, task.name, currentIndex);
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

          toast({
            title: "Task assegnate",
            description: `${selectedTasks.length} task cross-container assegnate a ${cleanerName}`,
            variant: "success",
          });

          // Rilascia lock PRIMA del reload
          setIsDragging(false);

          // Reload in background
          await refreshAssignments("manual");
        } catch (err) {
          console.error("Errore nel batch move:", err);
          toast({
            title: "Errore",
            description: "Impossibile assegnare le task selezionate.",
            variant: "destructive",
          });
          // Rilascia lock anche in caso di errore
          setIsDragging(false);
        }
        return;
      }

      if (!fromCleanerId && fromContainer && toCleanerId !== null && !toContainer) {
        console.log(`🔄 Spostamento da container ${fromContainer} a cleaner ${toCleanerId}`);

        try {
          // Carica i dati del cleaner per mostrare nome e cognome
          const cleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });
          const cleanersData = await cleanersResponse.json();
          const cleaner = cleanersData.cleaners.find((c: any) => c.id === toCleanerId);
          const cleanerName = cleaner ? `${cleaner.name} ${cleaner.lastname}` : `ID ${toCleanerId}`;

          // Salva in timeline.json (rimuove automaticamente da containers.json)
          await saveTaskAssignment(taskId, toCleanerId, logisticCode, destination.index);

          // CRITICAL: Marca modifiche dopo drag-and-drop da container
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          toast({
            title: "Task assegnata",
            description: `Task ${logisticCode} assegnata a ${cleanerName}`,
            variant: "success",
          });

          // Rilascia lock PRIMA del reload
          setIsDragging(false);

          // Reload in background
          await refreshAssignments("manual");
        } catch (err) {
          console.error("Errore nel salvataggio in timeline:", err);
          toast({
            title: "Errore",
            description: "Impossibile assegnare la task alla timeline.",
            variant: "destructive",
          });
          // Rilascia lock anche in caso di errore
          setIsDragging(false);
        }
        return;
      }

      if (fromCleanerId !== null && toCleanerId !== null) {
        console.log(`🔄 Spostamento tra cleaners: task ${logisticCode} da cleaner ${fromCleanerId} (idx ${source.index}) a cleaner ${toCleanerId} (idx ${destination.index})`);

        try {
          // Carica i dati dei cleaner per mostrare nome e cognome
          const cleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });
          const cleanersData = await cleanersResponse.json();
          const fromCleaner = cleanersData.cleaners.find((c: any) => c.id === fromCleanerId);
          const toCleaner = cleanersData.cleaners.find((c: any) => c.id === toCleanerId);
          const fromCleanerName = fromCleaner ? `${fromCleaner.name} ${fromCleaner.lastname}` : `ID ${fromCleanerId}`;
          const toCleanerName = toCleaner ? `${toCleaner.name} ${toCleaner.lastname}` : `ID ${toCleanerId}`;

          const payload = {
            date: format(selectedDate, "yyyy-MM-dd"),
            taskId,
            logisticCode,
            fromCleanerId,
            toCleanerId,
            sourceIndex: source.index,
            destIndex: destination.index,
            insertAt: destination.index
          };

          console.log('Payload inviato:', payload);

          const response = await fetch('/api/timeline/move-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          console.log('✅ Response ricevuta, status:', response.status, 'ok:', response.ok);

          const data = await response.json();
          console.log('✅ JSON parseato con successo:', data);

          if (!response.ok || !data?.success) {
            console.error('❌ Errore timeline/move-task - response.ok:', response.ok, 'data.success:', data?.success);
            toast({
              title: "Errore",
              description: data.message || "Impossibile spostare la task",
              variant: "destructive"
            });
            // Ricarica per sincronizzare solo in caso di errore
            await refreshAssignments("manual");
          } else {
            console.log('✅ Movimento completato - response.ok:', response.ok, 'data.success:', data.success);
            console.log('✅ Movimento salvato automaticamente in timeline.json');

            // CRITICAL: Invalida l'acknowledged state per vedere nuove incompatibilità dopo lo spostamento
            if ((window as any).invalidateAcknowledgedIncompatibleCleaners) {
              (window as any).invalidateAcknowledgedIncompatibleCleaners(fromCleanerId);
              (window as any).invalidateAcknowledgedIncompatibleCleaners(toCleanerId);
            }

            // CRITICAL: Marca modifiche dopo spostamento tra cleaners
            setHasUnsavedChanges(true);
            if (handleTaskMoved) {
              handleTaskMoved();
            }

            // Mostra toast SUBITO (non aspettare il reload)
            if (fromCleanerId !== toCleanerId) {
              toast({
                title: "Task spostata",
                description: `Task ${logisticCode} spostata da ${fromCleanerName} a ${toCleanerName}`,
                variant: "success",
              });
            }

            // CRITICAL: Rilascia il lock PRIMA del reload asincrono
            setIsDragging(false);

            // Reload in background (non blocca e non genera errori se fallisce)
            refreshAssignments("manual").catch(err => {
              console.warn('⚠️ Reload fallito dopo movimento (movimento già salvato):', err);
            });
          }
        } catch (error) {
          console.error('Errore nella chiamata API:', error);
          toast({
            title: "Errore di rete",
            description: "Impossibile spostare la task. Verifica la connessione.",
            variant: "destructive"
          });
        } finally {
          // Assicura che il lock sia sempre rilasciato
          setIsDragging(false);
        }
        return;
      }

      // 🔹 Ramo CONTAINERS (Early-Out / High / Low)
      const containerToJsonName: Record<string, string> = {
        'early-out': 'early_out',
        'high': 'high_priority',
        'low': 'low_priority'
      };

      const fromContainerJson = containerToJsonName[source.droppableId] || null;
      const toContainerJson = containerToJsonName[destination.droppableId] || null;

      // Caso: spostamento tra containers di priorità
      if (fromContainerJson && toContainerJson) {
        console.log(`📦 Spostamento tra containers: ${fromContainer} → ${toContainer}`);

        try {
          const payload = {
            taskId: draggableId,
            fromContainer: fromContainerJson,
            toContainer: toContainerJson,
            sourceIndex: source.index,
            destIndex: destination.index,
          };

          const resp = await fetch('/api/update-task-json', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          const json = await resp.json();
          if (!resp.ok || !json?.success) {
            console.error('update-task-json error', json);
            toast({
              title: "Errore",
              description: json?.message || "Errore nello spostamento tra containers",
              variant: "destructive"
            });
            return;
          }

          // CRITICAL: Marca modifiche dopo spostamento tra containers
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          toast({
            title: "Task spostata",
            description: `Task spostata tra containers`,
          });

          // Rilascia lock PRIMA del reload
          setIsDragging(false);

          // Ricarica i task dai containers aggiornati in background
          await refreshAssignments("manual");
        } catch (err) {
          console.error('update-task-json fetch failed', err);
          toast({
            title: "Errore",
            description: "Errore di rete nello spostamento",
            variant: "destructive"
          });
          // Rilascia lock anche in caso di errore
          setIsDragging(false);
        }
        return;
      }

      // Caso: Da container a timeline
      if (fromContainerJson && toCleanerId !== null) {
        console.log(`🔄 Spostamento da container ${fromContainerJson} a cleaner ${toCleanerId}`);

        try {
          // Carica i dati del cleaner per mostrare nome e cognome
          const cleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });
          const cleanersData = await cleanersResponse.json();
          const cleaner = cleanersData.cleaners.find((c: any) => c.id === toCleanerId);
          const cleanerName = cleaner ? `${cleaner.name} ${cleaner.lastname}` : `ID ${toCleanerId}`;

          // Salva in timeline.json (rimuove automaticamente da containers.json)
          await saveTaskAssignment(taskId, toCleanerId, logisticCode, destination.index);
          await refreshAssignments("manual");

          // CRITICAL: Marca modifiche dopo assegnazione
          setHasUnsavedChanges(true);
          if (handleTaskMoved) {
            handleTaskMoved();
          }

          toast({
            title: "Task assegnata",
            description: `Task ${logisticCode} assegnata a ${cleanerName}`,
            variant: "success",
          });
        } catch (err) {
          console.error("Errore nell'assegnazione:", err);
        } finally {
          // Rilascia lock indipendentemente dall'esito
          setIsDragging(false);
        }
        return;
      }

      // Caso: Da timeline a container
      if (fromCleanerId !== null && toContainerJson) {
        console.log(`🔄 Spostamento da cleaner ${fromCleanerId} a container ${toContainerJson}`);

        // Rimuovi da timeline.json
        await removeTimelineAssignment(taskId, logisticCode);

        // CRITICAL: Marca modifiche dopo rimozione da timeline
        setHasUnsavedChanges(true);
        if (handleTaskMoved) {
          handleTaskMoved();
        }

        // Rilascia lock PRIMA del reload
        setIsDragging(false);

        // Reload in background
        await refreshAssignments("manual");
        return;
      }

    } catch (error) {
      console.error('Errore nello spostamento:', error);
      toast({
        title: "Errore",
        description: "Errore nello spostamento della task",
        variant: "destructive",
      });
      // Assicurati che il lock venga sempre rilasciato
      setIsDragging(false);
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
            <ThemeToggle />
          </div>
        </div>

        <MultiSelectContext.Provider value={multiSelectContextValue}>
          <DragDropContext onDragEnd={onDragEnd}>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6 w-full">
              <PriorityColumn
                title="EARLY OUT"
                priority="early-out"
                tasks={earlyOutTasks}
                droppableId="early-out"
                icon="clock"
                assignAction={assignEarlyOutToTimeline}
                containerMultiSelectState={getContainerMultiSelectState('early_out')}
              />
              <PriorityColumn
                title="HIGH PRIORITY"
                priority="high"
                tasks={highPriorityTasks}
                droppableId="high"
                icon="alert-circle"
                assignAction={assignHighPriorityToTimeline}
                containerMultiSelectState={getContainerMultiSelectState('high_priority')}
              />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={lowPriorityTasks}
              droppableId="low"
              icon="arrow-down"
              assignAction={assignLowPriorityToTimeline}
              containerMultiSelectState={getContainerMultiSelectState('low_priority')}
            />
          </div>

          <div className="mt-6 grid grid-cols-1 xl:grid-cols-3 gap-6">
            <div className="xl:col-span-2">
              {/* Timeline View */}
              <div data-print-timeline>
                <TimelineView
                  personnel={[]}
                  tasks={allTasksWithAssignments}
                  hasUnsavedChanges={hasUnsavedChanges}
                  onTaskMoved={handleTaskMoved}
                  isReadOnly={isTimelineReadOnly} // Passa lo stato read-only
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
        </DragDropContext>
        </MultiSelectContext.Provider>
      </div>
    </div>
  );
}