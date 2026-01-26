import { Droppable } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "./task-card";
import { Clock, AlertCircle, ArrowDown, CheckSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  isDragDisabled?: boolean;
  containerMultiSelectState?: ContainerMultiSelectState;
  highlightedTaskIds?: Set<string>;
}

export default function PriorityColumn({
  title,
  priority,
  tasks,
  droppableId,
  icon,
  isDragDisabled = false,
  containerMultiSelectState,
  highlightedTaskIds = new Set(),
}: PriorityColumnProps) {
  const [isDateInPast, setIsDateInPast] = useState(false);
  
  // Usa lo stato passato dal parent
  const isMultiSelectMode = containerMultiSelectState?.isActive ?? false;
  const selectedTasks = containerMultiSelectState?.selectedTasks ?? [];
  const toggleMode = containerMultiSelectState?.toggleMode ?? (() => {});
  const toggleTask = containerMultiSelectState?.toggleTask ?? (() => {});
  const clearSelection = containerMultiSelectState?.clearSelection ?? (() => {});
  const isTaskSelected = containerMultiSelectState?.isTaskSelected ?? (() => false);
  const getTaskOrder = containerMultiSelectState?.getTaskOrder ?? (() => undefined);
  
  // Context per passare ai TaskCard
  const multiSelectCtx = useMemo(() => ({
    isMultiSelectMode,
    selectedTasks,
    toggleMode,
    toggleTask,
    clearSelection,
    isTaskSelected,
    getTaskOrder,
  }), [isMultiSelectMode, selectedTasks, toggleMode, toggleTask, clearSelection, isTaskSelected, getTaskOrder]);
  
  // DEBUG: commentato per performance
  // console.log('[DEBUG PriorityColumn]', priority, 'isMultiSelectMode:', isMultiSelectMode, 'selectedTasks:', selectedTasks.length);

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

  const getColumnClass = (priority: string, tasks: Task[]) => {
    switch (priority) {
      case "early-out":
        return "bg-custom-blue-light border-custom-blue";
      case "high":
        return "bg-custom-blue-light border-custom-blue";
      case "low":
        return "bg-custom-blue-light border-custom-blue";
      default:
        return "bg-gray-50 border-gray-300";
    }
  };

  const getHeaderClass = (priority: string) => {
    switch (priority) {
      case "early-out":
        return "text-custom-blue";
      case "high":
        return "text-custom-blue";
      case "low":
        return "text-custom-blue";
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
              const isDuplicate = tasks.some(
                t => t.name === task.name && t.id !== task.id
              );
              const isHighlighted = highlightedTaskIds.has(String(task.id));
              
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
                  isHighlighted={isHighlighted}
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