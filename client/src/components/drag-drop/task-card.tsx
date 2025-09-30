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
              rounded-sm p-1.5 shadow-sm border transition-all duration-200
              ${snapshot.isDragging ? "rotate-2 scale-105 shadow-lg" : ""}
              hover:scale-105 hover:shadow-md cursor-pointer
            `}
            data-testid={`task-card-${task.id}`}
            onClick={handleCardClick}
          >
          <div className="font-medium text-xs leading-tight" data-testid={`task-name-${task.id}`}>
            {task.name}
          </div>
          <div className="text-xs opacity-75 leading-tight" data-testid={`task-type-${task.id}`}>
            {task.type}
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs" data-testid={`task-duration-${task.id}`}>
              {task.duration}
            </span>
            <GripVertical className="w-2.5 h-2.5 opacity-50" />
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
