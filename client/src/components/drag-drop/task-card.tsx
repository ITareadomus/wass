import { Draggable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import { GripVertical, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";

interface TaskCardProps {
  task: Task;
  index: number;
}

export default function TaskCard({ task, index }: TaskCardProps) {
  const { toast } = useToast();
  const [isModalOpen, setIsModalOpen] = useState(false);

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
              rounded-md p-3 shadow-sm border transition-all duration-200
              ${snapshot.isDragging ? "rotate-2 scale-105 shadow-lg" : ""}
              hover:scale-105 hover:shadow-md cursor-pointer
            `}
            data-testid={`task-card-${task.id}`}
            onClick={handleCardClick}
          >
          <div className="font-medium text-sm" data-testid={`task-name-${task.id}`}>
            {task.name}
          </div>
          <div className="text-xs opacity-75" data-testid={`task-type-${task.id}`}>
            {task.type}
          </div>
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs" data-testid={`task-duration-${task.id}`}>
              {task.duration}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 hover:bg-background/20"
                onClick={handleScheduleTask}
                disabled={scheduleTaskMutation.isPending}
                data-testid={`button-schedule-${task.id}`}
              >
                <Calendar className="w-3 h-3" />
              </Button>
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
