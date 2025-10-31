import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar, RotateCcw, Users } from "lucide-react";
import { useState, useEffect } from "react";
import { Droppable } from "react-beautiful-dnd";
import TaskCard from "@/components/drag-drop/task-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
    "10:00", "11:00", "12:00", "13:00", "14:00",
    "15:00", "16:00", "17:00", "18:00", "19:00"
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
    // Colori distribuiti per massimo contrasto visivo tra consecutivi
    const colors = [
      { bg: "#EF4444", text: "#FFFFFF" }, // rosso
      { bg: "#3B82F6", text: "#FFFFFF" }, // blu
      { bg: "#22C55E", text: "#000000" }, // verde
      { bg: "#D946EF", text: "#FFFFFF" }, // fucsia
      { bg: "#F59E0B", text: "#000000" }, // ambra
      { bg: "#8B5CF6", text: "#FFFFFF" }, // viola
      { bg: "#14B8A6", text: "#000000" }, // teal
      { bg: "#F97316", text: "#FFFFFF" }, // arancione
      { bg: "#6366F1", text: "#FFFFFF" }, // indaco
      { bg: "#84CC16", text: "#000000" }, // lime
      { bg: "#EC4899", text: "#FFFFFF" }, // rosa
      { bg: "#0EA5E9", text: "#FFFFFF" }, // sky
      { bg: "#DC2626", text: "#FFFFFF" }, // rosso scuro
      { bg: "#10B981", text: "#000000" }, // smeraldo
      { bg: "#A855F7", text: "#FFFFFF" }, // viola chiaro
      { bg: "#EAB308", text: "#000000" }, // giallo
      { bg: "#06B6D4", text: "#000000" }, // ciano
      { bg: "#F43F5E", text: "#FFFFFF" }, // rose
      { bg: "#2563EB", text: "#FFFFFF" }, // blu scuro
      { bg: "#16A34A", text: "#FFFFFF" }, // verde scuro
      { bg: "#C026D3", text: "#FFFFFF" }, // fucsia scuro
      { bg: "#EA580C", text: "#FFFFFF" }, // arancione scuro
      { bg: "#7C3AED", text: "#FFFFFF" }, // viola medio
      { bg: "#0891B2", text: "#FFFFFF" }, // ciano scuro
      { bg: "#CA8A04", text: "#000000" }, // giallo scuro
      { bg: "#DB2777", text: "#FFFFFF" }, // rosa scuro
      { bg: "#4F46E5", text: "#FFFFFF" }, // indaco scuro
      { bg: "#65A30D", text: "#FFFFFF" }, // lime scuro
      { bg: "#059669", text: "#FFFFFF" }, // smeraldo scuro
      { bg: "#9333EA", text: "#FFFFFF" }, // viola profondo
      { bg: "#D97706", text: "#FFFFFF" }, // ambra scuro
      { bg: "#E11D48", text: "#FFFFFF" }, // rose scuro
      { bg: "#0284C7", text: "#FFFFFF" }, // sky scuro
      { bg: "#15803D", text: "#FFFFFF" }, // verde molto scuro
      { bg: "#0D9488", text: "#FFFFFF" }, // teal scuro
    ];
    return colors[index % colors.length];
  };

  useEffect(() => {
    const loadCleaners = async () => {
      try {
        // Aggiungi timestamp per evitare caching
        const response = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Verifica che la risposta sia JSON
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          console.error('Risposta non JSON:', contentType);
          setCleaners([]);
          return;
        }

        const selectedData = await response.json();
        console.log("Cleaners caricati da selected_cleaners.json:", selectedData);

        // I cleaners sono già nel formato corretto
        const cleanersList = selectedData.cleaners || [];
        setCleaners(cleanersList);
      } catch (error) {
        console.error("Errore nel caricamento dei cleaners selezionati:", error);
        setCleaners([]); // Imposta array vuoto invece di lasciare undefined
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
      // La data è già nel formato corretto yyyy-MM-dd nel localStorage
      const dateStr = localStorage.getItem('selected_work_date') || (() => {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      })();

      // 1. Reset timeline_assignments.json (file principale)
      const resetResponse = await fetch('/api/reset-timeline-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      if (!resetResponse.ok) {
        throw new Error('Errore nel reset della timeline');
      }

      // 2. Ricarica la pagina per rieseguire extract_all
      window.location.reload();
    } catch (error) {
      console.error('Errore nel reset:', error);
      alert('Errore durante il reset delle assegnazioni');
    }
  };

  const handleGoToConvocazioni = () => {
    // Apri la pagina delle convocazioni in una nuova finestra
    window.open('/convocazioni', '_blank');
  };

  // Non mostrare nulla se non ci sono cleaners
  if (cleaners.length === 0) {
    return null;
  }

  // --- NORMALIZZAZIONI TIMELINE ---
  // NON normalizzare task.type - lo determiniamo dai flag
  const normalizeTask = (task: any) => {
    // Normalizza SOLO i flag straordinaria/premium, NON il type
    const isPremium = Boolean(task.premium);
    const isStraordinaria = Boolean(task.straordinaria || task.is_straordinaria);

    // Normalizza confirmed_operation
    const rawConfirmed = task.confirmed_operation;
    const isConfirmedOperation =
      typeof rawConfirmed === "boolean"
        ? rawConfirmed
        : typeof rawConfirmed === "number"
          ? rawConfirmed !== 0
          : typeof rawConfirmed === "string"
            ? ["true", "1", "yes"].includes(rawConfirmed.toLowerCase().trim())
            : false;

    return {
      ...task,
      // NON sovrascrivere task.type - lascialo undefined se non esiste
      premium: isPremium,
      straordinaria: isStraordinaria,
      is_straordinaria: isStraordinaria,
      confirmed_operation: isConfirmedOperation,
    };
  };

  return (
    <>
      <div className="bg-card rounded-lg border shadow-sm">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground flex items-center">
              <Calendar className="w-5 h-5 mr-2 text-primary" />
              Timeline Assegnazioni - {cleaners.length} Cleaners
            </h3>
            <div className="flex gap-2">
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
            ).map(normalizeTask); // Applica la normalizzazione qui

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

                      {/* Task posizionate in sequenza - SEMPLIFICATO per compatibilità react-beautiful-dnd */}
                      <div className="relative z-10 flex items-center h-full">
                        {cleanerTasks
                          .sort((a, b) => {
                            const taskA = a as any;
                            const taskB = b as any;

                            if (taskA.sequence !== undefined && taskB.sequence !== undefined) {
                              return taskA.sequence - taskB.sequence;
                            }

                            const timeA = taskA.start_time || taskA.fw_start_time || taskA.startTime || "00:00";
                            const timeB = taskB.start_time || taskB.fw_start_time || taskB.startTime || "00:00";
                            return timeA.localeCompare(timeB);
                          })
                          .map((task, idx) => {
                            const taskObj = task as any;
                            
                            // Leggi travel_time dalla task
                            let travelTime = 0;
                            if (taskObj.travel_time !== undefined && taskObj.travel_time !== null) {
                              travelTime = typeof taskObj.travel_time === 'number' 
                                ? taskObj.travel_time 
                                : parseInt(String(taskObj.travel_time), 10);
                            }
                            if (isNaN(travelTime)) travelTime = 0;
                            
                            return (
                              <TaskCard 
                                key={task.id}
                                task={task} 
                                index={idx}
                                isInTimeline={true}
                                allTasks={cleanerTasks}
                                showTravelIndicator={idx > 0}
                                travelTime={travelTime}
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
        <DialogContent className={`sm:max-w-2xl max-h-[80vh] overflow-y-auto ${
          selectedCleaner?.role === "Formatore" 
            ? "border-4 border-orange-500 bg-orange-500/30" 
            : selectedCleaner?.role === "Premium"
            ? "border-4 border-yellow-500 bg-yellow-500/30"
            : selectedCleaner?.role === "Standard"
            ? "border-4 border-green-500 bg-green-500/30"
            : ""
        }`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Dettagli Cleaner #{selectedCleaner?.id}
              {selectedCleaner && (
                selectedCleaner.role === "Formatore" ? (
                  <span className="px-3 py-1 rounded-md bg-orange-500 text-black border-2 border-black font-semibold text-sm">
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