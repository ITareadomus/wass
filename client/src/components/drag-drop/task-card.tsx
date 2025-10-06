
import { Draggable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useState } from "react";

interface TaskCardProps {
  task: Task;
  index: number;
}

export default function TaskCard({ task, index }: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);

  const handleCardClick = () => {
    setIsModalOpen(true);
  };

  const getTaskClassByPriority = (priority: string | null) => {
    switch (priority) {
      case "early-out":
        return "task-early-out";
      case "high":
        return "task-high-priority";
      case "low":
        return "task-low-priority";
      default:
        return "task-unassigned";
    }
  };

  // Calcola la larghezza in base alla durata (ogni 30 minuti = 40px)
  const calculateWidth = (duration: string) => {
    const parts = duration.split(".");
    const hours = parseInt(parts[0] || "0");
    const minutes = parts[1] ? parseInt(parts[1]) : 0;
    const totalMinutes = hours * 60 + minutes;
    
    // Caso eccezionale: 30 minuti = larghezza di 1 ora
    if (totalMinutes === 30) {
      return "80px"; // Larghezza di 1 ora (2 * 40px)
    }
    
    const halfHours = Math.ceil(totalMinutes / 30);
    const width = halfHours * 40; // 40px per ogni mezza ora (ridotto)
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
              ${getTaskClassByPriority(task.priority)} 
              rounded-sm px-2 py-1 shadow-sm border transition-all duration-200
              ${snapshot.isDragging ? "rotate-2 scale-105 shadow-lg" : ""}
              hover:scale-105 hover:shadow-md cursor-pointer
              flex-shrink-0
            `}
            style={{
              ...provided.draggableProps.style,
              width: calculateWidth(task.duration),
              minHeight: '40px',
            }}
            data-testid={`task-card-${task.id}`}
            onClick={handleCardClick}
          >
            <div className="flex items-center justify-center h-full gap-1">
              <span className="font-medium text-[10px] leading-none" data-testid={`task-name-${task.id}`}>
                {task.name}
              </span>
              <span className="text-[8px] opacity-60 leading-none">
                ({task.duration.replace(".", ":")}h)
              </span>
            </div>
          </div>
        )}
      </Draggable>

      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Dettagli Task</DialogTitle>
          </DialogHeader>
          <div className="p-4">
            {/* Empty content as requested */}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
