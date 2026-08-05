import { TaskType as Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Inbox } from "lucide-react";

interface UnassignedTasksProps {
  tasks: Task[];
  hasAssigned?: boolean;
  isDragDisabled?: boolean;
  isReadOnly?: boolean;
}

export default function UnassignedTasks({ tasks, hasAssigned = false, isDragDisabled = false, isReadOnly = false }: UnassignedTasksProps) {
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

      <div
        className="min-h-48 space-y-2 transition-colors duration-200"
        data-testid="unassigned-tasks-container"
      >
        {tasks.map((task, index) => (
          <TaskCard
            key={task.id}
            task={task}
            index={index}
            isDragDisabled={isDragDisabled}
            isReadOnly={isReadOnly}
          />
        ))}
      </div>
    </div>
  );
}