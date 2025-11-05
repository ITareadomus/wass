import { Droppable } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Clock, AlertCircle, ArrowDown, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useState } from "react";

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
  const { toast } = useToast();
  const [isAssigning, setIsAssigning] = useState(false);

  const getColumnClass = (priority: string, tasks: Task[]) => {
    switch (priority) {
      case "early-out":
        return "bg-sky-100 border-sky-400";
      case "high":
        return "bg-sky-100 border-sky-400";
      case "low":
        return "bg-sky-100 border-sky-400";
      default:
        return "bg-gray-50 border-gray-300";
    }
  };

  const getHeaderClass = (priority: string) => {
    switch (priority) {
      case "early-out":
        return "text-sky-800";
      case "high":
        return "text-sky-800";
      case "low":
        return "text-sky-800";
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

  const handleAssignContainer = async () => {
    try {
      setIsAssigning(true);
      const savedDate = localStorage.getItem('selected_work_date');
      if (!savedDate) {
        toast({
          variant: "destructive",
          title: "Errore",
          description: "Nessuna data selezionata",
        });
        setIsAssigning(false);
        return;
      }
      // La data è già nel formato corretto yyyy-MM-dd, non serve più lo split
      const dateStr = savedDate;

      let endpoint = '';
      let successMessage = '';

      switch (priority) {
        case 'early-out':
          endpoint = '/api/assign-early-out-to-timeline';
          successMessage = '✅ EARLY-OUT assegnati con successo!';
          break;
        case 'high':
          endpoint = '/api/assign-high-priority-to-timeline';
          successMessage = '✅ HIGH PRIORITY assegnati con successo!';
          break;
        case 'low':
          endpoint = '/api/assign-low-priority-to-timeline';
          successMessage = '✅ LOW PRIORITY assegnati con successo!';
          break;
        default:
          throw new Error('Tipo di container non supportato');
      }

      console.log(`🔄 Esecuzione assegnazione ${priority} per data: ${dateStr}`);
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      if (!response.ok) {
        throw new Error(`Errore durante l'assegnazione ${priority}`);
      }

      const result = await response.json();
      console.log(`Assegnazione ${priority} completata:`, result);

      toast({
        variant: "success",
        title: "Successo",
        description: successMessage,
      });

      // Ricarica i task per riflettere le nuove assegnazioni
      if ((window as any).reloadAllTasks) {
        console.log('🔄 Ricaricamento task dopo assegnazione...');
        await (window as any).reloadAllTasks();
        console.log('✅ Task ricaricati con successo');
      }
    } catch (error: any) {
      console.error(`Errore nell'assegnazione ${priority}:`, error);
      toast({
        title: "Errore",
        description: `${title} non assegnati, errore!`,
        variant: "destructive",
      });
    } finally {
      setIsAssigning(false);
    }
  };

  return (
    <div className={`${getColumnClass(priority, tasks)} rounded-lg p-4 border-2`}>
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
          onClick={handleAssignContainer}
          disabled={isAssigning || tasks.length === 0}
          className="text-xs px-2 py-1 h-7"
        >
          {isAssigning ? (
            <>
              <span className="animate-spin mr-2">⏳</span>
              Assegnando...
            </>
          ) : (
            <>
              <Calendar className="w-3 h-3 mr-1" />
              Assegna
            </>
          )}
        </Button>
      </div>

      <Droppable droppableId={droppableId}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`
              flex flex-wrap gap-2 min-h-[120px] transition-colors duration-200 content-start p-2
              ${snapshot.isDraggingOver ? "drop-zone-active" : ""}
            `}
            data-testid={`priority-column-${droppableId}`}
          >
            {tasks.map((task, index) => (
              <TaskCard
                key={task.id}
                task={task}
                index={index}
                isInTimeline={false}
                allTasks={tasks}
                currentContainer={droppableId}
              />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}