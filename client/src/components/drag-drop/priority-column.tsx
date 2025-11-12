import { Droppable } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Clock, AlertCircle, ArrowDown, Calendar, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useState, useEffect } from "react";
import { useMultiSelect } from "@/pages/generate-assignments";

interface PriorityColumnProps {
  title: string;
  priority: string;
  tasks: Task[];
  droppableId: string;
  icon: "clock" | "alert-circle" | "arrow-down";
  assignAction?: () => Promise<void>;
  isDragDisabled?: boolean;
}

export default function PriorityColumn({
  title,
  priority,
  tasks,
  droppableId,
  icon,
  assignAction,
  isDragDisabled = false,
}: PriorityColumnProps) {
  const [isAssigning, setIsAssigning] = useState(false);
  const [isDateInPast, setIsDateInPast] = useState(false);
  const { toast } = useToast();
  const [hasAssigned, setHasAssigned] = useState(false);
  
  // Usa il context per multi-select
  const multiSelectCtx = useMultiSelect();
  const { isMultiSelectMode, selectedTasks, toggleMode, toggleTask, isTaskSelected, getTaskOrder } = multiSelectCtx;
  
  console.log('[DEBUG PriorityColumn]', priority, 'isMultiSelectMode:', isMultiSelectMode, 'selectedTasks:', selectedTasks.length);

  // Verifica se la data selezionata è nel passato
  useEffect(() => {
    const checkIfDateInPast = () => {
      const savedDate = localStorage.getItem('selected_work_date');
      if (!savedDate) {
        setIsDateInPast(false);
        return;
      }

      const [year, month, day] = savedDate.split('-').map(Number);
      const selectedDate = new Date(year, month - 1, day);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      selectedDate.setHours(0, 0, 0, 0);

      setIsDateInPast(selectedDate < today);
    };

    checkIfDateInPast();

    // Ricontrolla quando cambia la data
    const interval = setInterval(checkIfDateInPast, 1000);
    return () => clearInterval(interval);
  }, []);

  const iconMap: Record<string, React.ReactNode> = {
    clock: <Clock className="w-5 h-5 mr-2 text-muted-foreground" />,
    "alert-circle": <AlertCircle className="w-5 h-5 mr-2 text-muted-foreground" />,
    "arrow-down": <ArrowDown className="w-5 h-5 mr-2 text-muted-foreground" />,
  };

  // Identifica task duplicate basandosi sul logistic_code
  const logisticCodeCounts = tasks.reduce((acc, task) => {
    const code = task.name; // name contiene il logistic_code
    acc[code] = (acc[code] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const isDuplicateTask = (task: Task) => {
    return logisticCodeCounts[task.name] > 1;
  };

  // Funzione modificata per usare hasAssigned
  const handleAssign = async () => {
    if (assignAction) {
      await assignAction();
      setHasAssigned(true); // Imposta hasAssigned a true dopo l'assegnazione
    }
  };


  const getColumnClass = (priority: string, tasks: Task[]) => {
    switch (priority) {
      case "early-out":
        return "bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 border-sky-400";
      case "high":
        return "bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 border-sky-400";
      case "low":
        return "bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 border-sky-400";
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
            {isMultiSelectMode && selectedTasks.length > 0 && (
              <span className="ml-2 text-sky-600 font-semibold">
                ({selectedTasks.filter(st => tasks.some(t => t.id === st.taskId)).length} selezionate)
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant={isMultiSelectMode ? "default" : "outline"}
            size="sm"
            onClick={toggleMode}
            disabled={tasks.length === 0 || isDateInPast}
            className="text-xs px-2 py-1 h-7 border-2 border-sky-400"
            title={isMultiSelectMode ? "Disattiva selezione multipla" : "Attiva selezione multipla"}
            data-testid="button-toggle-multiselect"
          >
            <CheckSquare className={`w-3 h-3 ${isMultiSelectMode ? 'mr-1' : ''}`} />
            {isMultiSelectMode && <span className="ml-1">On</span>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAssign} // Utilizza handleAssign
            disabled={isAssigning || tasks.length === 0 || isDateInPast}
            className="text-xs px-2 py-1 h-7 border-2 border-sky-400"
            title={isDateInPast ? "Non puoi assegnare task per date passate" : ""}
            data-testid="button-assign"
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
            {tasks.map((task, index) => {
              // Verifica se è duplicata (stesso logistic_code ma id diverso)
              const isDuplicate = hasAssigned && tasks.some(
                t => t.name === task.name && t.id !== task.id
              );
              
              return (
                <TaskCard
                  key={task.id}
                  task={task}
                  index={index}
                  isInTimeline={false}
                  allTasks={tasks}
                  currentContainer={droppableId}
                  isDuplicate={isDuplicate}
                  isDragDisabled={isDragDisabled || isDateInPast}
                  isReadOnly={isDateInPast}
                />
              );
            })}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}