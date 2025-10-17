import { Draggable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { HelpCircle } from "lucide-react";

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
}

export default function TaskCard({
  task,
  index,
  isInTimeline = false,
}: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

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
              Dettagli Task #{task.name}
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
            {/* Informazioni Base */}
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
                <p className="text-sm">{task.customer_name || "N/A"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Tipologia
                </p>
                <p className="text-sm">{(task as any).type_apt ?? "N/A"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Durata di pulizia
                </p>
                <p className="text-sm">{task.duration.replace(".", ":")} ore</p>
              </div>
            </div>

            {/* Indirizzo */}
            <div>
              <p className="text-sm font-semibold text-muted-foreground">
                Indirizzo
              </p>
              <p className="text-sm">{task.address || "N/A"}</p>
            </div>

            {/* Date e orari */}
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
                    : "N/A"}
                  {(task as any).checkout_time
                    ? ` - ${(task as any).checkout_time}`
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
                    : "N/A"}
                  {(task as any).checkin_time
                    ? ` - ${(task as any).checkin_time}`
                    : ""}
                </p>
              </div>
            </div>

            {/* Pax */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Pax-In
                </p>
                <p className="text-sm">{(task as any).pax_in ?? "N/A"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Pax-Out
                </p>
                <p className="text-sm">{(task as any).pax_out ?? "N/A"}</p>
              </div>
            </div>

            {/* Tipologia intervento */}
            <div>
              <p className="text-sm font-semibold text-muted-foreground">
                Tipologia intervento
              </p>
              <p className="text-sm">
                {(task as any).operation_id === 2 && !(task as any).confirmed_operation
                  ? "non migrato"
                  : (task as any).operation_id ?? "N/A"}
              </p>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
