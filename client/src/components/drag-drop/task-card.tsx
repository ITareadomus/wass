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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useState, useEffect } from "react";
import { HelpCircle, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
  allTasks?: Task[];
  currentContainer?: string;
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
}: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState(task.id);
  const [assignmentTimes, setAssignmentTimes] = useState<{ start_time?: string; end_time?: string; travel_time?: number }>({});

  // Determina le task navigabili in base al contesto
  const getNavigableTasks = () => {
    if (!allTasks || allTasks.length === 0) return [];

    if (isInTimeline) {
      // In timeline: le task sono già filtrate per cleaner, usa direttamente allTasks
      return allTasks;
    } else {
      // Nei container: ritorna tutte le task del container
      return allTasks;
    }
  };

  const navigableTasks = getNavigableTasks();
  const currentTaskInNavigable = navigableTasks.findIndex(t => t.id === currentTaskId);

  const canGoPrev = currentTaskInNavigable > 0;
  const canGoNext = currentTaskInNavigable < navigableTasks.length - 1;

  const handlePrevTask = () => {
    if (!canGoPrev) return;
    const prevTask = navigableTasks[currentTaskInNavigable - 1];
    setCurrentTaskId(prevTask.id);
  };

  const handleNextTask = () => {
    if (!canGoNext) return;
    const nextTask = navigableTasks[currentTaskInNavigable + 1];
    setCurrentTaskId(nextTask.id);
  };

  // Reset currentTaskId quando il modale si apre
  useEffect(() => {
    if (isModalOpen) {
      setCurrentTaskId(task.id);
    }
  }, [isModalOpen, task.id]);

  // Task corrente da visualizzare - trova sempre per ID
  const displayTask = allTasks.find(t => t.id === currentTaskId) || task;

  // DEBUG: Log per verificare i flag della task durante navigazione
  useEffect(() => {
    if (isModalOpen) {
      console.log(`Task ${(displayTask as any).logistic_code || displayTask.name}:`, {
        premium: displayTask.premium,
        straordinaria: displayTask.straordinaria,
        currentTaskId: currentTaskId
      });
    }
  }, [currentTaskId, isModalOpen, displayTask]);

  // Normalizza confirmed_operation da boolean/number/string a boolean sicuro
  // USA displayTask invece di task
  const rawConfirmed = (displayTask as any).confirmed_operation;
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
  // USA displayTask invece di task
  const isPremium = Boolean(displayTask.premium);
  const isStraordinaria = Boolean(displayTask.straordinaria);

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
    // I dati sono già presenti nell'oggetto task (dalla timeline o dai containers)
    const taskObj = displayTask as any;
    if (taskObj.startTime || taskObj.start_time) {
      setAssignmentTimes({
        start_time: taskObj.start_time || taskObj.startTime,
        end_time: taskObj.end_time || taskObj.endTime,
        travel_time: taskObj.travel_time || taskObj.travelTime
      });
    }
  }, [displayTask, currentTaskId]);

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
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
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
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-base px-3 py-2">
                  <p className="font-semibold">{displayTask.address?.toLowerCase() || "indirizzo non disponibile"}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
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
                <p className="text-sm">{displayTask.address?.toLowerCase() || "non migrato"}</p>
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

          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}