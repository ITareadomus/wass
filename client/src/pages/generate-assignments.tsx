import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import { useState, useEffect } from "react";

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
  is_straordinaria: boolean;
  zone: number;
  reasons?: string[];
  alias?: string;
  premium?: boolean;
  is_straordinaria?: boolean;
  confirmed_operation?: boolean;
}

export default function GenerateAssignments() {
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

  useEffect(() => {
    // Esegui l'estrazione dei dati all'avvio
    const extractData = async () => {
      try {
        setIsExtracting(true);
        setExtractionStep("Estrazione dati dal database...");

        const response = await fetch('/api/extract-data', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
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

    extractData();
    loadEarlyOutAssignments();
  }, []);

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
      name: rawTask.logistic_code.toString(),
      alias: rawTask.alias,
      type: rawTask.customer_name || `Client ${rawTask.client_id}`,
      duration: formatDuration(rawTask.cleaning_time),
      priority: priority as any,
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: rawTask.address,
      premium: rawTask.premium,
      is_straordinaria: (rawTask as any).straordinaria || rawTask.is_straordinaria,
      confirmed_operation: rawTask.confirmed_operation,
      checkout_date: rawTask.checkout_date,
      checkout_time: rawTask.checkout_time,
      checkin_date: rawTask.checkin_date,
      checkin_time: rawTask.checkin_time,
      pax_in: rawTask.pax_in,
      pax_out: rawTask.pax_out,
      operation_id: rawTask.operation_id,
      customer_name: rawTask.customer_name,
      type_apt: (rawTask as any).type_apt,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  };

  // Carica i task dai file JSON
  const loadTasks = async () => {
    try {
      setIsLoadingTasks(true);
      setExtractionStep("Caricamento task nei contenitori...");

      const [earlyOutResponse, highPriorityResponse, lowPriorityResponse] = await Promise.all([
        fetch('/data/output/early_out.json'),
        fetch('/data/output/high_priority.json'),
        fetch('/data/output/low_priority.json')
      ]);

      if (!earlyOutResponse.ok || !highPriorityResponse.ok || !lowPriorityResponse.ok) {
        throw new Error('Errore nel caricamento dei file JSON');
      }

      const earlyOutData = await earlyOutResponse.json();
      const highPriorityData = await highPriorityResponse.json();
      const lowPriorityData = await lowPriorityResponse.json();

      const initialEarlyOut: Task[] = earlyOutData.early_out_tasks.map((task: RawTask) =>
        convertRawTask(task, "early-out")
      );

      const initialHigh: Task[] = highPriorityData.high_priority_tasks.map((task: RawTask) =>
        convertRawTask(task, "high")
      );

      const initialLow: Task[] = lowPriorityData.low_priority_tasks.map((task: RawTask) =>
        convertRawTask(task, "low")
      );

      setEarlyOutTasks(initialEarlyOut);
      setHighPriorityTasks(initialHigh);
      setLowPriorityTasks(initialLow);

      // Inizializza anche lo stato unificato
      setAllTasksWithAssignments([...initialEarlyOut, ...initialHigh, ...initialLow]);

      setIsLoadingTasks(false);
      setExtractionStep("Task caricati con successo!");
    } catch (error) {
      console.error("Errore nel caricamento dei task:", error);
      setIsLoadingTasks(false);
      setExtractionStep("Errore nel caricamento dei task");
    }
  };

  const loadEarlyOutAssignments = async () => {
    try {
      const response = await fetch('/data/output/early_out_assignments.json');
      if (!response.ok) {
        console.log('Nessuna assegnazione early-out trovata');
        return;
      }

      const assignmentsData = await response.json();
      const assignments = assignmentsData.early_out_tasks_assigned || [];

      console.log('Assegnazioni early-out caricate:', assignments);

      // Aggiorna le task con le assegnazioni
      setAllTasksWithAssignments(prevTasks => {
        return prevTasks.map(task => {
          const assignment = assignments.find((a: any) => String(a.task_id) === task.id);
          if (assignment && assignment.assigned_cleaner) {
            return {
              ...task,
              assignedCleaner: assignment.assigned_cleaner.id,
              assignedSlot: 0,
              startTime: assignment.assigned_cleaner.start_time
            };
          }
          return task;
        });
      });
    } catch (error) {
      console.error('Errore nel caricamento delle assegnazioni early-out:', error);
    }
  };

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

  const onDragEnd = (result: DropResult) => {
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

    // Se sto muovendo verso una timeline di un cleaner
    if (destination.droppableId.startsWith('timeline-')) {
      const cleanerId = parseInt(destination.droppableId.replace('timeline-', ''));

      setAllTasksWithAssignments((prevTasks) => {
        const updatedTasks = prevTasks.map((task) => {
          if (task.id === taskId) {
            return {
              ...task,
              assignedCleaner: cleanerId,
              assignedSlot: destination.index,
            };
          }
          return task;
        });

        saveTaskAssignments(updatedTasks);
        return updatedTasks;
      });
    }
    // Se sto muovendo da una timeline verso una colonna di priorità
    else {
      setAllTasksWithAssignments((prevTasks) => {
        const updatedTasks = prevTasks.map((task) => {
          if (task.id === taskId) {
            return {
              ...task,
              assignedCleaner: undefined,
              assignedSlot: undefined,
              startTime: undefined,
            };
          }
          return task;
        });

        saveTaskAssignments(updatedTasks);
        return updatedTasks;
      });
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
      <div className="container mx-auto p-4 max-w-screen-2xl">
        <div className="mb-6 flex justify-between items-center">
          <h1 className="text-3xl font-bold text-foreground">
            Genera Assegnazioni
          </h1>
          <div className="bg-card rounded-lg border shadow-sm px-4 py-2 text-center">
            <div className="text-sm text-muted-foreground">Task Totali</div>
            <div className="text-2xl font-bold text-primary">{allTasks.length}</div>
          </div>
        </div>

        <DragDropContext onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
            <PriorityColumn
              title="EARLY OUT"
              priority="early-out"
              tasks={earlyOutTasks.filter(task => !(task as any).assignedCleaner)}
              droppableId="early-out"
              icon="clock"
            />
            <PriorityColumn
              title="HIGH PRIORITY"
              priority="high"
              tasks={highPriorityTasks.filter(task => !(task as any).assignedCleaner)}
              droppableId="high"
              icon="alert-circle"
            />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={lowPriorityTasks.filter(task => !(task as any).assignedCleaner)}
              droppableId="low"
              icon="arrow-down"
            />
          </div>

          <div className="mt-6">
            <TimelineView
              personnel={[]}
              tasks={allTasksWithAssignments}
            />
          </div>
        </DragDropContext>
      </div>
    </div>
  );
}