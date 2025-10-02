
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
  icon: "clock" | "alert-circle" | "arrow-down";
  syncedHeight?: number;
  maxTaskCount?: number;
}

export default function PriorityColumn({
  title,
  priority,
  tasks,
  droppableId,
  icon,
  syncedHeight,
  maxTaskCount = 1,
}: PriorityColumnProps) {
  // Calcola la larghezza dinamica delle task in base al numero massimo
  const calculateDynamicTaskWidth = () => {
    if (maxTaskCount <= 0) return 80; // fallback
    
    // Larghezza disponibile per le task (considerando padding e gap)
    const containerWidth = 400; // larghezza approssimativa del container
    const gap = 8; // gap tra le task
    const padding = 16; // padding del container
    
    // Calcola quante task stanno per riga
    const tasksPerRow = Math.ceil(Math.sqrt(maxTaskCount));
    const availableWidth = containerWidth - (padding * 2) - (gap * (tasksPerRow - 1));
    const taskWidth = Math.floor(availableWidth / tasksPerRow);
    
    // Limiti min/max per leggibilità
    return Math.max(60, Math.min(taskWidth, 120));
  };

  const dynamicTaskWidth = calculateDynamicTaskWidth();
  // Calcola altezza minima dinamica: ogni task occupa circa 48px (40px + gap)
  const calculateMinHeight = () => {
    if (syncedHeight) return `${syncedHeight}px`;
    if (tasks.length === 0) return '100px';
    const taskHeight = 48; // altezza task + gap
    const headerHeight = 100; // circa l'altezza dell'header
    const padding = 16; // padding del contenitore
    const totalHeight = (tasks.length * taskHeight) + headerHeight + padding;
    return `${totalHeight}px`;
  };

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

  const handleTimelineAssignment = () => {
    console.log(`Smistamento task ${priority} sulla timeline`);
  };

  return (
    <div className={`${getColumnClass(priority)} rounded-lg p-4 border-2`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className={`font-semibold ${getHeaderClass(priority)} flex items-center`}>
            {renderIcon()}
            {title}
          </h3>
          <div className="text-xs text-muted-foreground mt-1">
            {tasks.length} task
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleTimelineAssignment}
          className="text-xs px-2 py-1 h-7"
          disabled={tasks.length === 0}
        >
          <Calendar className="w-3 h-3 mr-1" />
          Smista
        </Button>
      </div>
      
      <Droppable droppableId={droppableId}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`
              flex flex-wrap gap-2 transition-all duration-300 content-start p-2
              ${snapshot.isDraggingOver ? "drop-zone-active" : ""}
            `}
            style={{
              minHeight: calculateMinHeight()
            }}
            data-testid={`priority-column-${droppableId}`}
          >
            {tasks.map((task, index) => (
              <TaskCard key={task.id} task={task} index={index} dynamicWidth={dynamicTaskWidth} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
