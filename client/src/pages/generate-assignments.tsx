import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import { useState, useEffect } from "react";

interface RawTask {
  task_id: number;
  structure_id: number;
  logistic_code: number;
  client_id: number;
  premium: boolean;
  address: string;
  lat: string;
  lng: string;
  cleaning_time: number;
  checkin: string;
  checkout: string;
  checkin_time: string | null;
  checkout_time: string | null;
  pax_in: number;
  pax_out: number;
  small_equipment: boolean;
  operation_id: number;
  is_straordinaria: boolean;
  zone: number;
  reasons?: string[];
}

export default function GenerateAssignments() {
  const [earlyOutTasks, setEarlyOutTasks] = useState<Task[]>([]);
  const [highPriorityTasks, setHighPriorityTasks] = useState<Task[]>([]);
  const [lowPriorityTasks, setLowPriorityTasks] = useState<Task[]>([]);

  useEffect(() => {
    // Funzione per convertire cleaning_time (minuti) in formato ore.minuti
    const formatDuration = (minutes: number): string => {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}.${mins.toString().padStart(2, '0')}`;
    };

    // Funzione per convertire un task raw in Task
    const convertRawTask = (rawTask: RawTask, priority: string): Task => {
      return {
        id: rawTask.task_id.toString(),
        name: rawTask.logistic_code.toString(),
        type: `Client ${rawTask.client_id}`,
        duration: formatDuration(rawTask.cleaning_time),
        priority: priority as any,
        assignedTo: null,
        status: "pending",
        scheduledTime: null,
        address: rawTask.address,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    };

    // Carica i task dai file JSON
    const loadTasks = async () => {
      try {
        const [earlyOutResponse, highPriorityResponse, lowPriorityResponse] = await Promise.all([
          fetch('/data/early_out.json'),
          fetch('/data/high_priority.json'),
          fetch('/data/low_priority.json')
        ]);

        if (!earlyOutResponse.ok || !highPriorityResponse.ok || !lowPriorityResponse.ok) {
          throw new Error('Errore nel caricamento dei file JSON');
        }

        const earlyOutData = await earlyOutResponse.json();
        const highPriorityData = await highPriorityResponse.json();
        const lowPriorityData = await lowPriorityResponse.json();

        const initialEarlyOut: Task[] = earlyOutData.early_out_tasks.map((task: RawTask) => 
          convertRawTask(task, "early-out")
        );

        const initialHigh: Task[] = highPriorityData.high_priority_tasks.map((task: RawTask) => 
          convertRawTask(task, "high")
        );

        const initialLow: Task[] = lowPriorityData.low_priority_tasks.map((task: RawTask) => 
          convertRawTask(task, "low")
        );

        setEarlyOutTasks(initialEarlyOut);
        setHighPriorityTasks(initialHigh);
        setLowPriorityTasks(initialLow);
      } catch (error) {
        console.error("Errore nel caricamento dei task:", error);
      }
    };

    loadTasks();
  }, []);

  const onDragEnd = (result: DropResult) => {
    const { destination, source, draggableId } = result;

    if (!destination || destination.droppableId === source.droppableId) {
      return;
    }

    let taskToMove: Task | undefined;
    let sourceTasks: Task[] = [];
    
    
    if (source.droppableId === "early-out") {
      sourceTasks = earlyOutTasks;
    } else if (source.droppableId === "high") {
      sourceTasks = highPriorityTasks;
    } else if (source.droppableId === "low") {
      sourceTasks = lowPriorityTasks;
    }

    taskToMove = sourceTasks.find(task => task.id === draggableId);
    
    if (!taskToMove) return;

    const newSourceTasks = sourceTasks.filter(task => task.id !== draggableId);
    const updatedTask = { ...taskToMove, priority: destination.droppableId as any };

    if (destination.droppableId === "early-out") {
      setEarlyOutTasks([...earlyOutTasks, updatedTask]);
    } else if (destination.droppableId === "high") {
      setHighPriorityTasks([...highPriorityTasks, updatedTask]);
    } else if (destination.droppableId === "low") {
      setLowPriorityTasks([...lowPriorityTasks, updatedTask]);
    }

    if (source.droppableId === "early-out") {
      setEarlyOutTasks(newSourceTasks);
    } else if (source.droppableId === "high") {
      setHighPriorityTasks(newSourceTasks);
    } else if (source.droppableId === "low") {
      setLowPriorityTasks(newSourceTasks);
    }
  };

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="container mx-auto p-4 max-w-screen-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-foreground">
            Genera Assegnazioni
          </h1>
        </div>

        <DragDropContext onDragEnd={onDragEnd}>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
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
      </div>
    </div>
  );
}