
import { Draggable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import { GripVertical } from "lucide-react";
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

  // Calcola la larghezza in base alla durata (ogni 30 minuti = 60px)
  const calculateWidth = (duration: string) => {
    const [hours, minutes] = duration.split(".").map(Number);
    const totalMinutes = hours * 60 + minutes;
    const halfHours = Math.ceil(totalMinutes / 30);
    const width = halfHours * 60; // 60px per ogni mezza ora
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
              rounded-sm p-2 shadow-sm border transition-all duration-200
              ${snapshot.isDragging ? "rotate-2 scale-105 shadow-lg" : ""}
              hover:scale-105 hover:shadow-md cursor-pointer
              flex-shrink-0
            `}
            style={{
              ...provided.draggableProps.style,
              width: calculateWidth(task.duration),
              minHeight: '60px',
            }}
            data-testid={`task-card-${task.id}`}
            onClick={handleCardClick}
          >
            <div className="flex flex-col h-full justify-between">
              <div className="font-medium text-xs leading-tight" data-testid={`task-name-${task.id}`}>
                {task.name}
              </div>
              <div className="text-xs opacity-75 leading-tight" data-testid={`task-type-${task.id}`}>
                {task.type}
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs font-semibold" data-testid={`task-duration-${task.id}`}>
                  {task.duration}h
                </span>
                <GripVertical className="w-3 h-3 opacity-50" />
              </div>
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
