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
  AlertTriangle, 
  Calendar, 
  Clock, 
  MapPin, 
  Search, 
  ArrowRight,
  Building,
  Users,
  ChevronLeft,
  ChevronRight
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
}

interface ContainersData {
  containers: {
    [key: string]: { tasks?: Task[] } | undefined;
  };
}

export default function UnconfirmedTasks() {
  const [, setLocation] = useLocation();
  const [selectedDate, setSelectedDate] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const [searchTerm, setSearchTerm] = useState("");

  const { data: containersData, isLoading } = useQuery<ContainersData>({
    queryKey: ["/api/containers", selectedDate],
    queryFn: async () => {
      const response = await fetch(`/api/containers?date=${selectedDate}`);
      if (!response.ok) throw new Error("Failed to fetch containers");
      return response.json();
    },
  });

  const unconfirmedTasks = (() => {
    if (!containersData?.containers) return [];
    
    const allTasks: Task[] = [];
    
    Object.values(containersData.containers).forEach((container) => {
      const tasks = (container as { tasks?: Task[] })?.tasks || [];
      tasks.forEach(task => {
        if (task.confirmed_operation === false) {
          allTasks.push(task);
        }
      });
    });
    
    return allTasks;
  })();

  const filteredTasks = unconfirmedTasks.filter(task => {
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

  const getPriorityBadge = (priority?: string) => {
    switch (priority) {
      case "early_out":
        return <Badge className="bg-red-500 text-white">Early Out</Badge>;
      case "high_priority":
        return <Badge className="bg-orange-500 text-white">High Priority</Badge>;
      case "low_priority":
        return <Badge className="bg-blue-500 text-white">Low Priority</Badge>;
      default:
        return <Badge variant="secondary">Non assegnata</Badge>;
    }
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
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Cerca per ID, codice, indirizzo..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
                data-testid="input-search"
              />
            </div>
          </div>

          <div className="flex items-center gap-4 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
            <AlertTriangle className="h-8 w-8 text-amber-500 flex-shrink-0" />
            <div>
              <h2 className="font-semibold text-amber-800 dark:text-amber-200">
                {filteredTasks.length} Task con operazione non confermata
              </h2>
              <p className="text-sm text-amber-700 dark:text-amber-300">
                Queste task hanno operation_id = 0, indicando che l'operazione non è stata confermata nel sistema.
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : filteredTasks.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center p-12 text-center">
                <AlertTriangle className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-semibold mb-2">
                  {searchTerm ? "Nessun risultato" : "Nessuna task non confermata"}
                </h3>
                <p className="text-muted-foreground">
                  {searchTerm 
                    ? "Prova a modificare i termini di ricerca" 
                    : "Tutte le task per questa data hanno l'operazione confermata"}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredTasks.map((task) => (
                <Card 
                  key={`${task.task_id}-${task.logistic_code}`}
                  className="border-amber-200 dark:border-amber-800"
                  data-testid={`card-task-${task.task_id}`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-sm font-mono">
                          {task.logistic_code}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground">ID: {task.task_id}</p>
                      </div>
                      {getPriorityBadge(task.priority)}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {task.address && (
                      <div className="flex items-start gap-2">
                        <MapPin className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                        <span className="text-sm">{task.address}</span>
                      </div>
                    )}
                    
                    {(task.alias || task.customer_name) && (
                      <div className="flex items-center gap-2">
                        <Building className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{task.alias || task.customer_name}</span>
                      </div>
                    )}

                    <div className="flex items-center gap-4 text-sm">
                      {task.checkout_time && (
                        <div className="flex items-center gap-1">
                          <Clock className="h-4 w-4 text-muted-foreground" />
                          <span>Check-out: {task.checkout_time}</span>
                        </div>
                      )}
                      {task.cleaning_time && (
                        <span className="text-muted-foreground">
                          {task.cleaning_time} min
                        </span>
                      )}
                    </div>

                    {(task.pax_out || task.pax_in) && (
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">
                          {task.pax_out && `Out: ${task.pax_out}`}
                          {task.pax_out && task.pax_in && " / "}
                          {task.pax_in && `In: ${task.pax_in}`}
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap gap-1">
                      {task.premium && (
                        <Badge variant="outline" className="text-xs">Premium</Badge>
                      )}
                      {task.straordinaria && (
                        <Badge variant="outline" className="text-xs">Straordinaria</Badge>
                      )}
                      {task.type_apt && (
                        <Badge variant="outline" className="text-xs">{task.type_apt}</Badge>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
