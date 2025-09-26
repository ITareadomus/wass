import { Draggable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import { GripVertical, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface TaskCardProps {
  task: Task;
  index: number;
}

export default function TaskCard({ task, index }: TaskCardProps) {
  const { toast } = useToast();

  const scheduleTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const response = await apiRequest("PUT", `/api/tasks/${taskId}/schedule`);
      return response.json();
    },
    onSuccess: (updatedTask) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      toast({
        title: "📅 Task Posizionato nella Timeline",
        description: `"${updatedTask.name}" è ora visibile nella timeline`,
      });
    },
    onError: () => {
      toast({
        title: "❌ Errore Schedulazione",
        description: "Impossibile posizionare il task nella timeline. Riprova.",
        variant: "destructive",
      });
    },
  });

  const handleScheduleTask = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    scheduleTaskMutation.mutate(task.id);
  };
  const getTaskClassByDuration = (duration: string) => {
    const durationNum = parseFloat(duration);
    
    if (durationNum <= 3.0) {
      return "task-duration-short"; // Verde - task brevi
    } else if (durationNum <= 5.0) {
      return "task-duration-medium"; // Arancione - task medi
    } else if (durationNum <= 7.0) {
      return "task-duration-long"; // Viola - task lunghi
    } else {
      return "task-duration-extra-long"; // Rosso - task extra lunghi
    }
  };

  return (
    <Draggable draggableId={task.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={`
            ${task.priority ? getTaskClassByDuration(task.duration) : "task-unassigned"}
            rounded p-2 shadow-sm border transition-all duration-200 text-xs
            ${snapshot.isDragging ? "rotate-2 scale-105 shadow-lg" : ""}
            hover:scale-105 hover:shadow-md cursor-move
          `}
          data-testid={`task-card-${task.id}`}
        >
          <div className="font-medium text-xs" data-testid={`task-name-${task.id}`}>
            {task.name}
          </div>
          <div className="text-xs opacity-75 mt-1" data-testid={`task-type-${task.id}`}>
            {task.type}
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs font-medium" data-testid={`task-duration-${task.id}`}>
              {task.duration}h
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-4 w-4 p-0 hover:bg-background/20"
                onClick={handleScheduleTask}
                disabled={scheduleTaskMutation.isPending}
                data-testid={`button-schedule-${task.id}`}
              >
                <Calendar className="w-2.5 h-2.5" />
              </Button>
              <GripVertical className="w-2.5 h-2.5 opacity-50" />
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}
