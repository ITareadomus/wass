import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, Check, ChevronsUpDown, MapPin } from "lucide-react";
import { LogisticsZoneStartMap } from "@/components/dialogs/logistics-zone-start-map";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
import type {
  LogisticsDriverZoneStartChoice,
  LogisticsPreferredStartsPayload,
  LogisticsZoneDriverAssignmentsPayload,
  LogisticsZoneStartPlan,
  LogisticsZoneStartTaskOption,
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
  ) => void;
}) {
  const [drafts, setDrafts] = useState<DriverStartDraft[]>([]);
  const [swapNonce, setSwapNonce] = useState(0);

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
    setSwapNonce(0);
  }, [open, plan]);

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
    setDrafts((current) => {
      const fromIndex = current.findIndex((draft) => draft.driverId === fromDriverId);
      const toIndex = current.findIndex((draft) => draft.driverId === toDriverId);
      if (fromIndex < 0 || toIndex < 0) return current;
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
      return next;
    });
    setSwapNonce((value) => value + 1);
  };

  const handleConfirm = () => {
    const preferredStarts: LogisticsPreferredStartsPayload = {};
    const zoneDriverIds: LogisticsZoneDriverAssignmentsPayload = {};
    for (const draft of drafts) {
      zoneDriverIds[String(draft.zoneIndex)] = draft.driverId;
      if (draft.selectedTaskId != null) {
        preferredStarts[String(draft.driverId)] = draft.selectedTaskId;
      }
    }
    onConfirm(preferredStarts, zoneDriverIds);
  };

  const canSwap = drafts.length >= 2;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent className="max-h-[92vh] w-[min(96vw,1180px)] max-w-[1180px] overflow-hidden border-custom-blue">
        <DialogHeader>
          <DialogTitle>Scegli il primo appartamento per ogni autista</DialogTitle>
          <DialogDescription>
            A destra vedi le zone geografiche colorate per autista. Puoi scambiarle e, se vuoi, fissare da quale apt parte
            ciascuno: il punto scelto si evidenzia in giallo sulla mappa.
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 max-h-[68vh] gap-4 overflow-y-auto lg:grid-cols-[minmax(280px,0.95fr)_minmax(420px,1.15fr)] lg:overflow-hidden">
          <div className="space-y-4 pr-1 lg:max-h-full lg:overflow-y-auto">
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
                    <p className="mt-1 text-xs text-custom-blue">{driver.zoneLabel}</p>
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
                    onSelect={(taskId) =>
                      setDrafts((current) =>
                        current.map((draft) =>
                          draft.driverId === driver.driverId ? { ...draft, selectedTaskId: taskId } : draft,
                        ),
                      )
                    }
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="min-h-[280px] h-[42vh] lg:h-full lg:min-h-[360px]">
            <LogisticsZoneStartMap
              drivers={mapDrivers}
              selectedTaskIds={selectedTaskIds}
              onSelectTask={(driverId, taskId) =>
                setDrafts((current) =>
                  current.map((draft) => (draft.driverId === driverId ? { ...draft, selectedTaskId: taskId } : draft)),
                )
              }
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <p className="text-xs text-custom-blue">
            Clicca un punto sulla mappa per fissare il primo apt. I colori coincidono con quelli della timeline.
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="border-2 border-custom-blue" onClick={onCancel}>
              Annulla
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-2 border-custom-blue bg-primary text-primary-foreground hover:bg-primary/90"
              onClick={handleConfirm}
            >
              Continua
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
