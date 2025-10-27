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
  // State to track if assignments are in progress
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

  const handleTimelineAssignment = async () => {
    if (priority === 'early-out') {
      // Esegui lo script di assegnazione assign_eo.py
      try {
        // Ottieni la data selezionata dal localStorage
        const savedDate = localStorage.getItem('selected_work_date');
        const selectedDate = savedDate ? new Date(savedDate) : new Date();
        const dateStr = selectedDate.toISOString().split('T')[0];

        console.log('Esecuzione assign_eo.py per data:', dateStr);
        const response = await fetch('/api/run-optimizer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: dateStr })
        });

        if (!response.ok) {
          throw new Error('Errore durante l\'assegnazione ottimizzata');
        }

        const result = await response.json();
        console.log('Assegnazione ottimizzata completata:', result);

        toast({
          variant: "success",
          title: "✅ EARLY-OUT assegnati con successo!",
        });

        // Ricarica i task per riflettere le nuove assegnazioni
        if ((window as any).reloadAllTasks) {
          await (window as any).reloadAllTasks();
        }

        // Ricarica la pagina per aggiornare i marker sulla mappa
        window.location.reload();
      } catch (error: any) {
        console.error('Errore durante l\'assegnazione:', error);
        toast({
          variant: "destructive",
          title: "Errore durante l'assegnazione",
          description: error.message,
        });
      }
    } else if (priority === 'high') {
      // This part is handled by handleAssignHighPriority now
    } else if (priority === 'low') {
      try {
        // Ottieni la data selezionata dal localStorage
        const savedDate = localStorage.getItem('selected_work_date');
        const selectedDate = savedDate ? new Date(savedDate) : new Date();
        const dateStr = selectedDate.toISOString().split('T')[0];

        console.log('Esecuzione assign_lp.py per data:', dateStr);
        const response = await fetch('/api/assign-lp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: dateStr })
        });

        if (!response.ok) {
          throw new Error('Errore durante l\'assegnazione LP');
        }

        const result = await response.json();
        console.log('Assegnazione LP completata:', result);

        toast({
          variant: "success",
          title: "✅ LOW PRIORITY assegnati con successo!",
        });

        // Ricarica i task
        if ((window as any).reloadAllTasks) {
          await (window as any).reloadAllTasks();
        }

        // Ricarica la pagina per aggiornare i marker sulla mappa
        window.location.reload();
      } catch (error: any) {
        console.error('Errore nell\'assegnazione LP:', error);
        toast({
          title: "❌ LOW PRIORITY non assegnati, errore!",
          variant: "destructive",
        });
      }
    }
  };

  const handleAssignHighPriority = async () => {
    try {
      setIsAssigning(true);
      const savedDate = localStorage.getItem('selected_work_date');
      const selectedDate = savedDate ? new Date(savedDate) : new Date();
      const dateStr = selectedDate.toISOString().split('T')[0];

      console.log('Esecuzione assign_hp.py per data:', dateStr);
      const response = await fetch('/api/assign-hp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      if (!response.ok) {
        throw new Error('Errore durante l\'assegnazione high priority');
      }

      const result = await response.json();
      console.log('Assegnazione HP completata:', result);

      toast({
        variant: "success",
        title: "✅ HIGH PRIORITY assegnati con successo!",
      });

      // Ricarica i task
      if (typeof (window as any).reloadAllTasks === 'function') {
        await (window as any).reloadAllTasks();
      }
    } catch (error: any) {
      console.error('Errore nell\'assegnazione HP:', error);
      toast({
        title: "❌ HIGH-PRIORITY non assegnati, errore!",
        variant: "destructive",
      });
    } finally {
      setIsAssigning(false);
    }
  };

  const handleAssignLowPriority = async () => {
    try {
      setIsAssigning(true);
      const savedDate = localStorage.getItem('selected_work_date');
      const selectedDate = savedDate ? new Date(savedDate) : new Date();
      const dateStr = selectedDate.toISOString().split('T')[0];


      const response = await fetch('/api/assign-lp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      if (!response.ok) {
        throw new Error('Errore durante l\'assegnazione low priority');
      }

      const result = await response.json();
      console.log('Assegnazione LP completata:', result);

      toast({
        variant: "success",
        title: "✅ LOW PRIORITY assegnati con successo!",
      });

      // Ricarica i task
      if (typeof (window as any).reloadAllTasks === 'function') {
        await (window as any).reloadAllTasks();
      }
    } catch (error) {
      console.error('Errore nell\'assegnazione LP:', error);
      toast({
        title: "❌ LOW PRIORITY non assegnati, errore!",
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
        {priority === "high" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleAssignHighPriority}
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
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleTimelineAssignment}
            className="text-xs px-2 py-1 h-7"
            disabled={tasks.length === 0}
          >
            <Calendar className="w-3 h-3 mr-1" />
            Assegna
          </Button>
        )}
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