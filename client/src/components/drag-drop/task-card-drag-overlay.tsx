import { DragOverlay, type Modifier } from "@dnd-kit/core";
import type { TaskType as Task } from "@shared/schema";
import {
  getTaskDndKey,
  type ActiveDndRect,
  type AppDndItem,
  type DndScope,
} from "@/lib/dnd";
import TaskCard from "./task-card";

type TaskCardDragOverlayProps = {
  activeItem: AppDndItem | null;
  activeDragTask?: unknown;
  activeRect?: ActiveDndRect | null;
  tasks: readonly Task[];
  scope: DndScope;
  modifiers?: Modifier[];
  onLogisticsTimelineMutated?: () => void;
};

export function TaskCardDragOverlay({
  activeItem,
  activeDragTask,
  activeRect,
  tasks,
  scope,
  modifiers,
  onLogisticsTimelineMutated,
}: TaskCardDragOverlayProps) {
  const activeTask = activeItem
    ? (activeDragTask as Task | null | undefined) ??
      tasks.find((task) => getTaskDndKey(task) === activeItem.taskId) ??
      null
    : null;

  return (
    <DragOverlay adjustScale={false} dropAnimation={null} modifiers={modifiers}>
      {activeItem && activeTask ? (
        <div
          className="pointer-events-none origin-top-left"
          style={{
            width: activeRect?.width,
            height: activeRect?.height,
          }}
        >
          <TaskCard
            task={activeTask}
            index={activeItem.index}
            allTasks={tasks as Task[]}
            isInTimeline={activeItem.from.type !== "priority"}
            currentContainer={
              activeItem.from.type === "priority" ? activeItem.from.key : ""
            }
            cleanerId={
              activeItem.from.type === "timeline" ||
              activeItem.from.type === "summary"
                ? activeItem.from.staffId
                : null
            }
            isDragDisabled
            dragWrapper="none"
            externalIsDragging
            operationsScope={scope}
            dragOverlayWidthPx={activeRect?.width}
            timelinePxPerMinute={scope === "logistics" ? 4 : 2.5}
            minTimelineTaskWidthPx={scope === "logistics" ? 56 : 72}
            onLogisticsTimelineMutated={onLogisticsTimelineMutated}
          />
        </div>
      ) : null}
    </DragOverlay>
  );
}

export default TaskCardDragOverlay;
