import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Task, Personnel } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import TimelineView from "@/components/timeline/timeline-view";
import MapSection from "@/components/map/map-section";
import StatisticsPanel from "@/components/stats/statistics-panel";
import { Button } from "@/components/ui/button";
import { Plus, UserPlus, Save, Wand2, Fan, FileDown, Route } from "lucide-react";

export default function TaskManager() {
  const { toast } = useToast();

  const { data: tasks = [], isLoading: tasksLoading } = useQuery<Task[]>({
    queryKey: ["/api/tasks"],
  });

  const { data: personnel = [] } = useQuery<Personnel[]>({
    queryKey: ["/api/personnel"],
  });

  const updateTaskPriorityMutation = useMutation({
    mutationFn: async ({ taskId, priority }: { taskId: string; priority: string | null }) => {
      const response = await apiRequest("PUT", `/api/tasks/${taskId}/priority`, { priority });
      return response.json();
    },
    onSuccess: (updatedTask) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });

      console.log("Mutation success - showing toast for task:", updatedTask);

      // Enhanced notification with task details
      const priorityLabel = updatedTask.priority === "early-out" ? "Early Out" :
                           updatedTask.priority === "high" ? "Alta Priorità" :
                           updatedTask.priority === "low" ? "Bassa Priorità" : "Non Assegnato";

      const isUnassigned = updatedTask.priority === null;
      const title = isUnassigned ? "📥 Task Spostato" : "✅ Task Assegnato";

      toast({
        title,
        description: `"${updatedTask.name}" → ${priorityLabel}${updatedTask.assignedTo ? ' (Assegnato automaticamente)' : ''}`,
      });
    },
    onError: () => {
      toast({
        title: "❌ Errore Assegnazione",
        description: "Impossibile aggiornare la priorità del task. Riprova.",
        variant: "destructive",
      });
    },
  });

  const autoAssignMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/tasks/auto-assign");
      return response.json();
    },
    onSuccess: (updatedTasks) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });

      // Count assignments by priority
      const assignments = updatedTasks.filter((task: any) => task.priority && task.assignedTo);
      const byPriority = assignments.reduce((acc: any, task: any) => {
        acc[task.priority] = (acc[task.priority] || 0) + 1;
        return acc;
      }, {});

      const summary = Object.entries(byPriority).map(([priority, count]) => {
        const label = priority === "early-out" ? "Early Out" :
                     priority === "high" ? "Alta" : "Bassa";
        return `${label}: ${count}`;
      }).join(", ");

      if (assignments.length === 0) {
        toast({
          title: "🚀 Assegnazione Automatica Completata",
          description: "Nessun task disponibile per l'assegnazione",
        });
      } else {
        toast({
          title: "🚀 Assegnazione Automatica Completata",
          description: `${assignments.length} task assegnati - ${summary}`,
        });
      }
    },
    onError: () => {
      toast({
        title: "❌ Errore Assegnazione Automatica",
        description: "Impossibile completare l'assegnazione automatica. Verifica la connessione.",
        variant: "destructive",
      });
    },
  });

  const clearAssignmentsMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/tasks/clear-assignments");
      return response.json();
    },
    onSuccess: (updatedTasks) => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });

      const resetCount = updatedTasks.length;
      toast({
        title: "🔄 Assegnazioni Azzerate",
        description: `${resetCount} task riportati nella sezione "Non Assegnati"`,
      });
    },
    onError: () => {
      toast({
        title: "❌ Errore Reset",
        description: "Impossibile azzerare le assegnazioni. Riprova tra qualche momento.",
        variant: "destructive",
      });
    },
  });

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;

    if (!destination) return;

    if (destination.droppableId === source.droppableId) return;

    let newPriority: string | null = null;
    if (destination.droppableId === "early-out") newPriority = "early-out";
    else if (destination.droppableId === "high") newPriority = "high";
    else if (destination.droppableId === "low") newPriority = "low";
    else return; // Solo permettiamo drag tra le tre colonne di priorità

    console.log("Drag ended - calling mutation with:", { taskId: draggableId, priority: newPriority });

    updateTaskPriorityMutation.mutate({
      taskId: draggableId,
      priority: newPriority,
    });
  };

  const handleAutoAssign = () => {
    autoAssignMutation.mutate();
  };

  const handleClearAll = () => {
    if (confirm("Sei sicuro di voler azzerare tutte le assegnazioni?")) {
      clearAssignmentsMutation.mutate();
    }
  };

  const handleExportSchedule = () => {
    toast({
      title: "In sviluppo",
      description: "Funzione di esportazione in sviluppo",
    });
  };

  const handleOptimizeRoutes = () => {
    toast({
      title: "In sviluppo",
      description: "Funzione di ottimizzazione percorsi in sviluppo",
    });
  };




  if (tasksLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-lg">Caricamento...</div>
      </div>
    );
  }

  // Filtra solo i task con priorità assegnata
  const earlyOutTasks = tasks.filter(task => task.priority === "early-out");
  const highPriorityTasks = tasks.filter(task => task.priority === "high");
  const lowPriorityTasks = tasks.filter(task => task.priority === "low");

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="container mx-auto p-4 max-w-screen-2xl">
        <DragDropContext onDragEnd={onDragEnd}>
          {/* Task Assignment Section */}
          <div className="mb-4 flex justify-between items-center">
            <div className="flex flex-col">
              <h1 className="text-3xl font-bold text-foreground mb-2" data-testid="page-title">
                Gestione Assegnazione Task
              </h1>
              <div className="flex gap-4 items-center flex-wrap">
                <Button data-testid="button-new-task" className="bg-primary text-primary-foreground hover:bg-primary/90">
                  <Plus className="w-4 h-4 mr-2" />
                  Nuovo Task
                </Button>
                <Button data-testid="button-add-person" variant="secondary">
                  <UserPlus className="w-4 h-4 mr-2" />
                  Aggiungi Persona
                </Button>
                <Button data-testid="button-auto-save" variant="outline">
                  <Save className="w-4 h-4 mr-2" />
                  Salva Automatico: ON
                </Button>
              </div>
            </div>
            <div className="bg-card rounded-lg border shadow-sm px-4 py-2">
              <div className="text-sm text-muted-foreground">Totale Task</div>
              <div className="text-2xl font-bold text-primary">{tasks.length}</div>
            </div>
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
            <PriorityColumn
              title="EARLY OUT"
              priority="early-out"
              tasks={earlyOutTasks}
              droppableId="early-out"
              icon="clock"
            />
            <PriorityColumn
              title="HIGH PRIORITY"
              priority="high"
              tasks={highPriorityTasks}
              droppableId="high"
              icon="alert-circle"
            />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={lowPriorityTasks}
              droppableId="low"
              icon="arrow-down"
            />
          </div>
        </DragDropContext>

        {/* Timeline and Personnel View */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 mb-8">
          <div className="xl:col-span-2">
            <TimelineView personnel={personnel} tasks={tasks} />
          </div>
          <div className="space-y-6">
            <MapSection />
            <StatisticsPanel tasks={tasks} />
          </div>
        </div>

        {/* Quick Actions Panel */}
        <div className="bg-card rounded-lg border shadow-sm">
          <div className="p-4 border-b border-border">
            <h3 className="font-semibold text-foreground flex items-center">
              <div className="w-5 h-5 mr-2 text-primary">⚡</div>
              Azioni Rapide
            </h3>
          </div>
          <div className="p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Button
                data-testid="button-auto-assign"
                variant="outline"
                className="flex flex-col items-center p-4 h-auto"
                onClick={handleAutoAssign}
                disabled={autoAssignMutation.isPending}
              >
                <Wand2 className="text-primary text-xl mb-2" />
                <span className="text-sm font-medium">Assegnazione Automatica</span>
              </Button>
              <Button
                data-testid="button-clear-all"
                variant="outline"
                className="flex flex-col items-center p-4 h-auto"
                onClick={handleClearAll}
                disabled={clearAssignmentsMutation.isPending}
              >
                <Fan className="text-destructive text-xl mb-2" />
                <span className="text-sm font-medium">Azzera Assegnazioni</span>
              </Button>
              <Button
                data-testid="button-export"
                variant="outline"
                className="flex flex-col items-center p-4 h-auto"
                onClick={handleExportSchedule}
              >
                <FileDown className="text-primary text-xl mb-2" />
                <span className="text-sm font-medium">Esporta Programma</span>
              </Button>
              <Button
                data-testid="button-optimize-routes"
                variant="outline"
                className="flex flex-col items-center p-4 h-auto"
                onClick={handleOptimizeRoutes}
              >
                <Route className="text-primary text-xl mb-2" />
                <span className="text-sm font-medium">Ottimizza Percorsi</span>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}