import { Draggable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect } from "react";
import { HelpCircle } from "lucide-react";

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
}

export default function TaskCard({
  task,
  index,
  isInTimeline = false,
}: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [assignmentTimes, setAssignmentTimes] = useState<{ start_time?: string; end_time?: string }>({});

  useEffect(() => {
    const loadAssignmentTimes = async () => {
      try {
        const response = await fetch('/data/output/early_out_assignments.json');
        if (response.ok) {
          const data = await response.json();
          const taskId = (task as any).task_id ?? task.id;
          
          // Cerca la task nelle assegnazioni
          for (const cleanerEntry of data.early_out_tasks_assigned || []) {
            const assignedTask = cleanerEntry.tasks?.find((t: AssignedTask) => 
              String(t.task_id) === String(taskId) || String(t.logistic_code) === String(task.name)
            );
            if (assignedTask) {
              setAssignmentTimes({
                start_time: assignedTask.start_time,
                end_time: assignedTask.end_time
              });
              break;
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

  const getTaskClassByPriority = (task: Task) => {
    // Se is_straordinaria è true, sempre rosso
    if (task.is_straordinaria) {
      return "task-straordinaria";
    }
    // Se premium è true, dorato
    if (task.premium) {
      return "task-premium";
    }
    // Se premium è false o non presente, verde
    return "task-standard";
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
                ${getTaskClassByPriority(task)} 
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
            >
            {task.confirmed_operation === false && (
              <div className="absolute top-0.5 right-0.5 z-50">
                <HelpCircle
                  className="w-3 h-3 text-gray-900"
                  strokeWidth={2.5}
                />
              </div>
            )}
            <div 
              className="flex flex-col items-center justify-center h-full gap-0.5 cursor-pointer"
              onClick={handleCardClick}
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
              {task.is_straordinaria ? (
                <Badge className="bg-red-500 text-white border-2 border-black">
                  Straordinaria
                </Badge>
              ) : task.premium ? (
                <Badge className="bg-yellow-400 text-black border-2 border-black">
                  Premium
                </Badge>
              ) : (
                <Badge className="bg-green-500 text-white">Standard</Badge>
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
                  {(task as any).operation_id === 2 && !(task as any).confirmed_operation
                    ? "non migrato"
                    : (task as any).operation_id ?? "non migrato"}
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

            {/* Sesta riga: Start Time - End Time */}
            <div className="grid grid-cols-2 gap-4">
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
        </DialogContent>
      </Dialog>
    </>
  );
}
