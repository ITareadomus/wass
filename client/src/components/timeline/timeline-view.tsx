
import { Personnel, Task } from "@shared/schema";
import { Calendar } from "lucide-react";
import { useState, useEffect } from "react";
import { Droppable } from "react-beautiful-dnd";
import TaskCard from "@/components/drag-drop/task-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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

  // Palette di colori distintivi per i cleaners
  const cleanerColors = [
    { bg: '#3B82F6', text: '#FFFFFF' }, // Blu
    { bg: '#10B981', text: '#FFFFFF' }, // Verde
    { bg: '#F59E0B', text: '#FFFFFF' }, // Arancione
    { bg: '#8B5CF6', text: '#FFFFFF' }, // Viola
    { bg: '#EC4899', text: '#FFFFFF' }, // Rosa
    { bg: '#14B8A6', text: '#FFFFFF' }, // Teal
    { bg: '#F97316', text: '#FFFFFF' }, // Arancione scuro
    { bg: '#6366F1', text: '#FFFFFF' }, // Indaco
    { bg: '#EF4444', text: '#FFFFFF' }, // Rosso
    { bg: '#06B6D4', text: '#FFFFFF' }, // Ciano
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
        const data = await response.json();
        console.log("Cleaners caricati da selected_cleaners.json:", data);
        setCleaners(data.cleaners || []);
      } catch (error) {
        console.error("Errore nel caricamento dei cleaners:", error);
      }
    };
    loadCleaners();
  }, []);

  const handleCleanerClick = (cleaner: Cleaner) => {
    setSelectedCleaner(cleaner);
    setIsModalOpen(true);
  };

  // Non mostrare nulla se non ci sono cleaners
  if (cleaners.length === 0) {
    return null;
  }

  return (
    <>
      <div className="bg-card rounded-lg border shadow-sm">
        <div className="p-4 border-b border-border">
          <h3 className="font-semibold text-foreground flex items-center">
            <Calendar className="w-5 h-5 mr-2 text-primary" />
            Timeline Assegnazioni - {cleaners.length} Cleaners
          </h3>
        </div>
        <div className="p-4 overflow-x-auto">
          <div
            className="grid"
            style={{ gridTemplateColumns: "200px repeat(12, 80px)" }}
          >
            {/* Header Row */}
            <div className="timeline-cell p-2 bg-secondary font-semibold text-sm border border-border">
              CLEANER
            </div>
            {timeSlots.map((slot) => (
              <div
                key={slot}
                className="timeline-cell p-2 bg-secondary text-center text-xs font-medium border border-border"
              >
                {slot}
              </div>
            ))}

            {/* Cleaner Rows */}
            {cleaners.map((cleaner, index) => {
              const color = getCleanerColor(index);
              const droppableId = `cleaner-${cleaner.id}`;
              
              return (
                <div key={cleaner.id} className="contents">
                  {/* Cleaner Info Cell */}
                  <div
                    className="timeline-cell p-2 flex items-center border border-border cursor-pointer hover:opacity-90 transition-opacity"
                    style={{ 
                      backgroundColor: color.bg,
                      color: color.text
                    }}
                    onClick={() => handleCleanerClick(cleaner)}
                  >
                    <div>
                      <div className="text-sm font-medium">
                        {cleaner.name} {cleaner.lastname}
                      </div>
                      <div className="text-xs opacity-80">
                        {cleaner.role}
                      </div>
                    </div>
                  </div>

                  {/* Time Slots - Droppable Area */}
                  {timeSlots.map((slot, slotIndex) => {
                    const cellDroppableId = `${droppableId}-slot-${slotIndex}`;
                    // Trova le task assegnate a questo cleaner in questo slot
                    const slotTasks = tasks.filter(task => 
                      (task as any).assignedCleaner === cleaner.id && 
                      (task as any).assignedSlot === slotIndex
                    );

                    return (
                      <Droppable key={cellDroppableId} droppableId={cellDroppableId}>
                        {(provided, snapshot) => (
                          <div
                            ref={provided.innerRef}
                            {...provided.droppableProps}
                            className={`timeline-cell border border-border transition-colors p-1 min-h-[60px] flex items-center gap-1 ${
                              snapshot.isDraggingOver ? 'bg-primary/20 ring-2 ring-primary' : ''
                            }`}
                            style={{ 
                              backgroundColor: snapshot.isDraggingOver 
                                ? `${color.bg}30` 
                                : `${color.bg}10`
                            }}
                          >
                            {slotTasks.length > 0 ? (
                              slotTasks.map((task, taskIndex) => (
                                <TaskCard 
                                  key={task.id} 
                                  task={task} 
                                  index={taskIndex}
                                  isInTimeline={true}
                                />
                              ))
                            ) : (
                              <div className="text-xs text-muted-foreground opacity-50">
                                Trascina qui
                              </div>
                            )}
                            {provided.placeholder}
                          </div>
                        )}
                      </Droppable>
                    );
                  })}
                </div>
              );
            })}
          </div>
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
                  <p className="text-sm">{selectedCleaner.name}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">lastname</p>
                  <p className="text-sm">{selectedCleaner.lastname}</p>
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
