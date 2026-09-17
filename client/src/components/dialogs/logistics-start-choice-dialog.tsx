import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { LOGISTICS_START_CHOICE_AUTO } from "@shared/logistics-zone-start-plan";
import type {
  LogisticsPreferredStartsPayload,
  LogisticsZoneStartPlan,
  LogisticsZoneStartTaskOption,
} from "@shared/logistics-zone-start-plan";

const AUTO = LOGISTICS_START_CHOICE_AUTO;
const AUTO_SEARCH_VALUE = "auto lascia scegliere algoritmo";

type DriverPlan = LogisticsZoneStartPlan["drivers"][number];

function taskLabel(task: LogisticsZoneStartTaskOption): string {
  const address = task.address?.trim();
  const priority = task.priority ? ` · ${task.priority}` : "";
  return address
    ? `${task.logisticCode} · ${address}${priority}`
    : `${task.logisticCode}${priority}`;
}

function taskSearchValue(task: LogisticsZoneStartTaskOption): string {
  return [task.logisticCode, task.address, task.priority, task.taskId]
    .filter((part) => part != null && String(part).trim() !== "")
    .join(" ");
}

function StartTaskCombobox({
  driverId,
  tasks,
  value,
  onChange,
}: {
  driverId: number;
  tasks: LogisticsZoneStartTaskOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedTask = tasks.find((task) => String(task.taskId) === value);
  const label =
    value !== AUTO && selectedTask ? taskLabel(selectedTask) : "Lascia scegliere all'algoritmo";

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between border-2 border-custom-blue font-normal"
          data-testid={`select-start-task-${driverId}`}
        >
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="z-[200] w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <Command>
          <CommandInput placeholder="Cerca codice o indirizzo..." />
          <CommandList>
            <CommandEmpty>Nessun appartamento trovato.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={AUTO_SEARCH_VALUE}
                onSelect={() => {
                  onChange(AUTO);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn("mr-2 h-4 w-4", value === AUTO ? "opacity-100" : "opacity-0")}
                />
                Lascia scegliere all&apos;algoritmo
              </CommandItem>
              {tasks.map((task) => {
                const selected = value === String(task.taskId);
                return (
                  <CommandItem
                    key={task.taskId}
                    value={taskSearchValue(task)}
                    onSelect={() => {
                      onChange(String(task.taskId));
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn("mr-2 h-4 w-4", selected ? "opacity-100" : "opacity-0")}
                    />
                    <span className="truncate">{taskLabel(task)}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function isPopoverOutsideEvent(event: { target: EventTarget | null }): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest("[data-radix-popper-content-wrapper]") ||
      target.closest("[cmdk-list]") ||
      target.closest("[cmdk-input-wrapper]")
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
  onConfirm: (preferredStarts: LogisticsPreferredStartsPayload) => void;
}) {
  const [choices, setChoices] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open || !plan) return;
    const next: Record<string, string> = {};
    for (const driver of plan.drivers) {
      next[String(driver.driverId)] = AUTO;
    }
    setChoices(next);
  }, [open, plan]);

  const drivers = plan?.drivers ?? [];
  const canConfirm = drivers.length > 0;

  const payload = useMemo(() => {
    const preferredStarts: LogisticsPreferredStartsPayload = {};
    for (const driver of drivers) {
      const value = choices[String(driver.driverId)] ?? AUTO;
      if (value === AUTO) continue;
      const taskId = Number(value);
      if (Number.isFinite(taskId) && taskId > 0) {
        preferredStarts[String(driver.driverId)] = taskId;
      }
    }
    return preferredStarts;
  }, [choices, drivers]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
        data-testid="dialog-logistics-start-choice"
        onPointerDownOutside={(event) => {
          if (isPopoverOutsideEvent(event)) event.preventDefault();
        }}
        onFocusOutside={(event) => {
          if (isPopoverOutsideEvent(event)) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (isPopoverOutsideEvent(event)) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Da dove partire</DialogTitle>
          <DialogDescription>
            I giri sono già divisi per autista. Per ciascuno scegli il primo task, oppure lascia
            che lo scelga l&apos;algoritmo. Puoi digitare codice o indirizzo per trovarlo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {drivers.map((driver: DriverPlan) => (
            <div
              key={driver.driverId}
              className="rounded-md border-2 border-custom-blue/50 p-3"
              data-testid={`start-choice-driver-${driver.driverId}`}
            >
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ backgroundColor: driver.zoneColor }}
                  aria-hidden
                />
                <p className="min-w-0 truncate text-sm font-semibold text-foreground">
                  {driver.driverName}
                </p>
                <span className="text-xs text-muted-foreground">{driver.zoneLabel}</span>
              </div>
              <StartTaskCombobox
                driverId={driver.driverId}
                tasks={driver.tasks}
                value={choices[String(driver.driverId)] ?? AUTO}
                onChange={(nextValue) =>
                  setChoices((current) => ({
                    ...current,
                    [String(driver.driverId)]: nextValue,
                  }))
                }
              />
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="border-2 border-custom-blue"
            onClick={onCancel}
            data-testid="button-cancel-start-choice"
          >
            Annulla
          </Button>
          <Button
            type="button"
            className="border-2 border-custom-blue"
            disabled={!canConfirm}
            onClick={() => onConfirm(payload)}
            data-testid="button-confirm-start-choice"
          >
            Continua
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
