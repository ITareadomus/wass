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
}

export default function PriorityColumn({
  title,
  priority,
  tasks,
  droppableId,
  icon,
}: PriorityColumnProps) {
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
      // Esegui assign_eo.py per early-out
      try {
        console.log('Esecuzione assign_eo.py...');
        const response = await fetch('/api/assign-early-out', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
          throw new Error('Errore durante l\'assegnazione early-out');
        }

        const result = await response.json();
        console.log('Assegnazione early-out completata:', result);

        // Carica le assegnazioni dal file generato
        const assignmentsResponse = await fetch('/data/output/early_out_assignments.json');
        if (!assignmentsResponse.ok) {
          throw new Error('Errore nel caricamento delle assegnazioni');
        }

        const assignmentsData = await assignmentsResponse.json();
        const assignments = assignmentsData.early_out_tasks_assigned || [];

        // Aggiorna lo stato delle task tramite API
        for (const assignment of assignments) {
          if (assignment.assigned_cleaner && assignment.assignment_status === 'assigned') {
            await fetch('/api/save-assignments', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify([{
                id: String(assignment.task_id),
                assignedCleaner: assignment.assigned_cleaner.id,
                assignedSlot: 0,
                startTime: assignment.assigned_cleaner.start_time
              }])
            });
          }
        }

        alert('Early-out tasks assegnati con successo!');

        // Ricarica la pagina per mostrare le nuove assegnazioni
        window.location.reload();
      } catch (error) {
        console.error('Errore nell\'assegnazione early-out:', error);
        alert('Errore durante l\'assegnazione dei task early-out');
      }
    } else {
      // Logica originale per high e low priority
      alert(`Auto-assign per ${priority} non ancora implementato`);
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