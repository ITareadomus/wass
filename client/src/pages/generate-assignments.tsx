import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
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
  is_straordinaria?: boolean;
  confirmed_operation?: boolean;
}

export default function GenerateAssignments() {
  // Inizializza con domani (come task_extractor.py)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [selectedDate, setSelectedDate] = useState<Date>(tomorrow);
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
    // NON caricare le assegnazioni all'avvio - verranno caricate solo dopo aver premuto "Smista"
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

      // Crea un Set di logistic_code assegnati nella timeline
      const assignedInTimelineCodes = new Set(
        timelineAssignmentsData.assignments.map((a: any) => String(a.logistic_code))
      );

      console.log("Task assegnate nella timeline (logistic_code):", Array.from(assignedInTimelineCodes));

      // Filtra le task già presenti nella timeline dai container
      const filteredEarlyOut = initialEarlyOut.filter(task => {
        const isAssigned = assignedInTimelineCodes.has(String(task.name));
        if (isAssigned) {
          console.log(`Task ${task.name} filtrata da Early Out (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredHigh = initialHigh.filter(task => {
        const isAssigned = assignedInTimelineCodes.has(String(task.name));
        if (isAssigned) {
          console.log(`Task ${task.name} filtrata da High Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      const filteredLow = initialLow.filter(task => {
        const isAssigned = assignedInTimelineCodes.has(String(task.name));
        if (isAssigned) {
          console.log(`Task ${task.name} filtrata da Low Priority (è nella timeline)`);
        }
        return !isAssigned;
      });

      console.log("Task dopo filtro - Early:", filteredEarlyOut.length, "High:", filteredHigh.length, "Low:", filteredLow.length);

      setEarlyOutTasks(filteredEarlyOut);
      setHighPriorityTasks(filteredHigh);
      setLowPriorityTasks(filteredLow);

      // Crea l'array unificato con le assegnazioni della timeline
      const allTasks = [...initialEarlyOut, ...initialHigh, ...initialLow];
      const tasksWithAssignments = allTasks.map(task => {
        const timelineAssignment = timelineAssignmentsData.assignments.find(
          (a: any) => a.logistic_code === task.name || a.taskId === task.id
        );
        if (timelineAssignment) {
          return {
            ...task,
            assignedCleaner: timelineAssignment.cleanerId,
            sequence: timelineAssignment.sequence,
          };
        }
        return task;
      });

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
        const updatedTasks = prevTasks.map(task => {
          const assignment = assignments.find((a: any) => String(a.task_id) === task.id);
          if (assignment && assignment.assigned_cleaner) {
            return {
              ...task,
              assignedCleaner: assignment.assigned_cleaner.id,
              startTime: assignment.assigned_cleaner.start_time,
              sequence: assignment.sequence
            };
          }
          return task;
        });
        return updatedTasks;
      });

      // Aggiorna anche earlyOutTasks per rimuovere quelle assegnate
      setEarlyOutTasks(prevTasks => {
        return prevTasks.filter(task => {
          const assignment = assignments.find((a: any) => String(a.task_id) === task.id);
          return !assignment || !assignment.assigned_cleaner;
        });
      });
    } catch (error) {
      console.error('Errore nel caricamento delle assegnazioni early-out:', error);
    }
  };

  // Esponi le funzioni per poterle chiamare da altri componenti
  (window as any).reloadEarlyOutAssignments = loadEarlyOutAssignments;
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
            };
          }
          return task;
        });

        saveTaskAssignments(updatedTasks);
        return updatedTasks;
      });

      // Trova il logistic_code della task
      const task = allTasksWithAssignments.find(t => t.id === taskId);
      const logisticCode = task?.name; // name contiene il logistic_code

      // Salva l'assegnazione nella timeline
      saveTimelineAssignment(taskId, cleanerId, logisticCode);

      // Rimuovi la task dal container originale
      if (source.droppableId === 'early-out') {
        setEarlyOutTasks(prev => prev.filter(t => t.id !== taskId));
      } else if (source.droppableId === 'high') {
        setHighPriorityTasks(prev => prev.filter(t => t.id !== taskId));
      } else if (source.droppableId === 'low') {
        setLowPriorityTasks(prev => prev.filter(t => t.id !== taskId));
      }
    }
    // Se sto muovendo da una timeline verso una colonna di priorità
    else {
      setAllTasksWithAssignments((prevTasks) => {
        const updatedTasks = prevTasks.map((task) => {
          if (task.id === taskId) {
            return {
              ...task,
              assignedCleaner: undefined,
              startTime: undefined,
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
        if (destination.droppableId === 'early-out') {
          setEarlyOutTasks(prev => [...prev, taskToAdd]);
        } else if (destination.droppableId === 'high') {
          setHighPriorityTasks(prev => [...prev, taskToAdd]);
        } else if (destination.droppableId === 'low') {
          setLowPriorityTasks(prev => [...prev, taskToAdd]);
        }
      }
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