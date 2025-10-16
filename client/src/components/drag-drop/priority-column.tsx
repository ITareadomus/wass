import { Droppable } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Clock, AlertCircle, ArrowDown, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

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

  const handleTimelineAssignment = async () => {
    if (priority === 'early-out') {
      // Esegui il nuovo script ottimizzato opt.py
      try {
        console.log('Esecuzione opt.py (algoritmo ottimizzato)...');
        const response = await fetch('/api/assign-unified', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
          throw new Error('Errore durante l\'assegnazione ottimizzata');
        }

        const result = await response.json();
        console.log('Assegnazione ottimizzata completata:', result);

        // Svuota il file early_out.json
        await fetch('/api/clear-early-out-json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });

        toast({
          variant: "success",
          title: "✅ EARLY-OUT assegnati con successo!",
        });

        // Ricarica tutti i task per aggiornare i filtri e la timeline
        if ((window as any).reloadAllTasks) {
          await (window as any).reloadAllTasks();
        }
        
        // Ricarica anche le assegnazioni early-out
        if ((window as any).reloadEarlyOutAssignments) {
          await (window as any).reloadEarlyOutAssignments();
        }
      } catch (error) {
        console.error('Errore nell\'assegnazione:', error);
        toast({
          title: "❌ EARLY-OUT non assegnati, errore nel caricamento!",
          variant: "destructive",
        });
      }
    } else if (priority === 'high') {
      try {
        // Placeholder per high priority
        console.log('High priority assignment non ancora implementato');
        toast({
          variant: "success",
          title: "✅ HIGH-PRIORITY assegnati con successo!",
        });
      } catch (error) {
        console.error('Errore nell\'assegnazione high priority:', error);
        toast({
          title: "❌ HIGH-PRIORITY non assegnati, errore nel caricamento!",
          variant: "destructive",
        });
      }
    } else if (priority === 'low') {
      try {
        // Placeholder per low priority
        console.log('Low priority assignment non ancora implementato');
        toast({
          variant: "success",
          title: "✅ LOW-PRIORITY assegnati con successo!",
        });
      } catch (error) {
        console.error('Errore nell\'assegnazione low priority:', error);
        toast({
          title: "❌ LOW-PRIORITY non assegnati, errore nel caricamento!",
          variant: "destructive",
        });
      }
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
              flex flex-wrap gap-2 min-h-[120px] transition-colors duration-200 content-start p-2
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