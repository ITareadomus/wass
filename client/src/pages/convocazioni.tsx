import { useState, useEffect, useMemo } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Users, CalendarIcon, ArrowLeft, Save, UserPlus, Search, RefreshCw, AlertTriangle, Truck, Bike } from "lucide-react";
import { format, differenceInCalendarDays } from "date-fns";
import { it } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from 'wouter';

interface LogisticsVehicleOption {
  id: number;
  name: string;
  pms_code: string | null;
}

interface Cleaner {
  id: number;
  name: string;
  lastname: string;
  alias?: string | null;
  role: string;
  active: boolean;
  ranking: number;
  counter_hours: number;
  counter_days: number;
  available: boolean;
  contract_type: string;
  last_worked_date?: string | null;
  preferred_customers: number[];
  telegram_id: number | null;
  start_time: string | null;
  show_plus_one?: boolean;
  assigned_vehicle_id?: number | null;
  assigned_vehicle_name?: string | null;
  assigned_vehicle_pms_code?: string | null;
  assigned_vehicle_task_id?: number | null;
}

interface TaskStats {
  total: number;
  premium: number;
  standard: number;
  straordinarie: number;
}

function convocationKindFromSearch(): "cleaners" | "drivers" {
  if (typeof window === "undefined") return "cleaners";
  return new URLSearchParams(window.location.search).get("kind") === "drivers" ? "drivers" : "cleaners";
}

function useConvocationKind(): "cleaners" | "drivers" {
  const [kind, setKind] = useState<"cleaners" | "drivers">(convocationKindFromSearch);
  useEffect(() => {
    const sync = () => setKind(convocationKindFromSearch());
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return kind;
}

export default function Convocazioni() {
  const convKind = useConvocationKind();
  const isDrivers = convKind === "drivers";

  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [taskStats, setTaskStats] = useState<TaskStats>({ total: 0, premium: 0, standard: 0, straordinarie: 0 });
  const [selectedCleaners, setSelectedCleaners] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Inizializzazione...");
  const [searchCleaner, setSearchCleaner] = useState("");
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    // Leggi la data dal parametro URL se presente
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date');

    if (dateParam) {
      // Converte yyyy-MM-dd in Date senza problemi di timezone
      const [year, month, day] = dateParam.split('-').map(Number);
      return new Date(year, month - 1, day);
    }

    // Altrimenti usa la data salvata in localStorage
    const savedDate = localStorage.getItem('selected_work_date');
    if (savedDate) {
      const [year, month, day] = savedDate.split('-').map(Number);
      return new Date(year, month - 1, day);
    }

    return new Date();
  });
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Aggiunto uno stato per i cleaners filtrati per evitare che vengano sovrascritti quando cambia la data
  const [filteredCleaners, setFilteredCleaners] = useState<Cleaner[]>([]);
  const [showOnlyNotConvocatiDaDueGiorni, setShowOnlyNotConvocatiDaDueGiorni] = useState(false);

  useEffect(() => {
    const loadCleaners = async () => {
      try {
        setIsLoading(true);
        setLoadingMessage(
          isDrivers ? "Estrazione driver dal database..." : "Estrazione cleaners dal database..."
        );

        const dateStr = format(selectedDate, "yyyy-MM-dd");
        localStorage.setItem("selected_work_date", dateStr);

        const extractUrl = isDrivers ? "/api/extract-logistics-drivers" : "/api/extract-cleaners-optimized";
        const extractResponse = await fetch(extractUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: dateStr }),
        });

        if (!extractResponse.ok) {
          throw new Error(isDrivers ? "Errore durante l'estrazione dei driver" : "Errore durante l'estrazione dei cleaners");
        }

        const extractResult = await extractResponse.json();
        console.log("Estrazione completata:", extractResult);

        setLoadingMessage(isDrivers ? "Caricamento driver..." : "Caricamento cleaners...");

        const rosterUrl = isDrivers
          ? `/api/logistics-drivers?date=${dateStr}`
          : `/api/cleaners?date=${dateStr}`;
        const rosterResponse = await fetch(rosterUrl, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        if (!rosterResponse.ok) {
          throw new Error(isDrivers ? "Impossibile caricare i driver" : "Impossibile caricare i cleaners");
        }

        const rosterData = await rosterResponse.json();
        let dateCleaners = (isDrivers ? rosterData.drivers : rosterData.cleaners) || [];

        if (isDrivers) {
          const vRes = await fetch(`/api/logistics-vehicles?date=${dateStr}`, {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
          });
          if (vRes.ok) {
            const vj = await vRes.json();
            setLogisticsVehicles(Array.isArray(vj.vehicles) ? vj.vehicles : []);
          } else {
            setLogisticsVehicles([]);
          }
        } else {
          setLogisticsVehicles([]);
        }

        const selectedUrl = isDrivers
          ? `/api/selected-logistics-drivers?date=${dateStr}`
          : `/api/selected-cleaners?date=${dateStr}`;
        const selectedResponse = await fetch(selectedUrl, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        let alreadySelectedIds = new Set<number>();
        let preselectedIds = new Set<number>();
        const preselectedVehicleByDriver: Record<number, string> = {};

        if (selectedResponse.ok) {
          const selectedData = await selectedResponse.json();
          const selectedDateFromFile = selectedData.metadata?.date;
          if (selectedDateFromFile === dateStr) {
            const selectedIds = isDrivers
              ? selectedData.drivers?.map((c: any) => c.id) || []
              : selectedData.cleaners?.map((c: any) => c.id) || [];
            alreadySelectedIds = new Set(selectedIds);
            preselectedIds = new Set(selectedIds);
            if (isDrivers) {
              for (const d of selectedData.drivers || []) {
                if (d?.id != null && d?.assigned_vehicle_id != null) {
                  const sid = Number(d.assigned_vehicle_id);
                  if (Number.isFinite(sid)) {
                    preselectedVehicleByDriver[Number(d.id)] = String(sid);
                  }
                }
              }
            }
          }
        }

        const timelineUrl = isDrivers ? `/api/logistics-timeline?date=${dateStr}` : `/api/timeline?date=${dateStr}`;
        const timelineResponse = await fetch(timelineUrl);
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            const timelineDateFromFile = timelineData.metadata?.date;
            if (timelineDateFromFile === dateStr) {
              if (isDrivers && timelineData.drivers_assignments) {
                for (const row of timelineData.drivers_assignments) {
                  if (row.driver?.id) preselectedIds.add(row.driver.id);
                }
              }
              if (!isDrivers && timelineData.cleaners_assignments) {
                for (const row of timelineData.cleaners_assignments) {
                  if (row.cleaner?.id) preselectedIds.add(row.cleaner.id);
                }
              }
            }
          } catch (e) {
            console.warn("⚠️ Errore parsing timeline:", e);
          }
        }

        const availableCleaners = dateCleaners.filter((c: any) => c.active === true);
        availableCleaners.sort((a: any, b: any) => b.counter_hours - a.counter_hours);

        setCleaners(availableCleaners);
        setFilteredCleaners(availableCleaners);

        const allPreselectedIds = new Set([...alreadySelectedIds, ...preselectedIds]);
        setSelectedCleaners(allPreselectedIds);
        setSelectedVehicleByDriver(preselectedVehicleByDriver);

        setLoadingMessage("Caricamento statistiche task...");
        await loadTaskStats(dateStr, isDrivers);

        setIsLoading(false);
        setLoadingMessage("Caricamento completato!");
      } catch (error) {
        console.error("Errore nel caricamento convocazioni:", error);
        setLoadingMessage(isDrivers ? "Errore nel caricamento dei driver" : "Errore nel caricamento dei cleaners");
        setIsLoading(false);
      }
    };

    void loadCleaners();
  }, [selectedDate, convKind]);

  const loadTaskStats = async (dateStr: string, driversMode: boolean) => {
    try {
      const statsUrl = driversMode
        ? `/api/logistics-containers?date=${encodeURIComponent(dateStr)}`
        : `/api/containers?date=${encodeURIComponent(dateStr)}`;
      const res = await fetch(statsUrl);
      if (!res.ok) throw new Error('Errore durante il caricamento dei containers');
      const data = await res.json();
      const c = data.containers || {};
      const allTasks = [
        ...(c.early_out?.tasks || []),
        ...(c.high_priority?.tasks || []),
        ...(c.low_priority?.tasks || []),
      ];
      let total = 0, premium = 0, standard = 0, straordinarie = 0;
      for (const t of allTasks) {
        const isStraordinaria = t.straordinaria === true || (t as any).is_straordinaria === true || Number(t.operation_id) === 3;
        const isPremium = t.premium === true || t.premium === 1 || t.premium === "1";
        total += 1;
        if (isStraordinaria) straordinarie += 1;
        else if (isPremium) premium += 1;
        else standard += 1;
      }
      setTaskStats({ total, premium, standard, straordinarie });
    } catch (error) {
      console.error('Errore nel caricamento delle statistiche task:', error);
    }
  };

    const notConvocatiDaDueGiorniCount = useMemo(() => {
    const today = new Date();
    return filteredCleaners.filter((c) => {
      if (!c.last_worked_date) return false;
      const s = String(c.last_worked_date).trim();
      const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const d = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
      if (!d || isNaN(d.getTime())) return false;
      const days = differenceInCalendarDays(today, d);
      return days > 2;
    }).length;
  }, [filteredCleaners]);

  const cleanersToShow = useMemo(() => {
    if (!showOnlyNotConvocatiDaDueGiorni) return filteredCleaners;
    const today = new Date();
    return filteredCleaners.filter((c) => {
      if (!c.last_worked_date) return false;
      const s = String(c.last_worked_date).trim();
      const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      const d = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
      if (!d || isNaN(d.getTime())) return false;
      return differenceInCalendarDays(today, d) > 2;
    });
  }, [filteredCleaners, showOnlyNotConvocatiDaDueGiorni]);

  const [selectedVehicleByDriver, setSelectedVehicleByDriver] = useState<Record<number, string>>({});
  const [logisticsVehicles, setLogisticsVehicles] = useState<LogisticsVehicleOption[]>([]);

  const availableVehicles = logisticsVehicles;
  const availableVehicleById = useMemo(() => {
    const map = new Map<number, LogisticsVehicleOption>();
    for (const v of availableVehicles) map.set(v.id, v);
    return map;
  }, [availableVehicles]);
  const vehiclePmsCodeById = useMemo(() => {
    const map: Record<number, string | null> = {};
    for (const v of availableVehicles) {
      map[v.id] = v.pms_code && String(v.pms_code).trim() ? String(v.pms_code).trim() : null;
    }
    return map;
  }, [availableVehicles]);

  const driversRoster = useMemo(() => filteredCleaners, [filteredCleaners]);

  const visibleRoster = useMemo(() => cleanersToShow, [cleanersToShow]);

  const selectedDrivers = useMemo(
    () => (isDrivers ? driversRoster.filter((c) => selectedCleaners.has(c.id)) : []),
    [driversRoster, selectedCleaners, isDrivers]
  );
  const assignedVehicleIds = useMemo(() => {
    const used = new Set<number>();
    for (const rawId of Object.values(selectedVehicleByDriver)) {
      const id = Number(rawId);
      if (Number.isFinite(id)) used.add(id);
    }
    return used;
  }, [selectedVehicleByDriver]);

  const selectedDriverNames = useMemo(() => {
    if (!isDrivers) return [];
    return selectedDrivers.map((c) => `${c.name} ${c.lastname}`.trim());
  }, [selectedDrivers, isDrivers]);

  const toggleCleanerSelection = (cleanerId: number, isAvailable: boolean) => {
    // Se il cleaner è già selezionato, lo deseleziona
    if (selectedCleaners.has(cleanerId)) {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        newSet.delete(cleanerId);
        return newSet;
      });
      setSelectedVehicleByDriver((prev) => {
        const next = { ...prev };
        delete next[cleanerId];
        return next;
      });
      // (+1) istantaneo: nascondi quando deselezioni
      setCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: false } : c));
      setFilteredCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: false } : c));
      return;
    }

    // Se non è disponibile, mostra il dialog di conferma
    if (!isAvailable) {
      setConfirmDialog({ open: true, cleanerId });
      return;
    }

    // Altrimenti seleziona direttamente il cleaner
    setSelectedCleaners(prev => {
      const newSet = new Set(prev);
      newSet.add(cleanerId);
      return newSet;
    });
    // (+1) istantaneo: mostra quando convochi
    setCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: true } : c));
    setFilteredCleaners(prev => prev.map(c => c.id === cleanerId ? { ...c, show_plus_one: true } : c));
  };

  const handleConfirmUnavailable = () => {
    if (confirmDialog.cleanerId === null) {
      setConfirmDialog({ open: false, cleanerId: null });
      return;
    }
    const id = confirmDialog.cleanerId;
    const isCurrentlySelected = selectedCleaners.has(id);
    if (isCurrentlySelected) {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        newSet.delete(id);
        return newSet;
      });
      setSelectedVehicleByDriver((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: false } : c));
      setFilteredCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: false } : c));
    } else {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        newSet.add(id);
        return newSet;
      });
      setCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: true } : c));
      setFilteredCleaners(prev => prev.map(c => c.id === id ? { ...c, show_plus_one: true } : c));
    }
    setConfirmDialog({ open: false, cleanerId: null });
  };

  const handleSaveSelection = async (): Promise<boolean> => {
    const label = isDrivers ? "driver" : "cleaner";
    if (selectedCleaners.size === 0) {
      toast({
        variant: "destructive",
        title: `⚠️ Nessun ${label} selezionato`,
        description: `Seleziona almeno un ${label} prima di salvare`,
      });
      return false;
    }

    try {
      setIsSaving(true);
      const dateStr = format(selectedDate, "yyyy-MM-dd");
      const user = JSON.parse(localStorage.getItem("user") || "{}");

      if (isDrivers) {
        const timelineResponse = await fetch(`/api/logistics-timeline?date=${dateStr}`);
        let timelineDrivers: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.drivers_assignments) {
              timelineDrivers = timelineData.drivers_assignments
                .map((ca: any) => ca.driver)
                .filter((c: any) => c && selectedCleaners.has(c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline logistics:", e);
          }
        }
        const fromUI = filteredCleaners.filter((c) => selectedCleaners.has(c.id));
        const tlIds = new Set(timelineDrivers.map((c) => c.id));
        const uniqueFromUI = fromUI.filter((c) => !tlIds.has(c.id));
        const selectedData = [...timelineDrivers, ...uniqueFromUI].map((d: any) => {
          const assignedVehicleIdRaw = selectedVehicleByDriver[d.id];
          const assignedVehicleId = assignedVehicleIdRaw ? Number(assignedVehicleIdRaw) : null;
          const assignedVehicle = assignedVehicleId ? availableVehicleById.get(assignedVehicleId) : undefined;
          return {
            ...d,
            assigned_vehicle_id: assignedVehicleId,
            assigned_vehicle_name: assignedVehicle?.name ?? null,
            assigned_vehicle_pms_code: assignedVehicle?.pms_code ?? null,
          };
        });
        const response = await fetch("/api/save-selected-logistics-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            drivers: selectedData,
            total_selected: selectedData.length,
            date: dateStr,
            action_type: "replace",
            modified_by: user.username || "unknown",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio dei driver");
        const transferResponse = await fetch("/api/sync-logistics-driver-vehicles-to-adam", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            date: dateStr,
            username: user.username || "unknown",
          }),
        });
        if (!transferResponse.ok) {
          throw new Error("Errore nella sincronizzazione driver-veicolo su ADAM");
        }
        const transferResult = await transferResponse.json();
        if (!transferResult?.success) {
          throw new Error(
            transferResult?.message || "Sincronizzazione driver-veicolo su ADAM non riuscita"
          );
        }
        toast({
          variant: "success",
          title: `${selectedData.length} driver salvati con successo`,
          description: `Salvati su PG e sincronizzati su ADAM per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
        });
      } else {
        const timelineResponse = await fetch(`/api/timeline?date=${dateStr}`);
        let timelineCleaners: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.cleaners_assignments) {
              timelineCleaners = timelineData.cleaners_assignments
                .map((ca: any) => ca.cleaner)
                .filter((c: any) => c && selectedCleaners.has(c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline cleaners:", e);
          }
        }
        const cleanersFromUI = filteredCleaners.filter((c) => selectedCleaners.has(c.id));
        const timelineCleanerIds = new Set(timelineCleaners.map((c) => c.id));
        const uniqueCleanersFromUI = cleanersFromUI.filter((c) => !timelineCleanerIds.has(c.id));
        const selectedCleanersData = [...timelineCleaners, ...uniqueCleanersFromUI];
        const response = await fetch("/api/save-selected-cleaners", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cleaners: selectedCleanersData,
            total_selected: selectedCleanersData.length,
            date: dateStr,
            action_type: "replace",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio dei cleaners");
        toast({
          variant: "success",
          title: `${selectedCleanersData.length} cleaner salvati con successo!`,
          description: `I cleaners sono stati salvati per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
        });
      }
      return true;
    } catch (error) {
      console.error("Errore nel salvataggio:", error);
      toast({
        variant: "destructive",
        title: "❌ Errore nel salvataggio",
        description: isDrivers
          ? "Si è verificato un errore nel salvataggio/sincronizzazione driver"
          : "Si è verificato un errore nel salvataggio dei cleaners selezionati",
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddCleaners = async () => {
    const label = isDrivers ? "driver" : "cleaner";
    if (selectedCleaners.size === 0) {
      toast({
        variant: "destructive",
        title: `⚠️ Nessun ${label} selezionato`,
        description: `Seleziona almeno un ${label} prima di aggiungere`,
      });
      return;
    }

    try {
      setIsSaving(true);
      const dateStr = format(selectedDate, "yyyy-MM-dd");
      const user = JSON.parse(localStorage.getItem("user") || "{}");

      if (isDrivers) {
        const timelineResponse = await fetch(`/api/logistics-timeline?date=${dateStr}`);
        let timelineDrivers: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.drivers_assignments) {
              timelineDrivers = timelineData.drivers_assignments
                .map((ca: any) => ca.driver)
                .filter((c: any) => c && selectedCleaners.has(c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline logistics:", e);
          }
        }
        const currentResponse = await fetch(`/api/selected-logistics-drivers?date=${dateStr}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        const currentData = await currentResponse.json();
        const currentDrivers = currentData.drivers || [];
        const fromUI = filteredCleaners.filter((c) => selectedCleaners.has(c.id));
        const tlIds = new Set(timelineDrivers.map((c) => c.id));
        const uniqueFromUI = fromUI.filter((c) => !tlIds.has(c.id));
        const allSelected = [...timelineDrivers, ...uniqueFromUI].map((d: any) => {
          const assignedVehicleIdRaw = selectedVehicleByDriver[d.id];
          const assignedVehicleId = assignedVehicleIdRaw ? Number(assignedVehicleIdRaw) : null;
          const assignedVehicle = assignedVehicleId ? availableVehicleById.get(assignedVehicleId) : undefined;
          return {
            ...d,
            assigned_vehicle_id: assignedVehicleId,
            assigned_vehicle_name: assignedVehicle?.name ?? null,
            assigned_vehicle_pms_code: assignedVehicle?.pms_code ?? null,
          };
        });
        const existingIds = new Set(currentDrivers.map((c: any) => c.id));
        const newOnes = allSelected.filter((c) => !existingIds.has(c.id));
        const merged = [...currentDrivers, ...newOnes];
        const response = await fetch("/api/save-selected-logistics-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            drivers: merged,
            total_selected: merged.length,
            date: dateStr,
            action_type: "add",
            modified_by: user.username || "unknown",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio");
        if (newOnes.length === 0) {
          toast({
            variant: "success",
            title: "Nessun nuovo driver aggiunto",
            description: `Tutti i driver selezionati sono già presenti per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 4000,
          });
        } else {
          toast({
            variant: "success",
            title: `${newOnes.length} driver aggiunti correttamente!`,
            description: `Totale driver: ${merged.length} per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 3000,
          });
        }
        sessionStorage.setItem("preserveAssignments", "true");
        setLocation("/generate-logistics-assignments");
      } else {
        const timelineResponse = await fetch(`/api/timeline?date=${dateStr}`);
        let timelineCleaners: Cleaner[] = [];
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            if (timelineData.metadata?.date === dateStr && timelineData.cleaners_assignments) {
              timelineCleaners = timelineData.cleaners_assignments
                .map((ca: any) => ca.cleaner)
                .filter((c: any) => c && selectedCleaners.has(c.id));
            }
          } catch (e) {
            console.warn("⚠️ Errore caricamento timeline cleaners:", e);
          }
        }
        const currentResponse = await fetch(`/api/selected-cleaners?date=${dateStr}`, {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
        });
        const currentData = await currentResponse.json();
        const currentCleaners = currentData.cleaners || [];
        const cleanersFromUI = filteredCleaners.filter((c) => selectedCleaners.has(c.id));
        const timelineCleanerIds = new Set(timelineCleaners.map((c) => c.id));
        const uniqueCleanersFromUI = cleanersFromUI.filter((c) => !timelineCleanerIds.has(c.id));
        const allSelectedCleaners = [...timelineCleaners, ...uniqueCleanersFromUI];
        const existingIds = new Set(currentCleaners.map((c: any) => c.id));
        const newCleaners = allSelectedCleaners.filter((c) => !existingIds.has(c.id));
        const mergedCleaners = [...currentCleaners, ...newCleaners];
        const response = await fetch("/api/save-selected-cleaners", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cleaners: mergedCleaners,
            total_selected: mergedCleaners.length,
            date: dateStr,
            action_type: "add",
          }),
        });
        if (!response.ok) throw new Error("Errore nel salvataggio");
        if (newCleaners.length === 0) {
          toast({
            variant: "success",
            title: "Nessun nuovo cleaner aggiunto",
            description: `Tutti i cleaners selezionati sono già presenti per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 4000,
          });
        } else {
          toast({
            variant: "success",
            title: `${newCleaners.length} cleaner aggiunti correttamente!`,
            description: `Totale cleaners: ${mergedCleaners.length} per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
            duration: 3000,
          });
        }
        sessionStorage.setItem("preserveAssignments", "true");
        setLocation("/generate-assignments");
      }
    } catch (error) {
      console.error("Errore nell'aggiunta:", error);
      toast({
        variant: "destructive",
        title: "❌ Errore nell'aggiunta",
        description: isDrivers
          ? "Si è verificato un errore durante l'aggiunta dei driver"
          : "Si è verificato un errore durante l'aggiunta dei cleaners",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="p-4 w-full">
        <div className="mb-6 space-y-4">
          {/* Header con titolo e selettore data */}
          <div className="flex justify-between items-center flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-foreground flex items-center gap-2 flex-wrap">
                <Users className="w-8 h-8 text-custom-blue" />
                {isDrivers ? "CONVOCAZIONI DRIVER del" : "CONVOCAZIONI del"}
              </h1>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "justify-start text-left font-normal",
                      !selectedDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "dd/MM/yyyy", { locale: it }) : <span>Seleziona data</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={(date) => date && setSelectedDate(date)}
                    initialFocus
                    locale={it}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="space-y-4 text-center">
                <div className="flex justify-center">
                  <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
                </div>
                <h2 className="text-xl font-bold text-foreground">Caricamento Convocazioni</h2>
                <div className="flex items-center justify-center space-x-2 text-sm text-muted-foreground">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                  <span>{loadingMessage}</span>
                </div>
              </div>
            </div>
          ) : (
            /* Barra Contatore */
            <div className="bg-custom-blue-light rounded-xl border-2 border-custom-blue shadow-lg p-6">
              <div className="flex items-center gap-4 w-full">
                <div className="flex items-center gap-4 shrink-0">
                  <div className="text-lg font-semibold text-foreground">
                    {isDrivers ? "DRIVERS SELEZIONATI" : "CLEANERS SELEZIONATI"}
                  </div>
                  <div className="text-lg font-bold">
                    <span className="text-primary">{isDrivers ? selectedDrivers.length : selectedCleaners.size}</span>
                    <span className="text-muted-foreground mx-1">/</span>
                    <span className="text-foreground">{driversRoster.length}</span>
                  </div>
                </div>
                <div className="flex-1 min-w-0" aria-hidden />
                <button
                  type="button"
                  onClick={() => setShowOnlyNotConvocatiDaDueGiorni((prev) => !prev)}
                  className={cn(
                    "text-sm shrink-0 text-right rounded px-2 py-1 -mx-2 -my-1 transition-colors",
                    showOnlyNotConvocatiDaDueGiorni
                      ? "text-yellow-600 dark:text-yellow-400 bg-amber-500/20 underline"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  {isDrivers ? "Driver" : "Cleaners"} non convocati da due giorni o più:{" "}
                  <span className="font-bold text-yellow-500 dark:text-yellow-400">{notConvocatiDaDueGiorniCount}</span>
                  {showOnlyNotConvocatiDaDueGiorni && " (clicca per mostrare tutti)"}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Grid con lista cleaners e statistiche affiancate */}
        {!isLoading && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-200px)]">
          {/* Lista Cleaners - 2/3 dello spazio */}
          <Card className="p-6 lg:col-span-2 flex flex-col overflow-hidden border-2 border-custom-blue bg-custom-blue-light dark:bg-custom-blue">
            <div className="mb-4 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-custom-blue" />
              <Input
                placeholder={isDrivers ? "Cerca driver per nome..." : "Cerca cleaner per nome..."}
                value={searchCleaner}
                onChange={(e) => setSearchCleaner(e.target.value)}
                className="pl-10 border-2 border-custom-blue"
                data-testid="input-search-cleaner"
              />
            </div>

            <div className="space-y-3 flex-1 overflow-y-auto pr-2">
              {visibleRoster
                .filter((cleaner) =>
                  `${cleaner.name} ${cleaner.lastname}`
                    .toUpperCase()
                    .includes(searchCleaner.toUpperCase())
                )
                .map((cleaner) => {
                  const isAvailable = cleaner.available !== false;
                  const isPremium = cleaner.role === "Premium";
                  const isFormatore = cleaner.role === "Formatore";
                  const canDoStraordinaria = cleaner.role === "Straordinario";
                  const selectedVehicleIdRaw = selectedVehicleByDriver[cleaner.id];
                  const selectedVehicleId = selectedVehicleIdRaw ? Number(selectedVehicleIdRaw) : null;
                  const selectedVehicleName = selectedVehicleId
                    ? (availableVehicleById.get(selectedVehicleId)?.name ?? "").toString().trim()
                    : "";
                  const isScooterVehicle = /^piaggio\b/i.test(selectedVehicleName);
                  const selectedVehiclePlate = selectedVehicleId
                    ? vehiclePmsCodeById[selectedVehicleId] ?? null
                    : null;
                  const lastWorked = cleaner.last_worked_date
                    ? (() => {
                        const s = String(cleaner.last_worked_date).trim();
                        const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
                        return match
                          ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
                          : null;
                      })()
                    : null;
                  const daysSinceLastWorked =
                    lastWorked != null ? differenceInCalendarDays(new Date(), lastWorked) : null;
                  const showNotConvocatoWarning =
                    daysSinceLastWorked != null && daysSinceLastWorked > 2;

                  const borderColor = "border-2 border-custom-blue";
                  const bgColor = "bg-white dark:bg-background";

                  return (
                    <div
                      key={cleaner.id}
                      onClick={() => toggleCleanerSelection(cleaner.id, isAvailable)}
                      className={`flex items-center justify-between p-4 rounded-lg transition-all ${borderColor} ${bgColor} ${
                        !isAvailable
                          ? "opacity-60 cursor-pointer hover:opacity-70"
                          : "hover:opacity-80 cursor-pointer"
                      }`}
                    >
                  <div className="flex items-start gap-4 flex-1">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground text-lg">
                          {cleaner.name.toUpperCase()} {cleaner.lastname.toUpperCase()}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {!isAvailable && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                              Non disponibile
                            </span>
                          )}
                          {isDrivers ? (
                            <>
                              {cleaner.role === "Formatore" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                                  Formatore
                                </span>
                              )}
                              {cleaner.role === "Straordinario" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700">
                                  Straordinario
                                </span>
                              )}
                              {cleaner.role === "Premium" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700">
                                  Premium
                                </span>
                              )}
                              {cleaner.role === "Standard" && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                                  Standard
                                </span>
                              )}
                              {!["Formatore", "Straordinario", "Premium", "Standard"].includes(
                                String(cleaner.role || "")
                              ) && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-500/30 text-sky-900 dark:bg-sky-500/40 dark:text-sky-100 border-sky-600 dark:border-sky-400">
                                  Driver
                                </span>
                              )}
                              {selectedVehiclePlate && (
                                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200 border-sky-300 dark:border-sky-700">
                                  {isScooterVehicle ? (
                                    <Bike className="h-3.5 w-3.5" />
                                  ) : (
                                    <Truck className="h-3.5 w-3.5" />
                                  )}
                                  <span>{selectedVehiclePlate}</span>
                                </span>
                              )}
                            </>
                          ) : (
                            <>
                              {isFormatore && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-500/30 text-orange-800 dark:bg-orange-500/40 dark:text-orange-200 border-orange-600 dark:border-orange-400">
                                  Formatore
                                </span>
                              )}
                              {canDoStraordinaria && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-500/30 text-red-800 dark:bg-red-500/40 dark:text-red-200 border-red-600 dark:border-red-400">
                                  Straordinario
                                </span>
                              )}
                              {isPremium && !canDoStraordinaria && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400">
                                  Premium
                                </span>
                              )}
                              {!isPremium && !isFormatore && !canDoStraordinaria && (
                                <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400">
                                  Standard
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-foreground/80">
                        <span className="font-semibold">Ore questa settimana:</span> {(() => {
                          const hours = cleaner.counter_hours;
                          // Handle if counter_hours is accidentally a time string like "10:00"
                          if (typeof hours === 'string' && (hours as string).includes(':')) {
                            return '0.00';
                          }
                          return Number(hours || 0).toFixed(2);
                        })()}h
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Giorni consecutivi:</span>{' '}
                        <span className="inline-flex items-center gap-1">
                          {cleaner.counter_days}
                          {cleaner.show_plus_one && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="font-semibold text-yellow-600 dark:text-yellow-500">(+1)</span>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>In programma per questa data ma report non ancora compilato</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </span>
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Ultimo giorno lavorato:</span> {cleaner.last_worked_date ? (() => {
                          const s = String(cleaner.last_worked_date).trim();
                          const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
                          const d = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(s);
                          return isNaN(d.getTime()) ? "—" : format(d, "dd/MM/yyyy", { locale: it });
                        })() : "—"}
                        {showNotConvocatoWarning && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex items-center align-middle ml-1">
                                <AlertTriangle className="h-4 w-4 text-amber-500 -translate-y-px animate-pulse shrink-0" aria-hidden />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p>Non convocato da {daysSinceLastWorked} giorni</p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Contratto:</span> {cleaner.contract_type}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className={`flex items-center gap-1 bg-background border-2 rounded-lg px-3 py-1 ${borderColor}`}>
                      <span className="text-xs font-semibold text-foreground mr-2">Start Time:</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.start_time || "10:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes - 30;
                          if (totalMinutes < 0) totalMinutes += 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          // Aggiorna ENTRAMBI gli stati (cleaners E filteredCleaners)
                          setCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">−</span>
                      </Button>
                      <span className="text-sm font-mono font-bold min-w-[45px] text-center">
                        {cleaner.start_time || "10:00"}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.start_time || "10:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes + 30;
                          if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          // Aggiorna ENTRAMBI gli stati (cleaners E filteredCleaners)
                          setCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">+</span>
                      </Button>
                    </div>
                    <Switch
                      checked={selectedCleaners.has(cleaner.id)}
                      onCheckedChange={() => toggleCleanerSelection(cleaner.id, isAvailable)}
                      className="scale-150 pointer-events-none"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <Dialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog({ open, cleanerId: null })}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{isDrivers ? "Driver non disponibile" : "Cleaner Non Disponibile"}</DialogTitle>
                <DialogDescription>
                  {isDrivers
                    ? "Questo driver risulta non disponibile. Sei sicuro di volerlo selezionare?"
                    : "Questo cleaner risulta non disponibile. Sei sicuro di volerlo selezionare?"}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button 
                  variant="outline" 
                  onClick={() => setConfirmDialog({ open: false, cleanerId: null })}
                  className="border-2 border-custom-blue"
                >
                  Annulla
                </Button>
                <Button 
                  onClick={handleConfirmUnavailable}
                  className="bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
                >
                  Conferma
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <div className="flex justify-center mt-4 pt-4 border-t">
            <Button
              onClick={async () => {
                const ok = await handleSaveSelection();
                if (ok) {
                  setLocation(isDrivers ? "/generate-logistics-assignments" : "/generate-assignments");
                }
              }}
              size="lg"
              disabled={selectedCleaners.size === 0 || isSaving}
              className="flex items-center gap-2 bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
              data-testid="button-save-and-home"
            >
              {isSaving ? (
                <RefreshCw className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1" />
              )}
              {isSaving ? "Salvataggio..." : "Salva e Torna alla Home"}
              {!isSaving && <ArrowLeft className="w-4 h-4 ml-1" />}
            </Button>
          </div>
        </Card>

        {/* Pannello Statistiche - 1/3 dello spazio - FISSO */}
        <Card className="p-6 border-2 bg-background flex flex-col h-full overflow-hidden">
          <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center">
            <svg
              className="w-5 h-5 mr-2 text-custom-blue"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            Statistiche
          </h3>

          {/* Statistiche Task */}
          <div className="mb-4 pb-3 border-b border-border">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">Task Giornata</h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-blue-100 dark:bg-blue-950/50 rounded-lg p-2 border-2 border-blue-300 dark:border-blue-700">
                <div className="text-lg font-bold text-blue-800 dark:text-blue-200">{taskStats.total}</div>
                <div className="text-[10px] text-blue-800 dark:text-blue-200">Totale</div>
              </div>
              <div className="bg-yellow-100 dark:bg-yellow-950/50 rounded-lg p-2 border-2 border-yellow-300 dark:border-yellow-700">
                <div className="text-lg font-bold text-yellow-800 dark:text-yellow-200">{taskStats.premium}</div>
                <div className="text-[10px] text-yellow-800 dark:text-yellow-200">Premium</div>
              </div>
              <div className="bg-green-100 dark:bg-green-950/50 rounded-lg p-2 border-2 border-green-300 dark:border-green-700">
                <div className="text-lg font-bold text-green-800 dark:text-green-200">{taskStats.standard}</div>
                <div className="text-[10px] text-green-800 dark:text-green-200">Standard</div>
              </div>
              <div className="bg-red-100 dark:bg-red-950/50 rounded-lg p-2 border-2 border-red-300 dark:border-red-700">
                <div className="text-lg font-bold text-red-800 dark:text-red-200">{taskStats.straordinarie}</div>
                <div className="text-[10px] text-red-800 dark:text-red-200">Straordinarie</div>
              </div>
            </div>
          </div>

          {/* Statistiche roster */}
          <h4 className="text-xs font-semibold text-muted-foreground mb-2">
            {isDrivers ? "Driver" : "Cleaners"}
          </h4>
          <div className="grid grid-cols-2 gap-2">
            {/* Disponibili */}
            <div className="bg-blue-100 dark:bg-blue-950/50 rounded-lg p-2 h-[117px] flex flex-col items-center justify-center border-2 border-blue-300 dark:border-blue-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-blue-200 dark:text-blue-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.available !== false).length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-blue-500 dark:text-blue-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-blue-600 dark:fill-blue-400"
                >
                {driversRoster.length > 0 ? Math.round((driversRoster.filter(c => c.available !== false).length / driversRoster.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-blue-800 dark:text-blue-200 text-center">Disponibili</span>
              <span className="text-[9px] text-blue-800 dark:text-blue-200">
                {driversRoster.filter(c => c.available !== false).length}/{driversRoster.length}
              </span>
            </div>

            {/* Non Disponibili */}
            <div className="bg-gray-100 dark:bg-gray-950/50 rounded-lg p-2 h-[117px] flex flex-col items-center justify-center border-2 border-gray-300 dark:border-gray-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-gray-200 dark:text-gray-800"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${driversRoster.length > 0 ? (driversRoster.filter(c => c.available === false).length / driversRoster.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-gray-500 dark:text-gray-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-gray-600 dark:fill-gray-400"
                >
                  {driversRoster.length > 0 ? Math.round((driversRoster.filter(c => c.available === false).length / driversRoster.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-gray-800 dark:text-gray-200 text-center">Non Disponibili</span>
              <span className="text-[9px] text-gray-800 dark:text-gray-200">
                {driversRoster.filter(c => c.available === false).length}/{driversRoster.length}
              </span>
            </div>

            {!isDrivers && (
              <>
            {/* Premium */}
            <div className="bg-yellow-100 dark:bg-yellow-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-yellow-300 dark:border-yellow-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-yellow-200 dark:text-yellow-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.role === "Premium").length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-yellow-500 dark:text-yellow-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-yellow-600 dark:fill-yellow-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.role === "Premium").length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-yellow-800 dark:text-yellow-200 text-center">Premium</span>
              <span className="text-[9px] text-yellow-800 dark:text-yellow-200">
                {filteredCleaners.filter(c => c.role === "Premium").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Standard */}
            <div className="bg-green-100 dark:bg-green-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-green-300 dark:border-green-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-green-200 dark:text-green-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.role === "Standard").length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-green-500 dark:text-green-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-green-600 dark:fill-green-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.role === "Standard").length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-green-800 dark:text-green-200 text-center">Standard</span>
              <span className="text-[9px] text-green-800 dark:text-green-200">
                {filteredCleaners.filter(c => c.role === "Standard").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Formatori */}
            <div className="bg-orange-100 dark:bg-orange-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-orange-300 dark:border-orange-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-orange-200 dark:text-orange-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.role === "Formatore").length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-orange-500 dark:text-orange-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-orange-600 dark:fill-orange-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.role === "Formatore").length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-orange-800 dark:text-orange-200 text-center">Formatori</span>
              <span className="text-[9px] text-orange-800 dark:text-orange-200">
                {filteredCleaners.filter(c => c.role === "Formatore").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Straordinari */}
            <div className="bg-red-100 dark:bg-red-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-red-300 dark:border-red-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-red-200 dark:text-red-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.role === "Straordinario").length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-red-500 dark:text-red-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-red-600 dark:fill-red-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.role === "Straordinario").length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-red-800 dark:text-red-200 text-center">Straordinari</span>
              <span className="text-[9px] text-red-800 dark:text-red-200">
                {filteredCleaners.filter(c => c.role === "Straordinario").length}/{filteredCleaners.length}
              </span>
            </div>
              </>
            )}
          </div>

          {isDrivers && (
            <div className="mt-4 pt-3 border-t border-border flex-1 min-h-0">
              <h4 className="text-xs font-semibold text-muted-foreground mb-2">Veicoli</h4>
              <div className="bg-slate-100 dark:bg-slate-950/50 rounded-lg p-3 border-2 border-slate-300 dark:border-slate-700 h-[calc(100%-12px)] mb-[12px] overflow-y-auto">
                {selectedDriverNames.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Nessun driver selezionato.
                  </p>
                ) : (
                  <div className="space-y-1">
                    {selectedDrivers.map((driver) => (
                      <div key={driver.id} className="flex items-center gap-2">
                        <div className="text-xs font-medium text-slate-800 dark:text-slate-200 flex-1">
                          {`${driver.name} ${driver.lastname}`.trim()}
                        </div>
                        {(() => {
                          const currentVehicleId = Number(selectedVehicleByDriver[driver.id] ?? "");
                          const selectableVehicles = availableVehicles.filter((vehicle) => {
                            if (vehicle.id === currentVehicleId) return true;
                            return !assignedVehicleIds.has(vehicle.id);
                          });
                          return (
                        <select
                          value={selectedVehicleByDriver[driver.id] ?? ""}
                          onChange={(e) =>
                            setSelectedVehicleByDriver((prev) => ({
                              ...prev,
                              [driver.id]: e.target.value,
                            }))
                          }
                          className="h-7 text-xs rounded border border-slate-300 dark:border-slate-700 bg-background px-2 min-w-[120px]"
                        >
                          <option value="">Seleziona veicolo</option>
                          {selectableVehicles.map((vehicle) => (
                            <option key={vehicle.id} value={vehicle.id}>
                              {vehicle.name}
                            </option>
                          ))}
                        </select>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>
      </div>
        )}
    </div>
  </div>
  );
}