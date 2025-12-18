import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { useLocation } from "wouter";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { 
  AlertTriangle, 
  Calendar, 
  Clock, 
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  ArrowDown
} from "lucide-react";
import TaskCard from "@/components/drag-drop/task-card";
import { TaskType as Task } from "@shared/schema";

interface ContainersData {
  containers: {
    early_out?: { tasks?: Task[] };
    high_priority?: { tasks?: Task[] };
    low_priority?: { tasks?: Task[] };
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

  const { data: containersData, isLoading } = useQuery<ContainersData>({
    queryKey: ["/api/containers-enriched", selectedDate],
    queryFn: async () => {
      const response = await fetch(`/api/containers-enriched?date=${selectedDate}`);
      if (!response.ok) throw new Error("Failed to fetch containers");
      return response.json();
    },
  });

  const getUnconfirmedTasksByPriority = (priority: string): Task[] => {
    if (!containersData?.containers) return [];
    const container = containersData.containers[priority];
    if (!container?.tasks) return [];
    return container.tasks.filter(task => (task as any).confirmed_operation === false);
  };

  const earlyOutTasks = getUnconfirmedTasksByPriority("early_out");
  const highPriorityTasks = getUnconfirmedTasksByPriority("high_priority");
  const lowPriorityTasks = getUnconfirmedTasksByPriority("low_priority");

  const totalUnconfirmed = earlyOutTasks.length + highPriorityTasks.length + lowPriorityTasks.length;

  const filterTasks = (tasks: Task[]): Task[] => {
    if (!searchTerm) return tasks;
    const search = searchTerm.toLowerCase();
    return tasks.filter(task => {
      const taskId = String((task as any).id || (task as any).task_id || '');
      const logisticCode = String((task as any).logisticCode || (task as any).logistic_code || (task as any).name || '');
      const address = String((task as any).address || '');
      return (
        taskId.toLowerCase().includes(search) ||
        logisticCode.toLowerCase().includes(search) ||
        address.toLowerCase().includes(search)
      );
    });
  };

  const filteredEarlyOut = filterTasks(earlyOutTasks);
  const filteredHighPriority = filterTasks(highPriorityTasks);
  const filteredLowPriority = filterTasks(lowPriorityTasks);

  const changeDate = (days: number) => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() + days);
    setSelectedDate(format(current, "yyyy-MM-dd"));
  };

  const getHighlightedTaskIds = (tasks: Task[]): Set<string> => {
    if (!searchTerm.trim()) return new Set();
    const lowerSearch = searchTerm.toLowerCase();
    return new Set(tasks
      .filter(task => {
        const taskId = String((task as any).id || (task as any).task_id || '');
        const logisticCode = String((task as any).logisticCode || (task as any).logistic_code || (task as any).name || '');
        const address = String((task as any).address || '');
        return (
          taskId.toLowerCase().includes(lowerSearch) ||
          logisticCode.toLowerCase().includes(lowerSearch) ||
          address.toLowerCase().includes(lowerSearch)
        );
      })
      .map(t => String((t as any).id || (t as any).task_id || '')));
  };

  const highlightedEarlyOut = getHighlightedTaskIds(earlyOutTasks);
  const highlightedHighPriority = getHighlightedTaskIds(highPriorityTasks);
  const highlightedLowPriority = getHighlightedTaskIds(lowPriorityTasks);

  const PriorityContainer = ({ 
    title, 
    priority, 
    tasks, 
    icon,
    highlightedTaskIds
  }: { 
    title: string; 
    priority: string; 
    tasks: Task[]; 
    icon: "clock" | "alert-circle" | "arrow-down";
    highlightedTaskIds: Set<string>;
  }) => {
    const iconMap: Record<string, React.ReactNode> = {
      clock: <Clock className="w-5 h-5 mr-2 text-muted-foreground" />,
      "alert-circle": <AlertCircle className="w-5 h-5 mr-2 text-muted-foreground" />,
      "arrow-down": <ArrowDown className="w-5 h-5 mr-2 text-muted-foreground" />,
    };

    const getColumnClass = () => {
      switch (priority) {
        case "early-out":
          return "border-2 border-custom-blue bg-custom-blue-light";
        case "high":
          return "border-2 border-custom-blue bg-custom-blue-light";
        case "low":
          return "border-2 border-custom-blue bg-custom-blue-light";
        default:
          return "border-2 border-custom-blue bg-custom-blue-light";
      }
    };

    return (
      <div className={`rounded-lg p-4 ${getColumnClass()}`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center">
            {iconMap[icon]}
            <h3 className="font-semibold text-foreground">{title}</h3>
            <span className="ml-2 bg-muted text-muted-foreground px-2 py-0.5 rounded-full text-sm">
              {tasks.length}
            </span>
          </div>
        </div>
        <div className="space-y-3 max-h-[600px] overflow-y-auto">
          {tasks.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nessuna task non confermata
            </div>
          ) : (
            tasks.map((task, index) => (
              <TaskCard
                key={`${(task as any).id || (task as any).task_id}-${index}`}
                task={task}
                index={index}
                isDragDisabled={true}
                isHighlighted={highlightedTaskIds.has(String((task as any).id || (task as any).task_id || ''))}
              />
            ))
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-4">
            <AlertTriangle className="h-6 w-6 text-amber-500" />
            <h1 className="text-lg font-semibold">Task Non Confermate</h1>
          </div>
          <div className="flex items-center gap-2">
            <Button 
              onClick={() => setLocation(`/generate-assignments?date=${selectedDate}`)}
              variant="default"
              data-testid="button-go-to-assignments"
            >
              <ArrowRight className="h-4 w-4 mr-2" />
              Vai alle Assegnazioni
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </header>

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
                  {format(new Date(selectedDate), "EEEE d MMMM yyyy", { locale: it })}
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

            <div className="relative w-full max-w-sm">
              <Input
                placeholder="🔍 Cerca task per ID, logistic code o indirizzo..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="border-2 border-custom-blue"
                data-testid="input-search"
              />
            </div>
          </div>

          <div className="flex items-center gap-4 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
            <AlertTriangle className="h-8 w-8 text-amber-500 flex-shrink-0" />
            <div>
              <h2 className="font-semibold text-amber-800 dark:text-amber-200">
                {totalUnconfirmed} Task con operazione non confermata
              </h2>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Queste task hanno confirmed_operation = false, indicando che l'operazione non è stata confermata nel sistema.
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <PriorityContainer
                title="EARLY OUT"
                priority="early-out"
                tasks={filteredEarlyOut}
                icon="clock"
                highlightedTaskIds={highlightedEarlyOut}
              />
              <PriorityContainer
                title="HIGH PRIORITY"
                priority="high"
                tasks={filteredHighPriority}
                icon="alert-circle"
                highlightedTaskIds={highlightedHighPriority}
              />
              <PriorityContainer
                title="LOW PRIORITY"
                priority="low"
                tasks={filteredLowPriority}
                icon="arrow-down"
                highlightedTaskIds={highlightedLowPriority}
              />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
