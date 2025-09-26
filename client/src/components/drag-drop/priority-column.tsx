import { Droppable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Clock, AlertCircle, ArrowDown } from "lucide-react";

interface PriorityColumnProps {
  title: string;
  priority: string;
  tasks: Task[];
  droppableId: string;
  icon: "clock" | "alert-circle" | "arrow-down";
}

export default function PriorityColumn({
  title,
  priority,
  tasks,
  droppableId,
  icon,
}: PriorityColumnProps) {
  const getColumnClass = (priority: string) => {
    switch (priority) {
      case "early-out":
        return "priority-column-early border-orange-200";
      case "high":
        return "priority-column-high border-green-200";
      case "low":
        return "priority-column-low border-lime-200";
      default:
        return "bg-muted border-border";
    }
  };

  const getHeaderClass = (priority: string) => {
    switch (priority) {
      case "early-out":
        return "text-orange-800";
      case "high":
        return "text-green-800";
      case "low":
        return "text-lime-800";
      default:
        return "text-foreground";
    }
  };

  const renderIcon = () => {
    switch (icon) {
      case "clock":
        return <Clock className="w-5 h-5 mr-2" />;
      case "alert-circle":
        return <AlertCircle className="w-5 h-5 mr-2" />;
      case "arrow-down":
        return <ArrowDown className="w-5 h-5 mr-2" />;
    }
  };

  return (
    <div className={`${getColumnClass(priority)} rounded-lg p-4 border-2`}>
      <h3 className={`font-semibold mb-4 ${getHeaderClass(priority)} flex items-center`}>
        {renderIcon()}
        {title}
      </h3>
      
      <Droppable droppableId={droppableId}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`
              space-y-2 min-h-48 transition-colors duration-200
              ${snapshot.isDraggingOver ? "drop-zone-active" : ""}
            `}
            data-testid={`priority-column-${droppableId}`}
          >
            {tasks.map((task, index) => (
              <TaskCard key={task.id} task={task} index={index} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
