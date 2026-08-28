import { TaskType as Task } from "@shared/schema";
import { isWorkDateHistoricallyLocked } from "@shared/work-date-access";
import DraggableTaskCard from "./draggable-task-card";
import { ContainerTaskClip } from "./container-task-clip";
import { Clock, AlertCircle, ArrowDown, Calendar, CheckSquare, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { useState, useEffect, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { fetchWithOperation } from "@/lib/operationManager";
import { cn } from "@/lib/utils";
import {
  getTaskDndKey,
  priorityContainerDndId,
  priorityKeyFromLegacyDroppableId,
  taskDndId,
  type AppDndContainer,
  type AppDndItem,
  type DndScope,
} from "@/lib/dnd";

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
  assignButtonDisabled?: boolean;
  isDragDisabled?: boolean;
  containerMultiSelectState?: ContainerMultiSelectState;
  highlightedTaskIds?: Set<string>;
  /** Disabilita toolbar Multiselect + Assegna (es. pagina logistics senza timeline) */
  disableToolbar?: boolean;
  /** Zona drop senza padding interno (evita l'effetto "riquadro" dentro la colonna). */
  flushDropZone?: boolean;
  /** Passato a TaskCard per caricare i nomi operazione (enable_wass vs enable_wass_route). */
  operationsScope?: "housekeeping" | "logistics";
  /** Dopo mutazione tipologia logistica (container o timeline). */
  onLogisticsTimelineMutated?: () => void;
  className?: string;
  /** Overlay blur contenuto (il bordo blu resta visibile, come in timeline). */
  isContentLoading?: boolean;
  loadingMessage?: string;
}

export default function PriorityColumn({
  title,
  priority,
  tasks,
  droppableId,
  icon,
  assignAction,
  assignButtonDisabled = false,
  isDragDisabled = false,
  containerMultiSelectState,
  highlightedTaskIds = new Set(),
  disableToolbar = false,
  flushDropZone = false,
  operationsScope = "housekeeping",
  onLogisticsTimelineMutated,
  className,
  isContentLoading = false,
  loadingMessage,
}: PriorityColumnProps) {
  const [isAssigning, setIsAssigning] = useState(false);
  const [isHistoricalDateLocked, setIsHistoricalDateLocked] = useState(false);
  const { toast } = useToast();
  
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
    const checkIfDateLocked = () => {
      const savedDate = localStorage.getItem('selected_work_date');
      if (!savedDate) {
        setIsHistoricalDateLocked(false);
        return;
      }

      const [year, month, day] = savedDate.split('-').map(Number);
      const selectedDate = new Date(year, month - 1, day);
      setIsHistoricalDateLocked(isWorkDateHistoricallyLocked(selectedDate));
    };

    checkIfDateLocked();

    // Ricontrolla quando cambia la data
    const interval = setInterval(checkIfDateLocked, 1000);
    return () => clearInterval(interval);
  }, []);

  const iconMap: Record<string, React.ReactNode> = {
    clock: <Clock className="w-5 h-5 mr-2 text-muted-foreground" />,
    "alert-circle": <AlertCircle className="w-5 h-5 mr-2 text-muted-foreground" />,
    "arrow-down": <ArrowDown className="w-5 h-5 mr-2 text-muted-foreground" />,
  };

  const getTaskDuplicateMeta = (task: Task) => {
    const candidate = task as any;
    const groupId = candidate.duplicate_group_id ? String(candidate.duplicate_group_id) : "";
    const groupSizeActive = Number(candidate.duplicate_group_size_active || 0);
    const taskLocked = Boolean(candidate.locked);
    const isDuplicateActive = Boolean(candidate.is_duplicate_active) && !taskLocked;
    return {
      groupId,
      groupSizeActive,
      isDuplicateActive,
    };
  };

  const duplicatePalette = [
    "duplicate-zone-color-0",
    "duplicate-zone-color-1",
    "duplicate-zone-color-2",
    "duplicate-zone-color-3",
    "duplicate-zone-color-4",
    "duplicate-zone-color-5",
  ];

  const getColorClassForGroup = (groupId: string) => {
    if (!groupId) return duplicatePalette[0];
    let hash = 0;
    for (let i = 0; i < groupId.length; i++) {
      hash = ((hash << 5) - hash) + groupId.charCodeAt(i);
      hash |= 0;
    }
    return duplicatePalette[Math.abs(hash) % duplicatePalette.length];
  };

  const orderedEntries = useMemo(() => {
    const indexed = tasks.map((task, originalIndex) => {
      const duplicateMeta = getTaskDuplicateMeta(task);
      return { task, originalIndex, duplicateMeta };
    });

    const duplicateItems = indexed.filter((entry) => entry.duplicateMeta.isDuplicateActive);
    const nonDuplicateItems = indexed.filter((entry) => !entry.duplicateMeta.isDuplicateActive);

    const localGroupCounts = new Map<string, number>();
    for (const entry of duplicateItems) {
      const groupId = entry.duplicateMeta.groupId;
      if (!groupId) continue;
      localGroupCounts.set(groupId, (localGroupCounts.get(groupId) || 0) + 1);
    }

    duplicateItems.sort((a, b) => {
      const aGroup = a.duplicateMeta.groupId;
      const bGroup = b.duplicateMeta.groupId;
      const aLocalCount = localGroupCounts.get(aGroup) || 0;
      const bLocalCount = localGroupCounts.get(bGroup) || 0;
      if (aLocalCount !== bLocalCount) return bLocalCount - aLocalCount;
      if (aGroup !== bGroup) return aGroup.localeCompare(bGroup);
      return a.originalIndex - b.originalIndex;
    });

    return [...duplicateItems, ...nonDuplicateItems];
  }, [tasks]);

  const orderedTasks = useMemo(
    () => orderedEntries.map((entry) => entry.task),
    [orderedEntries]
  );

  const groupedDuplicateEntries = useMemo(() => {
    const duplicatesByGroup = new Map<string, typeof orderedEntries>();
    for (const entry of orderedEntries) {
      if (!entry.duplicateMeta.isDuplicateActive) continue;
      const groupKey = entry.duplicateMeta.groupId || `single-${String(entry.task.id)}`;
      const existing = duplicatesByGroup.get(groupKey) || [];
      existing.push(entry);
      duplicatesByGroup.set(groupKey, existing);
    }

    const duplicateBlocks: Array<{
      key: string;
      groupId: string;
      colorClass: string;
      entries: typeof orderedEntries;
      isGroup: boolean;
    }> = [];

    const seenKeys = new Set<string>();
    for (const entry of orderedEntries) {
      if (!entry.duplicateMeta.isDuplicateActive) continue;
      const key = entry.duplicateMeta.groupId || `single-${String(entry.task.id)}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const entries = duplicatesByGroup.get(key) || [entry];
      duplicateBlocks.push({
        key,
        groupId: entry.duplicateMeta.groupId,
        colorClass: getColorClassForGroup(entry.duplicateMeta.groupId),
        entries,
        isGroup: Boolean(entry.duplicateMeta.groupId) && entries.length > 1,
      });
    }

    const nonDuplicateEntries = orderedEntries.filter((entry) => !entry.duplicateMeta.isDuplicateActive);
    return { duplicateBlocks, nonDuplicateEntries };
  }, [orderedEntries]);

  const dndScope: DndScope = operationsScope === "logistics" ? "logistics" : "housekeeping";
  const priorityKey = priorityKeyFromLegacyDroppableId(droppableId);

  const priorityContainerId = priorityKey
    ? priorityContainerDndId(dndScope, priorityKey)
    : `invalid-priority-container:${dndScope}:${droppableId}`;

  const priorityContainerData: AppDndContainer | undefined = priorityKey
    ? {
        kind: "container",
        scope: dndScope,
        type: "priority",
        key: priorityKey,
        accepts: ["priority", "timeline", "summary"],
      }
    : undefined;

  const { setNodeRef: setPriorityDropRef, isOver: isPriorityOver } =
    useDroppable({
      id: priorityContainerId,
      data: priorityContainerData
        ? {
            ...priorityContainerData,
            insertIndex: orderedTasks.length,
          }
        : undefined,
      disabled:
        !priorityKey ||
        isDragDisabled ||
        isHistoricalDateLocked,
    });

  const selectedTaskIdSet = useMemo(
    () => new Set(selectedTasks.map((task) => String(task.taskId))),
    [selectedTasks]
  );

  const getDndCardProps = (task: Task, index: number) => {
    const taskKey = getTaskDndKey(task);
    const dndData: AppDndItem = {
      kind: "task",
      scope: dndScope,
      taskId: taskKey,
      index,
      initialIndex: index,
      from: {
        type: "priority",
        key: priorityKey ?? "low_priority",
      },
      selectedTaskIds: selectedTaskIdSet.has(taskKey)
        ? selectedTasks.map((selectedTask) => String(selectedTask.taskId))
        : undefined,
    };

    return {
      dndId: taskDndId(dndScope, taskKey, undefined, "priority"),
      dndData,
    };
  };

  // Funzione modificata per usare hasAssigned e stato di loading
  const handleAssign = async () => {
    if (!assignAction) return;
    
    try {
      setIsAssigning(true);
      await assignAction();
    } catch (error) {
      console.error("Errore durante l'assegnazione:", error);
      // I toast di errore vengono gestiti all'interno di assignAction
    } finally {
      setIsAssigning(false);
    }
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

      const endpoint = '/api/optimizer/run-all';
      const successMessage = `✅ ${title} assegnati!`;
      
      console.log(`🚀 Esecuzione optimizer per ${priority}, data: ${dateStr}`);
      const response = await fetchWithOperation(`assign-${priority}`, endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          date: dateStr, 
          skipPhase4: false, 
          applyToProduction: true 
        })
      });

      if (!response.ok) {
        throw new Error(`Errore durante l'assegnazione ${priority}`);
      }

      const result = await response.json();
      console.log(`Assegnazione ${priority} completata:`, result);
      
      const summary = result.summary || {};
      toast({
        variant: "success",
        title: "Successo",
        description: `${successMessage} (${summary.tasksAssigned || 0} task assegnate, ${summary.tasksUnassigned || 0} non assegnate)`,
      });

      // Ricarica i task per riflettere le nuove assegnazioni
      if ((window as any).reloadAllTasks) {
        console.log('🔄 Ricaricamento task dopo assegnazione...');
        await (window as any).reloadAllTasks();
        console.log('✅ Task ricaricati con successo');
      }
    } catch (error: any) {
      if (error.message.includes("Operazione annullata")) {
        console.log(`ℹ️ Assegnazione ${priority} annullata - richiesta più recente in corso`);
        return;
      }
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
    <div
      className={cn(
        getColumnClass(priority, tasks),
        "relative min-w-0 overflow-visible rounded-lg border-2 p-4",
        className
      )}
    >
      {isContentLoading && (
        <div className="absolute inset-0 z-40 flex items-center justify-center rounded-lg bg-black/20 backdrop-blur-sm dark:bg-black/40">
          {loadingMessage ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
              <p className="text-sm font-medium text-foreground">{loadingMessage}</p>
            </div>
          ) : null}
        </div>
      )}
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
            disabled={tasks.length === 0 || isHistoricalDateLocked || disableToolbar}
            className="text-xs px-2 py-1 h-7 border-2 border-custom-blue"
            title={isMultiSelectMode ? "Disattiva selezione multipla" : "Attiva selezione multipla"}
            data-testid="button-toggle-multiselect"
          >
            <CheckSquare className={`w-3 h-3 ${isMultiSelectMode ? "mr-1" : ""}`} />
            {isMultiSelectMode && <span className="ml-1">On</span>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleAssign}
            disabled={
              !assignAction ||
              assignButtonDisabled ||
              tasks.length === 0 ||
              isHistoricalDateLocked ||
              isAssigning ||
              disableToolbar
            }
            className="text-xs px-2 py-1 h-7 border-2 border-custom-blue"
            title="Assegna"
            data-testid="button-assign-priority"
          >
            <Calendar className="w-3 h-3 mr-1" />
            <span>{isAssigning ? "Assegnando..." : "Assegna"}</span>
          </Button>
        </div>
      </div>
      <div
        ref={setPriorityDropRef}
        className={cn(
          `
            flex flex-wrap gap-2 min-h-[120px] min-w-0
            overflow-visible transition-colors duration-200
            content-start border-0
            ${flushDropZone ? "p-0" : "p-2 pt-4 pl-4"}
          `,
          isPriorityOver && "rounded-md ring-2 ring-custom-blue/60",
        )}
        data-testid={`priority-column-${droppableId}`}
      >
            {(() => {
              let draggableIndex = 0;
              const rendered: React.ReactNode[] = [];

              for (const block of groupedDuplicateEntries.duplicateBlocks) {
                if (block.isGroup) {
                  rendered.push(
                    <div
                      key={`group-${block.key}`}
                      className={`duplicate-group-zone ${block.colorClass}`}
                      data-duplicate-group-id={block.groupId || undefined}
                    >
                      {block.entries.map((entry) => {
                        const task = entry.task;
                        const isHighlighted = highlightedTaskIds.has(String(task.id));
                        const currentIndex = draggableIndex++;
                        const dndCardProps = getDndCardProps(task, currentIndex);
                        return (
                          <div key={`task-${task.id}`} className="duplicate-group-item">
                            <ContainerTaskClip>
                              <DraggableTaskCard
                                {...dndCardProps}
                                task={task}
                                index={currentIndex}
                                isInTimeline={false}
                                allTasks={orderedTasks}
                                currentContainer={droppableId}
                                isDuplicate={true}
                                isDragDisabled={isDragDisabled || isHistoricalDateLocked}
                                isReadOnly={isHistoricalDateLocked}
                                multiSelectContext={multiSelectCtx}
                                isHighlighted={isHighlighted}
                                operationsScope={operationsScope}
                                onLogisticsTimelineMutated={onLogisticsTimelineMutated}
                              />
                            </ContainerTaskClip>
                          </div>
                        );
                      })}
                    </div>
                  );
                } else {
                  const entry = block.entries[0];
                  const task = entry.task;
                  const isHighlighted = highlightedTaskIds.has(String(task.id));
                  const currentIndex = draggableIndex++;
                  const dndCardProps = getDndCardProps(task, currentIndex);
                  rendered.push(
                    <div key={`single-row-${block.key}`} className="duplicate-single-row">
                      <div
                        key={`single-${block.key}`}
                        className={`duplicate-single-block duplicate-zone duplicate-zone-pulse ${block.colorClass}`}
                        data-duplicate-group-id={block.groupId || undefined}
                      >
                      <ContainerTaskClip className="max-w-full">
                        <DraggableTaskCard
                          {...dndCardProps}
                          task={task}
                          index={currentIndex}
                          isInTimeline={false}
                          allTasks={orderedTasks}
                          currentContainer={droppableId}
                          isDuplicate={true}
                          isDragDisabled={isDragDisabled || isHistoricalDateLocked}
                          isReadOnly={isHistoricalDateLocked}
                          multiSelectContext={multiSelectCtx}
                          isHighlighted={isHighlighted}
                          operationsScope={operationsScope}
                          onLogisticsTimelineMutated={onLogisticsTimelineMutated}
                        />
                      </ContainerTaskClip>
                      </div>
                    </div>
                  );
                }
              }

              for (const entry of groupedDuplicateEntries.nonDuplicateEntries) {
                const task = entry.task;
                const isHighlighted = highlightedTaskIds.has(String(task.id));
                const currentIndex = draggableIndex++;
                const dndCardProps = getDndCardProps(task, currentIndex);
                rendered.push(
                  <ContainerTaskClip key={`plain-${task.id}`}>
                    <DraggableTaskCard
                      {...dndCardProps}
                      task={task}
                      index={currentIndex}
                      isInTimeline={false}
                      allTasks={orderedTasks}
                      currentContainer={droppableId}
                      isDuplicate={false}
                      isDragDisabled={isDragDisabled || isHistoricalDateLocked}
                      isReadOnly={isHistoricalDateLocked}
                      multiSelectContext={multiSelectCtx}
                      isHighlighted={isHighlighted}
                      operationsScope={operationsScope}
                      onLogisticsTimelineMutated={onLogisticsTimelineMutated}
                    />
                  </ContainerTaskClip>
                );
              }

              return rendered;
            })()}
      </div>
    </div>
  );
}