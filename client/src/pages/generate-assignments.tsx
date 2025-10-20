import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import { useState, useEffect } from "react";
import { ThemeToggle } from "@/components/theme-toggle";
import { MapPin, CalendarIcon } from "lucide-react";
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
      return new Date(savedDate);
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

  useEffect(() => {
    // Esegui l'estrazione dei dati all'avvio e quando cambia la data
    const extractData = async () => {
      try {
        // Controlla se stiamo tornando dalla pagina convocazioni con preserveAssignments
        const preserveAssignments = sessionStorage.getItem('preserveAssignments');
        if (preserveAssignments === 'true') {
          console.log("Preservo le assegnazioni esistenti, salto l'estrazione");
          sessionStorage.removeItem('preserveAssignments');
          setIsExtracting(false);
          loadTasks();
          return;
        }

        setIsExtracting(true);
        setExtractionStep("Estrazione dati dal database...");

        const dateStr = format(selectedDate, "yyyy-MM-dd");
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

    extractData();
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

  // Carica i task dai file JSON
  const loadTasks = async () => {
    try {
      setIsLoadingTasks(true);
      setExtractionStep("Caricamento task nei contenitori...");

      const [earlyOutResponse, highPriorityResponse, lowPriorityResponse, timelineAssignmentsResponse] = await Promise.all([
        fetch('/data/output/early_out.json'),
        fetch('/data/output/high_priority.json'),
        fetch('/data/output/low_priority.json'),
        fetch('/data/output/timeline_assignments.json')
      ]);

      if (!earlyOutResponse.ok || !highPriorityResponse.ok || !lowPriorityResponse.ok) {
        throw new Error('Errore nel caricamento dei file JSON');
      }

      const earlyOutData = await earlyOutResponse.json();
      const highPriorityData = await highPriorityResponse.json();
      const lowPriorityData = await lowPriorityResponse.json();
      const timelineAssignmentsData = timelineAssignmentsResponse.ok ? await timelineAssignmentsResponse.json() : { assignments: [] };

      console.log("Early out data:", earlyOutData);
      console.log("High priority data:", highPriorityData);
      console.log("Low priority data:", lowPriorityData);
      console.log("Timeline assignments data:", timelineAssignmentsData);

      const initialEarlyOut: Task[] = (earlyOutData.early_out_tasks || []).map((task: RawTask) =>
        convertRawTask(task, "early-out")
      );

      const initialHigh: Task[] = (highPriorityData.high_priority_tasks || []).map((task: RawTask) =>
        convertRawTask(task, "high")
      );

      const initialLow: Task[] = (lowPriorityData.low_priority_tasks || []).map((task: RawTask) =>
        convertRawTask(task, "low")
      );

      console.log("Tasks convertiti - Early:", initialEarlyOut.length, "High:", initialHigh.length, "Low:", initialLow.length);

      // Crea una mappa di logistic_code -> assegnazione timeline
      const timelineAssignmentsMap = new Map<string, { cleanerId: number; sequence: number; logistic_code: string }>(
        timelineAssignmentsData.assignments.map((a: any) => [String(a.logistic_code), { cleanerId: a.cleanerId, sequence: a.sequence, logistic_code: a.logistic_code }])
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
          return {
            ...task,
            assignedCleaner: timelineAssignment.cleanerId,
            sequence: timelineAssignment.sequence,
          };
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
              };
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

  const loadHighPriorityAssignments = async () => {
    try {
      const hpResponse = await fetch('/data/output/high_priority_assignments.json');

      // Carica solo High Priority assignments
      let hpCleanersWithTasks: any[] = [];
      if (hpResponse.ok) {
        const hpAssignmentsData = await hpResponse.json();
        hpCleanersWithTasks = hpAssignmentsData.high_priority_tasks_assigned || [];
        console.log('Assegnazioni high-priority caricate:', hpCleanersWithTasks);
      }

      // Crea un Set di task_id assegnate e aggiorna timeline_assignments.json
      const assignedTaskIds = new Set();
      const timelineAssignments: any[] = [];
      
      hpCleanersWithTasks.forEach((cleanerEntry: any) => {
        cleanerEntry.tasks?.forEach((task: any) => {
          assignedTaskIds.add(String(task.task_id));
          // Aggiungi alla timeline
          timelineAssignments.push({
            logistic_code: String(task.logistic_code),
            cleanerId: cleanerEntry.cleaner.id,
            assignment_type: "high_priority",
            sequence: task.sequence || 0
          });
        });
      });

      // Salva le assegnazioni HP in timeline_assignments.json
      if (timelineAssignments.length > 0) {
        console.log(`Salvando ${timelineAssignments.length} assegnazioni HP in timeline_assignments.json:`, timelineAssignments);
        const saveResponse = await fetch('/api/save-hp-timeline-assignments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assignments: timelineAssignments })
        });
        
        if (!saveResponse.ok) {
          console.error('Errore nel salvataggio delle assegnazioni HP in timeline_assignments.json');
        } else {
          const saveResult = await saveResponse.json();
          console.log('Assegnazioni HP salvate con successo:', saveResult);
        }
      } else {
        console.warn('Nessuna assegnazione HP da salvare in timeline_assignments.json');
      }

      // Aggiorna le task con le assegnazioni HP
      setAllTasksWithAssignments(prevTasks => {
        const updatedTasks = prevTasks.map(task => {
          // Trova il cleaner e la task specifica
          for (const cleanerEntry of hpCleanersWithTasks) {
            const assignedTask = cleanerEntry.tasks?.find((t: any) => String(t.task_id) === task.id);
            if (assignedTask) {
              return {
                ...task,
                assignedCleaner: cleanerEntry.cleaner.id,
                startTime: assignedTask.start_time,
                sequence: assignedTask.sequence
              };
            }
          }
          return task;
        });
        return updatedTasks;
      });

      // Aggiorna i contenitori per rimuovere le task HP assegnate
      setHighPriorityTasks(prevTasks => prevTasks.filter(task => !assignedTaskIds.has(task.id)));
    } catch (error) {
      console.error('Errore nel caricamento delle assegnazioni HP:', error);
    }
  };

  // Esponi le funzioni per poterle chiamare da altri componenti
  (window as any).reloadEarlyOutAssignments = loadEarlyOutAssignments;
  (window as any).reloadHighPriorityAssignments = loadHighPriorityAssignments;
  (window as any).reloadAllTasks = loadTasks;

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

  const saveTimelineAssignment = async (taskId: string, cleanerId: number, logisticCode?: string) => {
    try {
      const response = await fetch('/api/save-timeline-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, cleanerId, logisticCode }),
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

  const removeTimelineAssignment = async (taskId: string, logisticCode?: string) => {
    try {
      const response = await fetch('/api/remove-timeline-assignment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, logisticCode }),
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

    // Se sto muovendo verso una timeline di un cleaner
    if (destination.droppableId.startsWith('timeline-')) {
      const cleanerId = parseInt(destination.droppableId.replace('timeline-', ''));

      // PRIMA rimuovi la task dal container di origine
      if (source.droppableId === 'early-out') {
        setEarlyOutTasks(prev => prev.filter(t => t.id !== taskId));
      } else if (source.droppableId === 'high') {
        setHighPriorityTasks(prev => prev.filter(t => t.id !== taskId));
      } else if (source.droppableId === 'low') {
        setLowPriorityTasks(prev => prev.filter(t => t.id !== taskId));
      }

      // POI aggiorna lo stato con l'assegnazione
      setAllTasksWithAssignments((prevTasks) => {
        const updatedTasks = prevTasks.map((task) => {
          if (task.id === taskId) {
            return {
              ...task,
              assignedCleaner: cleanerId,
            };
          }
          return task;
        });

        saveTaskAssignments(updatedTasks);
        return updatedTasks;
      });

      // Salva l'assegnazione nella timeline
      saveTimelineAssignment(taskId, cleanerId, logisticCode);

      // Aggiorna i JSON: rimuovi dal container di origine
      if (fromContainer) {
        updateTaskJson(taskId, logisticCode, fromContainer, toContainer);
      }
    }
    // Se sto muovendo da una timeline verso una colonna di priorità
    else if (source.droppableId.startsWith('timeline-')) {
      // Prima rimuovi l'assegnazione dalla timeline
      removeTimelineAssignment(taskId, logisticCode);

      setAllTasksWithAssignments((prevTasks) => {
        const updatedTasks = prevTasks.map((task) => {
          if (task.id === taskId) {
            return {
              ...task,
              assignedCleaner: undefined,
              startTime: undefined,
              sequence: undefined,
            };
          }
          return task;
        });

        saveTaskAssignments(updatedTasks);
        return updatedTasks;
      });

      // Ri-aggiungi la task al container di destinazione
      const taskToAdd = allTasksWithAssignments.find(t => t.id === taskId);
      if (taskToAdd) {
        // Rimuovi i dati di assegnazione dalla task
        const cleanTask = {
          ...taskToAdd,
          assignedCleaner: undefined,
          startTime: undefined,
          sequence: undefined,
        };

        if (destination.droppableId === 'early-out') {
          setEarlyOutTasks(prev => [...prev, cleanTask]);
        } else if (destination.droppableId === 'high') {
          setHighPriorityTasks(prev => [...prev, cleanTask]);
        } else if (destination.droppableId === 'low') {
          setLowPriorityTasks(prev => [...prev, cleanTask]);
        }

        // Aggiorna i JSON: aggiungi al container di destinazione
        if (toContainer) {
          updateTaskJson(taskId, logisticCode, 'timeline', toContainer);
        }
      }
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

            <div className="bg-card rounded-lg border shadow-sm">
              <div className="p-4 border-b border-border">
                <h3 className="font-semibold text-foreground flex items-center justify-between">
                  <span className="flex items-center">
                    <MapPin className="w-5 h-5 mr-2 text-primary" />
                    Mappa Assegnazioni
                  </span>
                  <button
                    onClick={() => {
                      const iframe = document.getElementById('map-iframe') as HTMLIFrameElement;
                      if (iframe.requestFullscreen) {
                        iframe.requestFullscreen();
                      }
                    }}
                    className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                  >
                    Schermo intero
                  </button>
                </h3>
              </div>
              <div className="p-4">
                <iframe
                  id="map-iframe"
                  width="100%"
                  height="400"
                  style={{ border: 0 }}
                  loading="lazy"
                  allowFullScreen
                  referrerPolicy="no-referrer-when-downgrade"
                  src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d89506.83160109393!2d9.14000405!3d45.4642035!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x4786c1493f1275e7%3A0x3cffcd13c6740e8d!2sMilano%20MI!5e1!3m2!1sit!2sit!4v1234567890&gestureHandling=greedy&disableDefaultUI=true&zoomControl=true"
                ></iframe>
              </div>
            </div>
          </div>
        </DragDropContext>
      </div>
    </div>
  );
}