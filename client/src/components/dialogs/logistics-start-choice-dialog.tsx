import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Check, ChevronsUpDown, MapPin } from "lucide-react";
import { LogisticsZoneStartMap, type ZoneShapePath } from "@/components/dialogs/logistics-zone-start-map";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
import { assignTasksToZonePolygons } from "@shared/logistics-zone-edit";
import type {
  LogisticsDriverZoneStartChoice,
  LogisticsPreferredStartsPayload,
  LogisticsZoneDriverAssignmentsPayload,
  LogisticsZoneStartPlan,
  LogisticsZoneStartTaskOption,
  LogisticsZoneTaskIdsPayload,
} from "@shared/logistics-zone-start-plan";

type DriverStartDraft = {
  driverId: number;
  driverName: string;
  zoneIndex: number;
  zoneLabel: string;
  zoneColor: string;
  tasks: LogisticsZoneStartTaskOption[];
  selectedTaskId: number | null;
};

function taskSearchText(task: LogisticsZoneStartTaskOption): string {
  return [task.logisticCode, task.address, task.priority].filter(Boolean).join(" ").toLowerCase();
}

function collectKnownTasks(
  drafts: DriverStartDraft[],
  unassignedTasks: LogisticsZoneStartTaskOption[],
): LogisticsZoneStartTaskOption[] {
  const seen = new Set<number>();
  const tasks: LogisticsZoneStartTaskOption[] = [];
  for (const task of [...drafts.flatMap((draft) => draft.tasks), ...unassignedTasks]) {
    if (seen.has(task.taskId)) continue;
    seen.add(task.taskId);
    tasks.push(task);
  }
  return tasks;
}

function previousZoneByTaskId(drafts: DriverStartDraft[]): Map<number, number> {
  const previous = new Map<number, number>();
  for (const draft of drafts) {
    for (const task of draft.tasks) {
      previous.set(task.taskId, draft.zoneIndex);
    }
  }
  return previous;
}

function applyZoneAssignmentsToDrafts(
  drafts: DriverStartDraft[],
  allTasks: LogisticsZoneStartTaskOption[],
  zoneByTaskId: Map<number, number | null>,
): { drafts: DriverStartDraft[]; unassignedTasks: LogisticsZoneStartTaskOption[] } {
  const tasksByZone = new Map<number, LogisticsZoneStartTaskOption[]>();
  const unassignedTasks: LogisticsZoneStartTaskOption[] = [];
  for (const task of allTasks) {
    const zoneIndex = zoneByTaskId.get(task.taskId);
    if (zoneIndex == null) {
      unassignedTasks.push(task);
      continue;
    }
    const list = tasksByZone.get(zoneIndex) ?? [];
    list.push(task);
    tasksByZone.set(zoneIndex, list);
  }
  return {
    drafts: drafts.map((draft) => {
      const tasks = tasksByZone.get(draft.zoneIndex) ?? [];
      const selectedStillThere = tasks.some((task) => task.taskId === draft.selectedTaskId);
      return {
        ...draft,
        tasks,
        selectedTaskId: selectedStillThere ? draft.selectedTaskId : null,
      };
    }),
    unassignedTasks,
  };
}

function StartAptCombobox({
  tasks,
  selectedTaskId,
  onSelect,
}: {
  tasks: LogisticsZoneStartTaskOption[];
  selectedTaskId: number | null;
  onSelect: (taskId: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedTask = tasks.find((task) => task.taskId === selectedTaskId) ?? null;
  const triggerLabel = selectedTask
    ? `${selectedTask.logisticCode}${selectedTask.address ? ` · ${selectedTask.address}` : ""}`
    : "Lascia scegliere all'algoritmo";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-auto min-h-9 w-full justify-between border-custom-blue px-3 py-2 text-left font-normal"
        >
          <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <Command>
          <CommandInput placeholder="Cerca apt, indirizzo o priorità..." />
          <CommandList>
            <CommandEmpty>Nessun appartamento trovato.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="lascia scegliere algoritmo automatico"
                onSelect={() => {
                  onSelect(null);
                  setOpen(false);
                }}
              >
                <Check className={cn("mr-2 h-4 w-4", selectedTaskId == null ? "opacity-100" : "opacity-0")} />
                Lascia scegliere all'algoritmo
              </CommandItem>
              {tasks.map((task) => (
                <CommandItem
                  key={task.taskId}
                  value={`${task.taskId} ${taskSearchText(task)}`}
                  onSelect={() => {
                    onSelect(task.taskId);
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", selectedTaskId === task.taskId ? "opacity-100" : "opacity-0")} />
                  <span className="min-w-0 flex-1 truncate">
                    {task.logisticCode}
                    {task.address ? ` · ${task.address}` : ""}
                    {task.priority ? ` · ${task.priority}` : ""}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function LogisticsStartChoiceDialog({
  open,
  plan,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  plan: LogisticsZoneStartPlan | null;
  onCancel: () => void;
  onConfirm: (
    preferredStarts: LogisticsPreferredStartsPayload,
    zoneDriverIds: LogisticsZoneDriverAssignmentsPayload,
    zoneTaskIds: LogisticsZoneTaskIdsPayload,
  ) => void;
}) {
  const [drafts, setDrafts] = useState<DriverStartDraft[]>([]);
  const [unassignedTasks, setUnassignedTasks] = useState<LogisticsZoneStartTaskOption[]>([]);
  const [zoneShapes, setZoneShapes] = useState<Record<number, ZoneShapePath[]>>({});
  const [swapNonce, setSwapNonce] = useState(0);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [scratchDrawnZoneIndices, setScratchDrawnZoneIndices] = useState<number[]>([]);
  const zoneShapesRef = useRef(zoneShapes);
  const draftsRef = useRef(drafts);
  const unassignedRef = useRef(unassignedTasks);
  const scratchDrawnZoneIndicesRef = useRef<Set<number>>(new Set());
  zoneShapesRef.current = zoneShapes;
  draftsRef.current = drafts;
  unassignedRef.current = unassignedTasks;
  scratchDrawnZoneIndicesRef.current = new Set(scratchDrawnZoneIndices);

  useEffect(() => {
    if (!open) return;
    setDrafts(
      (plan?.drivers ?? []).map((driver) => ({
        driverId: driver.driverId,
        driverName: driver.driverName,
        zoneIndex: driver.zoneIndex,
        zoneLabel: driver.zoneLabel,
        zoneColor: getPersonnelHexColor(driver.driverId, "logistics"),
        tasks: driver.tasks,
        selectedTaskId: null,
      })),
    );
    setUnassignedTasks([]);
    unassignedRef.current = [];
    setZoneShapes({});
    setScratchDrawnZoneIndices([]);
    scratchDrawnZoneIndicesRef.current = new Set();
    setSwapNonce(0);
    setMapFullscreen(false);
  }, [open, plan]);

  const applyShapesToDrafts = (shapes: Record<number, ZoneShapePath[]>, preferredZoneIndex?: number) => {
    const currentDrafts = draftsRef.current;
    const allTasks = collectKnownTasks(currentDrafts, unassignedRef.current);
    const applied = applyZoneAssignmentsToDrafts(
      currentDrafts,
      allTasks,
      assignTasksToZonePolygons(
        allTasks,
        previousZoneByTaskId(currentDrafts),
        Object.entries(shapes).map(([key, shapePath]) => ({
          zoneIndex: Number(key),
          path: shapePath,
        })),
        preferredZoneIndex,
      ),
    );
    draftsRef.current = applied.drafts;
    unassignedRef.current = applied.unassignedTasks;
    setDrafts(applied.drafts);
    setUnassignedTasks(applied.unassignedTasks);
  };

  const scratchDrawnShapes = useMemo(() => {
    const next: Record<number, ZoneShapePath[]> = {};
    for (const zoneIndex of scratchDrawnZoneIndices) {
      const path = zoneShapes[zoneIndex];
      if (path && path.length >= 3) next[zoneIndex] = path;
    }
    return next;
  }, [scratchDrawnZoneIndices, zoneShapes]);

  const selectedTaskIds = useMemo(() => {
    return new Set(
      drafts
        .map((draft) => draft.selectedTaskId)
        .filter((taskId): taskId is number => Number.isInteger(taskId) && taskId > 0),
    );
  }, [drafts]);

  const mapDrivers = useMemo<LogisticsDriverZoneStartChoice[]>(
    () =>
      drafts.map((draft) => ({
        driverId: draft.driverId,
        driverName: draft.driverName,
        zoneIndex: draft.zoneIndex,
        zoneLabel: draft.zoneLabel,
        zoneColor: draft.zoneColor,
        tasks: draft.tasks,
      })),
    [drafts],
  );

  const swapZone = (fromDriverId: number, toDriverId: number) => {
    if (fromDriverId === toDriverId) return;
    const current = draftsRef.current;
    const fromIndex = current.findIndex((draft) => draft.driverId === fromDriverId);
    const toIndex = current.findIndex((draft) => draft.driverId === toDriverId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = current.map((draft) => ({ ...draft }));
    const from = next[fromIndex];
    const to = next[toIndex];
    next[fromIndex] = {
      ...from,
      zoneIndex: to.zoneIndex,
      zoneLabel: to.zoneLabel,
      tasks: to.tasks,
      selectedTaskId: to.selectedTaskId,
    };
    next[toIndex] = {
      ...to,
      zoneIndex: from.zoneIndex,
      zoneLabel: from.zoneLabel,
      tasks: from.tasks,
      selectedTaskId: from.selectedTaskId,
    };
    draftsRef.current = next;
    setDrafts(next);
    setSwapNonce((value) => value + 1);
  };

  const handleZoneShapeChange = (zoneIndex: number, path: ZoneShapePath[]) => {
    const nextShapes = { ...zoneShapesRef.current, [zoneIndex]: path };
    zoneShapesRef.current = nextShapes;
    setZoneShapes(nextShapes);
    applyShapesToDrafts(nextShapes, zoneIndex);
  };

  const handleScratchZoneDrawn = (zoneIndex: number, path: ZoneShapePath[]) => {
    const nextShapes: Record<number, ZoneShapePath[]> = {};
    for (const drawnIndex of scratchDrawnZoneIndicesRef.current) {
      const existing = zoneShapesRef.current[drawnIndex];
      if (drawnIndex !== zoneIndex && existing && existing.length >= 3) {
        nextShapes[drawnIndex] = existing;
      }
    }
    nextShapes[zoneIndex] = path;
    const nextDrawn = new Set([...scratchDrawnZoneIndicesRef.current, zoneIndex]);
    scratchDrawnZoneIndicesRef.current = nextDrawn;
    setScratchDrawnZoneIndices([...nextDrawn]);
    zoneShapesRef.current = nextShapes;
    setZoneShapes(nextShapes);
    applyShapesToDrafts(nextShapes, zoneIndex);
  };

  const handleConfirm = () => {
    if (unassignedTasks.length > 0) return;
    const preferredStarts: LogisticsPreferredStartsPayload = {};
    const zoneDriverIds: LogisticsZoneDriverAssignmentsPayload = {};
    const zoneTaskIds: LogisticsZoneTaskIdsPayload = {};
    for (const draft of drafts) {
      zoneDriverIds[String(draft.zoneIndex)] = draft.driverId;
      zoneTaskIds[String(draft.zoneIndex)] = draft.tasks.map((task) => task.taskId);
      if (draft.selectedTaskId != null) {
        preferredStarts[String(draft.driverId)] = draft.selectedTaskId;
      }
    }
    onConfirm(preferredStarts, zoneDriverIds, zoneTaskIds);
  };

  const canSwap = drafts.length >= 2;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setMapFullscreen(false);
          onCancel();
        }
      }}
    >
      <DialogContent
        className={cn(
          "overflow-hidden border-custom-blue",
          mapFullscreen
            ? "left-0 top-0 flex h-[100dvh] max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0"
            : "max-h-[92vh] w-[min(96vw,1180px)] max-w-[1180px]",
        )}
        onEscapeKeyDown={(event) => {
          if (!mapFullscreen) return;
          event.preventDefault();
          setMapFullscreen(false);
        }}
        onPointerDownOutside={(event) => {
          if (mapFullscreen) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (mapFullscreen) event.preventDefault();
        }}
      >
        <DialogHeader className={mapFullscreen ? "sr-only" : undefined}>
          <DialogTitle>Scegli il primo appartamento per ogni autista</DialogTitle>
          <DialogDescription>
            Le zone sono già divise in base alle consegne scelte. Qui fissi solo il primo appartamento, oppure lo lasci
            all&apos;algoritmo. A destra puoi ancora spostare i bordi delle zone.
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "grid min-h-0 gap-4",
            mapFullscreen
              ? "h-full min-h-0 flex-1 overflow-hidden lg:grid-cols-1"
              : "max-h-[68vh] overflow-y-auto lg:grid-cols-[minmax(280px,0.95fr)_minmax(420px,1.15fr)] lg:overflow-hidden",
          )}
        >
          <div className={cn("space-y-4 pr-1 lg:max-h-full lg:overflow-y-auto", mapFullscreen && "hidden")}>
            {drafts.map((driver) => (
              <div key={driver.driverId} className="space-y-2 rounded-md border-2 border-custom-blue p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-3 w-3 shrink-0 rounded-full border border-black/10"
                        style={{ backgroundColor: driver.zoneColor }}
                        aria-hidden
                      />
                      <p className="truncate text-sm font-semibold">{driver.driverName}</p>
                    </div>
                    <p className="mt-1 text-xs text-custom-blue">
                      {driver.zoneLabel} · {driver.tasks.length} apt
                    </p>
                  </div>
                  {canSwap ? (
                    <div className="flex min-w-[176px] items-center gap-1">
                      <Select
                        key={`${driver.driverId}-${swapNonce}`}
                        onValueChange={(value) => {
                          const targetId = Number(value);
                          if (Number.isInteger(targetId) && targetId > 0) {
                            swapZone(driver.driverId, targetId);
                          }
                        }}
                      >
                        <SelectTrigger className="h-8 border-custom-blue text-xs">
                          <SelectValue placeholder="Scambia con zona" />
                        </SelectTrigger>
                        <SelectContent>
                          {drafts
                            .filter((other) => other.driverId !== driver.driverId)
                            .map((other) => (
                              <SelectItem key={other.driverId} value={String(other.driverId)}>
                                {other.zoneLabel}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <ArrowLeftRight className="h-4 w-4 shrink-0 text-custom-blue" aria-hidden />
                    </div>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5 text-xs text-custom-blue">
                    <MapPin className="h-3.5 w-3.5" />
                    Primo appartamento
                  </Label>
                  <StartAptCombobox
                    tasks={driver.tasks}
                    selectedTaskId={driver.selectedTaskId}
                    onSelect={(taskId) => {
                      const next = draftsRef.current.map((draft) =>
                        draft.driverId === driver.driverId ? { ...draft, selectedTaskId: taskId } : draft,
                      );
                      draftsRef.current = next;
                      setDrafts(next);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div
            className={cn(
              "min-h-[280px]",
              mapFullscreen ? "h-full min-h-0" : "h-[42vh] lg:h-full lg:min-h-[360px]",
            )}
          >
            <LogisticsZoneStartMap
              drivers={mapDrivers}
              unassignedTasks={unassignedTasks}
              selectedTaskIds={selectedTaskIds}
              zoneShapes={zoneShapes}
              scratchDrawnShapes={scratchDrawnShapes}
              fullscreen={mapFullscreen}
              onFullscreenChange={setMapFullscreen}
              onZoneShapesReady={(shapes) => {
                zoneShapesRef.current = shapes;
                setZoneShapes(shapes);
                applyShapesToDrafts(shapes);
              }}
              onZoneShapeChange={handleZoneShapeChange}
              onScratchZoneDrawn={handleScratchZoneDrawn}
              onSelectTask={(driverId, taskId) => {
                const next = draftsRef.current.map((draft) =>
                  draft.driverId === driverId ? { ...draft, selectedTaskId: taskId } : draft,
                );
                draftsRef.current = next;
                setDrafts(next);
              }}
            />
          </div>
        </div>
        <DialogFooter className={cn("gap-2 sm:justify-between", mapFullscreen && "hidden")}>
          <p className="text-xs text-custom-blue">
            {unassignedTasks.length > 0
              ? `Ingloba tutti gli apt nelle zone per continuare. ${unassignedTasks.length} fuori zona.`
              : "Clicca un punto per fissare il primo apt. I colori coincidono con quelli della timeline."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="border-2 border-custom-blue" onClick={onCancel}>
              Annulla
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-2 border-custom-blue bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              onClick={handleConfirm}
              disabled={unassignedTasks.length > 0}
            >
              Continua
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
