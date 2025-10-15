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

export default function TimelineView({
  personnel,
  tasks,
}: TimelineViewProps) {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedCleaner, setSelectedCleaner] = useState<Cleaner | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [earlyOutAssignments, setEarlyOutAssignments] = useState<any[]>([]);
  const [followupAssignments, setFollowupAssignments] = useState<any[]>([]);

  // Calcola il primo start_time dalle assegnazioni
  const getEarliestStartTime = () => {
    const allStartTimes: string[] = [];

    // Aggiungi start_time dalle early-out assignments
    earlyOutAssignments.forEach((task: any) => {
      if (task.assigned_cleaner?.start_time) {
        allStartTimes.push(task.assigned_cleaner.start_time);
      }
    });

    // Aggiungi start_time dalle followup assignments
    followupAssignments.forEach((assignment: any) => {
      assignment.assigned_tasks?.forEach((task: any) => {
        if (task.start_time) {
          allStartTimes.push(task.start_time);
        }
      });
    });

    if (allStartTimes.length === 0) return "08:00";

    // Trova il minimo
    allStartTimes.sort();
    const earliest = allStartTimes[0];
    
    // Arrotonda all'ora precedente (es: 09:30 -> 09:00)
    const hour = parseInt(earliest.split(':')[0]);
    return `${hour.toString().padStart(2, '0')}:00`;
  };

  const generateTimeSlots = () => {
    const startHour = parseInt(getEarliestStartTime().split(':')[0]);
    const endHour = 19; // Ora di fine fissa
    const slots: string[] = [];
    
    for (let hour = startHour; hour <= endHour; hour++) {
      slots.push(`${hour.toString().padStart(2, '0')}:00`);
    }
    
    return slots;
  };

  const timeSlots = generateTimeSlots();

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
    const loadData = async () => {
      try {
        // Carica cleaners
        const cleanersResponse = await fetch('/data/cleaners/selected_cleaners.json');
        if (!cleanersResponse.ok) {
          throw new Error(`HTTP error! status: ${cleanersResponse.status}`);
        }
        const selectedData = await cleanersResponse.json();
        console.log("Cleaners caricati da selected_cleaners.json:", selectedData);
        const cleanersList = selectedData.cleaners || [];
        setCleaners(cleanersList);

        // Carica early-out assignments
        try {
          const earlyOutResponse = await fetch('/data/output/early_out_assignments.json');
          if (earlyOutResponse.ok) {
            const earlyOutData = await earlyOutResponse.json();
            setEarlyOutAssignments(earlyOutData.early_out_tasks_assigned || []);
          }
        } catch (error) {
          console.log("Early-out assignments non disponibili");
        }

        // Carica followup assignments
        try {
          const followupResponse = await fetch('/data/output/followup_assignments.json');
          if (followupResponse.ok) {
            const followupData = await followupResponse.json();
            setFollowupAssignments(followupData.assignments || []);
          }
        } catch (error) {
          console.log("Followup assignments non disponibili");
        }
      } catch (error) {
        console.error("Errore nel caricamento dei dati:", error);
      }
    };
    loadData();
  }, []);

  const handleCleanerClick = (cleaner: Cleaner) => {
    setSelectedCleaner(cleaner);
    setIsModalOpen(true);
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
                      <div className="absolute inset-0 grid grid-cols-12 pointer-events-none opacity-10">
                        {timeSlots.map((slot, idx) => (
                          <div key={idx} className="border-r border-border"></div>
                        ))}
                      </div>

                      {/* Task posizionate in sequenza */}
                      <div className="relative z-10 flex items-center h-full">
                        {tasks
                          .filter((task) => (task as any).assignedCleaner === cleaner.id)
                          .filter((task, index, self) => 
                            // Rimuovi duplicati basandoti sul logistic_code (task.name)
                            index === self.findIndex((t) => t.name === task.name)
                          )
                          .sort((a, b) => ((a as any).assignedSlot || 0) - ((b as any).assignedSlot || 0))
                          .map((task, index) => {
                            // Calcola le ore totali della timeline (differenza tra primo e ultimo slot)
                            const firstHour = parseInt(timeSlots[0].split(':')[0]);
                            const lastHour = parseInt(timeSlots[timeSlots.length - 1].split(':')[0]);
                            const timelineHours = lastHour - firstHour;
                            return (
                              <TaskCard 
                                key={`${task.name}-${cleaner.id}`}
                                task={{...task, timelineHours}} 
                                index={index}
                                isInTimeline={true}
                              />
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
            </DialogTitle>
          </DialogHeader>
          {selectedCleaner && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">id</p>
                  <p className="text-sm">{selectedCleaner.id}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">name</p>
                  <p className="text-sm">{selectedCleaner.name.toUpperCase()}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">lastname</p>
                  <p className="text-sm">{selectedCleaner.lastname.toUpperCase()}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">role</p>
                  <p className="text-sm">{selectedCleaner.role}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">active</p>
                  <p className="text-sm">{selectedCleaner.active ? 'true' : 'false'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">ranking</p>
                  <p className="text-sm">{selectedCleaner.ranking}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">counter_hours</p>
                  <p className="text-sm">{selectedCleaner.counter_hours}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">counter_days</p>
                  <p className="text-sm">{selectedCleaner.counter_days}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">available</p>
                  <p className="text-sm">{selectedCleaner.available ? 'true' : 'false'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">contract_type</p>
                  <p className="text-sm">{selectedCleaner.contract_type}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">telegram_id</p>
                  <p className="text-sm">{selectedCleaner.telegram_id ?? 'null'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">start_time</p>
                  <p className="text-sm">{selectedCleaner.start_time ?? 'null'}</p>
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">preferred_customers</p>
                <p className="text-sm">[{selectedCleaner.preferred_customers.join(', ')}]</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}