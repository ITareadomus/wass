import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { it } from "date-fns/locale";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { Home, RefreshCw } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertTriangle,
  Calendar as CalendarIcon,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  Save,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const OFFICE_SCOPE_ENABLED = false;

interface Task {
  task_id: string | number;
  logistic_code: string;
  address?: string;
  alias?: string;
  customer_name?: string;
  customer_reference?: string | number;
  cleaning_time?: number;
  checkout_time?: string;
  checkout_date?: string;
  checkin_time?: string;
  checkin_date?: string;
  pax_in?: number;
  pax_out?: number;
  priority?: string;
  confirmed_operation?: boolean;
  premium?: boolean;
  straordinaria?: boolean;
  type_apt?: string;
  operation_id?: number;
  duration?: string;
}

interface ContainersData {
  containers: {
    [key: string]: { tasks?: Task[] } | undefined;
  };
}

interface OperationsData {
  active_operations: { id: number; name: string; enable_wass?: boolean; enable_wass_readonly?: boolean }[];
}

export default function UnconfirmedTasks() {
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [selectedDate, setSelectedDate] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get("date");
    if (dateParam) {
      localStorage.setItem("selected_work_date", dateParam);
      return dateParam;
    }
    const savedDate = localStorage.getItem("selected_work_date");
    return savedDate || format(new Date(), "yyyy-MM-dd");
  });
  const scopeFromUrl =
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("scope")
      : null;
  const savedScope =
    typeof window !== "undefined" ? localStorage.getItem("assignments_scope") : null;
  const isOfficeScope =
    OFFICE_SCOPE_ENABLED &&
    (scopeFromUrl === "office" || (!scopeFromUrl && savedScope === "office"));
  const scopeValue: "housekeeping" | "office" = isOfficeScope ? "office" : "housekeeping";
  const withScope = (url: string) => `${url}${url.includes("?") ? "&" : "?"}scope=${scopeValue}`;
  const assignmentsHomeHref = isOfficeScope
    ? "/generate-assignments?scope=office"
    : "/generate-assignments";

  useEffect(() => {
    localStorage.setItem("selected_work_date", selectedDate);
  }, [selectedDate]);

  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [selectedOperations, setSelectedOperations] = useState<Map<string | number, number>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [showRecap, setShowRecap] = useState(false);
  const [recapOperations, setRecapOperations] = useState<Map<string | number, number>>(new Map());
  const [expandedTaskId, setExpandedTaskId] = useState<string | number | null>(null);

  const { data: operationsData } = useQuery<OperationsData>({
    queryKey: ["/api/operations", isOfficeScope ? "office" : "default"],
    queryFn: async () => {
      const response = await fetch(isOfficeScope ? "/api/operations?scope=office" : "/api/operations");
      if (!response.ok) throw new Error("Failed to fetch operations");
      return response.json();
    },
    staleTime: 60000,
  });

  const officeOperationNames: Record<number, string> = {
    15: "PULIZIA UFFICI/ALTRO",
    38: "PULIZIA UFFICI/ALTRO STRAORDINARIA",
  };
  const defaultOperationNames: Record<number, string> = {
    1: "FERMATA",
    2: "PARTENZA",
    3: "PULIZIA STRAORDINARIA",
    4: "RIPASSO",
    ...officeOperationNames,
  };
  const fetchedOperations = operationsData?.active_operations || [];
  const fetchedOpsById = new Map<number, string>(
    fetchedOperations.map((op) => [Number(op.id), String(op.name || "").trim()])
  );
  const allowedOperations = isOfficeScope
    ? [15, 38].map((id) => ({
        id,
        name: fetchedOpsById.get(id) || officeOperationNames[id],
      }))
    : fetchedOperations.filter((op) => op.enable_wass !== false);

  const operationNames: Record<number, string> = fetchedOperations.reduce(
    (acc, op) => ({ ...acc, [op.id]: op.name }),
    isOfficeScope ? { ...officeOperationNames } : defaultOperationNames
  );

  
  // 🔄 Prima rigeneriamo i containers per la data selezionata:
  // questa operazione (refresh da ADAM) è quella che determina/aggiorna confirmed_operation.
  const {
    data: refreshResult,
    isLoading: isRefreshing,
    isError: isRefreshError,
    error: refreshError,
  } = useQuery({
    queryKey: ["/api/containers/refresh", selectedDate],
    queryFn: async () => {
      const response = await fetch("/api/containers/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: selectedDate, scope: scopeValue }),
      });
      if (!response.ok) {
        const msg = await response.text().catch(() => "");
        throw new Error(msg || "Failed to refresh containers");
      }
      return response.json();
    },
    // Ad ogni apertura pagina e ad ogni cambio data deve rieseguire il refresh
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });


  const { data: containersData, isLoading: isContainersLoading } = useQuery<ContainersData>({
    queryKey: ["/api/containers-enriched", selectedDate],
    enabled: !!refreshResult?.success,
    queryFn: async () => {
      const response = await fetch(
        withScope(`/api/containers-enriched?date=${selectedDate}`),
      );
      if (!response.ok) throw new Error("Failed to fetch containers");
      return response.json();
    },
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });


  const isLoading = isRefreshing || isContainersLoading;

  // Testi loader (allineati allo stile di generate-assignments)
  const loadingTitle = isRefreshing
    ? "Estrazione Task Non Confermati"
    : "Caricamento Task Non Confermati";

  const loadingStepLabel = isRefreshing
    ? "Step 1/2: Estrazione dal database dei task non confermati..."
    : "Step 2/2: Caricamento dei task non confermati...";


  const unconfirmedTasks = (() => {
    if (!containersData?.containers) return [];

    const allTasks: Task[] = [];

    Object.values(containersData.containers).forEach((container) => {
      const tasks = (container as { tasks?: Task[] })?.tasks || [];
      tasks.forEach((task) => {
        // Task non confermata se confirmed_operation è false, null o undefined
        if (task.confirmed_operation === false ||
            task.confirmed_operation === null || 
            task.confirmed_operation === undefined) {
          allTasks.push(task);
        }
      });
    });

    return allTasks;
  })();

  const hasTasksToSet = unconfirmedTasks.length > 0;

  const filteredTasks = unconfirmedTasks.filter((task) => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      String(task.task_id).toLowerCase().includes(search) ||
      String(task.logistic_code).toLowerCase().includes(search) ||
      (task.address || "").toLowerCase().includes(search) ||
      (task.alias || "").toLowerCase().includes(search) ||
      (task.customer_name || "").toLowerCase().includes(search) ||
      (task.customer_reference ? String(task.customer_reference).toLowerCase().includes(search) : false)
    );
  });

  const changeDate = (days: number) => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() + days);
    setSelectedDate(format(current, "yyyy-MM-dd"));
  };

  // Reset selected task when date changes
  useEffect(() => {
    setSelectedTask(null);
  }, [selectedDate]);

  const navigateTask = (direction: number) => {
    if (!selectedTask || filteredTasks.length === 0) return;
    const currentIndex = filteredTasks.findIndex(t => t.task_id === selectedTask.task_id);
    const newIndex = currentIndex + direction;
    if (newIndex >= 0 && newIndex < filteredTasks.length) {
      setSelectedTask({ ...filteredTasks[newIndex], operation_id: undefined });
    }
  };

  const currentTaskIndex = selectedTask 
    ? filteredTasks.findIndex(t => t.task_id === selectedTask.task_id)
    : -1;

  const getPriorityBadge = (priority?: string) => {
    switch (priority) {
      case "early_out":
        return <Badge className="bg-red-500 text-white">Early Out</Badge>;
      case "high_priority":
        return (
          <Badge className="bg-orange-500 text-white">High Priority</Badge>
        );
      case "low_priority":
        return <Badge className="bg-blue-500 text-white">Low Priority</Badge>;
      default:
        return <Badge variant="secondary">Non assegnata</Badge>;
    }
  };

  const handleShowRecap = () => {
    if (selectedOperations.size === 0) {
      toast({
        title: "Nessuna modifica",
        description: "Seleziona almeno una tipologia d'intervento prima di salvare.",
      });
      return;
    }
    setRecapOperations(new Map(selectedOperations));
    setShowRecap(true);
  };

  const handleConfirmSave = async () => {
    setIsSaving(true);
    try {
      const updates = Array.from(recapOperations.entries()).map(([taskId, operationId]) => ({
        taskId: String(taskId),
        operationId,
        date: selectedDate,
      }));

      const response = await fetch("/api/update-task-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates, scope: scopeValue }),
      });

      if (!response.ok) throw new Error("Errore nel salvataggio");

      toast({
        title: "Successo",
        description: `${recapOperations.size} task salvati su ADAM`,
        variant: "default",
      });

      setShowRecap(false);
      setSelectedOperations(new Map());
      setRecapOperations(new Map());
    } catch (error: any) {
      toast({
        title: "Errore",
        description: error.message || "Errore nel salvataggio su ADAM",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const getOperationName = (opId: number) => {
    return operationNames[opId] || `Operazione ${opId}`;
  };

  /** Area sotto header: altezza fissa + overflow hidden — niente scroll pagina (scroll solo nelle colonne lista/dettaglio). */
  const lockPageToViewport = !isLoading;

  return (
    <div
      className={cn(
        "bg-background",
        lockPageToViewport
          ? "flex h-[calc(100dvh-3.5rem-1px)] max-h-[calc(100dvh-3.5rem-1px)] flex-col overflow-hidden md:h-[calc(100dvh-3.75rem-1px)] md:max-h-[calc(100dvh-3.75rem-1px)]"
          : "min-h-screen"
      )}
    >
      <main
        className={cn(
          "w-full px-4",
          lockPageToViewport
            ? "flex min-h-0 flex-1 flex-col py-2 md:py-3"
            : "min-h-[calc(100vh-72px)] py-6"
        )}
      >
        <div
          className={cn(
            "flex flex-col gap-3 md:gap-4",
            lockPageToViewport && "min-h-0 flex-1"
          )}
        >
          {!isLoading && (
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => changeDate(-1)}
                  data-testid="button-prev-date"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Popover open={datePickerOpen} onOpenChange={setDatePickerOpen}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "flex items-center gap-2 rounded-lg bg-muted transition-colors hover:bg-muted/80",
                        lockPageToViewport ? "px-3 py-1.5 text-sm" : "px-4 py-2"
                      )}
                      data-testid="workdate-picker-trigger"
                    >
                      <CalendarIcon className="h-4 w-4" />
                      <span className="font-medium">
                        {format(parseISO(selectedDate), "EEEE d MMMM yyyy", { locale: it })}
                      </span>
                    </button>
                  </PopoverTrigger>

                  <PopoverContent className="w-auto p-2" align="start">
                  <Calendar
                    mode="single"
                    selected={parseISO(selectedDate)}
                    onSelect={(d) => {
                      if (!d) return;
                      setSelectedDate(format(d, "yyyy-MM-dd"));
                      setDatePickerOpen(false);
                    }}
                    initialFocus
                    locale={it}
                  />
                  </PopoverContent>
                </Popover>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => changeDate(1)}
                  data-testid="button-next-date"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          {isRefreshError ? (
            <div className="mb-4 shrink-0 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              Errore durante l&apos;aggiornamento dei containers per la data selezionata:{" "}
              {(refreshError as Error)?.message || "errore sconosciuto"}
            </div>
          ) : null}

          {isLoading ? (
            <PageViewportCentered layout="viewport" className="py-8">
              <div className="max-w-lg space-y-4 text-center">
                <div className="flex justify-center">
                  <div className="h-10 w-10 animate-spin rounded-full border-b-2 border-primary" />
                </div>
                <h2 className="text-xl font-bold text-foreground">{loadingTitle}</h2>
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-primary" />
                  <span>{loadingStepLabel}</span>
                </div>
              </div>
            </PageViewportCentered>
          ) : unconfirmedTasks.length === 0 ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2 md:gap-3">
              <div className="flex min-h-0 flex-1 gap-2 md:gap-3">
                <div className="flex min-h-0 w-[32%] min-w-0 flex-col overflow-hidden rounded-lg border-2 border-custom-blue p-2 md:w-[31%] md:p-3">
                  <div className="relative mb-2 w-full shrink-0">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-custom-blue" />
                    <Input
                      placeholder="Cerca per ID, code, indirizzo, cliente, alias o customer ID..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="border-2 border-custom-blue pl-10 text-xs"
                      data-testid="input-search"
                    />
                  </div>
                  <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden md:gap-3" />
                </div>

                <div className="flex min-h-0 w-[68%] min-w-0 flex-col overflow-hidden rounded-lg border-2 border-custom-blue bg-green-50 dark:bg-green-950/30 md:w-[69%]">
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center sm:p-12">
                    <CheckCircle className="h-12 w-12 shrink-0 text-green-500 sm:h-16 sm:w-16" />
                    <h3 className="max-w-2xl text-base font-semibold text-green-800 dark:text-green-200 sm:text-lg">
                      Tutti i task per questa data hanno la tipologia d&apos;intervento correttamente impostata.
                    </h3>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 justify-center pb-1 pt-0.5">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate(assignmentsHomeHref)}
                  disabled={false}
                  data-testid="button-go-home"
                  className="border-2 border-custom-blue"
                >
                  <Home className="mr-2 h-4 w-4" />
                  Torna alla Home
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2 md:gap-3">
              <div className="flex shrink-0 items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/30 md:gap-3 md:p-3">
                <AlertTriangle className="h-5 w-5 shrink-0 text-amber-500 md:h-6 md:w-6" />
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-200 md:text-base">
                    {unconfirmedTasks.length} Task con tipologia d'intervento non impostata
                  </h2>
                  <p className="text-xs text-amber-700 dark:text-amber-300 md:text-sm">
                    Imposta la tipologia d'intervento per ogni task prima di procedere con le assegnazioni.
                  </p>
                </div>
              </div>

              <div className="flex min-h-0 flex-1 gap-2 md:gap-3">
                <div className="flex min-h-0 w-[32%] min-w-0 flex-col overflow-hidden rounded-lg border-2 border-custom-blue p-2 md:w-[31%] md:p-3">
                  <div className="relative mb-2 w-full shrink-0">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-custom-blue" />
                    <Input
                      placeholder="Cerca per ID, code, indirizzo, cliente, alias o customer ID..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10 border-2 border-custom-blue text-xs"
                      data-testid="input-search"
                    />
                  </div>
                  <div className="custom-scrollbar flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden md:gap-3">
                    {filteredTasks.length === 0 && searchTerm ? (
                      <div className="flex flex-col items-center justify-center p-6 text-center text-muted-foreground">
                        <Search className="h-8 w-8 mb-2 opacity-50" />
                        <p className="text-sm">Nessun risultato per "{searchTerm}"</p>
                        <Button 
                          variant="link" 
                          size="sm" 
                          onClick={() => setSearchTerm("")}
                          className="mt-2"
                          data-testid="button-clear-search"
                        >
                          Cancella ricerca
                        </Button>
                      </div>
                    ) : (
                      filteredTasks.map((task) => (
                        <div
                          key={`${task.task_id}-${task.logistic_code}`}
                          className={`flex cursor-pointer items-center justify-between gap-2 rounded p-2 transition-all hover:opacity-80 md:gap-3 md:p-3 ${
                            selectedTask?.task_id === task.task_id
                              ? "bg-custom-blue-light border-[3px] border-custom-blue ring-[3px] ring-inset ring-[color:var(--priority-border-color)]/60 shadow-lg"
                              : "bg-custom-blue-light border border-custom-blue"
                          }`}
                          onClick={() => setSelectedTask(task)}
                          data-testid={`task-${task.task_id}`}
                        >
                          <div className="flex flex-col gap-1 flex-grow">
                            <div className="flex items-center gap-3">
                              <span className="text-muted-foreground font-mono text-sm">
                                ID:{String(task.task_id).padStart(5, '0')}
                              </span>
                              <span className="text-muted-foreground">-</span>
                              <span className="text-red-500 font-mono text-base font-semibold">
                                {task.logistic_code}{task.customer_reference ? ` (${task.customer_reference})` : ''}
                              </span>
                            </div>
                            {task.address && (
                              <span className="text-sm text-muted-foreground truncate max-w-[350px] uppercase">
                                {task.address}
                              </span>
                            )}
                          </div>
                          {selectedOperations.has(task.task_id) && (
                            <span className="text-sm font-semibold text-amber-700 dark:text-amber-300 whitespace-nowrap ml-2">
                              Tipologia = {selectedOperations.get(task.task_id) === 0 ? "Nessuna" : selectedOperations.get(task.task_id) === 1 ? "FERMATA" : selectedOperations.get(task.task_id) === 2 ? "PARTENZA" : selectedOperations.get(task.task_id) === 3 ? "STRAORDINARIA" : "RIPASSO"}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="flex min-h-0 w-[68%] min-w-0 flex-col overflow-hidden rounded-lg border-2 border-custom-blue bg-custom-blue-light p-2 md:w-[69%] md:p-3">
                  {!selectedTask ? (
                    <div className="flex flex-1 items-center justify-center px-2 text-center text-sm text-muted-foreground">
                      Seleziona una task per vedere i dettagli
                    </div>
                  ) : (
                    <div className="custom-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
                      <div className="mx-auto flex min-h-full w-full max-w-[36rem] flex-col">
                        <div className="grid shrink-0 grid-cols-[2rem_1fr_2rem] items-center pb-2 md:grid-cols-[2.25rem_1fr_2.25rem]">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 shrink-0 justify-self-start md:h-9 md:w-9"
                            onClick={() => navigateTask(-1)}
                            disabled={currentTaskIndex <= 0}
                            data-testid="button-prev-task"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <h3 className="flex items-center justify-center gap-1.5 text-base font-semibold md:gap-2 md:text-lg">
                            Task {String(selectedTask.task_id).padStart(5, "0")}
                            <Badge
                              variant="outline"
                              className={`text-xs shrink-0 px-2 py-0.5 rounded border font-medium ${
                                selectedTask.straordinaria
                                  ? "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500"
                                  : selectedTask.premium
                                    ? "bg-yellow-500/30 text-yellow-800 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400"
                                    : "bg-green-500/30 text-green-800 dark:text-green-200 border-green-600 dark:border-green-400"
                              }`}
                            >
                              {selectedTask.straordinaria
                                ? "STRAORDINARIA"
                                : selectedTask.premium
                                  ? "PREMIUM"
                                  : "STANDARD"}
                            </Badge>
                            {selectedTask.priority && (
                              <Badge
                                className={
                                  selectedTask.priority === "early_out"
                                    ? "bg-blue-500 text-white border-blue-700"
                                    : selectedTask.priority === "high_priority"
                                      ? "bg-orange-500 text-white border-orange-700"
                                      : "bg-gray-500 text-white border-gray-700"
                                }
                              >
                                {selectedTask.priority === "early_out"
                                  ? "EO"
                                  : selectedTask.priority === "high_priority"
                                    ? "HP"
                                    : "LP"}
                              </Badge>
                            )}
                          </h3>
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-8 w-8 shrink-0 justify-self-end md:h-9 md:w-9"
                            onClick={() => navigateTask(1)}
                            disabled={currentTaskIndex >= filteredTasks.length - 1}
                            data-testid="button-next-task"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>

                        <div className="mx-auto grid h-full min-h-0 w-[calc(100%-4rem)] flex-1 auto-rows-fr content-start gap-2 px-0.5 pt-1 pb-0.5 md:w-[calc(100%-4.5rem)] md:gap-2.5 md:pt-1.5 md:pb-1">
                          <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] content-start items-start gap-x-3 gap-y-1.5 md:gap-y-2">
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Codice ADAM</p>
                              <p className="text-sm">{selectedTask.logistic_code}</p>
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Cliente</p>
                              <p className="text-sm">{selectedTask.customer_name || selectedTask.alias || "non migrato"}</p>
                            </div>
                          </div>

                          <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] content-start items-start gap-x-3 gap-y-1.5 md:gap-y-2">
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Indirizzo</p>
                              <p className="text-sm uppercase">{selectedTask.address || "NON MIGRATO"}</p>
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Durata pulizia</p>
                              <p className="text-sm">
                                {selectedTask.cleaning_time
                                  ? `${selectedTask.cleaning_time} minuti`
                                  : selectedTask.duration
                                    ? `${selectedTask.duration.replace(".", ":")} ore`
                                    : "non migrato"}
                              </p>
                            </div>
                          </div>

                          <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] content-start items-start gap-x-3 gap-y-1.5 md:gap-y-2">
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Check-out</p>
                              <p className="text-sm">
                                {selectedTask.checkout_date
                                  ? new Date(selectedTask.checkout_date).toLocaleDateString("it-IT", {
                                      day: "2-digit",
                                      month: "2-digit",
                                      year: "numeric",
                                    })
                                  : "non migrato"}
                                {selectedTask.checkout_date && selectedTask.checkout_time
                                  ? ` - ${selectedTask.checkout_time}`
                                  : selectedTask.checkout_date
                                    ? " - orario non migrato"
                                    : ""}
                              </p>
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Check-in</p>
                              <p className="text-sm">
                                {selectedTask.checkin_date
                                  ? new Date(selectedTask.checkin_date).toLocaleDateString("it-IT", {
                                      day: "2-digit",
                                      month: "2-digit",
                                      year: "numeric",
                                    })
                                  : "non migrato"}
                                {selectedTask.checkin_date && selectedTask.checkin_time
                                  ? ` - ${selectedTask.checkin_time}`
                                  : selectedTask.checkin_date
                                    ? " - orario non migrato"
                                    : ""}
                              </p>
                            </div>
                          </div>

                          <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] content-start items-start gap-x-3 gap-y-1.5 md:gap-y-2">
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Tipologia appartamento</p>
                              <p className="text-sm">{selectedTask.type_apt || "non migrato"}</p>
                            </div>
                            <Popover>
                              <PopoverTrigger asChild>
                                <div
                                  className="-m-1 cursor-pointer rounded-lg border-2 border-amber-200 bg-amber-50 p-3 transition-colors hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/30 dark:hover:bg-amber-900/40"
                                  data-testid="trigger-operation-type"
                                >
                                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">Tipologia intervento</p>
                                  <p className="text-sm font-bold text-amber-700 dark:text-amber-300">
                                    {(() => {
                                      const selectedOp = selectedOperations.get(selectedTask.task_id);
                                      if (selectedOp === undefined) {
                                        return "non migrato";
                                      }
                                      return operationNames[selectedOp] || `Operazione ${selectedOp}`;
                                    })()}
                                  </p>
                                </div>
                              </PopoverTrigger>
                              <PopoverContent className="w-48 p-1" align="start">
                                <div className="flex flex-col">
                                  <button
                                    onClick={() => {
                                      const newOps = new Map(selectedOperations);
                                      newOps.delete(selectedTask.task_id);
                                      setSelectedOperations(newOps);
                                    }}
                                    className={`text-left text-sm px-2 py-1.5 rounded hover:bg-muted transition-colors ${
                                      !selectedOperations.has(selectedTask.task_id) ? "bg-amber-100 dark:bg-amber-900/50 font-semibold" : ""
                                    }`}
                                    data-testid="option-operation-0"
                                  >
                                    Nessuna
                                  </button>
                                  {allowedOperations.map((op) => (
                                    <button
                                      key={op.id}
                                      onClick={() => {
                                        const newOps = new Map(selectedOperations);
                                        newOps.set(selectedTask.task_id, op.id);
                                        setSelectedOperations(newOps);
                                      }}
                                      className={`text-left text-sm px-2 py-1.5 rounded hover:bg-muted transition-colors ${
                                        selectedOperations.get(selectedTask.task_id) === op.id ? "bg-amber-100 dark:bg-amber-900/50 font-semibold" : ""
                                      }`}
                                      data-testid={`option-operation-${op.id}`}
                                    >
                                      {op.name}
                                    </button>
                                  ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </div>

                          <div className="grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)] content-start items-start gap-x-3 gap-y-1.5 md:gap-y-2">
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Pax-In</p>
                              <p className="text-sm">{selectedTask.pax_in ?? "non migrato"}</p>
                            </div>
                            <div>
                              <p className="text-sm font-semibold text-muted-foreground">Pax-Out</p>
                              <p className="text-sm">{selectedTask.pax_out ?? "non migrato"}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div
                className={cn(
                  "flex shrink-0 justify-center gap-2 pt-1 md:gap-3",
                  hasTasksToSet ? "flex-wrap" : ""
                )}
              >
                {hasTasksToSet && (
                  <Button
                    onClick={handleShowRecap}
                    disabled={selectedOperations.size === 0 || isSaving}
                    variant="outline"
                    className="border-2 border-custom-blue"
                    data-testid="button-save-adam"
                  >
                    {isSaving ? (
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4 mr-2" />
                    )}
                    {isSaving
                      ? "Salvataggio..."
                      : `Salva su ADAM (${selectedOperations.size})`}
                  </Button>
                )}

                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate(assignmentsHomeHref)}
                  disabled={false}
                  data-testid="button-go-home"
                  className="border-2 border-custom-blue"
                >
                  <Home className="h-4 w-4 mr-2" />
                  Torna alla Home
                </Button>
              </div>

              <Dialog open={showRecap} onOpenChange={setShowRecap}>
                <DialogContent className="max-w-2xl">
                  <DialogHeader>
                    <DialogTitle>Recap - Conferma Salvataggio</DialogTitle>
                  </DialogHeader>

                  <div className="space-y-1.5 py-2 max-h-[calc(80vh-150px)] overflow-y-auto">
                    {Array.from(recapOperations.entries()).map(([taskId, opId]) => {
                      const task = filteredTasks.find(t => t.task_id === taskId);
                      const isExpanded = expandedTaskId === taskId;
                      if (!task) return null;

                      return (
                        <div 
                          key={taskId} 
                          className="bg-custom-blue-light border border-custom-blue rounded-lg p-2 cursor-pointer hover:opacity-80 transition-opacity"
                          onClick={() => setExpandedTaskId(isExpanded ? null : taskId)}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
                              <span className="font-mono text-xs font-semibold">ID: {String(task.task_id).padStart(5, '0')}</span>
                              <span className="text-red-500 text-xs font-semibold">{task.logistic_code}</span>
                              {task.address && <span className="text-xs text-muted-foreground truncate">{task.address}</span>}
                            </div>

                            <div className="flex-shrink-0">
                              {!isExpanded ? (
                                <span className="text-amber-700 dark:text-amber-300 text-xs font-semibold whitespace-nowrap">Tipologia = {getOperationName(opId)}</span>
                              ) : (
                                <Select value={String(opId)} onValueChange={(val) => {
                                  const newOps = new Map(recapOperations);
                                  newOps.set(taskId, parseInt(val));
                                  setRecapOperations(newOps);
                                }}>
                                  <SelectTrigger className="bg-white dark:bg-slate-900 h-7 text-xs w-auto">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {allowedOperations.map((op) => (
                                      <SelectItem key={op.id} value={String(op.id)}>
                                        {op.name}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <DialogFooter className="gap-2">
                    <Button
                      variant="outline"
                      className="border-2 border-custom-blue"
                      onClick={() => setShowRecap(false)}
                      disabled={isSaving}
                    >
                      Annulla
                    </Button>
                    <Button
                      variant="outline"
                      className="border-2 border-custom-blue"
                      onClick={handleConfirmSave}
                      disabled={isSaving}
                    >
                      {isSaving ? "Salvataggio..." : "Conferma Salvataggio"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
