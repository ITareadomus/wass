import { useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { TaskType as Task } from "@shared/schema";
import {
  getTaskDndKey,
  priorityContainerDndId,
  priorityKeyFromLegacyDroppableId,
  taskDndId,
  type AppDndContainer,
  type AppDndItem,
  type DndScope,
} from "@/lib/dnd";
import DraggableTaskCard from "./draggable-task-card";
import type { TaskCardProps } from "./task-card";

export type DndPriorityColumnProps = {
  scope: DndScope;
  title: string;
  tasks: Task[];
  droppableId: string;
  isDragDisabled?: boolean;
  highlightedTaskIds?: Set<string>;
  selectedTaskIds?: string[];
  taskCardProps?: Partial<
    Omit<
      TaskCardProps,
      | "task"
      | "index"
      | "allTasks"
      | "currentContainer"
      | "draggableId"
      | "dragWrapper"
      | "externalIsDragging"
      | "externalDragHandleProps"
    >
  >;
};

export function DndPriorityColumn({
  scope,
  title,
  tasks,
  droppableId,
  isDragDisabled = false,
  highlightedTaskIds = new Set(),
  selectedTaskIds = [],
  taskCardProps,
}: DndPriorityColumnProps) {
  const priorityKey = priorityKeyFromLegacyDroppableId(droppableId);

  if (!priorityKey) {
    throw new Error(`Unsupported priority droppableId: ${droppableId}`);
  }

  const containerId = priorityContainerDndId(scope, priorityKey);
  const selectedTaskIdSet = useMemo(
    () => new Set(selectedTaskIds.map(String)),
    [selectedTaskIds],
  );

  const containerData: AppDndContainer = {
    kind: "container",
    scope,
    type: "priority",
    key: priorityKey,
    accepts: ["priority", "timeline", "summary"],
  };

  const { setNodeRef } = useDroppable({
    id: containerId,
    data: {
      ...containerData,
      insertIndex: tasks.length,
    },
    // I container sono sorgenti, non target: priorita' e ordinamento arrivano dai dati task.
    disabled: true,
  });

  return (
    <section className="min-w-0 overflow-visible rounded-lg border-2 border-custom-blue bg-custom-blue-light p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-custom-blue">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{tasks.length} task</p>
        </div>
      </div>

      <div
        ref={setNodeRef}
        className="flex min-h-[120px] min-w-0 flex-wrap content-start gap-2 overflow-visible border-0 p-2 pt-4 pl-4"
        data-testid={`dnd-priority-column-${droppableId}`}
      >
        {tasks.map((task, index) => {
          const taskKey = getTaskDndKey(task);
          const dndId = taskDndId(scope, taskKey);
          const isDraggedTaskSelected = selectedTaskIdSet.has(taskKey);
          const dndData: AppDndItem = {
            kind: "task",
            scope,
            taskId: taskKey,
            index,
            initialIndex: index,
            from: {
              type: "priority",
              key: priorityKey,
            },
            selectedTaskIds: isDraggedTaskSelected ? selectedTaskIds : undefined,
          };

          return (
            <DraggableTaskCard
              key={dndId}
              dndId={dndId}
              dndData={dndData}
              task={task}
              index={index}
              isInTimeline={false}
              allTasks={tasks}
              currentContainer={droppableId}
              isDragDisabled={isDragDisabled}
              isHighlighted={highlightedTaskIds.has(taskKey)}
              {...taskCardProps}
            />
          );
        })}
      </div>
    </section>
  );
}

export default DndPriorityColumn;
