import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";
import AssignmentsTimeline from "@/components/timeline/assignments-timeline";
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
  alias?: string;
  premium?: boolean;
  is_straordinaria?: boolean;
}

export default function GenerateAssignments() {
  const [earlyOutTasks, setEarlyOutTasks] = useState<Task[]>([]);
  const [highPriorityTasks, setHighPriorityTasks] = useState<Task[]>([]);
  const [lowPriorityTasks, setLowPriorityTasks] = useState<Task[]>([]);

  // Task assegnati per ogni cleaner
  const [lopezTasks, setLopezTasks] = useState<Task[]>([]);
  const [garciaTasks, setGarciaTasks] = useState<Task[]>([]);
  const [rossiTasks, setRossiTasks] = useState<Task[]>([]);

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
        alias: rawTask.alias,
        type: `Client ${rawTask.client_id}`,
        duration: formatDuration(rawTask.cleaning_time),
        priority: priority as any,
        assignedTo: null,
        status: "pending",
        scheduledTime: null,
        address: rawTask.address,
        premium: rawTask.premium,
        is_straordinaria: rawTask.is_straordinaria,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    };

    // Carica i task dai file JSON
    const loadTasks = async () => {
      try {
        const [earlyOutResponse, highPriorityResponse, lowPriorityResponse] = await Promise.all([
          fetch('/public/data/early_out.json'),
          fetch('/public/data/high_priority.json'),
          fetch('/public/data/low_priority.json')
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
    let setSourceTasks: React.Dispatch<React.SetStateAction<Task[]>> = () => {};

    // Determine the source list and its setter function
    if (source.droppableId === "early-out") {
      sourceTasks = earlyOutTasks;
      setSourceTasks = setEarlyOutTasks;
    } else if (source.droppableId === "high") {
      sourceTasks = highPriorityTasks;
      setSourceTasks = setHighPriorityTasks;
    } else if (source.droppableId === "low") {
      sourceTasks = lowPriorityTasks;
      setSourceTasks = setLowPriorityTasks;
    } else if (source.droppableId === "lopez") {
      sourceTasks = lopezTasks;
      setSourceTasks = setLopezTasks;
    } else if (source.droppableId === "garcia") {
      sourceTasks = garciaTasks;
      setSourceTasks = setGarciaTasks;
    } else if (source.droppableId === "rossi") {
      sourceTasks = rossiTasks;
      setSourceTasks = setRossiTasks;
    }

    taskToMove = sourceTasks.find(task => task.id === draggableId);

    if (!taskToMove) return;

    // Remove the task from the source list
    const newSourceTasks = sourceTasks.filter(task => task.id !== draggableId);

    // Add the task to the destination list
    if (destination.droppableId === "lopez") {
      setLopezTasks([...lopezTasks, taskToMove]);
    } else if (destination.droppableId === "garcia") {
      setGarciaTasks([...garciaTasks, taskToMove]);
    } else if (destination.droppableId === "rossi") {
      setRossiTasks([...rossiTasks, taskToMove]);
    } else if (destination.droppableId === "early-out") {
      setEarlyOutTasks([...earlyOutTasks, taskToMove]);
    } else if (destination.droppableId === "high") {
      setHighPriorityTasks([...highPriorityTasks, taskToMove]);
    } else if (destination.droppableId === "low") {
      setLowPriorityTasks([...lowPriorityTasks, taskToMove]);
    }

    // Update the source list state
    setSourceTasks(newSourceTasks);
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
            <div className="bg-blue-100 rounded-lg p-4">
              <PriorityColumn
                title="EARLY OUT"
                priority="early-out"
                tasks={earlyOutTasks}
                droppableId="early-out"
                icon="clock"
              />
            </div>
            <div className="bg-blue-200 rounded-lg p-4">
              <PriorityColumn
                title="HIGH PRIORITY"
                priority="high"
                tasks={highPriorityTasks}
                droppableId="high"
                icon="alert-circle"
              />
            </div>
            <div className="bg-blue-300 rounded-lg p-4">
              <PriorityColumn
                title="LOW PRIORITY"
                priority="low"
                tasks={lowPriorityTasks}
                droppableId="low"
                icon="arrow-down"
              />
            </div>
          </div>

          <AssignmentsTimeline
            lopezTasks={lopezTasks}
            garciaTasks={garciaTasks}
            rossiTasks={rossiTasks}
          />
        </DragDropContext>
      </div>
    </div>
  );
}