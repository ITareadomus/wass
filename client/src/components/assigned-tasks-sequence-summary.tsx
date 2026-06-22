import { useMemo } from "react";
import { ListOrdered } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SequenceSummaryGroup } from "@/lib/sequence-summary";
import { logisticsKindSequenceDotClass } from "@/lib/logistics-task-kind-ui";

interface AssignedTasksSequenceSummaryProps {
  groups: SequenceSummaryGroup[];
  searchTask?: string;
  staffLabel?: string;
}

function matchesSearch(entry: SequenceSummaryGroup["tasks"][number], query: string): boolean {
  const lowerSearch = query.toLowerCase();
  return (
    entry.taskId.toLowerCase().includes(lowerSearch) ||
    entry.logisticCode.toLowerCase().includes(lowerSearch) ||
    entry.address.toLowerCase().includes(lowerSearch)
  );
}

export default function AssignedTasksSequenceSummary({
  groups,
  searchTask = "",
  staffLabel = "Cleaner",
}: AssignedTasksSequenceSummaryProps) {
  const totalTasks = useMemo(
    () => groups.reduce((sum, group) => sum + group.tasks.length, 0),
    [groups]
  );

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="mb-4 mt-4 w-full">
      <div className="rounded-lg border-2 border-custom-blue bg-custom-blue-light p-4">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="flex items-center font-semibold text-custom-blue">
              <ListOrdered className="mr-2 h-5 w-5" />
              Resoconto assegnazioni
            </h3>
            <div className="mt-1 text-xs text-muted-foreground">
              {totalTasks} task in sequenza · {groups.length} {staffLabel.toLowerCase()}
              {groups.length === 1 ? "" : "s"}
            </div>
          </div>
        </div>

        <div className="grid min-h-[120px] grid-cols-1 gap-4 lg:grid-cols-3">
          {groups.map((group) => (
            <div
              key={group.id}
              className="flex min-h-[120px] flex-col rounded-lg border border-custom-blue/40 bg-background/70 p-3"
            >
              <div className="mb-2 border-b border-custom-blue/20 pb-2">
                <h4 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-custom-blue">
                  <span className="truncate">{group.label}</span>
                  {group.vehiclePlate && (
                    <span className="shrink-0 rounded border border-custom-blue/40 bg-background/80 px-1.5 text-[10px] font-semibold leading-4 text-custom-blue">
                      {group.vehiclePlate}
                    </span>
                  )}
                  <span className="ml-2 font-normal text-muted-foreground">
                    · {group.tasks.length} task
                  </span>
                </h4>
              </div>

              <ol className="flex flex-1 flex-col gap-1.5 overflow-y-auto">
                {group.tasks.map((entry) => {
                  const isHighlighted = searchTask.trim() ? matchesSearch(entry, searchTask.trim()) : false;

                  return (
                    <li
                      key={`${group.id}-${entry.taskId}-${entry.sequence}`}
                      className={cn(
                        "rounded-md border px-2 py-1.5 text-xs",
                        isHighlighted
                          ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30"
                          : "border-border/70 bg-background"
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={logisticsKindSequenceDotClass(entry.logisticsTaskKind)}>
                            {entry.sequence}
                          </span>
                          <span className="shrink-0 font-semibold text-foreground">
                            {entry.logisticCode || "N/D"}
                          </span>
                          {entry.address && (
                            <span className="truncate text-[11px] text-muted-foreground">
                              {entry.address}
                            </span>
                          )}
                        </div>
                        <div className="mt-1 truncate pl-0 text-[10px] text-muted-foreground">
                          <span className="font-medium text-foreground/80">HK window:</span>{" "}
                          {entry.hkWindow}
                          <span className="mx-1.5 text-border">·</span>
                          <span className="font-medium text-foreground/80">LG window:</span>{" "}
                          {entry.lgWindow}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
