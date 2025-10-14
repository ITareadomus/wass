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
        <div className="p-4">
          {/* Blocco cleaners */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
            {cleaners.map((cleaner, index) => {
              const color = getCleanerColor(index);

              return (
                <div
                  key={cleaner.id}
                  className="p-3 border border-border cursor-pointer hover:opacity-90 transition-opacity rounded-lg"
                  style={{
                    backgroundColor: color.bg,
                    color: color.text
                  }}
                  onClick={() => handleCleanerClick(cleaner)}
                >
                  <div className="text-sm font-medium break-words">
                    {cleaner.name.toUpperCase()} {cleaner.lastname.toUpperCase()}
                  </div>
                  <div className="text-xs opacity-80 mt-1">
                    {cleaner.role}
                  </div>
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

      {/* Timeline Section */}
      <div className="relative w-full h-96 overflow-x-auto bg-background p-4 rounded-lg border shadow-sm mt-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-foreground flex items-center">
            <Calendar className="w-5 h-5 mr-2 text-primary" />
            Timeline
          </h3>
        </div>

        {/* Time Slots Header */}
        <div className="flex h-10 border-b border-border">
          <div className="w-40 flex-shrink-0 border-r border-border flex items-center justify-center font-medium text-sm">
            Cleaner
          </div>
          <div className="flex flex-grow relative">
            {timeSlots.map((slot, index) => (
              <div
                key={slot}
                className="text-center text-xs text-muted-foreground absolute top-0 bottom-0 flex items-center justify-center"
                style={{
                  left: `${index * (100 / timeSlots.length)}%`,
                  width: `${100 / timeSlots.length}%`,
                }}
              >
                {slot}
              </div>
            ))}
          </div>
        </div>

        {/* Tasks Rows */}
        <div className="relative">
          {cleaners.map((cleaner, cleanerIndex) => {
            // Filtra i task per il cleaner corrente
            const cleanerTasks = tasks.filter(task => (task as any).cleaner_id === cleaner.id);

            // Ordina i task per start_time
            cleanerTasks.sort((a, b) => {
              const aStart = (a as any).start_time || "00:00";
              const bStart = (b as any).start_time || "00:00";
              return aStart.localeCompare(bStart);
            });

            return (
              <Droppable droppableId={`cleaner-${cleaner.id}`} key={cleaner.id}>
                {(provided) => (
                  <div
                    ref={provided.innerRef}
                    {...provided.droppableProps}
                    className="flex items-center relative h-24 border-b border-border last:border-b-0"
                    style={{ width: 'calc(11 * 16.67 * 12px)' }} // 11 hours * 16.67 px/min * 60 min/hr = ~11002px
                  >
                    {/* Cleaner Info */}
                    <div className="w-40 flex-shrink-0 border-r border-border flex items-center justify-center font-medium text-sm p-2">
                      <div
                        className="p-2 rounded-md text-center w-full"
                        style={{
                          backgroundColor: getCleanerColor(cleanerIndex).bg,
                          color: getCleanerColor(cleanerIndex).text
                        }}
                      >
                        {cleaner.name} {cleaner.lastname}
                      </div>
                    </div>

                    {/* Tasks for this cleaner */}
                    <div className="flex-grow relative">
                      {cleanerTasks.map((task, index) => {
                        const taskData = (task as any);

                        // Timeline usa 16.67 pixel per minuto
                        const PIXELS_PER_MINUTE = 16.67;
                        const TIMELINE_START_HOUR = 8;

                        // Estrai start_time
                        let startTime = taskData.start_time || "10:00";
                        const [startHour, startMinute] = startTime.split(":").map(Number);

                        // Calcola minuti dall'inizio della timeline (8:00)
                        const startMinutesFromTimelineStart = (startHour * 60 + startMinute) - (TIMELINE_START_HOUR * 60);

                        // Calcola left in pixel: minuti × 16.67
                        const leftPixels = startMinutesFromTimelineStart * PIXELS_PER_MINUTE;

                        // Estrai cleaning_time in minuti
                        const cleaningTimeMinutes = taskData.cleaning_time || 60;

                        // Calcola width in pixel: cleaning_time × 16.67
                        const widthPixels = cleaningTimeMinutes * PIXELS_PER_MINUTE;

                        return (
                          <div
                            key={task.id}
                            className="absolute top-0"
                            style={{
                              left: `${leftPixels}px`,
                              width: `${widthPixels}px`,
                            }}
                          >
                            <TaskCard task={task} />
                          </div>
                        );
                      })}
                      {provided.placeholder}
                    </div>
                  </div>
                )}
              </Droppable>
            );
          })}
        </div>
      </div>
    </>
  );
}