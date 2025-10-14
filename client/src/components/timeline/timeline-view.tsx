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

  const timeSlots = [
    "08:00", "09:00", "10:00", "11:00", "12:00",
    "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"
  ];

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

                      {/* Task posizionate e dimensionate in base a start_time/end_time */}
                      <div className="relative z-10 h-full">
                        {tasks
                          .filter((task) => (task as any).assignedCleaner === cleaner.id)
                          .filter((task, index, self) => 
                            // Rimuovi duplicati basandoti sul logistic_code (task.name)
                            index === self.findIndex((t) => t.name === task.name)
                          )
                          .sort((a, b) => {
                            const aStart = (a as any).start_time || "10:00";
                            const bStart = (b as any).start_time || "10:00";
                            return aStart.localeCompare(bStart);
                          })
                          .map((task, index) => {
                            // Ottieni start_time e end_time dalla task
                            let startTime = (task as any).start_time || "10:00";
                            let endTime = (task as any).end_time || "10:00";
                            
                            // Se non ci sono start_time/end_time, calcolali dalla durata
                            if (!((task as any).start_time && (task as any).end_time)) {
                              // Calcola dalla durata della task
                              const durationParts = task.duration.split(".");
                              const hours = parseInt(durationParts[0] || "0");
                              const minutes = durationParts[1] ? parseInt(durationParts[1]) : 0;
                              const taskDurationMinutes = hours * 60 + minutes;
                              
                              startTime = "10:00"; // Default
                              const [startHour, startMinute] = startTime.split(":").map(Number);
                              const startMinutes = startHour * 60 + startMinute;
                              const endMinutes = startMinutes + taskDurationMinutes;
                              const endHour = Math.floor(endMinutes / 60);
                              const endMinute = endMinutes % 60;
                              endTime = `${endHour.toString().padStart(2, '0')}:${endMinute.toString().padStart(2, '0')}`;
                            }
                            
                            const [startHour, startMinute] = startTime.split(":").map(Number);
                            const [endHour, endMinute] = endTime.split(":").map(Number);
                            
                            const startMinutesFromMidnight = startHour * 60 + startMinute;
                            const endMinutesFromMidnight = endHour * 60 + endMinute;
                            
                            // La timeline va dalle 08:00 alle 19:00 = 11 ore = 660 minuti
                            const timelineStartMinutes = 8 * 60; // 08:00 = 480 min
                            const timelineTotalMinutes = 11 * 60; // 660 min
                            
                            // Calcola posizione (left) in percentuale
                            const offsetMinutes = startMinutesFromMidnight - timelineStartMinutes;
                            const leftPercentage = (offsetMinutes / timelineTotalMinutes) * 100;
                            
                            // Calcola larghezza in percentuale basata sulla durata effettiva
                            const durationMinutes = endMinutesFromMidnight - startMinutesFromMidnight;
                            const widthPercentage = (durationMinutes / timelineTotalMinutes) * 100;
                            
                            return (
                              <div
                                key={`${task.name}-${cleaner.id}`}
                                className="absolute"
                                style={{ 
                                  left: `${Math.max(0, leftPercentage)}%`,
                                  width: `${widthPercentage}%`,
                                  top: '50%',
                                  transform: 'translateY(-50%)'
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