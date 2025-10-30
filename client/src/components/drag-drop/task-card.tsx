import { Draggable } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
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
}: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [assignmentTimes, setAssignmentTimes] = useState<{ start_time?: string; end_time?: string; travel_time?: number }>({});

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
        const taskObj = task as any;
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
  }, [isModalOpen, task]);

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
              className="flex flex-col items-center justify-center h-full gap-0.5"
            >
              <div className="flex items-center gap-1">
                <span
                  className="font-medium text-[10px] leading-none"
                  data-testid={`task-name-${task.id}`}
                >
                  {task.name}
                </span>
                <span className="text-[8px] opacity-60 leading-none">
                  ({task.duration.replace(".", ":")}h)
                </span>
              </div>
              {task.alias && (
                <span className="text-[8px] opacity-70 leading-none">
                  {task.alias}{(task as any).type_apt ? ` (${(task as any).type_apt})` : ''}
                </span>
              )}
            </div>
          </div>
            );
          }}
      </Draggable>

      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Dettagli Task #{(task as any).task_id ?? task.id}
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
              {(task as any).priority && (
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs shrink-0",
                    (task as any).priority === "early_out"
                      ? "bg-blue-500 text-white border-blue-700"
                      : (task as any).priority === "high_priority"
                        ? "bg-orange-500 text-white border-orange-700"
                        : "bg-gray-500 text-white border-gray-700"
                  )}
                >
                  {(task as any).priority === "early_out" 
                    ? "EO" 
                    : (task as any).priority === "high_priority" 
                      ? "HP" 
                      : "LP"}
                </Badge>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Prima riga: Codice ADAM - Cliente */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Codice ADAM
                </p>
                <p className="text-sm">{task.name}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Cliente
                </p>
                <p className="text-sm">{task.customer_name || "non migrato"}</p>
              </div>
            </div>

            {/* Seconda riga: Indirizzo - Durata pulizie */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Indirizzo
                </p>
                <p className="text-sm">{task.address || "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Durata di pulizia
                </p>
                <p className="text-sm">{task.duration.replace(".", ":")} ore</p>
              </div>
            </div>

            {/* Terza riga: Checkout - Checkin */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Checkout
                </p>
                <p className="text-sm">
                  {(task as any).checkout_date
                    ? new Date((task as any).checkout_date).toLocaleDateString(
                        "it-IT",
                        { day: "2-digit", month: "2-digit", year: "numeric" },
                      )
                    : "non migrato"}
                  {(task as any).checkout_date
                    ? ((task as any).checkout_time
                        ? ` - ${(task as any).checkout_time}`
                        : " - orario non migrato")
                    : ""}
                </p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Checkin
                </p>
                <p className="text-sm">
                  {(task as any).checkin_date
                    ? new Date((task as any).checkin_date).toLocaleDateString(
                        "it-IT",
                        { day: "2-digit", month: "2-digit", year: "numeric" },
                      )
                    : "non migrato"}
                  {(task as any).checkin_date
                    ? ((task as any).checkin_time
                        ? ` - ${(task as any).checkin_time}`
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
                <p className="text-sm">{(task as any).type_apt ?? "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Tipologia intervento
                </p>
                <p className="text-sm">
                  {!isConfirmedOperation ? "non migrato" : (task as any).operation_id ?? "-"}
                </p>
              </div>
            </div>

            {/* Quinta riga: Pax-In - Pax-Out */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Pax-In
                </p>
                <p className="text-sm">{(task as any).pax_in ?? "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Pax-Out
                </p>
                <p className="text-sm">{(task as any).pax_out ?? "non migrato"}</p>
              </div>
            </div>


          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}