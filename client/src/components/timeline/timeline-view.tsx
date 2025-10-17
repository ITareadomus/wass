import { Personnel, Task } from "@shared/schema";
import { Calendar, RotateCcw } from "lucide-react";
import { useState, useEffect } from "react";
import { Droppable } from "react-beautiful-dnd";
import TaskCard from "@/components/drag-drop/task-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface TimelineViewProps {
  personnel: Personnel[];
  tasks: Task[];
}

interface Cleaner {
  id: number;
  name: string;
  lastname: string;
  role: string;
  active: boolean;
  ranking: number;
  counter_hours: number;
  counter_days: number;
  available: boolean;
  contract_type: string;
  preferred_customers: number[];
  telegram_id: number | null;
  start_time: string | null;
}

interface AssignmentData {
  task_id: number;
  logistic_code: number;
  start_time: string;
  end_time: string;
  sequence: number;
}

export default function TimelineView({
  personnel,
  tasks,
}: TimelineViewProps) {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedCleaner, setSelectedCleaner] = useState<Cleaner | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [assignmentsMap, setAssignmentsMap] = useState<Map<string, AssignmentData>>(new Map());

  const timeSlots = [
    "10:00", "11:00", "12:00", "13:00", "14:00",
    "15:00", "16:00", "17:00", "18:00", "19:00"
  ];

  const TIMELINE_START = 10 * 60; // 10:00 in minuti
  const TIMELINE_END = 19 * 60; // 19:00 in minuti
  const TIMELINE_DURATION = TIMELINE_END - TIMELINE_START; // 540 minuti (9 ore)

  // Palette di colori azzurri per i cleaners
  const cleanerColors = [
    { bg: '#0EA5E9', text: '#FFFFFF' }, // Azzurro
    { bg: '#38BDF8', text: '#FFFFFF' }, // Azzurro chiaro
    { bg: '#0284C7', text: '#FFFFFF' }, // Azzurro scuro
    { bg: '#7DD3FC', text: '#000000' }, // Azzurro molto chiaro
    { bg: '#075985', text: '#FFFFFF' }, // Azzurro molto scuro
    { bg: '#06B6D4', text: '#FFFFFF' }, // Ciano
    { bg: '#22D3EE', text: '#000000' }, // Ciano chiaro
    { bg: '#0891B2', text: '#FFFFFF' }, // Ciano scuro
    { bg: '#67E8F9', text: '#000000' }, // Ciano molto chiaro
    { bg: '#164E63', text: '#FFFFFF' }, // Ciano molto scuro
  ];

  const getCleanerColor = (index: number) => {
    return cleanerColors[index % cleanerColors.length];
  };

  useEffect(() => {
    const loadCleaners = async () => {
      try {
        const response = await fetch('/data/cleaners/selected_cleaners.json');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const selectedData = await response.json();
        console.log("Cleaners caricati da selected_cleaners.json:", selectedData);

        // I cleaners sono già nel formato corretto
        const cleanersList = selectedData.cleaners || [];
        setCleaners(cleanersList);
      } catch (error) {
        console.error("Errore nel caricamento dei cleaners selezionati:", error);
      }
    };
    loadCleaners();
  }, []);

  useEffect(() => {
    const loadAssignments = async () => {
      try {
        const response = await fetch('/data/output/early_out_assignments.json');
        if (!response.ok) {
          console.log('Nessuna assegnazione trovata');
          return;
        }

        const data = await response.json();
        const map = new Map<string, AssignmentData>();

        for (const cleanerEntry of data.early_out_tasks_assigned || []) {
          for (const task of cleanerEntry.tasks || []) {
            const key = `${task.task_id}-${task.logistic_code}`;
            map.set(key, task);
          }
        }

        setAssignmentsMap(map);
        console.log('Assignment times caricati:', map.size, 'tasks');
      } catch (error) {
        console.error('Errore nel caricamento assignment times:', error);
      }
    };

    loadAssignments();
  }, []);

  const handleCleanerClick = (cleaner: Cleaner) => {
    setSelectedCleaner(cleaner);
    setIsModalOpen(true);
  };

  // Converte una stringa time (HH:MM) in minuti dal midnight
  const timeToMinutes = (time: string): number => {
    const [hours, minutes] = time.split(':').map(Number);
    return hours * 60 + minutes;
  };

  // Calcola la posizione left in percentuale rispetto alla timeline
  const calculateLeftPosition = (startTime: string): number => {
    const startMinutes = timeToMinutes(startTime);
    const offset = startMinutes - TIMELINE_START;
    return (offset / TIMELINE_DURATION) * 100;
  };

  // Calcola la larghezza in percentuale
  const calculateTaskWidth = (startTime: string, endTime: string): number => {
    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);
    const duration = endMinutes - startMinutes;
    return (duration / TIMELINE_DURATION) * 100;
  };

  const handleResetAssignments = async () => {
    try {
      // Svuota timeline_assignments.json
      const response = await fetch('/api/reset-timeline-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.ok) {
        // Ricarica la pagina per ripristinare lo stato iniziale
        window.location.reload();
      } else {
        console.error('Errore nel reset delle assegnazioni');
      }
    } catch (error) {
      console.error('Errore nella chiamata API di reset:', error);
    }
  };

  // Non mostrare nulla se non ci sono cleaners
  if (cleaners.length === 0) {
    return null;
  }

  return (
    <>
      <div className="bg-card rounded-lg border shadow-sm">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground flex items-center">
              <Calendar className="w-5 h-5 mr-2 text-primary" />
              Timeline Assegnazioni - {cleaners.length} Cleaners
            </h3>
            <Button
              onClick={handleResetAssignments}
              variant="outline"
              size="sm"
              className="flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Reset Assegnazioni
            </Button>
          </div>
        </div>
        <div className="p-4 overflow-x-auto">
          {/* Header con orari */}
          <div className="flex mb-2">
            <div className="w-24 flex-shrink-0"></div>
            <div className="flex-1 flex">
              {timeSlots.map((slot) => (
                <div
                  key={slot}
                  className="flex-1 text-center text-sm font-medium text-muted-foreground border-l border-border first:border-l-0 py-1"
                >
                  {slot}
                </div>
              ))}
            </div>
          </div>

          {/* Righe dei cleaners */}
          {cleaners.map((cleaner, index) => {
            const color = getCleanerColor(index);
            const droppableId = `cleaner-${cleaner.id}`;

            // Trova tutte le task assegnate a questo cleaner
            const cleanerTasks = tasks.filter(task => 
              (task as any).assignedCleaner === cleaner.id
            );

            return (
              <div key={cleaner.id} className="flex mb-0.5">
                {/* Info cleaner */}
                <div
                  className="w-24 flex-shrink-0 p-1 flex items-center border border-border cursor-pointer hover:opacity-90 transition-opacity"
                  style={{ 
                    backgroundColor: color.bg,
                    color: color.text
                  }}
                  onClick={() => handleCleanerClick(cleaner)}
                >
                  <div className="w-full">
                    <div className="text-[9px] font-medium break-words leading-tight">
                      {cleaner.name.toUpperCase()} {cleaner.lastname.toUpperCase()}
                    </div>
                  </div>
                </div>

                {/* Timeline per questo cleaner - area unica droppable */}
                <Droppable droppableId={`timeline-${cleaner.id}`} direction="horizontal">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`relative border-t border-border transition-colors min-h-[45px] flex-1 ${
                        snapshot.isDraggingOver ? 'bg-primary/20 ring-2 ring-primary' : ''
                      }`}
                      style={{ 
                        backgroundColor: snapshot.isDraggingOver 
                          ? `${color.bg}40`
                          : `${color.bg}10`
                      }}
                    >
                      {/* Griglia oraria di sfondo (solo visiva) */}
                      <div className="absolute inset-0 grid grid-cols-10 pointer-events-none opacity-10">
                        {timeSlots.map((slot, idx) => (
                          <div key={idx} className="border-r border-border"></div>
                        ))}
                      </div>

                      {/* Task posizionate in base a start_time */}
                      <div className="relative z-10 h-full">
                        {tasks
                          .filter((task) => (task as any).assignedCleaner === cleaner.id)
                          .map((task, index) => {
                            const taskId = (task as any).task_id ?? task.id;
                            const logisticCode = task.name;
                            const assignmentKey = `${taskId}-${logisticCode}`;
                            const assignmentData = assignmentsMap.get(assignmentKey);

                            if (!assignmentData?.start_time || !assignmentData?.end_time) {
                              return null; // Non mostrare task senza tempi
                            }

                            const leftPosition = calculateLeftPosition(assignmentData.start_time);
                            const width = calculateTaskWidth(assignmentData.start_time, assignmentData.end_time);

                            return (
                              <div
                                key={`${task.id}-${cleaner.id}-${index}`}
                                className="absolute top-0 bottom-0 flex items-center"
                                style={{
                                  left: `${leftPosition}%`,
                                  width: `${width}%`,
                                  zIndex: 20
                                }}
                              >
                                <TaskCard 
                                  task={task} 
                                  index={index}
                                  isInTimeline={true}
                                />
                              </div>
                            );
                          })}
                        {provided.placeholder}
                      </div>
                    </div>
                  )}
                </Droppable>
              </div>
            );
          })}
        </div>
      </div>

      {/* Cleaner Details Dialog */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Dettagli Cleaner #{selectedCleaner?.id}
              {selectedCleaner && (
                selectedCleaner.role === "Formatore" ? (
                  <span className="px-3 py-1 rounded-md bg-orange-500 text-white border-2 border-black font-semibold text-sm">
                    Formatore
                  </span>
                ) : selectedCleaner.role === "Premium" ? (
                  <span className="px-3 py-1 rounded-md bg-yellow-400 text-black border-2 border-black font-semibold text-sm">
                    Premium
                  </span>
                ) : (
                  <span className="px-3 py-1 rounded-md bg-green-500 text-white border-2 border-black font-semibold text-sm">
                    Standard
                  </span>
                )
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedCleaner && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Nome</p>
                  <p className="text-sm">{selectedCleaner.name.toUpperCase()}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Cognome</p>
                  <p className="text-sm">{selectedCleaner.lastname.toUpperCase()}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Giorni lavorati</p>
                  <p className="text-sm">{selectedCleaner.counter_days}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Ore lavorate</p>
                  <p className="text-sm">{selectedCleaner.counter_hours}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Tipo contratto</p>
                  <p className="text-sm">{selectedCleaner.contract_type}</p>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}