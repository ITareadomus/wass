import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import MapSection from "@/components/map/map-section";
import { useState, useEffect } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { CalendarIcon } from "lucide-react";
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
  is_straordinaria?: boolean;
  zone: number;
  reasons?: string[];
  alias?: string;
  confirmed_operation?: boolean;
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

  // Carica le assegnazioni quando i task sono pronti
  useEffect(() => {
    if (!isLoadingTasks && earlyOutTasks.length === 0 && highPriorityTasks.length > 0) {
      // Se non ci sono early-out tasks ma ci sono high priority, probabilmente sono già state assegnate
      loadEarlyOutAssignments();
    }
  }, [isLoadingTasks, earlyOutTasks.length, highPriorityTasks.length]);

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
      is_straordinaria: (rawTask as any).straordinaria || rawTask.is_straordinaria,
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

      console.log(`🔄 Caricamento task dai file JSON (timestamp: ${timestamp})...`);

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

      // Crea una mappa di logistic_code -> assegnazione timeline completa
      // Nuova struttura: cleaners_assignments è un array di {cleaner, tasks}
      const timelineAssignmentsMap = new Map<string, any>();

      if (timelineAssignmentsData.cleaners_assignments) {
        // Nuova struttura organizzata per cleaner
        console.log('📋 Caricamento da cleaners_assignments:', timelineAssignmentsData.cleaners_assignments.length, 'cleaners');
        for (const cleanerEntry of timelineAssignmentsData.cleaners_assignments) {
          console.log(`   Cleaner ${cleanerEntry.cleaner.id} (${cleanerEntry.cleaner.name}) ha ${cleanerEntry.tasks?.length || 0} task`);
          for (const task of cleanerEntry.tasks || []) {
            const logisticCode = String(task.logistic_code);
            console.log(`      → Task ${logisticCode} assegnata a cleaner ${cleanerEntry.cleaner.id}`);
            timelineAssignmentsMap.set(logisticCode, {
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
          timelineAssignmentsMap.set(String(a.logistic_code), a);
        }
      }

      console.log("✅ Task assegnate nella timeline (logistic_code):", Array.from(timelineAssignmentsMap.keys()));

      // Filtra le task già presenti nella timeline dai container
      const filteredEarlyOut = initialEarlyOut.filter(task => {
        const isAssigned = timelineAssignmentsMap.has(String(task.name));
        if (isAssigned) {
          console.log(`Task ${task.name} filtrata da Early Out (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredHigh = initialHigh.filter(task => {
        const isAssigned = timelineAssignmentsMap.has(String(task.name));
        if (isAssigned) {
          console.log(`Task ${task.name} filtrata da High Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredLow = initialLow.filter(task => {
        const isAssigned = timelineAssignmentsMap.has(String(task.name));
        if (isAssigned) {
          console.log(`Task ${task.name} filtrata da Low Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      console.log("Task dopo filtro - Early:", filteredEarlyOut.length, "High:", filteredHigh.length, "Low:", filteredLow.length);

      // AGGIORNA GLI STATI IN MODO SINCRONIZZATO
      setEarlyOutTasks(filteredEarlyOut);
      setHighPriorityTasks(filteredHigh);
      setLowPriorityTasks(filteredLow);

      console.log(`📊 SINCRONIZZAZIONE CONTAINERS:`);
      console.log(`   - Early Out: ${filteredEarlyOut.length} task`);
      console.log(`   - High Priority: ${filteredHigh.length} task`);
      console.log(`   - Low Priority: ${filteredLow.length} task`);

      // Crea l'array unificato SOLO con task dai containers (non assegnate)
      // Le task assegnate vengono aggiunte SOLO se sono effettivamente in timeline.json
      const tasksWithAssignments: Task[] = [];

      // Aggiungi task NON assegnate dai containers
      tasksWithAssignments.push(...filteredEarlyOut, ...filteredHigh, ...filteredLow);

      // Aggiungi SOLO task che sono effettivamente in timeline.json con i loro dati completi
      for (const [logisticCode, timelineAssignment] of timelineAssignmentsMap.entries()) {
        // Trova la task originale dai containers per prendere i dati base
        const originalTask = [...initialEarlyOut, ...initialHigh, ...initialLow].find(
          t => String(t.name) === logisticCode
        );

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
            is_straordinaria: timelineAssignment.is_straordinaria || timelineAssignment.straordinaria,
            confirmed_operation: timelineAssignment.confirmed_operation,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          console.log(`➕ Aggiungendo task ${logisticCode} dalla timeline a cleaner ${timelineAssignment.cleanerId} con sequence ${timelineAssignment.sequence}`);
          
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
            is_straordinaria: timelineAssignment.is_straordinaria !== undefined ? timelineAssignment.is_straordinaria : (timelineAssignment.straordinaria !== undefined ? timelineAssignment.straordinaria : (baseTask as any).is_straordinaria),
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

      console.log(`📊 SINCRONIZZAZIONE TIMELINE:`);
      console.log(`   - Task totali: ${tasksWithAssignments.length}`);
      console.log(`   - Task assegnate: ${tasksWithAssignments.filter(t => (t as any).assignedCleaner).length}`);
      console.log(`   - Task nei containers: ${tasksWithAssignments.filter(t => !(t as any).assignedCleaner).length}`);
      
      // Debug: mostra alcune task assegnate
      const assignedTasks = tasksWithAssignments.filter(t => (t as any).assignedCleaner);
      if (assignedTasks.length > 0) {
        console.log(`📌 Esempio task assegnate (prime 3):`, assignedTasks.slice(0, 3).map(t => ({
          name: t.name,
          assignedCleaner: (t as any).assignedCleaner,
          sequence: (t as any).sequence,
          start_time: (t as any).start_time
        })));
      }

      setAllTasksWithAssignments(tasksWithAssignments);

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

  const loadEarlyOutAssignments = async () => {
    try {
      const eoResponse = await fetch('/data/output/early_out_assignments.json');

      // Carica solo Early Out assignments
      let eoCleanersWithTasks: any[] = [];
      if (eoResponse.ok) {
        const eoAssignmentsData = await eoResponse.json();
        eoCleanersWithTasks = eoAssignmentsData.early_out_tasks_assigned || [];
        console.log('Assegnazioni early-out caricate:', eoCleanersWithTasks);
      }

      // Solo Early Out
      const allCleanersWithTasks = eoCleanersWithTasks;

      // Crea un Set di task_id assegnate
      const assignedTaskIds = new Set();
      allCleanersWithTasks.forEach((cleanerEntry: any) => {
        cleanerEntry.tasks?.forEach((task: any) => {
          assignedTaskIds.add(String(task.task_id));
        });
      });

      // Aggiorna le task con le assegnazioni
      setAllTasksWithAssignments(prevTasks => {
        const updatedTasks = prevTasks.map(task => {
          // Trova il cleaner e la task specifica
          for (const cleanerEntry of allCleanersWithTasks) {
            const assignedTask = cleanerEntry.tasks?.find((t: any) => String(t.task_id) === task.id);
            if (assignedTask) {
              return {
                ...task,
                assignedCleaner: cleanerEntry.cleaner.id,
                startTime: assignedTask.start_time,
                sequence: assignedTask.sequence
              } as any;
            }
          }
          return task;
        });
        return updatedTasks;
      });

      // Aggiorna i contenitori per rimuovere le task assegnate
      setEarlyOutTasks(prevTasks => prevTasks.filter(task => !assignedTaskIds.has(task.id)));
      setHighPriorityTasks(prevTasks => prevTasks.filter(task => !assignedTaskIds.has(task.id)));
    } catch (error) {
      console.error('Errore nel caricamento delle assegnazioni:', error);
    }
  };

  // Funzione per confermare le assegnazioni
  const confirmAssignments = async () => {
    try {
      setIsConfirming(true);
      const dateStr = format(selectedDate, "yyyy-MM-dd");

      const response = await fetch('/api/confirm-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: "Assegnazioni Confermate!",
          description: `${result.total_assignments} assegnazioni salvate in ${result.filename}`,
          duration: 5000,
        });
      } else {
        throw new Error(result.error || 'Errore sconosciuto');
      }
    } catch (error: any) {
      console.error("Errore nella conferma delle assegnazioni:", error);
      toast({
        title: "Errore",
        description: error.message || "Errore durante il salvataggio delle assegnazioni",
        variant: "destructive",
        duration: 5000,
      });
    } finally {
      setIsConfirming(false);
    }
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

      // Trova il task completo dai containers
      const task = allTasksWithAssignments.find(t => t.id === taskId);

      const response = await fetch('/api/save-timeline-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          taskId, 
          cleanerId, 
          logisticCode, 
          date: dateStr, 
          dropIndex,
          taskData: task // Passa tutti i dati del task
        }),
      });
      if (!response.ok) {
        console.error('Errore nel salvataggio dell\'assegnazione nella timeline');
      } else {
        console.log('Assegnazione salvata nella timeline con successo');
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
        console.error('Errore nel reorder della timeline');
      } else {
        console.log('Timeline riordinata con successo');
      }
    } catch (error) {
      console.error('Errore nella chiamata API di reorder timeline:', error);
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

  const onDragEnd = async (result: DropResult) => {
    const { source, destination, draggableId } = result;

    if (!destination) return;

    // Se droppo nella stessa posizione, non fare nulla
    if (
      source.droppableId === destination.droppableId &&
      source.index === destination.index
    ) {
      return;
    }

    const taskId = draggableId;
    const task = allTasksWithAssignments.find(t => t.id === taskId);
    const logisticCode = task?.name;

    // Mappa dei container ID ai nomi dei file JSON
    const containerToJsonName: { [key: string]: string } = {
      'early-out': 'early-out',
      'high': 'high',
      'low': 'low'
    };

    const fromContainer = containerToJsonName[source.droppableId] || null;
    const toContainer = destination.droppableId.startsWith('timeline-')
      ? destination.droppableId
      : containerToJsonName[destination.droppableId] || null;

    try {
      // Caso 1: Reorder intra-timeline (stessa colonna cleaner) O spostamento tra cleaners diversi
      if (source.droppableId.startsWith('timeline-') && destination.droppableId.startsWith('timeline-')) {
        const sourceCleanerId = parseInt(source.droppableId.replace('timeline-', ''));
        const destCleanerId = parseInt(destination.droppableId.replace('timeline-', ''));

        if (sourceCleanerId === destCleanerId) {
          // Reorder nella stessa timeline
          console.log(`🔄 Reorder task ${logisticCode} nella timeline del cleaner ${sourceCleanerId} da posizione ${source.index} a ${destination.index}`);
          await reorderTimelineAssignment(taskId, sourceCleanerId, logisticCode || '', source.index, destination.index);
          
          // Ricarica immediatamente per mostrare il nuovo ordine
          await loadTasks(true);
          return;
        } else {
          // Spostamento tra cleaners diversi
          console.log(`🔄 Spostamento task ${logisticCode} da cleaner ${sourceCleanerId} a cleaner ${destCleanerId}`);
          
          const dateStr = format(selectedDate, "yyyy-MM-dd");
          const response = await fetch('/api/move-task-between-cleaners', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              taskId, 
              logisticCode,
              sourceCleanerId, 
              destCleanerId, 
              destIndex: destination.index,
              date: dateStr 
            }),
          });
          
          if (!response.ok) {
            throw new Error('Errore nello spostamento tra cleaners');
          }
          
          // Ricarica immediatamente per mostrare il nuovo ordine
          await loadTasks(true);
          return;
        }
      }

      // Caso 2: Da timeline a container
      if (source.droppableId.startsWith('timeline-') && 
          (destination.droppableId === 'early-out' || 
           destination.droppableId === 'high' || 
           destination.droppableId === 'low')) {

        console.log(`🔄 Spostamento da timeline a container: ${source.droppableId} -> ${destination.droppableId}`);

        // 1. Rimuovi da timeline.json
        await removeTimelineAssignment(taskId, logisticCode);

        // 2. Aggiorna containers.json
        await updateTaskJson(taskId, logisticCode, 'timeline', destination.droppableId);

        // 3. FORZA ricaricamento completo e sincronizzato
        await loadTasks(true);

        console.log(`✅ Sincronizzazione completata`);
        return;
      }

      // Caso 3: Da container a timeline
      if ((source.droppableId === 'early-out' || source.droppableId === 'high' || source.droppableId === 'low') &&
          destination.droppableId.startsWith('timeline-')) {

        const cleanerId = parseInt(destination.droppableId.split('-')[1]);
        console.log(`🔄 Spostamento da container a timeline: ${source.droppableId} -> cleaner ${cleanerId}`);

        // 1. Salva in timeline.json (questo rimuove automaticamente da containers.json)
        await saveTimelineAssignment(taskId, cleanerId, logisticCode, destination.index);

        // 2. FORZA ricaricamento completo e sincronizzato
        await loadTasks(true);

        console.log(`✅ Sincronizzazione completata`);
        return;
      }

      // Caso 4: Tra containers
      if (fromContainer && toContainer && !destination.droppableId.startsWith('timeline-')) {
        console.log(`🔄 Spostamento tra containers: ${fromContainer} -> ${toContainer}`);

        // 1. Aggiorna containers.json
        await updateTaskJson(taskId, logisticCode, fromContainer, toContainer);

        // 2. FORZA ricaricamento completo e sincronizzato
        await loadTasks(true);

        console.log(`✅ Sincronizzazione completata`);
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

  const allTasks = [...earlyOutTasks, ...highPriorityTasks, ...lowPriorityTasks, ...lopezTasks, ...garciaTasks, ...rossiTasks];

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
            <ThemeToggle />
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
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(date) => date && setSelectedDate(date)}
                  initialFocus
                  locale={it}
                />
              </PopoverContent>
            </Popover>
            <Button
              onClick={confirmAssignments}
              disabled={isConfirming || allTasksWithAssignments.filter(t => (t as any).assignedCleaner).length === 0}
              className="bg-green-600 hover:bg-green-700 text-white"
            >
              {isConfirming ? (
                <>
                  <span className="animate-spin mr-2">⏳</span>
                  Salvando...
                </>
              ) : (
                '✓ Conferma Assegnazioni'
              )}
            </Button>
            <div className="bg-card rounded-lg border shadow-sm px-4 py-2 text-center">
              <div className="text-sm text-muted-foreground">Task Totali</div>
              <div className="text-2xl font-bold text-primary">{allTasks.length}</div>
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

            <MapSection tasks={allTasksWithAssignments} />
          </div>
        </DragDropContext>
      </div>
    </div>
  );
}