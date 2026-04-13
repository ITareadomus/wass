import {
  Calendar as CalendarIcon,
  RotateCcw,
  Users,
  Loader2,
  UserMinus,
  UserPlus,
  Truck,
  RefreshCw,
  CheckCircle,
  Pencil,
  Save,
  Bike,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Droppable } from "react-beautiful-dnd";
import { useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import TaskCard from "@/components/drag-drop/task-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { getCleanerHexColor } from "@/lib/cleaner-colors";
import type { TaskType as Task } from "@shared/schema";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type PriorityWindows = {
  EO: { start: string; end: string };
  HP: { start: string; end: string };
  LP: { start: string; end?: string | null };
};

export interface LogisticsDriverRow {
  id: number;
  name?: string;
  lastname?: string;
  role?: string;
  premium?: boolean;
  start_time?: string | null;
  alias?: string;
  counter_hours?: number | string;
  counter_days?: number;
  contract_type?: string | null;
  show_plus_one?: boolean;
  /** Presente se il driver ha task in timeline ma non è più nei convocati */
  isRemoved?: boolean;
}

interface LogisticsTimelineViewProps {
  workDate: string;
  drivers: LogisticsDriverRow[];
  driversAssignments: Array<{ driver: LogisticsDriverRow; tasks: any[] }>;
  searchTask: string;
  isReadOnly?: boolean;
  isLoadingOverlay?: boolean;
  onRefresh: () => Promise<void>;
}

function priorityUiFromTask(t: any): "early-out" | "high" | "low" {
  const p = String(t?.priority || "").toLowerCase();
  if (["early_out", "early-out", "earlyout", "early_out_assignment", "eo"].includes(p)) return "early-out";
  if (["high_priority", "high-priority", "highpriority", "high", "high_priority_assignment", "hp"].includes(p)) return "high";
  return "low";
}

function timelineTaskToTask(t: any, driverId: number): Task {
  const cleaning = Number(t.cleaning_time) || 0;
  const hours = Math.floor(cleaning / 60);
  const mins = cleaning % 60;
  const pr = priorityUiFromTask(t);
  const co = t.confirmed_operation;
  const confirmed_operation =
    typeof co === "boolean" ? co : typeof co === "number" ? co !== 0 : undefined;
  return {
    id: String(t.task_id),
    name: String(t.logistic_code ?? t.task_id),
    alias: t.alias ?? undefined,
    type: String(t.customer_name || ""),
    duration: `${hours}.${String(mins).padStart(2, "0")}`,
    priority: pr,
    assignedTo: null,
    status: "pending",
    scheduledTime: t.start_time ?? null,
    address: t.address != null ? String(t.address) : undefined,
    lat: t.lat != null ? String(t.lat) : undefined,
    lng: t.lng != null ? String(t.lng) : undefined,
    premium: Boolean(t.premium),
    straordinaria: Boolean(t.straordinaria),
    confirmed_operation,
    checkout_date: t.checkout_date != null ? String(t.checkout_date) : undefined,
    checkout_time: t.checkout_time != null ? String(t.checkout_time) : undefined,
    checkin_date: t.checkin_date != null ? String(t.checkin_date) : undefined,
    checkin_time: t.checkin_time != null ? String(t.checkin_time) : undefined,
    pax_in: typeof t.pax_in === "number" ? t.pax_in : undefined,
    pax_out: typeof t.pax_out === "number" ? t.pax_out : undefined,
    operation_id: typeof t.operation_id === "number" ? t.operation_id : undefined,
    customer_name: t.customer_name != null ? String(t.customer_name) : undefined,
    customer_reference: t.customer_reference != null ? String(t.customer_reference) : undefined,
    type_apt: t.type_apt != null ? String(t.type_apt) : undefined,
    start_time: t.start_time != null ? String(t.start_time) : undefined,
    end_time: t.end_time != null ? String(t.end_time) : undefined,
    travel_time: t.travel_time != null ? Number(t.travel_time) : undefined,
    locked: Boolean(t.locked),
    locked_reason: t.locked_reason != null ? String(t.locked_reason) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...( { assignedCleaner: driverId, sequence: t.sequence } as any ),
  };
}

function highlightedIdsForDriverTasks(tasks: Task[], q: string): Set<string> {
  const result = new Set<string>();
  const lower = q.trim().toLowerCase();
  if (!lower) return result;
  for (const task of tasks) {
    const taskId = String(task.id);
    const code = String(task.name || "");
    const addr = String(task.address || "");
    const cn = String(task.customer_name || "");
    if (
      taskId.toLowerCase().includes(lower) ||
      code.toLowerCase().includes(lower) ||
      addr.toLowerCase().includes(lower) ||
      cn.toLowerCase().includes(lower)
    ) {
      result.add(taskId);
    }
  }
  return result;
}

export default function LogisticsTimelineView({
  workDate,
  drivers,
  driversAssignments,
  searchTask,
  isReadOnly = false,
  isLoadingOverlay = false,
  onRefresh,
}: LogisticsTimelineViewProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [showResetDialog, setShowResetDialog] = useState(false);
  const [showClearDriversDialog, setShowClearDriversDialog] = useState(false);
  const [addDriverOpen, setAddDriverOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const [availableDrivers, setAvailableDrivers] = useState<any[]>([]);
  const [driverToReplace, setDriverToReplace] = useState<number | null>(null);
  const [startTimeDialog, setStartTimeDialog] = useState<{
    open: boolean;
    driverId: number | null;
    driverName: string;
    isAvailable: boolean;
  }>({ open: false, driverId: null, driverName: "", isAvailable: true });
  const [pendingStartTime, setPendingStartTime] = useState("10:00");
  const [confirmUnavailableDialog, setConfirmUnavailableDialog] = useState<{
    open: boolean;
    driverId: number | null;
  }>({ open: false, driverId: null });

  const [showAdamTransferDialog, setShowAdamTransferDialog] = useState(false);
  const [lastAdamTransfer, setLastAdamTransfer] = useState<string | null>(null);
  const [isTransferringToAdam, setIsTransferringToAdam] = useState(false);

  const [priorityWindows, setPriorityWindows] = useState<PriorityWindows | null>(null);
  const [timelineWidthPx, setTimelineWidthPx] = useState(0);
  const timelineRowRef = useRef<HTMLDivElement>(null);

  const displayInputClass =
    "h-9 border-transparent bg-transparent shadow-none focus-visible:ring-0 px-0 pointer-events-none select-none";

  const [driverDetailsOpen, setDriverDetailsOpen] = useState(false);
  const [selectedDriverForDetails, setSelectedDriverForDetails] = useState<LogisticsDriverRow | null>(null);
  const [driversAliases, setDriversAliases] = useState<Record<number, { alias: string }>>({});
  const [aliasDialog, setAliasDialog] = useState<{
    open: boolean;
    driverId: number | null;
    driverName: string;
  }>({ open: false, driverId: null, driverName: "" });
  const [editingAlias, setEditingAlias] = useState("");
  const [isSavingAlias, setIsSavingAlias] = useState(false);
  const [editDriverStartDialog, setEditDriverStartDialog] = useState<{
    open: boolean;
    driverId: number | null;
    driverName: string;
  }>({ open: false, driverId: null, driverName: "" });
  const [pendingEditStartTime, setPendingEditStartTime] = useState("10:00");
  const [isSavingDriverStartTime, setIsSavingDriverStartTime] = useState(false);
  const [confirmRemoveDriverId, setConfirmRemoveDriverId] = useState<number | null>(null);
  const [selectedSwapDriver, setSelectedSwapDriver] = useState<string>("");

  const loadDriverAliases = useCallback(async () => {
    try {
      const response = await fetch(`/api/cleaners-aliases?date=${encodeURIComponent(workDate)}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });
      if (!response.ok) return;
      const aliasesData = await response.json();
      const raw = aliasesData.aliases || {};
      const mapped: Record<number, { alias: string }> = {};
      for (const [k, v] of Object.entries(raw)) {
        const id = Number(k);
        if (!Number.isFinite(id)) continue;
        mapped[id] = { alias: String((v as { alias?: string }).alias ?? "") };
      }
      setDriversAliases(mapped);
    } catch (e) {
      console.warn("loadDriverAliases:", e);
    }
  }, [workDate]);

  useEffect(() => {
    void loadDriverAliases();
  }, [loadDriverAliases]);

  useEffect(() => {
    if (!driverDetailsOpen || selectedDriverForDetails == null) return;
    const latest = drivers.find((d) => d.id === selectedDriverForDetails.id);
    if (!latest) return;
    setSelectedDriverForDetails((prev) =>
      prev?.id === latest.id ? { ...prev, ...latest } : prev
    );
  }, [drivers, driverDetailsOpen, selectedDriverForDetails?.id]);

  useEffect(() => {
    const loadPriorityWindows = async () => {
      try {
        const res = await fetch("/api/settings", {
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        if (!res.ok) return;
        const s = await res.json();
        const eoStart = s?.["early-out"]?.eo_start_time;
        const eoEnd = s?.["early-out"]?.eo_end_time;
        const hpStart = s?.["high-priority"]?.hp_start_time;
        const hpEnd = s?.["high-priority"]?.hp_end_time;
        const lpStart =
          s?.["low-priority"]?.lp_start_time ?? hpEnd ?? hpStart;
        if (eoStart && eoEnd && hpStart && hpEnd && lpStart) {
          setPriorityWindows({
            EO: { start: eoStart, end: eoEnd },
            HP: { start: hpStart, end: hpEnd },
            LP: { start: lpStart, end: null },
          });
        }
      } catch (e) {
        console.warn("Failed to load /api/settings for logistics priority windows", e);
      }
    };
    void loadPriorityWindows();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const response = await fetch(
          `/api/logistics-last-adam-transfer?date=${encodeURIComponent(workDate)}`
        );
        const data = await response.json();
        if (cancelled) return;
        if (data.success && data.lastTransfer) {
          setLastAdamTransfer(data.lastTransfer);
        } else {
          setLastAdamTransfer(null);
        }
      } catch {
        if (!cancelled) setLastAdamTransfer(null);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [workDate]);

  const handleTransferLogisticsToAdam = async () => {
    try {
      setIsTransferringToAdam(true);
      setShowAdamTransferDialog(false);

      const currentUser = JSON.parse(localStorage.getItem("user") || "{}");
      const pendingEdits = JSON.parse(sessionStorage.getItem("pending_task_edits") || "{}");

      if (Object.keys(pendingEdits).length > 0) {
        for (const [, edit] of Object.entries(pendingEdits)) {
          try {
            const taskEdit = edit as any;
            const updateResponse = await fetch("/api/update-task-details", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                taskId: taskEdit.taskId,
                logisticCode: taskEdit.logisticCode,
                checkoutDate: taskEdit.checkoutDate,
                checkoutTime: taskEdit.checkoutTime,
                checkinDate: taskEdit.checkinDate,
                checkinTime: taskEdit.checkinTime,
                cleaningTime: taskEdit.cleaningTime,
                paxIn: taskEdit.paxIn,
                paxOut: taskEdit.paxOut,
                operationId: taskEdit.operationId,
                date: workDate,
                modified_by: currentUser.username || "system",
              }),
            });
            await updateResponse.json();
          } catch (editError) {
            console.warn("Salvataggio task pendente prima del transfer:", editError);
          }
        }
      }

      toast({
        title: "Trasferimento in corso…",
        description: "Registrazione assegnazioni logistica",
        variant: "default",
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await fetch("/api/transfer-logistics-to-adam", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: workDate,
          username: currentUser.username || "system",
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();

      if (result.success) {
        sessionStorage.removeItem("pending_task_edits");
        try {
          const lr = await fetch(
            `/api/logistics-last-adam-transfer?date=${encodeURIComponent(workDate)}`
          );
          const lj = await lr.json();
          if (lj.success && lj.lastTransfer) setLastAdamTransfer(lj.lastTransfer);
          else setLastAdamTransfer(new Date().toISOString());
        } catch {
          setLastAdamTransfer(new Date().toISOString());
        }
        toast({
          title: "Trasferimento completato",
          description: result.message || "Assegnazioni logistica registrate",
          variant: "success",
        });
      } else {
        toast({
          title: "Errore trasferimento",
          description: result.message || "Operazione non riuscita",
          variant: "destructive",
        });
      }
    } catch (error: any) {
      console.error("Errore trasferimento ADAM (logistica):", error);
      let errorMessage = "Impossibile comunicare con il server";
      if (error.name === "AbortError") {
        errorMessage = "Timeout: il server impiega troppo tempo a rispondere";
      } else if (error.message) {
        errorMessage = error.message;
      }
      toast({
        title: "Errore connessione",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsTransferringToAdam(false);
    }
  };

  const assignmentByDriver = new Map<number, any[]>();
  for (const row of driversAssignments) {
    assignmentByDriver.set(row.driver.id, row.tasks || []);
  }

  const hasTasksInTimeline = driversAssignments.some((r) => (r.tasks?.length || 0) > 0);

  const calculateDriverColumnWidth = () => {
    if (drivers.length === 0) return 96;
    const maxLength = drivers.reduce((max, d) => {
      const label =
        driversAliases[d.id]?.alias ||
        d.alias ||
        `${d.name ?? ""} ${d.lastname ?? ""}`.trim() ||
        `ID ${d.id}`;
      return Math.max(max, label.length);
    }, 0);
    const baseWidth = 60;
    const charWidth = 7.5;
    const badgeSpace = 30;
    return Math.max(96, baseWidth + maxLength * charWidth + badgeSpace);
  };
  const driverColumnWidth = calculateDriverColumnWidth();

  const getGlobalStartTime = () => {
    if (drivers.length === 0) return "10:00";
    const startTimes = drivers.map((d) => d.start_time || "10:00");
    return startTimes.reduce((min, current) => {
      const [minH, minM] = min.split(":").map(Number);
      const [curH, curM] = current.split(":").map(Number);
      const minMinutes = minH * 60 + minM;
      const curMinutes = curH * 60 + curM;
      return curMinutes < minMinutes ? current : min;
    });
  };

  const generateGlobalTimeSlots = () => {
    const globalStartTime = getGlobalStartTime();
    const [startHour, startMin] = globalStartTime.split(":").map(Number);
    const startHourRounded = startMin > 0 ? startHour : startHour;
    const endHour = 19;
    const slots: string[] = [];
    for (let hour = startHourRounded; hour <= endHour; hour++) {
      slots.push(`${String(hour).padStart(2, "0")}:00`);
    }
    return slots;
  };

  const getGlobalTimelineMinutes = () => {
    const globalStartTime = getGlobalStartTime();
    const [startHour, startMin] = globalStartTime.split(":").map(Number);
    const startHourRounded = startMin > 0 ? startHour : startHour;
    const startMinutes = startHourRounded * 60;
    const endMinutes = 19 * 60;
    return endMinutes - startMinutes;
  };

  const globalTimeSlots = generateGlobalTimeSlots();
  const globalTimelineMinutes = getGlobalTimelineMinutes();

  const timeToMinutes = (t: string) => {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  };

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

  const minutesToPct = (absoluteMinutes: number) => {
    if (!globalTimeSlots.length) return 0;
    const timelineStart = timeToMinutes(globalTimeSlots[0]);
    const timelineEnd = timelineStart + globalTimeSlots.length * 60;
    const total = timelineEnd - timelineStart;
    if (total <= 0) return 0;
    return ((absoluteMinutes - timelineStart) / total) * 100;
  };

  useEffect(() => {
    (window as any).globalTimelineMinutes = globalTimelineMinutes;
    (window as any).globalTimeSlotsCount = globalTimeSlots.length;
  }, [globalTimelineMinutes, globalTimeSlots.length]);

  useEffect(() => {
    const measureWidth = () => {
      if (timelineRowRef.current) {
        setTimelineWidthPx(timelineRowRef.current.offsetWidth);
      }
    };
    measureWidth();
    window.addEventListener("resize", measureWidth);
    const timer = setTimeout(measureWidth, 100);
    return () => {
      window.removeEventListener("resize", measureWidth);
      clearTimeout(timer);
    };
  }, [drivers, globalTimeSlots.length]);

  const loadAvailableDrivers = useCallback(async () => {
    try {
      try {
        await fetch("/api/extract-logistics-drivers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: workDate }),
        });
      } catch {
        /* ADAM opzionale */
      }

      const driversResponse = await fetch(`/api/logistics-drivers?date=${encodeURIComponent(workDate)}`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      });

      if (!driversResponse.ok) {
        setAvailableDrivers([]);
        return;
      }

      const driversData = await driversResponse.json();
      const dateDrivers = driversData.drivers || [];

      const selectedActiveIds = new Set(drivers.filter((d) => !d.isRemoved).map((d) => d.id));
      const timelineDriverIds = new Set(driversAssignments.map((row) => row.driver.id));

      const available = dateDrivers.filter(
        (c: any) =>
          c.active !== false && !selectedActiveIds.has(c.id) && !timelineDriverIds.has(c.id)
      );

      available.sort((a: any, b: any) => {
        const ha = Number(a.weekly_hours ?? a.counter_hours ?? 0);
        const hb = Number(b.weekly_hours ?? b.counter_hours ?? 0);
        return hb - ha;
      });

      setAvailableDrivers(available);
    } catch (e) {
      console.error("loadAvailableDrivers logistics:", e);
      setAvailableDrivers([]);
    }
  }, [workDate, drivers, driversAssignments]);

  const addDriverMutation = useMutation({
    mutationFn: async (driverId: number) => {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await apiRequest("POST", "/api/add-driver-to-timeline", {
        driverId,
        date: workDate,
        modified_by: user.username || "unknown",
      });
      return response.json();
    },
    onSuccess: async (data: { replaced?: number | null; message?: string }, driverId) => {
      await onRefresh();
      toast({
        title: data?.replaced != null ? "Driver sostituito" : "Driver aggiunto",
        description: data?.message || `Operazione completata (ID ${driverId})`,
        variant: "success",
      });
      setAddDriverOpen(false);
      setStartTimeDialog({ open: false, driverId: null, driverName: "", isAvailable: true });
      setDriverToReplace(null);
      setConfirmUnavailableDialog({ open: false, driverId: null });
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error?.message || "Impossibile aggiungere il driver",
        variant: "destructive",
      });
    },
  });

  const handlePickDriver = (driverId: number, isAvailable: boolean) => {
    const d = availableDrivers.find((x) => x.id === driverId);
    const driverName = d ? `${d.name ?? ""} ${d.lastname ?? ""}`.trim() || `ID ${driverId}` : `ID ${driverId}`;
    setStartTimeDialog({
      open: true,
      driverId,
      driverName,
      isAvailable,
    });
    setPendingStartTime(d?.start_time || "10:00");
    setAddDriverOpen(false);
  };

  const handleConfirmStartTimeAndAdd = async () => {
    if (startTimeDialog.driverId == null) return;
    const driverId = startTimeDialog.driverId;

    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-logistics-driver-start-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId,
          startTime: pendingStartTime,
          date: workDate,
          modified_by: user.username || "unknown",
        }),
      });
      if (!response.ok) {
        throw new Error("Errore nel salvataggio dello start time");
      }
    } catch {
      toast({
        title: "Errore",
        description: "Impossibile salvare lo start time",
        variant: "destructive",
      });
      return;
    }

    setAvailableDrivers((prev) =>
      prev.map((c) => (c.id === driverId ? { ...c, start_time: pendingStartTime } : c))
    );

    if (!startTimeDialog.isAvailable) {
      setConfirmUnavailableDialog({ open: true, driverId });
      return;
    }

    addDriverMutation.mutate(driverId);
  };

  const handleConfirmAddUnavailableDriver = async () => {
    const driverId = confirmUnavailableDialog.driverId;
    if (driverId == null) return;

    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const res = await fetch("/api/update-logistics-driver-field", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId,
          date: workDate,
          field: "available",
          value: true,
          modified_by: user.username || "unknown",
        }),
      });
      if (!res.ok) throw new Error("update field failed");
    } catch (e) {
      console.error(e);
    }

    setAvailableDrivers((prev) =>
      prev.map((c) => (c.id === driverId ? { ...c, start_time: pendingStartTime, available: true } : c))
    );
    setConfirmUnavailableDialog({ open: false, driverId: null });
    addDriverMutation.mutate(driverId);
  };

  const clearDriversMutation = useMutation({
    mutationFn: async () => {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      await apiRequest("POST", "/api/save-selected-logistics-drivers", {
        drivers: [],
        date: workDate,
        action_type: "clear",
        modified_by: user.username || "unknown",
      });
    },
    onSuccess: async () => {
      toast({ title: "Convocazioni svuotate", variant: "success" });
      await onRefresh();
    },
    onError: () => {
      toast({ title: "Errore", description: "Impossibile svuotare i convocati", variant: "destructive" });
    },
  });

  const removeDriverMutation = useMutation({
    mutationFn: async (id: number) => {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const res = await apiRequest("POST", "/api/remove-driver-from-selected", {
        driverId: id,
        date: workDate,
        modified_by: user.username || "unknown",
      });
      return res.json() as Promise<{ success?: boolean; message?: string }>;
    },
    onSuccess: async (data) => {
      setConfirmRemoveDriverId(null);
      setDriverDetailsOpen(false);
      setSelectedDriverForDetails(null);
      await onRefresh();
      toast({
        title: "Driver aggiornato",
        description: data?.message || "Operazione completata",
        variant: "success",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error?.message || "Rimozione non riuscita",
        variant: "destructive",
      });
    },
  });

  const swapDriversMutation = useMutation({
    mutationFn: async (payload: { sourceDriverId: number; destDriverId: number }) => {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const res = await apiRequest("POST", "/api/swap-drivers-tasks", {
        ...payload,
        date: workDate,
        modified_by: user.username || "unknown",
      });
      return res.json() as Promise<{ success?: boolean; message?: string }>;
    },
    onSuccess: async (data) => {
      setSelectedSwapDriver("");
      await onRefresh();
      toast({
        title: "Task scambiate",
        description: data?.message || "Operazione completata",
        variant: "success",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error?.message || "Scambio non riuscito",
        variant: "destructive",
      });
    },
  });

  const handleSwapDrivers = () => {
    if (!selectedSwapDriver || !selectedDriverForDetails) return;
    const destDriverId = parseInt(selectedSwapDriver, 10);
    if (!Number.isFinite(destDriverId)) return;
    swapDriversMutation.mutate({
      sourceDriverId: selectedDriverForDetails.id,
      destDriverId,
    });
  };

  const openDriverDetails = (driver: LogisticsDriverRow) => {
    const latest = drivers.find((d) => d.id === driver.id) || driver;
    setSelectedDriverForDetails(latest);
    setDriverDetailsOpen(true);
    void loadDriverAliases();
  };

  const handleOpenAliasDialogForDriver = (d: LogisticsDriverRow) => {
    const currentAlias = driversAliases[d.id]?.alias ?? d.alias ?? "";
    setEditingAlias(currentAlias);
    setAliasDialog({
      open: true,
      driverId: d.id,
      driverName: `${d.name ?? ""} ${d.lastname ?? ""}`.trim() || `ID ${d.id}`,
    });
  };

  const handleSaveDriverAlias = async () => {
    if (aliasDialog.driverId == null) return;
    setIsSavingAlias(true);
    try {
      const response = await fetch("/api/update-cleaner-alias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cleanerId: aliasDialog.driverId,
          alias: editingAlias,
          date: workDate,
        }),
      });
      if (!response.ok) throw new Error("Salvataggio alias fallito");
      await loadDriverAliases();
      await onRefresh();
      toast({ title: "Alias salvato", variant: "success" });
      setAliasDialog({ open: false, driverId: null, driverName: "" });
    } catch (e: any) {
      toast({
        title: "Errore",
        description: e?.message || "Impossibile salvare l'alias",
        variant: "destructive",
      });
    } finally {
      setIsSavingAlias(false);
    }
  };

  const handleOpenEditDriverStartTime = (d: LogisticsDriverRow) => {
    setPendingEditStartTime(d.start_time || "10:00");
    setEditDriverStartDialog({
      open: true,
      driverId: d.id,
      driverName: `${d.name ?? ""} ${d.lastname ?? ""}`.trim() || `ID ${d.id}`,
    });
  };

  const handleSaveEditedDriverStartTime = async () => {
    if (editDriverStartDialog.driverId == null) return;
    if (!/^\d{2}:\d{2}$/.test(pendingEditStartTime)) {
      toast({
        variant: "destructive",
        title: "Formato orario non valido",
        description: "Usa HH:mm (es. 10:00)",
      });
      return;
    }
    setIsSavingDriverStartTime(true);
    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const response = await fetch("/api/update-logistics-driver-start-time", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          driverId: editDriverStartDialog.driverId,
          startTime: pendingEditStartTime,
          date: workDate,
          modified_by: user.username || "unknown",
        }),
      });
      if (!response.ok) throw new Error("Aggiornamento start time fallito");
      await onRefresh();
      setSelectedDriverForDetails((prev) =>
        prev && prev.id === editDriverStartDialog.driverId
          ? { ...prev, start_time: pendingEditStartTime }
          : prev
      );
      toast({ title: "Start time aggiornato", variant: "success" });
      setEditDriverStartDialog({ open: false, driverId: null, driverName: "" });
    } catch (e: any) {
      toast({
        title: "Errore",
        description: e?.message || "Impossibile salvare",
        variant: "destructive",
      });
    } finally {
      setIsSavingDriverStartTime(false);
    }
  };

  const handleReset = async () => {
    setIsResetting(true);
    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const res = await fetch("/api/reset-logistics-timeline-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: workDate, modified_by: user.username || "unknown" }),
      });
      if (!res.ok) throw new Error("reset failed");
      toast({ title: "Assegnazioni resettate", variant: "success" });
      await onRefresh();
    } catch {
      toast({ title: "Errore", description: "Reset non riuscito", variant: "destructive" });
    } finally {
      setIsResetting(false);
      setShowResetDialog(false);
    }
  };

  return (
    <>
      <div className="bg-custom-blue-light rounded-lg border-2 border-custom-blue shadow-sm relative">
        {(isLoadingOverlay || clearDriversMutation.isPending) && (
          <div className="absolute inset-0 bg-black/20 dark:bg-black/40 rounded-lg flex items-center justify-center z-40 backdrop-blur-sm pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
              <p className="text-sm font-medium text-foreground">Aggiornamento…</p>
            </div>
          </div>
        )}

        <div className="px-4 py-4 border-b border-border">
          <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
            <div>
              <h2 className="text-xl font-bold text-foreground flex items-center">
                <CalendarIcon className="w-5 h-5 mr-2 text-custom-blue" />
                Timeline Logistica - {drivers.length} Driver
              </h2>
            </div>
            <div className="flex gap-3 print:hidden">
              <Button
                variant="outline"
                size="sm"
                disabled={isReadOnly}
                className="flex items-center gap-2 border-2 border-custom-blue"
                onClick={() =>
                  setLocation(`/convocazioni?kind=drivers&date=${encodeURIComponent(workDate)}`)
                }
              >
                <Truck className="w-4 h-4 shrink-0" aria-hidden />
                Convocazioni
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={isReadOnly || !hasTasksInTimeline || isResetting}
                className="flex items-center gap-2 border-2 border-custom-blue"
                onClick={() => setShowResetDialog(true)}
                title={!hasTasksInTimeline ? "Nessuna task in timeline" : "Reset assegnazioni"}
              >
                {isResetting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Reset Assegnazioni
              </Button>
            </div>
          </div>
        </div>

        <div className="px-4 pt-4 pb-4 overflow-x-auto">
          <div className="flex items-stretch mb-1 px-4 h-[26px]">
            <div className="flex-shrink-0 h-full print:hidden" style={{ width: `${driverColumnWidth}px` }} />
            <div className="flex-1 h-full relative">
              {priorityWindows && (
                <div className="absolute inset-0">
                  {(() => {
                    const eo1 = clamp(minutesToPct(timeToMinutes(priorityWindows.EO.start)), 0, 100);
                    const eo2 = clamp(minutesToPct(timeToMinutes(priorityWindows.EO.end)), 0, 100);
                    const hp1 = clamp(minutesToPct(timeToMinutes(priorityWindows.HP.start)), 0, 100);
                    const hp2 = clamp(minutesToPct(timeToMinutes(priorityWindows.HP.end)), 0, 100);
                    const lp1 = clamp(minutesToPct(timeToMinutes(priorityWindows.LP.start)), 0, 100);
                    const lp2 = 100;
                    const TOP_LP = -6;
                    const TOP_MAIN = 12;
                    const windows = [
                      { key: "LP" as const, left: lp1, right: lp2, top: TOP_LP, opacity: 0.65 },
                      { key: "EO" as const, left: eo1, right: eo2, top: TOP_MAIN, opacity: 0.85 },
                      { key: "HP" as const, left: hp1, right: hp2, top: TOP_MAIN, opacity: 0.75 },
                    ];
                    return windows.map((w) => {
                      const width = Math.max(0, w.right - w.left);
                      if (width < 2) return null;
                      const hideLabel = width < 6;
                      return (
                        <div
                          key={w.key}
                          className="absolute"
                          style={{
                            left: `${w.left}%`,
                            width: `${width}%`,
                            top: `${w.top}px`,
                            opacity: w.opacity,
                          }}
                        >
                          <div className="relative h-[20px]">
                            <div className="absolute left-0 right-0 top-[10px] border-t border-slate-500/60 dark:border-white/60" />
                            <div className="absolute left-0 top-[6px] h-[8px] border-l border-slate-500/60 dark:border-white/60" />
                            <div className="absolute right-0 top-[6px] h-[8px] border-r border-slate-500/60 dark:border-white/60" />
                            {!hideLabel && (
                              <Badge
                                variant="outline"
                                className={cn(
                                  "absolute left-1/2 -translate-x-1/2 top-[-1px] text-xs shrink-0",
                                  w.key === "EO"
                                    ? "bg-blue-500 text-white border-blue-700 dark:bg-blue-600 dark:border-blue-300"
                                    : w.key === "HP"
                                      ? "bg-orange-500 text-white border-orange-700 dark:bg-orange-600 dark:border-orange-300"
                                      : "bg-gray-500 text-white border-gray-700 dark:bg-gray-600 dark:border-gray-300"
                                )}
                              >
                                {w.key}
                              </Badge>
                            )}
                          </div>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
            <div className="flex-shrink-0 w-20 h-full" />
          </div>

          <div className="flex items-stretch mb-2 px-4 h-[44px]">
            <div
              className="flex-shrink-0 p-1 flex items-center justify-center h-full print:hidden"
              style={{ width: `${driverColumnWidth}px` }}
            >
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  isReadOnly ||
                  drivers.length === 0 ||
                  hasTasksInTimeline ||
                  clearDriversMutation.isPending
                }
                onClick={() => setShowClearDriversDialog(true)}
                className={cn(
                  "w-full h-full border-2",
                  "border-red-600 dark:border-red-500",
                  "text-red-700 dark:text-red-200",
                  "hover:bg-red-50 dark:hover:bg-red-950/30"
                )}
                title={
                  isReadOnly
                    ? "Non disponibile in modalità storico (data passata)"
                    : drivers.length === 0
                      ? "Nessun convocato"
                      : hasTasksInTimeline
                        ? "Svuota solo se timeline senza task"
                        : "Rimuovi tutti i convocati"
                }
              >
                <UserMinus className="w-5 h-5" />
              </Button>
            </div>
            <div
              ref={timelineRowRef}
              className="flex-1 h-full grid"
              style={{ gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}
            >
              {globalTimeSlots.map((slot, idx) => (
                <div
                  key={`${slot}-${idx}`}
                  className="h-full flex items-center justify-center text-center text-xs font-semibold text-foreground border-r border-border px-1"
                >
                  {slot}
                </div>
              ))}
            </div>
            <div className="flex-shrink-0 w-20 h-full text-center text-xs font-semibold text-foreground border-l border-border px-1 flex items-center justify-center">
              Ore lavorate
            </div>
          </div>

          <div className="flex-1 overflow-auto px-4 pb-4 pt-1">
            {drivers.length === 0 && !isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-yellow-100 dark:bg-yellow-950/50 border-2 border-yellow-300 dark:border-yellow-700 rounded-lg">
                <div className="text-center p-6">
                  <Users className="mx-auto h-12 w-12 text-yellow-600 dark:text-yellow-400 mb-3" />
                  <h3 className="text-lg font-semibold text-yellow-800 dark:text-yellow-200 mb-2">
                    Nessun driver convocato
                  </h3>
                  <p className="text-yellow-700 dark:text-yellow-300">
                    Vai alla pagina Convocazioni per selezionare i driver da convocare
                  </p>
                </div>
              </div>
            ) : drivers.length === 0 && isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-red-50 dark:bg-red-950/20 border-2 border-red-300 dark:border-blue-800 rounded-lg">
                <div className="text-center p-6">
                  <CalendarIcon className="mx-auto h-12 w-12 text-red-600 dark:text-red-400 mb-3" />
                  <h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
                    Nessuna assegnazione presente per questa data
                  </h3>
                  <p className="text-red-700 dark:text-red-300">
                    Non sono disponibili dati salvati per questa data passata
                  </p>
                </div>
              </div>
            ) : (
              drivers.map((driver) => {
                const rawTasks = assignmentByDriver.get(driver.id) || [];
                const tasks = rawTasks
                  .map((t) => timelineTaskToTask(t, driver.id))
                  .sort((a, b) => {
                    const sa = (a as any).sequence ?? 0;
                    const sb = (b as any).sequence ?? 0;
                    return sa - sb;
                  });
                const hi = highlightedIdsForDriverTasks(tasks, searchTask);
                return (
                  <div key={driver.id} className="flex mb-0.5">
                    <div
                      className={cn(
                        "flex-shrink-0 p-1 flex items-center border-2 border-custom-blue bg-custom-blue/10",
                        "cursor-pointer hover:opacity-90 transition-opacity",
                        driver.isRemoved && "opacity-70"
                      )}
                      style={{ width: `${driverColumnWidth}px` }}
                      onClick={(e) => {
                        e.preventDefault();
                        openDriverDetails(driver);
                      }}
                      title={
                        driver.isRemoved
                          ? "Dettagli — driver rimosso dai convocati (sostituisci dal pannello)"
                          : "Dettagli driver"
                      }
                    >
                      <div className="w-full flex items-center gap-2">
                        {!driver.isRemoved && (
                          <div
                            className="flex-shrink-0 w-3 h-3 rounded-full"
                            style={{ backgroundColor: getCleanerHexColor(driver.id) }}
                          />
                        )}
                        <div className="break-words font-bold text-[13px] flex-1">
                          {driversAliases[driver.id]?.alias ||
                            driver.alias ||
                            `${(driver.name || "").toUpperCase()} ${(driver.lastname || "").toUpperCase()}`.trim() ||
                            `ID ${driver.id}`}
                        </div>
                        {driver.isRemoved && (
                          <div className="bg-red-600 text-white font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            RIMOSSO
                          </div>
                        )}
                        {!driver.isRemoved && driver.role === "Straordinario" && (
                          <div className="bg-red-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            S
                          </div>
                        )}
                        {!driver.isRemoved &&
                          driver.role !== "Straordinario" &&
                          driver.role === "Premium" && (
                            <div className="bg-yellow-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                              P
                            </div>
                          )}
                        {!driver.isRemoved &&
                          driver.role !== "Straordinario" &&
                          driver.role === "Formatore" && (
                            <div className="bg-orange-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                              F
                            </div>
                          )}
                      </div>
                    </div>
                    <Droppable droppableId={`timeline-${driver.id}`} direction="horizontal" isDropDisabled={isReadOnly}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.droppableProps}
                          className={cn(
                            "relative min-h-[45px] flex-1 border-l border-border transition-colors",
                            snapshot.isDraggingOver
                              ? "bg-blue-200/40 dark:bg-blue-900/40 border-l-2 border-blue-400"
                              : "bg-background"
                          )}
                        >
                          <div
                            className="absolute inset-0 pointer-events-none grid"
                            style={{ gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}
                          >
                            {globalTimeSlots.map((slot, idx) => (
                              <div
                                key={slot}
                                className={cn(
                                  "border-r border-border",
                                  idx % 2 === 0
                                    ? "bg-blue-50/30 dark:bg-blue-950/10"
                                    : "bg-sky-100/30 dark:bg-sky-900/10"
                                )}
                              />
                            ))}
                          </div>
                          <div className="relative z-10 flex items-center h-full min-h-[45px] px-0 gap-0 flex-wrap">
                            {tasks.map((task, index) => (
                              <TaskCard
                                key={`${task.id}-${driver.id}`}
                                task={task}
                                index={index}
                                isInTimeline
                                allTasks={tasks}
                                currentContainer=""
                                cleanerId={driver.id}
                                isReadOnly={isReadOnly}
                                isDragDisabled={isReadOnly || Boolean((task as any).locked)}
                                timelineWidthPx={timelineWidthPx}
                                operationsScope="logistics"
                                isHighlighted={hi.has(String(task.id))}
                              />
                            ))}
                            {provided.placeholder}
                          </div>
                        </div>
                      )}
                    </Droppable>
                    <div className="flex-shrink-0 w-20 min-h-[45px] border-l border-border flex items-center justify-center text-xs text-muted-foreground">
                      —
                    </div>
                  </div>
                );
              })
            )}

            {/* Riga finale: +, indicatore salvataggio / storico, trasferimento ADAM */}
            <div className="pt-2" />
            <div className="flex items-stretch mb-2 h-[44px]">
              <div
                className="flex-shrink-0 p-1 flex items-center justify-center h-full print:hidden"
                style={{ width: `${driverColumnWidth}px` }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isReadOnly}
                  className="w-full h-full border-2 border-custom-blue"
                  aria-label="Aggiungi driver"
                  title="Aggiungi driver"
                  onClick={() => {
                    setDriverToReplace(null);
                    setAddDriverOpen(true);
                    void loadAvailableDrivers();
                  }}
                >
                  <UserPlus className="w-5 h-5" />
                </Button>
              </div>
              <div className="flex-1 p-1 flex gap-2 h-full min-h-[44px]">
                {!isReadOnly && (
                  <div
                    className="flex-1 h-full flex items-center justify-center gap-2 px-4 py-2 rounded-md border-2 border-custom-blue bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200"
                    data-testid="indicator-logistics-autosave"
                  >
                    <CheckCircle className="w-4 h-4 shrink-0" />
                    <span className="text-sm font-medium">Salvataggio automatico attivo</span>
                  </div>
                )}
                {isReadOnly && (
                  <Button
                    disabled
                    variant="outline"
                    className="flex-1 h-full border-2 border-custom-blue bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 cursor-default"
                  >
                    📜 Sei in modalità storico
                  </Button>
                )}
              </div>
            </div>
            {lastAdamTransfer && (
              <div className="flex justify-center px-1 pb-1">
                <span className="text-xs text-muted-foreground">
                  Ultimo salvataggio su ADAM:{" "}
                  {(() => {
                    const d = new Date(lastAdamTransfer);
                    const day = String(d.getDate()).padStart(2, "0");
                    const month = String(d.getMonth() + 1).padStart(2, "0");
                    const year = d.getFullYear();
                    const hours = String(d.getHours()).padStart(2, "0");
                    const minutes = String(d.getMinutes()).padStart(2, "0");
                    return `${day}/${month}/${year} - ${hours}:${minutes}`;
                  })()}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      <AlertDialog open={showAdamTransferDialog} onOpenChange={setShowAdamTransferDialog}>
        <AlertDialogContent className="sm:max-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <CheckCircle className="w-5 h-5" />
              Conferma Trasferimento su ADAM
            </AlertDialogTitle>
            <AlertDialogDescription>
              <p className="text-base text-foreground font-semibold mb-3">
                Salvando su ADAM eventuali assegnazioni salvate precedentemente in questa data, VERRANNO
                SOVRASCRITTE!
              </p>
              <p className="text-sm text-muted-foreground">
                Sei sicuro di voler procedere? Questa azione è irreversibile.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-2 border-custom-blue">Annulla</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void handleTransferLogisticsToAdam()}
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Conferma Trasferimento
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset assegnazioni logistics?</AlertDialogTitle>
            <AlertDialogDescription>
              Svuota la timeline per questa data e rigenera i containers da ADAM. I convocati non vengono modificati.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleReset()}>Conferma</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={showClearDriversDialog} onOpenChange={setShowClearDriversDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rimuovere tutti i driver convocati?</AlertDialogTitle>
            <AlertDialogDescription>
              Svuota la selezione convocati per questa data. Non disponibile se ci sono task in timeline.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setShowClearDriversDialog(false);
                clearDriversMutation.mutate();
              }}
            >
              Conferma
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={addDriverOpen}
        onOpenChange={(open) => {
          setAddDriverOpen(open);
          if (!open) {
            setDriverToReplace(null);
            setConfirmUnavailableDialog({ open: false, driverId: null });
          }
        }}
      >
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {driverToReplace != null ? "Sostituisci driver rimosso" : "Aggiungi driver alla timeline"}
            </DialogTitle>
            <DialogDescription>
              {driverToReplace != null ? (
                <>
                  Sostituendo{" "}
                  <strong>
                    {(() => {
                      const rem = drivers.find((d) => d.id === driverToReplace);
                      return rem
                        ? `${rem.name ?? ""} ${rem.lastname ?? ""}`.trim() || `ID ${driverToReplace}`
                        : `ID ${driverToReplace}`;
                    })()}
                  </strong>{" "}
                  — le sue task verranno assegnate al nuovo driver.
                </>
              ) : (
                "Seleziona un driver disponibile da aggiungere alla timeline."
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-4">
            {availableDrivers.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-custom-blue mr-2" />
                <p className="text-muted-foreground">Caricamento driver disponibili…</p>
              </div>
            ) : (
              availableDrivers.map((d: any) => {
                const isAvailable = d.available !== false;
                return (
                  <div
                    key={d.id}
                    className={cn(
                      "flex items-center justify-between p-3 border rounded-lg cursor-pointer",
                      !isAvailable ? "opacity-70 hover:opacity-80" : "hover:bg-accent"
                    )}
                    onClick={() => handlePickDriver(d.id, isAvailable)}
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-semibold">
                          {d.name} {d.lastname}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {d.role ?? "Driver"}
                          {d.contract_type != null && d.contract_type !== ""
                            ? ` • Contratto: ${d.contract_type}`
                            : ""}
                          {" • "}
                          {Number(d.counter_hours ?? 0).toFixed(2)}h
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      {!isAvailable && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                          Non disponibile
                        </span>
                      )}
                      {d.role === "Formatore" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                          Formatore
                        </span>
                      )}
                      {d.role === "Straordinario" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700">
                          Straordinario
                        </span>
                      )}
                      {d.role === "Premium" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700">
                          Premium
                        </span>
                      )}
                      {d.role === "Standard" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                          Standard
                        </span>
                      )}
                      {!["Formatore", "Straordinario", "Premium", "Standard"].includes(
                        String(d.role || "")
                      ) && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-sky-500/30 text-sky-900 dark:bg-sky-500/40 dark:text-sky-100 border-sky-600 dark:border-sky-400">
                          Driver
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={startTimeDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setStartTimeDialog({ open: false, driverId: null, driverName: "", isAvailable: true });
            setAddDriverOpen(true);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Inserisci start time</DialogTitle>
            <DialogDescription>
              Orario di inizio per <strong>{startTimeDialog.driverName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <span className="text-sm font-semibold text-muted-foreground mb-2 block">Start time</span>
              <div className="flex items-center justify-center gap-1 bg-background border-2 border-custom-blue rounded-lg px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingStartTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes - 30;
                    if (totalMinutes < 0) totalMinutes += 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setPendingStartTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">−</span>
                </Button>
                <span className="text-lg font-mono font-bold min-w-[60px] text-center">{pendingStartTime}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingStartTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes + 30;
                    if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setPendingStartTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">+</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Intervalli di 30 minuti (+ / −)
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStartTimeDialog({ open: false, driverId: null, driverName: "", isAvailable: true });
                setAddDriverOpen(true);
              }}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleConfirmStartTimeAndAdd()}
              disabled={addDriverMutation.isPending}
              className="border-2 border-custom-blue"
            >
              Conferma e aggiungi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmUnavailableDialog.open}
        onOpenChange={(open) => setConfirmUnavailableDialog({ open, driverId: null })}
      >
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle>Conferma aggiunta driver</DialogTitle>
            <DialogDescription>
              Il driver selezionato non risulta disponibile. Vuoi comunque aggiungerlo e segnarlo come
              disponibile?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setConfirmUnavailableDialog({ open: false, driverId: null })}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              onClick={() => void handleConfirmAddUnavailableDriver()}
              disabled={addDriverMutation.isPending}
              className="bg-custom-blue hover:bg-custom-blue/90 text-white"
            >
              Conferma e aggiungi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dettagli driver (stile dialog cleaner HK) */}
      <Dialog
        open={driverDetailsOpen}
        onOpenChange={(open) => {
          setDriverDetailsOpen(open);
          if (!open) {
            setSelectedDriverForDetails(null);
            setSelectedSwapDriver("");
          }
        }}
      >
        <DialogContent
          className={cn(
            "sm:max-w-2xl max-h-[80vh] overflow-y-auto",
            "bg-white dark:bg-background"
          )}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 w-full">
              <span className="flex min-w-0 items-center gap-2">
                Dettagli Driver #{selectedDriverForDetails?.id}
                {selectedDriverForDetails &&
                  (selectedDriverForDetails.role === "Straordinario" ? (
                    <span className="px-2 py-0.5 rounded border font-medium text-sm bg-red-600/30 text-gray-900 dark:bg-red-500/40 dark:text-red-200 border-red-700 dark:border-red-400">
                      Straordinario
                    </span>
                  ) : selectedDriverForDetails.role === "Formatore" ? (
                    <span className="px-2 py-0.5 rounded border font-medium text-sm bg-orange-600/30 text-gray-900 dark:bg-orange-500/40 dark:text-orange-200 border-orange-700 dark:border-orange-400">
                      Formatore
                    </span>
                  ) : selectedDriverForDetails.role === "Premium" ? (
                    <span className="px-2 py-0.5 rounded border font-medium text-sm bg-yellow-600/30 text-gray-900 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-700 dark:border-yellow-400">
                      Premium
                    </span>
                  ) : selectedDriverForDetails.role === "Standard" ? (
                    <span className="px-2 py-0.5 rounded border font-medium text-sm bg-green-600/30 text-gray-900 dark:bg-green-500/40 dark:text-green-200 border-green-700 dark:border-green-400">
                      Standard
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded border font-medium text-sm bg-sky-500/30 text-sky-900 dark:bg-sky-500/40 dark:text-sky-100 border-sky-600 dark:border-sky-400">
                      Driver
                    </span>
                  ))}
              </span>
              {(() => {
                const vehicleName = String(
                  selectedDriverForDetails?.assigned_vehicle_name ??
                    selectedDriverForDetails?.vehicle_name ??
                    ""
                ).trim();
                if (!vehicleName) return null;
                const isScooterVehicle = /^piaggio\b/i.test(vehicleName);
                return (
                  <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-0.5 rounded border text-sm font-medium bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200 border-sky-300 dark:border-sky-700">
                    {isScooterVehicle ? (
                      <Bike className="h-3.5 w-3.5" />
                    ) : (
                      <Truck className="h-3.5 w-3.5" />
                    )}
                    <span>{vehicleName}</span>
                  </span>
                );
              })()}
            </DialogTitle>
          </DialogHeader>

          {selectedDriverForDetails && (
            <div className="space-y-4 text-gray-900 dark:text-foreground">
              {selectedDriverForDetails.isRemoved && (
                <p className="text-sm font-medium text-red-600 dark:text-red-400">
                  Driver non più nei convocati per questa data — le task restano in timeline fino a sostituzione.
                </p>
              )}

              <div className="grid grid-cols-4 gap-x-6 gap-y-4">
                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1 flex items-center gap-1">
                    Alias
                    {!isReadOnly && (
                      <Pencil className="w-3 h-3 text-gray-700 dark:text-muted-foreground/60" />
                    )}
                  </p>
                  <p
                    className={cn(
                      "text-sm p-2 rounded border border-border",
                      !isReadOnly && "cursor-pointer hover:bg-muted/50 hover:border-custom-blue"
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) handleOpenAliasDialogForDriver(selectedDriverForDetails);
                    }}
                  >
                    {driversAliases[selectedDriverForDetails.id]?.alias ||
                      selectedDriverForDetails.alias ||
                      `${selectedDriverForDetails.name ?? ""} ${selectedDriverForDetails.lastname ?? ""}`.trim() ||
                      `ID ${selectedDriverForDetails.id}`}
                  </p>
                </div>

                <div className="col-span-1">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">Nome</p>
                  <Input
                    value={(selectedDriverForDetails.name ?? "").toUpperCase()}
                    readOnly
                    className={displayInputClass}
                  />
                </div>

                <div className="col-span-1">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">Cognome</p>
                  <Input
                    value={(selectedDriverForDetails.lastname ?? "").toUpperCase()}
                    readOnly
                    className={displayInputClass}
                  />
                </div>

                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">
                    Giorni lavorati
                  </p>
                  <div className={cn("flex items-center h-9 min-h-9", displayInputClass)}>
                    <span className="text-sm tabular-nums">
                      {selectedDriverForDetails.counter_days ?? ""}
                    </span>
                    {selectedDriverForDetails.show_plus_one && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-sm font-semibold text-yellow-600 dark:text-yellow-500 ml-1">
                            (+1)
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>In programma per questa data ma report non ancora compilato</p>
                        </TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                </div>

                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">
                    Ore lavorate questa settimana
                  </p>
                  <Input
                    value={String(selectedDriverForDetails.counter_hours ?? "")}
                    readOnly
                    className={displayInputClass}
                  />
                </div>

                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1 flex items-center gap-1">
                    Start Time
                    {!isReadOnly && (
                      <Pencil className="w-3 h-3 text-gray-700 dark:text-muted-foreground/60" />
                    )}
                  </p>
                  <p
                    className={cn(
                      "text-sm p-2 rounded border border-border",
                      !isReadOnly && "cursor-pointer hover:bg-muted/50 hover:border-custom-blue"
                    )}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) handleOpenEditDriverStartTime(selectedDriverForDetails);
                    }}
                  >
                    {selectedDriverForDetails.start_time || "10:00"}
                  </p>
                </div>

                <div className="col-span-2">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-1">
                    Tipo contratto
                  </p>
                  <Input
                    value={String(selectedDriverForDetails.contract_type ?? "")}
                    readOnly
                    className={displayInputClass}
                  />
                </div>
              </div>

              {!selectedDriverForDetails.isRemoved && !isReadOnly && (
                <div className="border-t pt-4 mt-4">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-3">
                    Scambia Driver
                  </p>
                  <p className="text-xs text-gray-700 dark:text-muted-foreground mb-3">
                    Seleziona un altro driver per scambiare le task assegnate.
                  </p>
                  <div className="flex gap-3 items-end">
                    <div className="flex-1">
                      <Select
                        value={selectedSwapDriver}
                        onValueChange={setSelectedSwapDriver}
                        disabled={swapDriversMutation.isPending}
                      >
                        <SelectTrigger data-testid="select-swap-driver">
                          <SelectValue placeholder="Seleziona driver…" />
                        </SelectTrigger>
                        <SelectContent>
                          {drivers
                            .filter((d) => d.id !== selectedDriverForDetails.id)
                            .map((d) => (
                              <SelectItem key={d.id} value={String(d.id)}>
                                {driversAliases[d.id]?.alias ||
                                  `${d.name ?? ""} ${d.lastname ?? ""}`.trim() ||
                                  `ID ${d.id}`}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      onClick={handleSwapDrivers}
                      disabled={!selectedSwapDriver || swapDriversMutation.isPending}
                      variant="default"
                      className="flex gap-2 shrink-0"
                      data-testid="button-swap-driver"
                    >
                      {swapDriversMutation.isPending ? (
                        <>
                          <RefreshCw className="h-4 w-4 animate-spin" />
                          Scambio…
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-4 w-4" />
                          Scambia
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              )}

              {selectedDriverForDetails.isRemoved && !isReadOnly && (
                <div className="border-t pt-4 mt-4">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-3">
                    Sostituisci driver
                  </p>
                  <p className="text-xs text-gray-700 dark:text-muted-foreground mb-3">
                    Scegli un nuovo driver: le task della riga verranno riassegnate.
                  </p>
                  <Button
                    className="w-full border-2 border-custom-blue"
                    variant="default"
                    onClick={() => {
                      const id = selectedDriverForDetails.id;
                      setDriverDetailsOpen(false);
                      setSelectedDriverForDetails(null);
                      setDriverToReplace(id);
                      setAddDriverOpen(true);
                      void loadAvailableDrivers();
                    }}
                  >
                    Sostituisci…
                  </Button>
                </div>
              )}

              {!selectedDriverForDetails.isRemoved && (
                <div className="border-t pt-4 mt-4">
                  <p className="text-sm font-semibold text-gray-800 dark:text-muted-foreground mb-3">
                    Rimuovi driver
                  </p>
                  <p className="text-xs text-gray-700 dark:text-muted-foreground mb-3">
                    Il driver sarà rimosso dalla selezione, ma le sue task rimarranno in timeline. Sarà necessario
                    assegnarle a un altro driver.
                  </p>
                  <Button
                    onClick={() => {
                      setConfirmRemoveDriverId(selectedDriverForDetails.id);
                      setDriverDetailsOpen(false);
                    }}
                    disabled={removeDriverMutation.isPending || isReadOnly}
                    variant="destructive"
                    className="w-full"
                  >
                    Rimuovi dalla selezione
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={aliasDialog.open}
        onOpenChange={(open) => !open && setAliasDialog({ open: false, driverId: null, driverName: "" })}
      >
        <DialogContent
          className="sm:max-md"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Alias
            </DialogTitle>
            <DialogDescription>
              Stai modificando l&apos;alias di <strong>{aliasDialog.driverName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">Nuovo Alias</label>
              <Input
                value={editingAlias}
                onChange={(e) => setEditingAlias(e.target.value)}
                placeholder="Inserisci alias"
                className="w-full"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveDriverAlias();
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAliasDialog({ open: false, driverId: null, driverName: "" })}
              disabled={isSavingAlias}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSaveDriverAlias()}
              disabled={isSavingAlias}
              className="border-2 border-custom-blue"
            >
              {isSavingAlias ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Salvataggio...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Salva
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={editDriverStartDialog.open}
        onOpenChange={(open) => !open && setEditDriverStartDialog({ open: false, driverId: null, driverName: "" })}
      >
        <DialogContent
          className="sm:max-w-md"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Modifica start time</DialogTitle>
            <DialogDescription>
              Orario di inizio per <strong>{editDriverStartDialog.driverName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <span className="text-sm font-semibold text-muted-foreground mb-2 block">Start time</span>
              <div className="flex items-center justify-center gap-1 bg-background border-2 border-custom-blue rounded-lg px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingEditStartTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes - 30;
                    if (totalMinutes < 0) totalMinutes += 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setPendingEditStartTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">−</span>
                </Button>
                <span className="text-lg font-mono font-bold min-w-[60px] text-center">{pendingEditStartTime}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingEditStartTime.split(":").map(Number);
                    let totalMinutes = hours * 60 + minutes + 30;
                    if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    setPendingEditStartTime(
                      `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`
                    );
                  }}
                >
                  <span className="text-lg font-bold">+</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">Intervalli di 30 minuti (+ / −)</p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditDriverStartDialog({ open: false, driverId: null, driverName: "" })}
              className="border-2 border-custom-blue"
              disabled={isSavingDriverStartTime}
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSaveEditedDriverStartTime()}
              disabled={isSavingDriverStartTime}
              className="border-2 border-custom-blue"
            >
              {isSavingDriverStartTime ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Salvataggio…
                </>
              ) : (
                "Salva"
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRemoveDriverId != null} onOpenChange={(open) => !open && setConfirmRemoveDriverId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rimuovere il driver dalla selezione?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRemoveDriverId != null
                ? (() => {
                    const d = drivers.find((x) => x.id === confirmRemoveDriverId);
                    const label = d
                      ? `${d.name ?? ""} ${d.lastname ?? ""}`.trim() || `ID ${confirmRemoveDriverId}`
                      : `ID ${confirmRemoveDriverId}`;
                    return (
                      <>
                        Confermi la rimozione di <strong>{label}</strong> dai convocati per questa data?
                      </>
                    );
                  })()
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-2 border-custom-blue">Annulla</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (confirmRemoveDriverId != null) removeDriverMutation.mutate(confirmRemoveDriverId);
              }}
              disabled={removeDriverMutation.isPending}
            >
              Rimuovi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
