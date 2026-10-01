import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { resolveDeliveryQuotas, splitDeliveryRemainder } from "@shared/logistics-delivery-quotas";

export interface DeliveryQuotaDriverOption {
  driverId: number;
  driverName: string;
}

function parseQuotaInput(raw: string): number | null | "invalid" {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  return Number(trimmed);
}

export function LogisticsDeliveryQuotaDialog({
  open,
  drivers,
  total,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  drivers: DeliveryQuotaDriverOption[];
  total: number;
  onCancel: () => void;
  onConfirm: (deliveryQuotas: Record<string, number | null> | null) => void;
}) {
  const [inputs, setInputs] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;
    setInputs({});
  }, [open, drivers, total]);

  const parsed = useMemo(
    () =>
      drivers.map((driver) => ({
        ...driver,
        quota: parseQuotaInput(inputs[driver.driverId] ?? ""),
      })),
    [drivers, inputs],
  );
  const resolution = useMemo(
    () =>
      resolveDeliveryQuotas({
        total,
        drivers: parsed.map((driver) => ({
          driverId: driver.driverId,
          driverName: driver.driverName,
          quota: driver.quota === "invalid" ? null : driver.quota,
        })),
      }),
    [parsed, total],
  );
  const error = resolution.error;
  const equalSplit = splitDeliveryRemainder(total, drivers.length);
  const countForDriver = (driverId: number, index: number): number | null => {
    const resolved = resolution.counts?.get(driverId);
    if (resolved != null) return resolved;
    if (!resolution.error && resolution.explicitSum === 0) return equalSplit[index] ?? 0;
    const quota = parsed[index]?.quota;
    return typeof quota === "number" ? quota : null;
  };
  const selectableNumbers = (driverId: number): number[] => {
    const takenByOthers = parsed.reduce((sum, driver) => {
      if (driver.driverId === driverId || typeof driver.quota !== "number") return sum;
      return sum + driver.quota;
    }, 0);
    const max = Math.max(0, total - takenByOthers);
    const numbers = Array.from({ length: max + 1 }, (_, value) => value);
    const current = Number(inputs[driverId] ?? "");
    if (Number.isInteger(current) && current >= 0 && !numbers.includes(current)) {
      numbers.push(current);
      numbers.sort((left, right) => left - right);
    }
    return numbers;
  };

  const confirm = () => {
    if (error) return;
    const anyQuota = parsed.some((driver) => typeof driver.quota === "number");
    if (!anyQuota) {
      onConfirm(null);
      return;
    }
    const payload: Record<string, number | null> = {};
    for (const driver of parsed) {
      payload[String(driver.driverId)] = driver.quota === "invalid" ? null : driver.quota;
    }
    onConfirm(payload);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-custom-blue sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Quante consegne per autista</DialogTitle>
          <DialogDescription>
            Scegli quante consegne fare prima del calcolo delle zone. Algoritmo lascia la quantità automatica.
            I numeri scelti, insieme a chi resta in automatico, devono chiudere le {total} consegne della giornata.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-custom-blue">{total} consegne in giornata.</p>
          {drivers.map((driver, index) => {
            const assigned = countForDriver(driver.driverId, index);
            const typed = typeof parsed[index]?.quota === "number";
            return (
              <div key={driver.driverId} className="space-y-1.5 rounded-md border-2 border-custom-blue p-3">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={`quota-${driver.driverId}`} className="text-sm font-semibold">
                    {driver.driverName}
                  </Label>
                  <span className="shrink-0 text-sm font-semibold text-custom-blue">
                    {assigned == null ? "—" : `${assigned} consegne`}
                  </span>
                </div>
                <Select
                  value={(inputs[driver.driverId] ?? "") === "" ? "auto" : inputs[driver.driverId]}
                  onValueChange={(value) =>
                    setInputs((current) => ({
                      ...current,
                      [driver.driverId]: value === "auto" ? "" : value,
                    }))
                  }
                >
                  <SelectTrigger id={`quota-${driver.driverId}`} className="h-9 border-custom-blue">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Algoritmo</SelectItem>
                    {selectableNumbers(driver.driverId).map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        {value}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {typed
                    ? "Numero scelto da te."
                    : resolution.explicitSum > 0
                      ? "Calcolato sull'avanzo della giornata."
                      : "Divise in automatico tra gli autisti."}
                </p>
              </div>
            );
          })}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <p className={error ? "text-xs text-red-600 dark:text-red-400" : "text-xs text-custom-blue"}>
            {error ?? "Poi vengono calcolate le zone e scegli il primo appartamento."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" className="border-2 border-custom-blue" onClick={onCancel}>
              Annulla
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-2 border-custom-blue bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={Boolean(error) || total <= 0}
              onClick={confirm}
            >
              Calcola le zone
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
