import { Draggable } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState, useEffect } from "react";
import { HelpCircle, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

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

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
  allTasks?: Task[];
  currentContainer?: string;
  availableCleaners?: Cleaner[];
  currentCleanerId?: number;
}

interface AssignedTask {
  task_id: number;
  logistic_code: number;
  start_time: string;
  end_time: string;
  travel_time?: number;
}

export default function TaskCard({
  task,
  index,
  isInTimeline = false,
  allTasks = [],
  currentContainer = '',
  availableCleaners = [],
  currentCleanerId,
}: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentTaskIndex, setCurrentTaskIndex] = useState(index);
  const [assignmentTimes, setAssignmentTimes] = useState<{ start_time?: string; end_time?: string; travel_time?: number }>({});
  const [selectedSwapCleaner, setSelectedSwapCleaner] = useState<string>("");
  const { toast } = useToast();

  // Mutation per scambiare task tra cleaners
  const swapCleanersMutation = useMutation({
    mutationFn: async ({ sourceCleanerId, destCleanerId }: { sourceCleanerId: number; destCleanerId: number }) => {
      // Leggi la data selezionata da localStorage, fallback a oggi se non presente
      const savedDate = localStorage.getItem('selected_work_date');
      const workDate = savedDate || new Date().toISOString().split('T')[0];
      
      const response = await apiRequest("POST", "/api/swap-cleaners-tasks", {
        sourceCleanerId,
        destCleanerId,
        date: workDate
      });
      return await response.json();
    },
    onSuccess: () => {
      // Invalida cache per ricaricare le assegnazioni
      queryClient.invalidateQueries({ queryKey: ["/api/timeline-assignments"] });
      toast({
        title: "Successo",
        description: "Task scambiate con successo tra i cleaners",
      });
      setSelectedSwapCleaner("");
      setIsModalOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Errore nello scambio delle task",
        variant: "destructive",
      });
    },
  });

  // Determina le task navigabili in base al contesto
  const getNavigableTasks = () => {
    if (!allTasks || allTasks.length === 0) return [];

    if (isInTimeline) {
      // In timeline: filtra per cleaner
      const taskObj = allTasks[currentTaskIndex] as any;
      const cleanerId = taskObj?.assignedCleaner;
      if (!cleanerId) return allTasks;

      return allTasks.filter((t: any) => t.assignedCleaner === cleanerId);
    } else {
      // Nei container: ritorna tutte le task del container
      return allTasks;
    }
  };

  const navigableTasks = getNavigableTasks();
  const currentTaskInNavigable = navigableTasks.findIndex(t => t.id === allTasks[currentTaskIndex]?.id);

  const canGoPrev = currentTaskInNavigable > 0;
  const canGoNext = currentTaskInNavigable < navigableTasks.length - 1;

  const handlePrevTask = () => {
    if (!canGoPrev) return;
    const prevTask = navigableTasks[currentTaskInNavigable - 1];
    const prevIndex = allTasks.findIndex(t => t.id === prevTask.id);
    setCurrentTaskIndex(prevIndex);
  };

  const handleNextTask = () => {
    if (!canGoNext) return;
    const nextTask = navigableTasks[currentTaskInNavigable + 1];
    const nextIndex = allTasks.findIndex(t => t.id === nextTask.id);
    setCurrentTaskIndex(nextIndex);
  };

  const handleSwapCleaners = () => {
    if (!selectedSwapCleaner || !currentCleanerId) return;
    
    const destCleanerId = parseInt(selectedSwapCleaner, 10);
    swapCleanersMutation.mutate({
      sourceCleanerId: currentCleanerId,
      destCleanerId: destCleanerId,
    });
  };

  // Reset currentTaskIndex quando il modale si apre
  useEffect(() => {
    if (isModalOpen) {
      setCurrentTaskIndex(index);
    }
  }, [isModalOpen, index]);

  // Task corrente da visualizzare
  const displayTask = allTasks[currentTaskIndex] || task;

  // Normalizza confirmed_operation da boolean/number/string a boolean sicuro
  const rawConfirmed = (task as any).confirmed_operation;
  const isConfirmedOperation =
    typeof rawConfirmed === "boolean"
      ? rawConfirmed
      : typeof rawConfirmed === "number"
        ? rawConfirmed !== 0
        : typeof rawConfirmed === "string"
          ? ["true", "1", "yes"].includes(rawConfirmed.toLowerCase().trim())
          : false;

  // Determina il tipo di task SOLO dai flag premium/straordinaria
  // Priorità: straordinaria → premium → standard
  const isPremium = Boolean((task as any).premium);
  const isStraordinaria = Boolean((task as any).straordinaria || (task as any).is_straordinaria);

  // Funzione per assegnare colore e label SOLO in base al tipo
  const getTaskTypeStyle = () => {
    if (isStraordinaria) {
      return { label: "STRAORDINARIA", colorClass: "task-straordinaria" };
    }
    if (isPremium) {
      return { label: "PREMIUM", colorClass: "task-premium" };
    }
    return { label: "STANDARD", colorClass: "task-standard" };
  };
  const { label: typeLabel, colorClass } = getTaskTypeStyle();

  useEffect(() => {
    const loadAssignmentTimes = async () => {
      try {
        // Prima controlla se i dati sono già presenti nell'oggetto task (dalla timeline)
        const taskObj = displayTask as any;
        if (taskObj.startTime || taskObj.start_time) {
          setAssignmentTimes({
            start_time: taskObj.start_time || taskObj.startTime,
            end_time: taskObj.end_time || taskObj.endTime,
            travel_time: taskObj.travel_time || taskObj.travelTime
          });
          return;
        }

        // Se non ci sono, cerca nei file JSON
        // Prova prima con early_out_assignments.json
        const eoResponse = await fetch('/data/output/early_out_assignments.json');
        if (eoResponse.ok) {
          const eoData = await eoResponse.json();
          const taskId = (task as any).task_id ?? task.id;

          // Cerca la task nelle assegnazioni Early Out
          for (const cleanerEntry of eoData.early_out_tasks_assigned || []) {
            const assignedTask = cleanerEntry.tasks?.find((t: AssignedTask) => 
              String(t.task_id) === String(taskId) || String(t.logistic_code) === String(task.name)
            );
            if (assignedTask) {
              setAssignmentTimes({
                start_time: assignedTask.start_time,
                end_time: assignedTask.end_time,
                travel_time: assignedTask.travel_time
              });
              return; // Trovata, esci
            }
          }
        }

        // Se non trovata in EO, prova con high_priority_assignments.json
        const hpResponse = await fetch('/data/output/high_priority_assignments.json');
        if (hpResponse.ok) {
          const hpData = await hpResponse.json();
          const taskId = (task as any).task_id ?? task.id;

          // Cerca la task nelle assegnazioni High Priority
          for (const cleanerEntry of hpData.high_priority_tasks_assigned || []) {
            const assignedTask = cleanerEntry.tasks?.find((t: AssignedTask) => 
              String(t.task_id) === String(taskId) || String(t.logistic_code) === String(task.name)
            );
            if (assignedTask) {
              setAssignmentTimes({
                start_time: assignedTask.start_time,
                end_time: assignedTask.end_time,
                travel_time: assignedTask.travel_time
              });
              return; // Trovata, esci
            }
          }
        }

        // Se non trovata in HP, prova con low_priority_assignments.json
        const lpResponse = await fetch('/data/output/low_priority_assignments.json');
        if (lpResponse.ok) {
          const lpData = await lpResponse.json();
          const taskId = (task as any).task_id ?? task.id;

          // Cerca la task nelle assegnazioni Low Priority
          for (const cleanerEntry of lpData.low_priority_tasks_assigned || []) {
            const assignedTask = cleanerEntry.tasks?.find((t: AssignedTask) => 
              String(t.task_id) === String(taskId) || String(t.logistic_code) === String(task.name)
            );
            if (assignedTask) {
              setAssignmentTimes({
                start_time: assignedTask.start_time,
                end_time: assignedTask.end_time,
                travel_time: assignedTask.travel_time
              });
              return; // Trovata, esci
            }
          }
        }
      } catch (error) {
        console.error('Errore nel caricamento dei tempi di assegnazione:', error);
      }
    };

    if (isModalOpen) {
      loadAssignmentTimes();
    }
  }, [isModalOpen, displayTask, currentTaskIndex]);

  const handleCardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsModalOpen(true);
  };

  // Calcola la larghezza in base alla durata
  const calculateWidth = (duration: string, forTimeline: boolean) => {
    const parts = duration.split(".");
    const hours = parseInt(parts[0] || "0");
    const minutes = parts[1] ? parseInt(parts[1]) : 0;
    const totalMinutes = hours * 60 + minutes;

    // Se 0 minuti, usa almeno 30 minuti
    const effectiveMinutes = totalMinutes === 0 ? 30 : totalMinutes;

    if (forTimeline) {
      // La timeline copre 10 ore (dalle 10:00 alle 19:00 = 600 minuti)
      // Ogni ora occupa il 10% della larghezza totale
      const widthPercentage = (effectiveMinutes / 600) * 100;
      return `${widthPercentage}%`;
    } else {
      // Per le colonne di priorità:
      // Se la task è < 60 minuti, usa sempre 60 minuti (larghezza di 1 ora)
      const displayMinutes = effectiveMinutes < 60 ? 60 : effectiveMinutes;
      const halfHours = Math.ceil(displayMinutes / 30);
      const baseWidth = halfHours * 50;
      return `${baseWidth}px`;
    }
  };

  // Verifica se end_time sfora checkin_time
  const isOverdue = (() => {
    const taskObj = displayTask as any;
    const endTime = assignmentTimes.end_time || taskObj.end_time || taskObj.endTime;
    const checkinTime = taskObj.checkin_time;

    if (!endTime || !checkinTime || !isInTimeline) return false;

    // Converti in minuti per confronto
    const [endH, endM] = endTime.split(':').map(Number);
    const [checkinH, checkinM] = checkinTime.split(':').map(Number);

    const endMinutes = endH * 60 + endM;
    const checkinMinutes = checkinH * 60 + checkinM;

    return endMinutes > checkinMinutes;
  })();

  return (
    <>
      <Draggable draggableId={task.id} index={index}>
        {(provided, snapshot) => {
          const cardWidth = calculateWidth(task.duration, isInTimeline);

          return (
            <div
              ref={provided.innerRef}
              {...provided.draggableProps}
              {...provided.dragHandleProps}
              className={`
                ${colorClass} 
                rounded-sm px-2 py-1 shadow-sm border transition-all duration-200
                ${snapshot.isDragging ? "shadow-lg scale-105" : ""}
                ${isOverdue ? "animate-blink" : ""}
                hover:shadow-md cursor-pointer
                flex-shrink-0 relative
              `}
              style={{
                ...provided.draggableProps.style,
                width: cardWidth,
                minHeight: "40px",
              }}
              data-testid={`task-card-${task.id}`}
              onClick={(e) => {
                if (!snapshot.isDragging) {
                  handleCardClick(e);
                }
              }}
            >
              {!isConfirmedOperation && (
                <div className="absolute top-0.5 right-0.5 z-50">
                  <HelpCircle
                    className="w-3 h-3 text-gray-900"
                    strokeWidth={2.5}
                  />
                </div>
              )}
              <div 
                className="flex flex-col items-center justify-center h-full gap-0"
              >
                <div className="flex items-center gap-1">
                  <span
                    className="text-[13px] text-[#ff0000] font-extrabold"
                    data-testid={`task-name-${task.id}`}
                  >
                    {task.name}
                  </span>
                  <span className="text-[11px] opacity-60 leading-none font-bold text-[#000000]">
                    ({task.duration.replace(".", ":")}h)
                  </span>
                </div>
                {task.alias && (
                  <span className="text-[11px] opacity-70 leading-none mt-0.5 text-[#000000] font-bold">
                    {task.alias}{(task as any).type_apt ? ` (${(task as any).type_apt})` : ''}
                  </span>
                )}
              </div>
            </div>
          );
          }}
      </Draggable>
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto [&>button]:hidden">
          <DialogHeader>
            <div className="flex items-center justify-between w-full">
              <Button
                variant="ghost"
                size="icon"
                onClick={handlePrevTask}
                disabled={!canGoPrev}
                className={cn(
                  "h-8 w-8",
                  !canGoPrev && "opacity-30 cursor-not-allowed"
                )}
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>

              <DialogTitle className="flex items-center gap-2 flex-1 justify-center">
                Dettagli Task #{(displayTask as any).task_id ?? displayTask.id}
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs shrink-0",
                    isStraordinaria
                      ? "bg-red-500 text-white border-red-700"
                      : isPremium
                        ? "bg-yellow-400 text-black border-yellow-600"
                        : "bg-green-500 text-white border-green-700"
                  )}
                >
                  {typeLabel}
                </Badge>
                {(displayTask as any).priority && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs shrink-0",
                      (displayTask as any).priority === "early_out"
                        ? "bg-blue-500 text-white border-blue-700"
                        : (displayTask as any).priority === "high_priority"
                          ? "bg-orange-500 text-white border-orange-700"
                          : "bg-gray-500 text-white border-gray-700"
                    )}
                  >
                    {(displayTask as any).priority === "early_out" 
                      ? "EO" 
                      : (displayTask as any).priority === "high_priority" 
                        ? "HP" 
                        : "LP"}
                  </Badge>
                )}
              </DialogTitle>

              <Button
                variant="ghost"
                size="icon"
                onClick={handleNextTask}
                disabled={!canGoNext}
                className={cn(
                  "h-8 w-8",
                  !canGoNext && "opacity-30 cursor-not-allowed"
                )}
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          </DialogHeader>
          <div className="space-y-4">
            {/* Prima riga: Codice ADAM - Cliente */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Codice ADAM
                </p>
                <p className="text-sm">{displayTask.name}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Cliente
                </p>
                <p className="text-sm">{displayTask.customer_name || "non migrato"}</p>
              </div>
            </div>

            {/* Seconda riga: Indirizzo - Durata pulizie */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Indirizzo
                </p>
                <p className="text-sm">{displayTask.address || "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Durata di pulizia
                </p>
                <p className="text-sm">{displayTask.duration.replace(".", ":")} ore</p>
              </div>
            </div>

            {/* Terza riga: Checkout - Checkin */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Checkout
                </p>
                <p className="text-sm">
                  {(displayTask as any).checkout_date
                    ? new Date((displayTask as any).checkout_date).toLocaleDateString(
                        "it-IT",
                        { day: "2-digit", month: "2-digit", year: "numeric" },
                      )
                    : "non migrato"}
                  {(displayTask as any).checkout_date
                    ? ((displayTask as any).checkout_time
                        ? ` - ${(displayTask as any).checkout_time}`
                        : " - orario non migrato")
                    : ""}
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Checkin
                </p>
                <p className="text-sm">
                  {(displayTask as any).checkin_date
                    ? new Date((displayTask as any).checkin_date).toLocaleDateString(
                        "it-IT",
                        { day: "2-digit", month: "2-digit", year: "numeric" },
                      )
                    : "non migrato"}
                  {(displayTask as any).checkin_date
                    ? ((displayTask as any).checkin_time
                        ? ` - ${(displayTask as any).checkin_time}`
                        : " - orario non migrato")
                    : ""}
                </p>
              </div>
            </div>

            {/* Nuova riga: Travel Time - Start Time/End Time */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Travel Time
                </p>
                <p className="text-sm">
                  {assignmentTimes.travel_time !== undefined 
                    ? `${assignmentTimes.travel_time} minuti` 
                    : "non assegnato"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">
                    Start Time
                  </p>
                  <p className="text-sm">{assignmentTimes.start_time ?? "non assegnato"}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">
                    End Time
                  </p>
                  <p className="text-sm">{assignmentTimes.end_time ?? "non assegnato"}</p>
                </div>
              </div>
            </div>

            {/* Quarta riga: Tipologia appartamento - Tipologia intervento */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Tipologia appartamento
                </p>
                <p className="text-sm">{(displayTask as any).type_apt ?? "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Tipologia intervento
                </p>
                <p className="text-sm">
                  {!isConfirmedOperation ? "non migrato" : (displayTask as any).operation_id ?? "-"}
                </p>
              </div>
            </div>

            {/* Quinta riga: Pax-In - Pax-Out */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Pax-In
                </p>
                <p className="text-sm">{(displayTask as any).pax_in ?? "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Pax-Out
                </p>
                <p className="text-sm">{(displayTask as any).pax_out ?? "non migrato"}</p>
              </div>
            </div>

            {/* Sesta riga: Scambia cleaner (solo in timeline) */}
            {isInTimeline && currentCleanerId && availableCleaners.length > 0 && (
              <div className="border-t pt-4 mt-4">
                <p className="text-sm font-semibold text-muted-foreground mb-3">
                  Scambia Cleaner
                </p>
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <Select 
                      value={selectedSwapCleaner} 
                      onValueChange={setSelectedSwapCleaner}
                      disabled={swapCleanersMutation.isPending}
                    >
                      <SelectTrigger data-testid="select-swap-cleaner">
                        <SelectValue placeholder="Seleziona cleaner..." />
                      </SelectTrigger>
                      <SelectContent>
                        {availableCleaners
                          .filter(c => c.id !== currentCleanerId) // Escludi cleaner corrente
                          .filter(c => {
                            // Mostra solo cleaners con task assegnate
                            const hasTasks = allTasks.some((t: any) => t.assignedCleaner === c.id);
                            return hasTasks;
                          })
                          .map(cleaner => (
                            <SelectItem 
                              key={cleaner.id} 
                              value={String(cleaner.id)}
                              data-testid={`option-cleaner-${cleaner.id}`}
                            >
                              {cleaner.name} {cleaner.lastname}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={handleSwapCleaners}
                    disabled={!selectedSwapCleaner || swapCleanersMutation.isPending}
                    variant="default"
                    className="flex gap-2"
                    data-testid="button-swap-cleaner"
                  >
                    {swapCleanersMutation.isPending ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Scambio...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        Scambia
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}

          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}