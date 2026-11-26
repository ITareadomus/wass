import { useMemo } from "react";
import { useComparisonSelection } from "@/components/comparison/comparison-selection";
import { comparisonCardTasks } from "@/components/comparison/comparison-timeline";
import MapSection, { type MapFilterControl, type MapRosterCleaner } from "@/components/map/map-section";
import type { DaySnapshot } from "@shared/day-sql-snapshot";

export function ComparisonMap({ day }: { day: DaySnapshot }) {
  const selection = useComparisonSelection();
  const tasks = useMemo(() => comparisonCardTasks(day), [day]);
  const rosterCleaners = useMemo<MapRosterCleaner[]>(
    () => day.cleaners.map((cleaner) => ({ id: cleaner.id, name: cleaner.name, alias: cleaner.name })),
    [day],
  );
  const mapFilter = useMemo<MapFilterControl | undefined>(() => {
    if (!selection) return undefined;
    return {
      taskId: selection.taskId,
      cleanerId: selection.cleanerId,
      setTaskId: selection.setTask,
    };
  }, [selection]);

  return (
    <MapSection
      tasks={tasks}
      workDate={day.workDate ?? ""}
      compact
      className="w-full"
      bodyClassName="flex flex-col"
      mapClassName="h-[380px]"
      mapMinHeight={380}
      rosterCleaners={rosterCleaners}
      mapFilter={mapFilter}
    />
  );
}
