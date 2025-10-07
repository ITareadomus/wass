
import { Draggable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useState } from "react";
import { HelpCircle } from "lucide-react";

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
}

export default function TaskCard({ task, index, isInTimeline = false }: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleCardClick = () => {
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

  // Calcola la larghezza in base alla durata (ogni 30 minuti = 40px)
  const calculateWidth = (duration: string, forTimeline: boolean) => {
    const parts = duration.split(".");
    const hours = parseInt(parts[0] || "0");
    const minutes = parts[1] ? parseInt(parts[1]) : 0;
    const totalMinutes = hours * 60 + minutes;
    
    // Se 0 minuti, usa almeno 30 minuti
    if (totalMinutes === 0) {
      return "40px";
    }
    
    // Se la task dura meno di 1 ora e non è sulla timeline, mostrala come 1 ora
    if (totalMinutes < 60 && !forTimeline) {
      return "80px"; // 1 ora = 80px
    }
    
    // Calcola in base ai 30 minuti = 40px
    const width = Math.ceil(totalMinutes / 30) * 40;
    return `${width}px`;
  };

  return (
    <>
      <Draggable draggableId={task.id} index={index}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.draggableProps}
            {...provided.dragHandleProps}
            className={`
              ${getTaskClassByPriority(task)} 
              rounded-sm px-2 py-1 shadow-sm border transition-all duration-200
              ${snapshot.isDragging ? "rotate-2 scale-105 shadow-lg" : ""}
              hover:scale-105 hover:shadow-md cursor-pointer
              flex-shrink-0 relative
            `}
            style={{
              ...provided.draggableProps.style,
              width: calculateWidth(task.duration, isInTimeline),
              minHeight: '40px',
            }}
            data-testid={`task-card-${task.id}`}
            onClick={handleCardClick}
          >
            {task.confirmed_operation === false && (
              <div className="absolute top-0.5 right-0.5 z-50">
                <HelpCircle className="w-3 h-3 text-gray-900" strokeWidth={2.5} />
              </div>
            )}
            <div className="flex flex-col items-center justify-center h-full gap-0.5">
              <div className="flex items-center gap-1">
                <span className="font-medium text-[10px] leading-none" data-testid={`task-name-${task.id}`}>
                  {task.name}
                </span>
                <span className="text-[8px] opacity-60 leading-none">
                  ({task.duration.replace(".", ":")}h)
                </span>
              </div>
              {task.alias && (
                <span className="text-[8px] opacity-70 leading-none">
                  {task.alias}
                </span>
              )}
            </div>
          </div>
        )}
      </Draggable>

      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Dettagli Task #{task.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Informazioni Base */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">ID Task</p>
                <p className="text-sm">{task.id}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Codice Logistico</p>
                <p className="text-sm">{task.name}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Alias</p>
                <p className="text-sm">{task.alias || 'N/A'}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Cliente</p>
                <p className="text-sm">{task.type}</p>
              </div>
            </div>

            {/* Indirizzo */}
            <div>
              <p className="text-sm font-semibold text-muted-foreground">Indirizzo</p>
              <p className="text-sm">{task.address}</p>
            </div>

            {/* Durata e Tempo */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Durata Pulizia</p>
                <p className="text-sm">{task.duration.replace(".", ":")} ore</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Priorità</p>
                <p className="text-sm capitalize">{task.priority || 'Non assegnata'}</p>
              </div>
            </div>

            {/* Status Flags */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Premium</p>
                <p className="text-sm">{task.premium ? '✅ Sì' : '❌ No'}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Straordinaria</p>
                <p className="text-sm">{task.is_straordinaria ? '✅ Sì' : '❌ No'}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Operazione Confermata</p>
                <p className="text-sm">{task.confirmed_operation === false ? '❓ Da Confermare' : task.confirmed_operation ? '✅ Confermata' : '❌ No'}</p>
              </div>
            </div>

            {/* Assegnazione */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Assegnato a</p>
                <p className="text-sm">{task.assignedTo || 'Non assegnato'}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Stato</p>
                <p className="text-sm capitalize">{task.status}</p>
              </div>
            </div>

            {/* Timestamp */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Creato il</p>
                <p className="text-sm">{new Date(task.createdAt).toLocaleString('it-IT')}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">Ultimo aggiornamento</p>
                <p className="text-sm">{new Date(task.updatedAt).toLocaleString('it-IT')}</p>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
