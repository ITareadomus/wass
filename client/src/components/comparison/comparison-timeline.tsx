import { Fragment, type PointerEvent as ReactPointerEvent, type UIEvent as ReactUIEvent } from "react";
import TaskCard from "@/components/drag-drop/task-card";
import { TimelineHorizontalScrollbar } from "@/components/timeline/timeline-horizontal-scrollbar";
import { useComparisonSelection } from "@/components/comparison/comparison-selection";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
import {
  layoutHousekeepingTimelineTask,
  renderedHousekeepingCardMinutes,
} from "@shared/housekeeping-timeline-layout";
import type { ComparisonTask, DaySnapshot } from "@shared/day-sql-snapshot";
import type { TaskType } from "@shared/schema";

const MIN_TASK_PX = 75;

function formatMinutes(minutes: number): string {
  const normalized = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hours = Math.floor(normalized / 60);
  const mins = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function durationLabel(minutes: number): string {
  const safe = Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${hours}.${String(mins).padStart(2, "0")}`;
}

function toCardTask(task: ComparisonTask, collaboratorIds?: number[]): TaskType {
  const start = task.startMin != null ? formatMinutes(task.startMin) : null;
  const end = task.endMin != null ? formatMinutes(task.endMin) : null;
  return {
    id: task.taskId,
    name: task.logisticCode,
    alias: task.alias || undefined,
    type: task.customerName || "STANDARD",
    duration: durationLabel(task.cleaningMin),
    priority: task.priority,
    assignedTo: String(task.cleanerId),
    status: "assigned",
    scheduledTime: start,
    address: task.address,
    apt_code: task.aptCode || undefined,
    lat: task.lat != null ? String(task.lat) : undefined,
    lng: task.lng != null ? String(task.lng) : undefined,
    premium: task.premium,
    straordinaria: task.straordinaria,
    confirmed_operation: task.confirmed,
    checkout_time: task.checkoutTime,
    checkin_time: task.checkinTime,
    customer_reference: task.customerReference || undefined,
    customer_name: task.customerName || undefined,
    type_apt: task.typeApt || undefined,
    operation_id: task.operationId ?? undefined,
    startTime: start ?? undefined,
    endTime: end ?? undefined,
    createdAt: "",
    updatedAt: "",
    task_id: Number(task.taskId),
    cleaning_time: task.cleaningMin,
    start_time: start,
    end_time: end,
    sequence: task.sequence,
    travel_time: task.travelMin,
    assignedCleaner: task.cleanerId,
    collaborator_count: task.collaboratorCount,
    collaborator_ids: collaboratorIds && collaboratorIds.length > 1 ? collaboratorIds : undefined,
  } as TaskType;
}

function CleanerTasks({
  tasks,
  collaboratorIds,
  cleanerStart,
  gridStart,
  pxPerMinute,
  width,
  workDate,
}: {
  tasks: ComparisonTask[];
  collaboratorIds: Map<string, number[]>;
  cleanerStart: number;
  gridStart: number;
  pxPerMinute: number;
  width: number;
  workDate: string | null;
}) {
  const cards = tasks.map((task) => toCardTask(task, collaboratorIds.get(task.taskId)));
  let cursor = gridStart;
  return (
    <div className="relative z-10 flex h-full items-center" style={{ minHeight: 50, width }}>
      {tasks.map((task, index) => {
        const card = cards[index];
        const cardMinutes = renderedHousekeepingCardMinutes(card.duration, pxPerMinute, MIN_TASK_PX);
        const slot = layoutHousekeepingTimelineTask({
          isFirst: index === 0,
          gridStartMinutes: gridStart,
          cursorMinutes: cursor,
          startMinutes: task.startMin,
          fallbackStartMinutes: cleanerStart,
          travelMinutes: index === 0 ? 0 : task.travelMin,
          cardMinutes,
        });
        cursor = slot.nextCursorMinutes;
        const initialWidth = slot.initialOffsetMinutes > 0 ? slot.initialOffsetMinutes * pxPerMinute : 0;
        const travelWidth = slot.travelMinutes > 0 ? slot.travelMinutes * pxPerMinute : 0;
        const alignShift = slot.alignGapMinutes < 0 ? slot.alignGapMinutes * pxPerMinute : 0;
        const waiting = slot.alignGapMinutes > 0 ? slot.alignGapMinutes : 0;
        const waitingWidth = waiting > 0 ? waiting * pxPerMinute : 0;
        return (
          <Fragment key={`${task.taskId}-${task.sequence}`}>
            {alignShift < 0 ? <div className="shrink-0" style={{ width: 0, marginLeft: alignShift }} /> : null}
            {initialWidth > 0 ? <div className="shrink-0" style={{ width: initialWidth, minHeight: 50 }} /> : null}
            {travelWidth > 0 ? (
              <div
                className="flex shrink-0 items-center"
                style={{ width: travelWidth, minHeight: 50 }}
                title={`${task.travelMin} min`}
              >
                <div aria-hidden className="h-0.5 w-full bg-slate-500/55 dark:bg-slate-400/40" />
              </div>
            ) : null}
            {waitingWidth > 0 ? (
              <div
                className="flex shrink-0 items-center justify-center border-y border-dashed border-amber-400 bg-amber-100/50 py-3 dark:bg-amber-900/20"
                style={{ width: waitingWidth, minHeight: 50 }}
                title={`Attesa checkout: ${Math.round(waiting)} min`}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="shrink-0 text-amber-600 dark:text-amber-400"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12,6 12,12 16,14" />
                </svg>
              </div>
            ) : null}
            <TaskCard
              task={card}
              index={index}
              workDate={workDate ?? undefined}
              isInTimeline
              allTasks={cards}
              isDragDisabled
              isReadOnly
              timelinePxPerMinute={pxPerMinute}
              minTimelineTaskWidthPx={MIN_TASK_PX}
              cleanerId={task.cleanerId}
            />
          </Fragment>
        );
      })}
    </div>
  );
}

export function comparisonCollaborators(day: DaySnapshot): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (const task of day.tasks) {
    if (!task.assigned || task.cleanerId <= 0) continue;
    const ids = groups.get(task.taskId) ?? [];
    if (!ids.includes(task.cleanerId)) ids.push(task.cleanerId);
    groups.set(task.taskId, ids);
  }
  return groups;
}

export function comparisonCardTasks(day: DaySnapshot): TaskType[] {
  const collaborators = comparisonCollaborators(day);
  return day.tasks.map((task) => {
    const card = toCardTask(task, collaborators.get(task.taskId));
    if (!task.assigned) (card as { sequence?: number | null }).sequence = undefined;
    return card;
  });
}

const NAME_WIDTH = 168;

export function ComparisonTimeline({
  day,
  startMin,
  endMin,
  pxPerMinute,
  registerScrollRef,
  onScroll,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
}: {
  day: DaySnapshot;
  startMin: number;
  endMin: number;
  pxPerMinute: number;
  registerScrollRef: (node: HTMLDivElement | null) => void;
  onScroll: (event: ReactUIEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const selection = useComparisonSelection();
  const width = Math.max(1, endMin - startMin) * pxPerMinute;
  const hours: number[] = [];
  for (let minute = startMin; minute <= endMin; minute += 60) hours.push(minute);
  const unassigned = day.tasks.filter((task) => !task.assigned);
  const collaborators = comparisonCollaborators(day);
  const trackEvents = {
    ref: registerScrollRef,
    onScroll,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex h-8 items-stretch border-b bg-muted/90">
        <div className="flex shrink-0 items-center border-r px-2 text-xs font-medium" style={{ width: NAME_WIDTH }}>
          Cleaner
        </div>
        <div {...trackEvents} className="timeline-center-scroll min-w-0 flex-1">
          <div className="relative h-8" style={{ width }}>
            {hours.map((minute) => (
              <span
                key={minute}
                className="absolute top-1 text-[11px] text-muted-foreground"
                style={{ left: (minute - startMin) * pxPerMinute }}
              >
                {formatMinutes(minute)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="max-h-[420px] overflow-x-hidden overflow-y-auto">
        {day.cleaners.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">Nessun cleaner in questo file.</p>
        ) : (
          day.cleaners.map((cleaner) => {
            const tasks = day.tasks
              .filter((task) => task.assigned && task.cleanerId === cleaner.id)
              .sort((a, b) => a.sequence - b.sequence || (a.startMin ?? 0) - (b.startMin ?? 0));
            const cleanerActive = selection?.cleanerId === cleaner.id;
            return (
              <div key={cleaner.id} className="flex border-b last:border-b-0">
                <button
                  type="button"
                  className="flex shrink-0 items-center gap-2 border-r bg-background px-2 text-left"
                  style={{ width: NAME_WIDTH, minHeight: 50 }}
                  title="Doppio clic: mostra sulla mappa solo gli appartamenti di questo cleaner"
                  onDoubleClick={() => selection?.toggleCleaner(cleaner.id)}
                >
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: getPersonnelHexColor(cleaner.id) }} />
                  <span className="min-w-0">
                    <span className={`block truncate text-sm font-medium ${cleanerActive ? "text-amber-600 dark:text-amber-300" : ""}`}>{cleaner.name}</span>
                    <span className="block text-[11px] text-muted-foreground">{tasks.length} task</span>
                  </span>
                </button>
                <div {...trackEvents} className="timeline-center-scroll relative min-h-[50px] min-w-0 flex-1 border-l border-border bg-background">
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 grid"
                    style={{ width, gridTemplateColumns: `repeat(${Math.max(1, hours.length - 1)}, 1fr)` }}
                  >
                    {hours.slice(0, -1).map((minute, index) => (
                      <div
                        key={minute}
                        className={index % 2 === 0 ? "border-r border-border bg-blue-50/30 dark:bg-blue-950/10" : "border-r border-border bg-sky-100/30 dark:bg-sky-900/10"}
                      />
                    ))}
                  </div>
                  <CleanerTasks
                    tasks={tasks}
                    collaboratorIds={collaborators}
                    cleanerStart={cleaner.startMin}
                    gridStart={startMin}
                    pxPerMinute={pxPerMinute}
                    width={width}
                    workDate={day.workDate}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
      <TimelineHorizontalScrollbar
        labelColumnWidth={NAME_WIDTH}
        contentWidth={width}
        trailingWidth={0}
        registerRef={registerScrollRef}
        onScroll={onScroll}
      />
      {unassigned.length > 0 ? (
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          {unassigned.length} task ancora nei contenitori, senza barra in timeline.
        </p>
      ) : null}
    </div>
  );
}
