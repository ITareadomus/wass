import { DndContext, MeasuringStrategy } from "@dnd-kit/core";
import type { TaskType as Task } from "@shared/schema";
import {
  useAssignmentDnd,
  useLogisticsDnd,
  type DndDropOperation,
  type DndScope,
} from "@/lib/dnd";
import DndPriorityColumn from "./dnd-priority-column";
import type { TaskCardProps } from "./task-card";
import TaskCardDragOverlay from "./task-card-drag-overlay";

export type DndPriorityBoardColumn = {
  title: string;
  droppableId: "early-out" | "high" | "low";
  tasks: Task[];
  highlightedTaskIds?: Set<string>;
};

export type DndPriorityBoardProps = {
  scope: DndScope;
  columns: readonly DndPriorityBoardColumn[];
  isDragDisabled?: boolean;
  selectedTaskIds?: string[];
  onOperation: (operation: DndDropOperation) => void | Promise<void>;
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

export function DndPriorityBoard({
  scope,
  columns,
  isDragDisabled = false,
  selectedTaskIds = [],
  onOperation,
  taskCardProps,
}: DndPriorityBoardProps) {
  const assignmentDnd = useAssignmentDnd({
    scope,
    onOperation,
  });
  const logisticsDnd = useLogisticsDnd({
    onOperation,
  });
  const dnd = scope === "logistics" ? logisticsDnd : assignmentDnd;
  const overlayTasks = columns.flatMap((column) => column.tasks);

  return (
    <DndContext
      sensors={dnd.sensors}
      collisionDetection={dnd.collisionDetection}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      {...dnd.handlers}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {columns.map((column) => (
          <DndPriorityColumn
            key={column.droppableId}
            scope={scope}
            title={column.title}
            tasks={column.tasks}
            droppableId={column.droppableId}
            isDragDisabled={isDragDisabled}
            highlightedTaskIds={column.highlightedTaskIds}
            selectedTaskIds={selectedTaskIds}
            taskCardProps={taskCardProps}
          />
        ))}
      </div>
      <TaskCardDragOverlay
        activeItem={dnd.activeItem}
        activeRect={dnd.activeRect}
        tasks={overlayTasks}
        scope={scope}
      />
    </DndContext>
  );
}

export default DndPriorityBoard;
