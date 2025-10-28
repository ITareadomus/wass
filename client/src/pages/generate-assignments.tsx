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
  // Leggi la data da localStorage se disponibile, altrimenti usa domani
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const savedDate = localStorage.getItem('selected_work_date');
    if (savedDate) {
      const saved = new Date(savedDate);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      // Se la data salvata è nel passato, usa domani
      if (saved < today) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow;
      }
      return saved;
    }
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  });

  // Salva la data in localStorage ogni volta che cambia
  useEffect(() => {
    localStorage.setItem('selected_work_date', selectedDate.toISOString());
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
  const extractData = async (dateStr: string) => {
    try {
      setIsExtracting(true);
      setExtractionStep("Estrazione dati dal database...");

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
    const dateStr = format(selectedDate, "yyyy-MM-dd");
    extractData(dateStr);
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

      // Aggiungi timestamp per evitare cache
      const timestamp = Date.now();
      const [containersResponse, generalTimelineResponse, dateTimelineResponse] = await Promise.all([
        fetch(`/data/output/containers.json?t=${timestamp}`),
        fetch(`/data/output/timeline_assignments.json?t=${timestamp}`),
        fetch(`/data/output/timeline_assignments/${dateStr}.json?t=${timestamp}`)
      ]);

      if (!containersResponse.ok) {
        throw new Error('Errore nel caricamento del file containers.json');
      }

      const containersData = await containersResponse.json();

      // Prima prova a caricare da timeline_assignments.json, poi da timeline_assignments/{date}.json
      let timelineAssignmentsData = { assignments: [], current_date: dateStr };
      if (generalTimelineResponse.ok) {
        timelineAssignmentsData = await generalTimelineResponse.json();
        console.log("Caricato da timeline_assignments.json (principale)");
      } else if (dateTimelineResponse.ok) {
        timelineAssignmentsData = await dateTimelineResponse.json();
        console.log(`Caricato da timeline_assignments/${dateStr}.json (fallback)`);
      }

      console.log("Containers data:", containersData);
      console.log("Timeline assignments data:", timelineAssignmentsData);

      // Estrai task dai container
      const initialEarlyOut: Task[] = (containersData.containers?.early_out?.tasks || []).map((task: RawTask) =>
        convertRawTask(task, "early-out")
      );

      const initialHigh: Task[] = (containersData.containers?.high_priority?.tasks || []).map((task: RawTask) =>
        convertRawTask(task, "high")
      );

      const initialLow: Task[] = (containersData.containers?.low_priority?.tasks || []).map((task: RawTask) =>
        convertRawTask(task, "low")
      );

      console.log("Task convertiti - Early:", initialEarlyOut.length, "High:", initialHigh.length, "Low:", initialLow.length);

      // Crea una mappa di logistic_code -> assegnazione timeline completa
      const timelineAssignmentsMap = new Map<string, any>(
        timelineAssignmentsData.assignments.map((a: any) => [String(a.logistic_code), a])
      );

      console.log("Task assegnate nella timeline (logistic_code):", Array.from(timelineAssignmentsMap.keys()));

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

      setEarlyOutTasks(filteredEarlyOut);
      setHighPriorityTasks(filteredHigh);
      setLowPriorityTasks(filteredLow);

      // Crea l'array unificato con TUTTE le task (incluse quelle filtrate) e le loro assegnazioni
      const allTasks = [...initialEarlyOut, ...initialHigh, ...initialLow];
      const tasksWithAssignments = allTasks.map(task => {
        const timelineAssignment = timelineAssignmentsMap.get(String(task.name));
        if (timelineAssignment && timelineAssignment.cleanerId) {
          console.log(`Assegnando task ${task.name} a cleaner ${timelineAssignment.cleanerId} con sequence ${timelineAssignment.sequence}`);
          // Usa i dati dalla timeline se disponibili, altrimenti usa i dati del task originale
          return {
            ...task,
            assignedCleaner: timelineAssignment.cleanerId,
            sequence: timelineAssignment.sequence,
            startTime: timelineAssignment.start_time || task.startTime,
            endTime: timelineAssignment.end_time || task.endTime,
            travelTime: timelineAssignment.travel_time || 0,
            address: timelineAssignment.address || task.address,
            lat: timelineAssignment.lat || task.lat,
            lng: timelineAssignment.lng || task.lng,
          } as any;
        }
        return task;
      });

      console.log(`Task con assegnazioni (${tasksWithAssignments.length} totali):`, tasksWithAssignments.filter(t => (t as any).assignedCleaner).length, "assegnate");
      setAllTasksWithAssignments(tasksWithAssignments);

      setIsLoadingTasks(false);
      setExtractionStep("Task caricati con successo!");
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



  // Esponi le funzioni per poterle chiamare da altri componenti
  (window as any).reloadAllTasks = reloadAllTasks;

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
      const response = await fetch('/api/save-timeline-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, cleanerId, logisticCode, date: dateStr, dropIndex }),
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

    // Caso 1: Reorder intra-timeline (stessa colonna cleaner)
    if (source.droppableId.startsWith('timeline-') && destination.droppableId.startsWith('timeline-')) {
      const sourceCleanerId = parseInt(source.droppableId.replace('timeline-', ''));
      const destCleanerId = parseInt(destination.droppableId.replace('timeline-', ''));

      if (sourceCleanerId === destCleanerId) {
        // Reorder nella stessa timeline
        reorderTimelineAssignment(taskId, sourceCleanerId, logisticCode || '', source.index, destination.index);

        // Aggiorna lo stato locale
        setAllTasksWithAssignments((prevTasks) => {
          const updatedTasks = [...prevTasks];
          const taskToMove = updatedTasks.find(t => t.id === taskId);
          if (taskToMove) {
            (taskToMove as any).sequence = destination.index + 1;
          }
          return updatedTasks;
        });
        return;
      }
    }

    // Se droppo dalla timeline a un container
    if (source.droppableId.startsWith('timeline-') && 
        (destination.droppableId === 'early-out' || 
         destination.droppableId === 'high' || 
         destination.droppableId === 'low')) {

      console.log(`Spostamento da timeline a container: ${source.droppableId} -> ${destination.droppableId}`);

      // Rimuovi dalla timeline
      const updatedTasks = allTasksWithAssignments.map(t => {
        if (t.id === taskId) {
          const updated = { ...t };
          delete (updated as any).assignedCleaner;
          return updated;
        }
        return t;
      });
      setAllTasksWithAssignments(updatedTasks);

      // Rimuovi da timeline_assignments.json
      await removeTimelineAssignment(taskId, logisticCode);

      // Aggiorna il file JSON del container di destinazione
      await updateTaskJson(taskId, logisticCode, 'timeline', destination.droppableId);

      return;
    }
    // Se droppo da un container a una timeline
    if ((source.droppableId === 'early-out' || source.droppableId === 'high' || source.droppableId === 'low') &&
        destination.droppableId.startsWith('timeline-')) {

      const cleanerId = parseInt(destination.droppableId.split('-')[1]);
      console.log(`Spostamento da container a timeline: ${source.droppableId} -> cleaner ${cleanerId}`);

      // Aggiorna lo stato locale
      const updatedTasks = allTasksWithAssignments.map(t => {
        if (t.id === taskId) {
          return { ...t, assignedCleaner: cleanerId } as any;
        }
        return t;
      });
      setAllTasksWithAssignments(updatedTasks);

      // Salva in timeline_assignments.json
      await saveTimelineAssignment(taskId, cleanerId, logisticCode, destination.index);

      // Aggiorna i file JSON dei container
      await updateTaskJson(taskId, logisticCode, source.droppableId, destination.droppableId);

      return;
    }
    // Se sto muovendo tra contenitori di priorità
    else {
      // Rimuovi dal container di origine
      if (source.droppableId === 'early-out') {
        setEarlyOutTasks(prev => prev.filter(t => t.id !== taskId));
      } else if (source.droppableId === 'high') {
        setHighPriorityTasks(prev => prev.filter(t => t.id !== taskId));
      } else if (source.droppableId === 'low') {
        setLowPriorityTasks(prev => prev.filter(t => t.id !== taskId));
      }

      // Aggiungi al container di destinazione
      const taskToAdd = allTasksWithAssignments.find(t => t.id === taskId);
      if (taskToAdd) {
        if (destination.droppableId === 'early-out') {
          setEarlyOutTasks(prev => [...prev, taskToAdd]);
        } else if (destination.droppableId === 'high') {
          setHighPriorityTasks(prev => [...prev, taskToAdd]);
        } else if (destination.droppableId === 'low') {
          setLowPriorityTasks(prev => [...prev, taskToAdd]);
        }

        // Aggiorna i JSON
        if (fromContainer && toContainer) {
          updateTaskJson(taskId, logisticCode, fromContainer, toContainer);
        }
      }
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
            />
            <PriorityColumn
              title="HIGH PRIORITY"
              priority="high"
              tasks={highPriorityTasks}
              droppableId="high"
              icon="alert-circle"
            />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={lowPriorityTasks}
              droppableId="low"
              icon="arrow-down"
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