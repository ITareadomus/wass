import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import MapSection from "@/components/map/map-section";
import { useState, useEffect, useRef } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { CalendarIcon, Users, RefreshCw } from "lucide-react";
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

export default function GenerateAssignments() {
  // Usa la data salvata in localStorage, oppure la data odierna se non presente
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const savedDate = localStorage.getItem('selected_work_date');
    if (savedDate) {
      // Converte yyyy-MM-dd in Date senza problemi di timezone
      const [year, month, day] = savedDate.split('-').map(Number);
      return new Date(year, month - 1, day);
    }
    return new Date();
  });

  // Traccia il primo caricamento per evitare reload automatici
  const [isInitialMount, setIsInitialMount] = useState(true);

  // Stato per tracciare se la timeline è in modalità di sola visualizzazione
  const [isTimelineReadOnly, setIsTimelineReadOnly] = useState<boolean>(false);

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
  const [lastSavedAssignment, setLastSavedAssignment] = useState<string | null>(null);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

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
        setLastSavedAssignment(displayDateTime);

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
        setLastSavedAssignment(null);
        return false;
      }
    } catch (error) {
      console.error("Errore nel caricamento delle assegnazioni salvate:", error);
      setLastSavedAssignment(null);
      return false;
    }
  };

  // Funzione per verificare ed eventualmente caricare automaticamente le assegnazioni salvate
  const checkAndAutoLoadSavedAssignments = async (date: Date) => {
    try {
      setIsExtracting(true);
      setExtractionStep("Verifica assegnazioni salvate...");

      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      // Verifica se esistono assegnazioni salvate
      const checkResponse = await fetch('/api/check-saved-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      const checkResult = await checkResponse.json();

      if (checkResult.found) {
        // Esistono assegnazioni salvate - CARICA AUTOMATICAMENTE
        console.log("✅ Trovate assegnazioni salvate per", dateStr, "- caricamento automatico...");
        setExtractionStep("Caricamento assegnazioni salvate...");

        // Imposta timeline in modalità read-only (assegnazioni salvate)
        setIsTimelineReadOnly(true);
        console.log("🔒 Timeline impostata in modalità READ-ONLY (assegnazioni salvate)");

        // Carica direttamente le assegnazioni salvate
        const loaded = await loadSavedAssignments(date);

        if (loaded) {
          // CRITICAL: Verifica che la data nel file caricato corrisponda alla data selezionata
          const timestamp = Date.now() + Math.random();
          const timelineResponse = await fetch(`/data/output/timeline.json?t=${timestamp}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
          });

          if (timelineResponse.ok) {
            const timelineData = await timelineResponse.json();
            const loadedDate = timelineData.metadata?.date;

            if (loadedDate !== dateStr) {
              console.warn(`⚠️ La data nel file (${loadedDate}) non corrisponde alla data selezionata (${dateStr})`);
              console.log("📭 Mostro timeline vuota per data passata senza salvataggi");
              
              // Data passata senza salvataggi corrispondenti: mostra timeline vuota
              setIsTimelineReadOnly(true);
              setExtractionStep("Data passata - nessuna assegnazione disponibile");
              
              // Svuota i containers e la timeline
              setEarlyOutTasks([]);
              setHighPriorityTasks([]);
              setLowPriorityTasks([]);
              setAllTasksWithAssignments([]);
              
              await new Promise(resolve => setTimeout(resolve, 500));
              setIsExtracting(false);
              return;
            }
          }

          // La data corrisponde - procedi con il caricamento normale
          console.log("⏳ Attesa sincronizzazione file dopo caricamento da Object Storage...");
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Ricarica la timeline UI
          if ((window as any).loadTimelineCleaners) {
            console.log("🔄 Ricaricamento timeline cleaners dopo auto-load...");
            await (window as any).loadTimelineCleaners();
          }

          // Ricarica i tasks con i dati aggiornati
          try {
            console.log("📊 Caricamento tasks da file aggiornati...");
            await loadTasks(true);
            console.log("✅ Tasks caricati con successo da assegnazioni salvate");
          } catch (err) {
            console.warn("⚠️ Errore nel caricamento tasks dopo auto-load:", err);
            // Se fallisce, prova con estrazione nuova
            await extractData(date);
            return;
          }

          setExtractionStep("Assegnazioni caricate!");
          await new Promise(resolve => setTimeout(resolve, 100));
          setIsExtracting(false);
        } else {
          // Caricamento fallito, procedi con estrazione normale
          console.log("⚠️ Caricamento assegnazioni salvate fallito, procedo con estrazione normale");
          await extractData(date);
        }
      } else {
        // NON esistono assegnazioni salvate
        console.log("ℹ️ Nessuna assegnazione salvata per", dateStr);

        // Verifica se la data è nel passato
        if (isDateInPast(date)) {
          // Data passata senza salvataggi: read-only con timeline vuota
          console.log("🔒 Data passata senza assegnazioni salvate - modalità READ-ONLY");
          setIsTimelineReadOnly(true);
          setExtractionStep("Data passata - nessuna assegnazione disponibile");
          await new Promise(resolve => setTimeout(resolve, 500));
          setIsExtracting(false);
        } else {
          // Data presente/futura senza salvataggi: modalità editabile
          console.log("✏️ Data presente/futura - modalità EDITABILE");
          setIsTimelineReadOnly(false);
          await extractData(date);
        }
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

      // Resetta la timeline
      await fetch('/api/reset-timeline-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      const response = await fetch('/api/extract-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
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
      // NUOVO: Prima verifica se esistono assegnazioni salvate
      // Se esistono, carica direttamente quelle invece di creare container vuoti
      checkAndAutoLoadSavedAssignments(selectedDate);
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

      const containersData = await containersResponse.json();

      // Carica da timeline.json con gestione errori robusta
      let timelineAssignmentsData = {
        assignments: [],
        metadata: { date: dateStr },
        cleaners_assignments: []
      };

      if (timelineResponse.ok) {
        try {
          const timelineText = await timelineResponse.text();

          // CRITICAL: Verifica che sia JSON valido
          if (!timelineText.trim().startsWith('{') && !timelineText.trim().startsWith('[')) {
            console.error("❌ timeline.json contiene HTML/testo non valido - file non pronto");
            console.log("🔄 Attesa aggiuntiva per sincronizzazione file...");

            // Attendi un po' di più e riprova
            await new Promise(resolve => setTimeout(resolve, 500));

            const retryResponse = await fetch(`/data/output/timeline.json?t=${Date.now() + Math.random()}`, {
              cache: 'no-store',
              headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
            });

            if (retryResponse.ok) {
              const retryText = await retryResponse.text();
              if (retryText.trim().startsWith('{')) {
                timelineAssignmentsData = JSON.parse(retryText);
                console.log("✅ Timeline caricata dopo retry:", {
                  cleaners: timelineAssignmentsData.cleaners_assignments?.length || 0,
                  date: timelineAssignmentsData.metadata?.date
                });
              } else {
                console.warn("⚠️ Retry fallito, usa timeline vuota");
              }
            }
          } else {
            timelineAssignmentsData = JSON.parse(timelineText);
            console.log("✅ Caricato da timeline.json:", {
              cleaners: timelineAssignmentsData.cleaners_assignments?.length || 0,
              date: timelineAssignmentsData.metadata?.date
            });
          }
        } catch (parseError) {
          console.error("❌ Errore parsing timeline.json:", parseError);
          console.log("ℹ️ Uso timeline vuota per questa data");
        }
      } else {
        console.warn("⚠️ timeline.json non trovato (HTTP", timelineResponse.status, "), uso timeline vuota");
      }

      console.log("Containers data:", containersData);
      console.log("Timeline assignments data:", timelineAssignmentsData);

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

      // Crea una mappa di task_id -> assegnazione timeline completa
      // Nuova struttura: cleaners_assignments è un array di {cleaner, tasks}
      const timelineAssignmentsMap = new Map<string, any>();

      if (timelineAssignmentsData.cleaners_assignments) {
        // Nuova struttura organizzata per cleaner
        console.log('📋 Caricamento da cleaners_assignments:', timelineAssignmentsData.cleaners_assignments.length, 'cleaners');
        for (const cleanerEntry of timelineAssignmentsData.cleaners_assignments) {
          // Verifica che cleanerEntry.cleaner esista
          if (!cleanerEntry.cleaner) {
            console.warn('⚠️ Trovata entry senza cleaner, salto:', cleanerEntry);
            continue;
          }

          console.log(`   Cleaner ${cleanerEntry.cleaner.id} (${cleanerEntry.cleaner.name}) ha ${cleanerEntry.tasks?.length || 0} task`);
          for (const task of cleanerEntry.tasks || []) {
            const taskId = String(task.task_id);
            const taskLC = String(task.logistic_code);
            console.log(`      → Task ${taskLC} (ID: ${taskId}) assegnata a cleaner ${cleanerEntry.cleaner.id}`);
            timelineAssignmentsMap.set(taskId, {
              ...task,
              cleanerId: cleanerEntry.cleaner.id,
              sequence: task.sequence
            });
          }
        }
      } else if (timelineAssignmentsData.assignments) {
        // Vecchia struttura piatta (fallback)
        console.log('📋 Caricamento da assignments (vecchia struttura):', timelineAssignmentsData.assignments.length);
        for (const a of timelineAssignmentsData.assignments) {
          timelineAssignmentsMap.set(String(a.task_id), a);
        }
      }

      console.log("✅ Task assegnate nella timeline (task_id):", Array.from(timelineAssignmentsMap.keys()));

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
    await loadTasks(true); // Skip extraction, just reload from files
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
      const selectedCleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`);
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
        toast({
          title: "Early Out Assegnati!",
          description: result.message,
          duration: 3000,
        });

        // Ricarica i task per mostrare le assegnazioni nella timeline
        await loadTasks(true);
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
      const selectedCleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`);
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
      const selectedCleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`);
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

  const saveTimelineAssignment = async (taskId: string, cleanerId: number, logisticCode?: string, dropIndex?: number) => {
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

      const response = await fetch('/api/save-timeline-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId, // Chiave univoca
          cleanerId,
          logisticCode, // Attributo non univoco
          date: dateStr,
          dropIndex,
          priority,
          taskData: task
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
          await loadTasks(true);
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

    try {
      // 🔹 Ramo TIMELINE (drag tra cleaners o riordino nello stesso cleaner)
      const fromCleanerId = parseCleanerId(source.droppableId);
      const toCleanerId = parseCleanerId(destination.droppableId);

      // ✅ NUOVO CASO: da container (early/high/low) → timeline di un cleaner
      const fromContainer = parseContainerKey(source.droppableId);
      const toContainer = parseContainerKey(destination.droppableId);

      if (!fromCleanerId && fromContainer && toCleanerId !== null && !toContainer) {
        console.log(`🔄 Spostamento da container ${fromContainer} a cleaner ${toCleanerId}`);

        try {
          // Carica i dati del cleaner per mostrare nome e cognome
          const cleanersResponse = await fetch('/data/cleaners/selected_cleaners.json');
          const cleanersData = await cleanersResponse.json();
          const cleaner = cleanersData.cleaners.find((c: any) => c.id === toCleanerId);
          const cleanerName = cleaner ? `${cleaner.name} ${cleaner.lastname}` : `ID ${toCleanerId}`;

          // Salva in timeline.json (rimuove automaticamente da containers.json)
          await saveTimelineAssignment(taskId, toCleanerId, logisticCode, destination.index);
          await loadTasks(true);

          toast({
            title: "Task assegnata",
            description: `Task ${logisticCode} assegnata a ${cleanerName}`,
            variant: "success",
          });
        } catch (err) {
          console.error("Errore nel salvataggio in timeline:", err);
          toast({
            title: "Errore",
            description: "Impossibile assegnare la task alla timeline.",
            variant: "destructive",
          });
        }
        return;
      }

      if (fromCleanerId !== null && toCleanerId !== null) {
        console.log(`🔄 Timeline move: task ${logisticCode} da cleaner ${fromCleanerId} (idx ${source.index}) a cleaner ${toCleanerId} (idx ${destination.index})`);

        try {
          // Carica i dati dei cleaner per mostrare nome e cognome
          const cleanersResponse = await fetch('/data/cleaners/selected_cleaners.json');
          const cleanersData = await cleanersResponse.json();
          const fromCleaner = cleanersData.cleaners.find((c: any) => c.id === fromCleanerId);
          const toCleaner = cleanersData.cleaners.find((c: any) => c.id === toCleanerId);
          const fromCleanerName = fromCleaner ? `${fromCleaner.name} ${fromCleaner.lastname}` : `ID ${fromCleanerId}`;
          const toCleanerName = toCleaner ? `${toCleaner.name} ${toCleaner.lastname}` : `ID ${toCleanerId}`;

          const payload = {
            taskId: draggableId,
            logisticCode,
            fromCleanerId,
            toCleanerId,
            sourceIndex: source.index,
            destIndex: destination.index,
          };

          console.log('Payload inviato:', payload);

          const response = await fetch('/api/timeline/move-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          const data = await response.json();
          console.log('Risposta server:', data);

          if (!response.ok || !data?.success) {
            console.error('Errore timeline/move-task:', data);
            toast({
              title: "Errore",
              description: data.message || "Impossibile spostare la task",
              variant: "destructive"
            });
            // Ricarica per sincronizzare solo in caso di errore
            await loadTasks(true);
          } else {
            console.log('✅ Movimento salvato automaticamente in timeline.json');

            // CRITICAL FIX: NON ricaricare da Object Storage dopo ogni movimento
            // Il file locale timeline.json è già aggiornato dal backend
            // Ricarichiamo SOLO dal file locale, senza sovrascrivere con il file salvato
            const timestamp = Date.now() + Math.random();
            const timelineResponse = await fetch(`/data/output/timeline.json?t=${timestamp}`, {
              cache: 'no-store',
              headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
            });

            if (timelineResponse.ok) {
              const timelineData = await timelineResponse.json();

              // Ricostruisci allTasksWithAssignments dalla timeline aggiornata
              const tasksWithAssignments: Task[] = [];
              const addedIds = new Set<string>();

              // Task non assegnate dai containers (già in stato)
              for (const task of [...earlyOutTasks, ...highPriorityTasks, ...lowPriorityTasks]) {
                const tid = String(task.id);
                if (!addedIds.has(tid)) {
                  tasksWithAssignments.push(task);
                  addedIds.add(tid);
                }
              }

              // Task assegnate dalla timeline
              for (const cleanerEntry of timelineData.cleaners_assignments || []) {
                for (const task of cleanerEntry.tasks || []) {
                  const taskWithAssignment = {
                    ...task,
                    id: String(task.task_id),
                    name: String(task.logistic_code),
                    type: task.customer_name || 'Unknown',
                    duration: formatDuration(task.cleaning_time || 0),
                    priority: task.priority || 'unknown',
                    assignedCleaner: cleanerEntry.cleaner.id,
                    sequence: task.sequence,
                    start_time: task.start_time,
                    end_time: task.end_time,
                    startTime: task.start_time,
                    endTime: task.end_time,
                    travelTime: task.travel_time || 0,
                    assignedTo: null,
                    status: "pending",
                    scheduledTime: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                  };

                  const tid = String(task.task_id);
                  if (!addedIds.has(tid)) {
                    tasksWithAssignments.push(taskWithAssignment as any);
                    addedIds.add(tid);
                  }
                }
              }

              setAllTasksWithAssignments(tasksWithAssignments);
            }

            // Mostra toast solo se i cleaner sono diversi
            if (fromCleanerId !== toCleanerId) {
              toast({
                title: "Task spostata",
                description: `Task ${logisticCode} spostata da ${fromCleanerName} a ${toCleanerName}`,
                variant: "success",
              });
            }
          }
        } catch (error) {
          console.error('Errore nella chiamata API:', error);
          toast({
            title: "Errore di rete",
            description: "Impossibile spostare la task. Verifica la connessione.",
            variant: "destructive"
          });
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

          // Ricarica i task dai containers aggiornati
          await loadTasks(true);

          toast({
            title: "Task spostata",
            description: `Task spostata tra containers`,
          });
        } catch (err) {
          console.error('update-task-json fetch failed', err);
          toast({
            title: "Errore",
            description: "Errore di rete nello spostamento",
            variant: "destructive"
          });
        }
        return;
      }

      // Caso: Da container a timeline
      if (fromContainerJson && toCleanerId !== null) {
        console.log(`🔄 Spostamento da container ${fromContainerJson} a cleaner ${toCleanerId}`);

        try {
          // Carica i dati del cleaner per mostrare nome e cognome
          const cleanersResponse = await fetch('/data/cleaners/selected_cleaners.json');
          const cleanersData = await cleanersResponse.json();
          const cleaner = cleanersData.cleaners.find((c: any) => c.id === toCleanerId);
          const cleanerName = cleaner ? `${cleaner.name} ${cleaner.lastname}` : `ID ${toCleanerId}`;

          // Salva in timeline.json (rimuove automaticamente da containers.json)
          await saveTimelineAssignment(taskId, toCleanerId, logisticCode, destination.index);

          // CRITICAL FIX: Ricarica SOLO i file locali, non da Object Storage
          await new Promise(resolve => setTimeout(resolve, 100));

          const timestamp = Date.now() + Math.random();
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

          if (containersResponse.ok && timelineResponse.ok) {
            const [containersData, timelineData] = await Promise.all([
              containersResponse.json(),
              timelineResponse.json()
            ]);

            // Aggiorna containers
            setEarlyOutTasks((containersData.containers?.early_out?.tasks || []).map((t: any) => convertRawTask(t, "early_out")));
            setHighPriorityTasks((containersData.containers?.high_priority?.tasks || []).map((t: any) => convertRawTask(t, "high_priority")));
            setLowPriorityTasks((containersData.containers?.low_priority?.tasks || []).map((t: any) => convertRawTask(t, "low_priority")));

            // Ricostruisci allTasksWithAssignments
            const tasksWithAssignments: Task[] = [];
            const addedIds = new Set<string>();

            for (const task of [...earlyOutTasks, ...highPriorityTasks, ...lowPriorityTasks]) {
              const tid = String(task.id);
              if (!addedIds.has(tid)) {
                tasksWithAssignments.push(task);
                addedIds.add(tid);
              }
            }

            for (const cleanerEntry of timelineData.cleaners_assignments || []) {
              for (const task of cleanerEntry.tasks || []) {
                const taskWithAssignment = {
                  ...task,
                  id: String(task.task_id),
                  name: String(task.logistic_code),
                  type: task.customer_name || 'Unknown',
                  duration: formatDuration(task.cleaning_time || 0),
                  priority: task.priority || 'unknown',
                  assignedCleaner: cleanerEntry.cleaner.id,
                  sequence: task.sequence,
                  start_time: task.start_time,
                  end_time: task.end_time,
                  startTime: task.start_time,
                  endTime: task.end_time,
                  travelTime: task.travel_time || 0,
                  assignedTo: null,
                  status: "pending",
                  scheduledTime: null,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString()
                };

                const tid = String(task.task_id);
                if (!addedIds.has(tid)) {
                  tasksWithAssignments.push(taskWithAssignment as any);
                  addedIds.add(tid);
                }
              }
            }

            setAllTasksWithAssignments(tasksWithAssignments);
          }

          toast({
            title: "Task assegnata",
            description: `Task ${logisticCode} assegnata a ${cleanerName}`,
            variant: "success",
          });
        } catch (err) {
          console.error("Errore nell'assegnazione:", err);
        }
        return;
      }

      // Caso: Da timeline a container
      if (fromCleanerId !== null && toContainerJson) {
        console.log(`🔄 Spostamento da cleaner ${fromCleanerId} a container ${toContainerJson}`);

        // Rimuovi da timeline.json
        await removeTimelineAssignment(taskId, logisticCode);
        await loadTasks(true);
        return;
      }

    } catch (error) {
      console.error('Errore nello spostamento:', error);
      // NON ricaricare - mostra solo errore
      toast({
        title: "Errore",
        description: "Errore nello spostamento della task",
        variant: "destructive",
      });
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


  // Mostra loader durante l'estrazione
  if (isExtracting || isLoadingTasks) {
    return (
      <div className="bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary"></div>
          </div>
          <h2 className="text-2xl font-bold text-foreground">
            {isExtracting ? "Estrazione Dati in Corso" : "Caricamento Task"}
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
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
              GENERA ASSEGNAZIONI
              <span className="text-2xl font-normal text-muted-foreground ml-4">
                del {format(selectedDate, "dd/MM/yyyy", { locale: it })}
              </span>
            </h1>
            <Button
              onClick={() => loadTasks(true)}
              variant="outline"
              size="icon"
              className="rounded-full h-10 w-10"
              title="Ricarica dati"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex items-center gap-3">
            {/* Date Selector + Dark Mode Toggle */}
            <div className="flex items-center gap-3">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "w-[240px] justify-start text-left font-normal",
                      !selectedDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "PPP", { locale: it }) : <span>Seleziona data</span>}
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
              <ThemeToggle />
            </div>
          </div>
        </div>

        <DragDropContext onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6 w-full">
            <PriorityColumn
              title="EARLY OUT"
              priority="early-out"
              tasks={earlyOutTasks}
              droppableId="early-out"
              icon="clock"
              assignAction={assignEarlyOutToTimeline}
            />
            <PriorityColumn
              title="HIGH PRIORITY"
              priority="high"
              tasks={highPriorityTasks}
              droppableId="high"
              icon="alert-circle"
              assignAction={assignHighPriorityToTimeline}
            />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={lowPriorityTasks}
              droppableId="low"
              icon="arrow-down"
              assignAction={assignLowPriorityToTimeline}
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
                  onTaskMoved={() => setHasUnsavedChanges(true)}
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
                      className="w-5 h-5 mr-2 text-primary"
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
                  <div className="bg-blue-50 dark:bg-blue-950/20 rounded-lg p-3 border border-blue-200 dark:border-blue-800">
                    <div className="text-xs text-blue-600 dark:text-blue-400 font-medium mb-1">Totale</div>
                    <div className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                      {allTasksWithAssignments.length}
                    </div>
                  </div>

                  {/* Premium */}
                  <div className="bg-yellow-50 dark:bg-yellow-950/20 rounded-lg p-3 border border-yellow-200 dark:border-yellow-800">
                    <div className="text-xs text-yellow-600 dark:text-yellow-400 font-medium mb-1">Premium</div>
                    <div className="text-2xl font-bold text-yellow-700 dark:text-yellow-300">
                      {allTasksWithAssignments.filter(t => t.premium).length}
                    </div>
                  </div>

                  {/* Standard */}
                  <div className="bg-green-50 dark:bg-green-950/20 rounded-lg p-3 border border-green-200 dark:border-green-800">
                    <div className="text-xs text-green-600 dark:text-green-400 font-medium mb-1">Standard</div>
                    <div className="text-2xl font-bold text-green-700 dark:text-green-300">
                      {allTasksWithAssignments.filter(t => !t.premium && !t.straordinaria).length}
                    </div>
                  </div>

                  {/* Straordinarie */}
                  <div className="bg-red-50 dark:bg-red-950/20 rounded-lg p-3 border border-red-200 dark:border-red-800">
                    <div className="text-xs text-red-600 dark:text-red-400 font-medium mb-1">Straordinarie</div>
                    <div className="text-2xl font-bold text-red-700 dark:text-red-300">
                      {allTasksWithAssignments.filter(t => t.straordinaria).length}
                    </div>
                  </div>

                  {/* Non Assegnate */}
                  <div className="bg-gray-50 dark:bg-gray-950/20 rounded-lg p-3 border border-gray-200 dark:border-gray-800 col-span-2 text-center">
                    <div className="text-xs text-gray-600 dark:text-gray-400 font-medium mb-1">Non Assegnate</div>
                    <div className="text-2xl font-bold text-gray-700 dark:text-gray-300">
                      {earlyOutTasks.length + highPriorityTasks.length + lowPriorityTasks.length}
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