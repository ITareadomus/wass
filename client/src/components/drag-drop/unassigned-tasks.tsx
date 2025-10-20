import { Droppable } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Inbox } from "lucide-react";

interface UnassignedTasksProps {
  tasks: Task[];
}

export default function UnassignedTasks({ tasks }: UnassignedTasksProps) {
  return (
    <div className="bg-muted rounded-lg p-4">
      <h3 className="font-semibold mb-4 text-foreground flex items-center">
        <Inbox className="w-5 h-5 mr-2 text-muted-foreground" />
        Task Non Assegnati
        <span 
          className="ml-2 bg-destructive text-destructive-foreground text-xs px-2 py-1 rounded-full"
          data-testid="unassigned-count"
        >
          {tasks.length}
        </span>
      </h3>
      
      <Droppable droppableId="unassigned">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`
              space-y-2 min-h-48 transition-colors duration-200
              ${snapshot.isDraggingOver ? "drop-zone-active" : ""}
            `}
            data-testid="unassigned-tasks-container"
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
