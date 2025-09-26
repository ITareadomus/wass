
import { Droppable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Clock, AlertCircle, ArrowDown, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PriorityColumnProps {
  title: string;
  priority: string;
  tasks: Task[];
  droppableId: string;
  icon: string;
}

export default function PriorityColumn({ 
  title, 
  priority, 
  tasks, 
  droppableId, 
  icon 
}: PriorityColumnProps) {
  const getIcon = () => {
    switch (icon) {
      case "clock":
        return <Clock className="w-5 h-5" />;
      case "alert-circle":
        return <AlertCircle className="w-5 h-5" />;
      case "arrow-down":
        return <ArrowDown className="w-5 h-5" />;
      default:
        return <Clock className="w-5 h-5" />;
    }
  };

  const handleScheduleAllTasks = () => {
    // Per adesso non fa nulla come richiesto
    console.log(`Smistamento automatico timeline per ${title} - ${tasks.length} task`);
  };

  const getPriorityColor = () => {
    switch (priority) {
      case "early-out":
        return "border-orange-300 bg-orange-50";
      case "high":
        return "border-green-300 bg-green-50";
      case "low":
        return "border-lime-300 bg-lime-50";
      default:
        return "border-gray-300 bg-gray-50";
    }
  };

  return (
    <div className={`rounded-lg border-2 ${getPriorityColor()}`}>
      <div className="p-4 border-b border-border">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold text-foreground flex items-center">
            <div className="text-primary mr-2">
              {getIcon()}
            </div>
            {title}
            <span 
              className="ml-2 bg-primary text-primary-foreground text-xs px-2 py-1 rounded-full"
              data-testid={`${priority}-count`}
            >
              {tasks.length}
            </span>
          </h3>
        </div>
        
        {/* Pulsante per smistamento automatico timeline */}
        <Button
          size="sm"
          variant="outline"
          className="w-full flex items-center justify-center gap-2"
          onClick={handleScheduleAllTasks}
          disabled={tasks.length === 0}
          data-testid={`button-schedule-all-${priority}`}
        >
          <Calendar className="w-4 h-4" />
          <span className="text-xs">Smista su Timeline ({tasks.length})</span>
        </Button>
      </div>
      
      <Droppable droppableId={droppableId}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`
              p-4 space-y-2 min-h-64 transition-colors duration-200
              ${snapshot.isDraggingOver ? "drop-zone-active" : ""}
            `}
            data-testid={`${priority}-tasks-container`}
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
