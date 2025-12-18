import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { useLocation } from "wouter";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  Calendar,
  Clock,
  MapPin,
  Search,
  ArrowRight,
  Building,
  Users,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
} from "lucide-react";

interface Task {
  task_id: string | number;
  logistic_code: string;
  address?: string;
  alias?: string;
  customer_name?: string;
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

export default function UnconfirmedTasks() {
  const [, setLocation] = useLocation();
  const [selectedDate, setSelectedDate] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get("date");
    return dateParam || format(new Date(), "yyyy-MM-dd");
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const { data: containersData, isLoading } = useQuery<ContainersData>({
    queryKey: ["/api/containers-enriched", selectedDate],
    queryFn: async () => {
      const response = await fetch(
        `/api/containers-enriched?date=${selectedDate}`,
      );
      if (!response.ok) throw new Error("Failed to fetch containers");
      return response.json();
    },
  });

  const unconfirmedTasks = (() => {
    if (!containersData?.containers) return [];

    const allTasks: Task[] = [];

    Object.values(containersData.containers).forEach((container) => {
      const tasks = (container as { tasks?: Task[] })?.tasks || [];
      tasks.forEach((task) => {
        if (task.confirmed_operation === false) {
          allTasks.push(task);
        }
      });
    });

    return allTasks;
  })();

  const filteredTasks = unconfirmedTasks.filter((task) => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      String(task.task_id).toLowerCase().includes(search) ||
      String(task.logistic_code).toLowerCase().includes(search) ||
      (task.address || "").toLowerCase().includes(search) ||
      (task.alias || "").toLowerCase().includes(search) ||
      (task.customer_name || "").toLowerCase().includes(search)
    );
  });

  const changeDate = (days: number) => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() + days);
    setSelectedDate(format(current, "yyyy-MM-dd"));
  };

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

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto px-4 py-6">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => changeDate(-1)}
                data-testid="button-prev-date"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div className="flex items-center gap-2 px-4 py-2 bg-muted rounded-lg">
                <Calendar className="h-4 w-4" />
                <span className="font-medium">
                  {format(new Date(selectedDate), "EEEE d MMMM yyyy", {
                    locale: it,
                  })}
                </span>
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={() => changeDate(1)}
                data-testid="button-next-date"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={() => setLocation("/generate-assignments")}
                variant="default"
                data-testid="button-go-to-assignments"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Vai alle Assegnazioni
              </Button>
              <ThemeToggle />
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : filteredTasks.length === 0 ? (
            <Card className="border-2 border-custom-blue bg-green-50 dark:bg-green-950/30">
              <CardContent className="flex flex-col items-center justify-center p-12 text-center">
                <CheckCircle className="h-12 w-12 text-green-500 mb-4" />
                <h3 className="text-lg font-semibold mb-2 text-green-800 dark:text-green-200">
                  Tutti i task per questa data hanno la tipologia d'intervento correttamente impostata.
                </h3>
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex items-center gap-4 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                <AlertTriangle className="h-8 w-8 text-amber-500 flex-shrink-0" />
                <div>
                  <h2 className="font-semibold text-amber-800 dark:text-amber-200">
                    {filteredTasks.length} Task con tipologia d'intervento non impostata
                  </h2>
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    Imposta la tipologia d'intervento per ogni task prima di procedere con le assegnazioni.
                  </p>
                </div>
              </div>

              <div className="flex gap-4 items-start">
                <div className="w-1/3 border-2 border-custom-blue rounded-lg p-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
                  <div className="relative w-full mb-3">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Cerca per ID, codice ADAM, indirizzo..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="pl-10"
                      data-testid="input-search"
                    />
                  </div>
                  <div className="flex flex-col gap-3">
                    {filteredTasks.map((task) => (
                      <div
                        key={`${task.task_id}-${task.logistic_code}`}
                        className={`flex items-center justify-between gap-4 p-3 rounded cursor-pointer hover:bg-muted ${
                          selectedTask?.task_id === task.task_id
                            ? "bg-primary/20 border-2 border-primary ring-2 ring-primary/50 shadow-md"
                            : "bg-muted/50 border border-custom-blue"
                        }`}
                        onClick={() => setSelectedTask({ ...task, operation_id: undefined })}
                        data-testid={`task-${task.task_id}`}
                      >
                        <div className="flex flex-col gap-1">
                          <div className="flex items-center gap-3">
                            <span className="text-muted-foreground font-mono text-sm">
                              ID:{String(task.task_id).padStart(5, '0')}
                            </span>
                            <span className="text-muted-foreground">-</span>
                            <span className="text-red-500 font-mono text-base font-semibold">
                              {task.logistic_code}
                            </span>
                          </div>
                          {task.address && (
                            <span className="text-sm text-muted-foreground truncate max-w-[250px] uppercase">
                              {task.address}
                            </span>
                          )}
                        </div>
                        <Select
                          defaultValue=""
                          onValueChange={(value) => {
                            const newOperationId = value === "none" ? 0 : parseInt(value);
                            if (selectedTask?.task_id === task.task_id) {
                              setSelectedTask({ ...selectedTask, operation_id: newOperationId });
                            }
                          }}
                        >
                          <SelectTrigger className="w-[200px] text-sm">
                            <SelectValue placeholder="Seleziona operazione" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">— Nessuna operazione —</SelectItem>
                            <SelectItem value="1">FERMATA</SelectItem>
                            <SelectItem value="2">PARTENZA</SelectItem>
                            <SelectItem value="3">PULIZIA STRAORDINARIA</SelectItem>
                            <SelectItem value="4">RIPASSO</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="w-2/3 border-2 border-custom-blue rounded-lg p-6 max-h-[70vh]">
                  {!selectedTask ? (
                    <div className="flex items-center justify-center h-full text-muted-foreground">
                      Seleziona una task per vedere i dettagli
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={() => navigateTask(-1)}
                            disabled={currentTaskIndex <= 0}
                            data-testid="button-prev-task"
                          >
                            <ChevronLeft className="h-4 w-4" />
                          </Button>
                          <h3 className="text-lg font-semibold flex items-center gap-2">
                            Task {currentTaskIndex + 1}/{filteredTasks.length}
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
                            onClick={() => navigateTask(1)}
                            disabled={currentTaskIndex >= filteredTasks.length - 1}
                            data-testid="button-next-task"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Codice ADAM
                          </p>
                          <p className="text-base">{selectedTask.logistic_code}</p>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Cliente
                          </p>
                          <p className="text-base">{selectedTask.customer_name || selectedTask.alias || "non migrato"}</p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Indirizzo
                          </p>
                          <p className="text-base uppercase">{selectedTask.address || "NON MIGRATO"}</p>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Durata pulizia
                          </p>
                          <p className="text-base">
                            {selectedTask.cleaning_time
                              ? `${selectedTask.cleaning_time} minuti`
                              : selectedTask.duration
                                ? `${selectedTask.duration.replace(".", ":")} ore`
                                : "non migrato"}
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Check-out
                          </p>
                          <p className="text-base">
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
                          <p className="text-base font-semibold text-muted-foreground">
                            Check-in
                          </p>
                          <p className="text-base">
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

                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Tipologia appartamento
                          </p>
                          <p className="text-base">{selectedTask.type_apt || "non migrato"}</p>
                        </div>
                        <div className="bg-amber-100 dark:bg-amber-900/30 border-2 border-amber-400 dark:border-amber-600 rounded-lg p-3 -m-1">
                          <p className="text-base font-semibold text-amber-700 dark:text-amber-300">
                            Tipologia intervento
                          </p>
                          <p className="text-base font-bold text-amber-800 dark:text-amber-200">
                            {(() => {
                              const operationNames: Record<number, string> = {
                                1: "FERMATA",
                                2: "PARTENZA",
                                3: "PULIZIA STRAORDINARIA",
                                4: "RIPASSO"
                              };
                              if (selectedTask.confirmed_operation === false && !selectedTask.operation_id) {
                                return "non migrato";
                              }
                              if (!selectedTask.operation_id || selectedTask.operation_id === 0) {
                                return "non migrato";
                              }
                              return operationNames[selectedTask.operation_id] || `Operazione ${selectedTask.operation_id}`;
                            })()}
                          </p>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-6">
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Pax-In
                          </p>
                          <p className="text-base">{selectedTask.pax_in ?? "non migrato"}</p>
                        </div>
                        <div>
                          <p className="text-base font-semibold text-muted-foreground">
                            Pax-Out
                          </p>
                          <p className="text-base">{selectedTask.pax_out ?? "non migrato"}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
