import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import MapSection from "@/components/map/map-section";
import { useState, useEffect } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { CalendarIcon, Users } from "lucide-react";
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

export default function GenerateAssignments() {
  // Leggi la data da localStorage se disponibile, altrimenti usa oggi
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const savedDate = localStorage.getItem('selected_work_date');
    if (savedDate) {
      const saved = new Date(savedDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Se la data salvata è nel passato, usa oggi
      if (saved < today) {
        return new Date();
      }
      return saved;
    }
    return new Date();
  });

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

  // Stati di caricamento
  const [isExtracting, setIsExtracting] = useState(true);
  const [extractionStep, setExtractionStep] = useState<string>("Inizializzazione...");
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Funzione per estrarre i dati dal backend
  const extractData = async (date: Date) => {
    try {
      setIsExtracting(true);
      setExtractionStep("Estrazione dati dal database...");

      // Format date in local timezone to avoid UTC shift
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      console.log("Estraendo task per la data:", dateStr);

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

      setExtractionStep("Elaborazione task completata!");
      setIsExtracting(false);

      // Carica i task dopo l'estrazione
      loadTasks();
    } catch (error) {
      console.error("Errore nell'estrazione:", error);
      setExtractionStep("Errore durante l'estrazione. Caricamento task esistenti...");
      setIsExtracting(false);
      // Prova comunque a caricare i task esistenti
      loadTasks();
    }
  };

  useEffect(() => {
    extractData(selectedDate);
  }, [selectedDate]); // Aggiungi selectedDate come dipendenza



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

      // Carica da timeline.json
      let timelineAssignmentsData = { assignments: [], current_date: dateStr };

      if (timelineResponse.ok) {
        timelineAssignmentsData = await timelineResponse.json();
        console.log("Caricato da timeline.json");
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

      // Debug: mostra alcune task assegnate
      const assignedTasks = dedupedTasks.filter(t => (t as any).assignedCleaner);
      if (assignedTasks.length > 0) {
        console.log(`📌 Esempio task assegnate (prime 3):`, assignedTasks.slice(0, 3).map(t => ({
          id: t.id,
          name: t.name,
          assignedCleaner: (t as any).assignedCleaner,
          sequence: (t as any).sequence,
          start_time: (t as any).start_time
        })));
      }

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

      console.log(`📅 Assegnazione EO per data: ${dateStr}`);
      console.log(`📅 selectedDate oggetto:`, selectedDate);

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

      console.log(`📅 Assegnazione HP per data: ${dateStr}`);
      console.log(`📅 selectedDate oggetto:`, selectedDate);

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

      console.log(`📅 Assegnazione LP per data: ${dateStr}`);
      console.log(`📅 selectedDate oggetto:`, selectedDate);

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
      } else {
        console.log('Assegnazione rimossa dalla timeline con successo');
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
          // Salva in timeline.json (rimuove automaticamente da containers.json)
          await saveTimelineAssignment(taskId, toCleanerId, logisticCode, destination.index);
          await loadTasks(true);

          toast({
            title: "Task assegnata",
            description: `Task ${logisticCode} assegnata al cleaner`,
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
            // Ricarica per sincronizzare
            await loadTasks(true);
          } else {
            // Ricarica i dati dopo lo spostamento
            await loadTasks(true);
            console.log('Timeline aggiornata con successo');
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

        // Salva in timeline.json (rimuove automaticamente da containers.json)
        await saveTimelineAssignment(taskId, toCleanerId, logisticCode, destination.index);
        await loadTasks(true);
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
      console.error('❌ Errore durante lo spostamento:', error);
      // In caso di errore, ricarica comunque per ripristinare lo stato corretto
      await loadTasks(true);
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
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            GENERA ASSEGNAZIONI
            <span className="text-2xl font-normal text-muted-foreground ml-4">
              del {format(selectedDate, "dd/MM/yyyy", { locale: it })}
            </span>
          </h1>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => setLocation('/convocazioni')}
              variant="outline"
              className="flex items-center gap-2"
            >
              <Users className="w-4 h-4" />
              Convocazioni
            </Button>
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
              <TimelineView
                personnel={[]}
                tasks={allTasksWithAssignments}
              />
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