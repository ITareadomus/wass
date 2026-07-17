import { DragOverlay, type Modifier } from "@dnd-kit/core";
import type { TaskType as Task } from "@shared/schema";
import type { SequenceSummaryEntry } from "@/lib/sequence-summary";
import { SequenceSummaryTaskRow } from "@/components/sequence-summary-task-row";
import {
  getTaskDndKey,
  type ActiveDndRect,
  type AppDndItem,
  type DndScope,
} from "@/lib/dnd";
import TaskCard from "./task-card";

function isSequenceSummaryEntry(value: unknown): value is SequenceSummaryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "logisticCode" in value &&
    "sequence" in value
  );
}

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
  const isSummaryDrag = activeItem?.from.type === "summary";
  const isTimelineDrag = activeItem?.from.type === "timeline";

  const activeSummaryEntry = isSummaryDrag && isSequenceSummaryEntry(activeDragTask)
    ? activeDragTask
    : null;

  const activeTask = activeItem && !isSummaryDrag
    ? (activeDragTask as Task | null | undefined) ??
      tasks.find((task) => getTaskDndKey(task) === activeItem.taskId) ??
      null
    : null;

  const measuredOverlayWidth =
    activeRect?.width && activeRect.width > 0 ? activeRect.width : undefined;
  const overlayHeight =
    activeRect?.height && activeRect.height > 0 ? activeRect.height : undefined;

  const liveTimelinePxPerMinute = (() => {
    if (typeof window === "undefined") return null;
    const value = Number((window as any).timelinePxPerMinute);
    return Number.isFinite(value) && value > 0 ? value : null;
  })();

  // HK timeline: overlay a 15' allineato al rect della card (stesso top-left
  // della collision detection) — niente snap al cursore.
  const useCompactHkTimelineOverlay =
    isTimelineDrag && scope === "housekeeping";
  const compactTimelinePxPerMinute =
    liveTimelinePxPerMinute ?? (scope === "logistics" ? 4 : 2.5);
  const compactOverlayWidthPx = Math.max(
    15 * compactTimelinePxPerMinute,
    56,
  );
  const compactOverlayHeightPx = 40;

  const overlayWidth = useCompactHkTimelineOverlay
    ? compactOverlayWidthPx
    : measuredOverlayWidth;
  const renderedOverlayHeight = useCompactHkTimelineOverlay
    ? compactOverlayHeightPx
    : overlayHeight;

  return (
    <DragOverlay adjustScale={false} dropAnimation={null} modifiers={modifiers}>
      {activeItem && activeSummaryEntry ? (
        <div
          className="pointer-events-none origin-top-left"
          style={{
            width: measuredOverlayWidth,
            height: overlayHeight,
          }}
        >
          <SequenceSummaryTaskRow
            entry={activeSummaryEntry}
            className="h-full w-full"
            isDragging
          />
        </div>
      ) : activeItem && activeTask ? (
        <div
          className="pointer-events-none origin-top-left"
          style={{
            width: overlayWidth,
            height: renderedOverlayHeight,
            minWidth:
              isTimelineDrag && (scope === "logistics" || useCompactHkTimelineOverlay)
                ? 56
                : undefined,
            minHeight: isTimelineDrag ? 40 : undefined,
          }}
        >
          <TaskCard
            task={activeTask}
            index={activeItem.index}
            allTasks={tasks as Task[]}
            isInTimeline={isTimelineDrag}
            currentContainer={
              activeItem.from.type === "priority" ? activeItem.from.key : ""
            }
            cleanerId={
              activeItem.from.type === "timeline" ? activeItem.from.staffId : null
            }
            isDragDisabled
            dragWrapper="none"
            externalIsDragging
            operationsScope={scope}
            compactAdamTimelineUi={useCompactHkTimelineOverlay}
            dragOverlayWidthPx={overlayWidth}
            timelinePxPerMinute={
              useCompactHkTimelineOverlay || scope === "logistics"
                ? compactTimelinePxPerMinute
                : 2.5
            }
            minTimelineTaskWidthPx={
              useCompactHkTimelineOverlay || scope === "logistics" ? 56 : 72
            }
            onLogisticsTimelineMutated={onLogisticsTimelineMutated}
          />
        </div>
      ) : null}
    </DragOverlay>
  );
}

export default TaskCardDragOverlay;
