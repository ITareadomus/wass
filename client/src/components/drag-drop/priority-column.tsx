
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Clock, AlertCircle, ArrowDown, Calendar, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useState, useEffect, useMemo } from "react";

interface ContainerMultiSelectState {
  isActive: boolean;
  toggleMode: () => void;
  selectedTasks: Array<{ taskId: string; order: number; container: string }>;
  toggleTask: (taskId: string) => void;
  clearSelection: () => void;
  isTaskSelected: (taskId: string) => boolean;
  getTaskOrder: (taskId: string) => number | undefined;
}

interface PriorityColumnProps {
  title: string;
  priority: string;
  tasks: Task[];
  droppableId: string;
  icon: "clock" | "alert-circle" | "arrow-down";
  assignAction?: () => Promise<void>;
  isDragDisabled?: boolean;
  containerMultiSelectState?: ContainerMultiSelectState;
}

export default function PriorityColumn({
  title,
  priority,
  tasks,
  droppableId,
  icon,
  assignAction,
  isDragDisabled = false,
  containerMultiSelectState,
}: PriorityColumnProps) {
  const [isAssigning, setIsAssigning] = useState(false);
  const [isDateInPast, setIsDateInPast] = useState(false);
  const { toast } = useToast();
  const [hasAssigned, setHasAssigned] = useState(false);
  
  const { setNodeRef, isOver } = useDroppable({
    id: droppableId,
  });
  
  const isMultiSelectMode = containerMultiSelectState?.isActive ?? false;
  const selectedTasks = containerMultiSelectState?.selectedTasks ?? [];
  const toggleMode = containerMultiSelectState?.toggleMode ?? (() => {});
  const toggleTask = containerMultiSelectState?.toggleTask ?? (() => {});
  const clearSelection = containerMultiSelectState?.clearSelection ?? (() => {});
  const isTaskSelected = containerMultiSelectState?.isTaskSelected ?? (() => false);
  const getTaskOrder = containerMultiSelectState?.getTaskOrder ?? (() => undefined);
  
  const multiSelectCtx = useMemo(() => ({
    isMultiSelectMode,
    selectedTasks,
    toggleMode,
    toggleTask,
    clearSelection,
    isTaskSelected,
    getTaskOrder,
  }), [isMultiSelectMode, selectedTasks, toggleMode, toggleTask, clearSelection, isTaskSelected, getTaskOrder]);

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
    const interval = setInterval(checkIfDateInPast, 1000);
    return () => clearInterval(interval);
  }, []);

  const iconMap: Record<string, React.ReactNode> = {
    clock: <Clock className="w-5 h-5 mr-2 text-muted-foreground" />,
    "alert-circle": <AlertCircle className="w-5 h-5 mr-2 text-muted-foreground" />,
    "arrow-down": <ArrowDown className="w-5 h-5 mr-2 text-muted-foreground" />,
  };

  const logisticCodeCounts = tasks.reduce((acc, task) => {
    const code = task.name;
    acc[code] = (acc[code] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const isDuplicateTask = (task: Task) => {
    return logisticCodeCounts[task.name] > 1;
  };

  const handleAssign = async () => {
    if (assignAction) {
      await assignAction();
      setHasAssigned(true);
    }
  };

  const getColumnClass = (priority: string, tasks: Task[]) => {
    switch (priority) {
      case "early-out":
      case "high":
      case "low":
        return "bg-custom-blue-light border-custom-blue";
      default:
        return "bg-gray-50 border-gray-300";
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

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      if (!response.ok) {
        throw new Error(`Errore durante l'assegnazione ${priority}`);
      }

      const result = await response.json();

      toast({
        variant: "success",
        title: "Successo",
        description: successMessage,
      });

      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
    } catch (error: any) {
      toast({
        title: "Errore",
        description: `${title} non assegnati, errore!`,
        variant: "destructive",
      });
    } finally {
      setIsAssigning(false);
    }
  };

  const taskIds = tasks.map(t => String(t.id));

  return (
    <div className={`${getColumnClass(priority, tasks)} rounded-lg p-4 border-2`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold flex items-center text-custom-blue">
            {renderIcon()}
            {title}
          </h3>
          <div className="text-xs text-muted-foreground mt-1">
            {tasks.length} task
            {isMultiSelectMode && (
              <span className="ml-2 text-sky-600 font-semibold">
                ({selectedTasks.filter(st => tasks.some(t => String(t.id) === st.taskId)).length} selezionate)
              </span>
            )}
            {!isMultiSelectMode && selectedTasks.filter(st => tasks.some(t => String(t.id) === st.taskId)).length > 0 && (
              <span className="ml-2 text-amber-600 font-semibold">
                ({selectedTasks.filter(st => tasks.some(t => String(t.id) === st.taskId)).length} da altri container)
              </span>
            )}
            {selectedTasks.length > 0 && (
              <span className="ml-2 text-green-600 font-semibold">
                [TOT: {selectedTasks.length}]
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
            className="text-xs px-2 py-1 h-7 border-2 border-custom-blue"
            title={isMultiSelectMode ? "Disattiva selezione multipla" : "Attiva selezione multipla"}
            data-testid="button-toggle-multiselect"
          >
            <CheckSquare className={`w-3 h-3 ${isMultiSelectMode ? 'mr-1' : ''}`} />
            {isMultiSelectMode && <span className="ml-1">On</span>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAssign}
            disabled={isAssigning || tasks.length === 0 || isDateInPast}
            className="text-xs px-2 py-1 h-7 border-2 border-custom-blue"
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
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`
            flex flex-wrap gap-2 min-h-[120px] transition-colors duration-200 content-start p-2
            ${isOver ? "drop-zone-active" : ""}
          `}
          data-testid={`priority-column-${droppableId}`}
        >
          {tasks.map((task, index) => {
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
                multiSelectContext={multiSelectCtx}
              />
            );
          })}
        </div>
      </SortableContext>
    </div>
  );
}
