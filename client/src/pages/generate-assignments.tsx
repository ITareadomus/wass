import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { useState, useEffect, useRef } from "react";
import PriorityColumn from "@/components/drag-drop/priority-column";
import { Task } from "@shared/schema";

export default function GenerateAssignments() {
  const [maxColumnHeight, setMaxColumnHeight] = useState<number>(0);
  const columnRefs = useRef<(HTMLDivElement | null)[]>([]);

  const onDragEnd = (result: DropResult) => {
    // Per ora vuoto
    console.log(result);
  };

  // Task per Early Out (8 task)
  const earlyOutTasks: Task[] = [
    {
      id: "ea1",
      name: "TASK1",
      type: "PREMIUM",
      duration: "1.00",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "ea2",
      name: "TASK2",
      type: "STANDARD",
      duration: "2.00",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "ea3",
      name: "TASK3",
      type: "PREMIUM",
      duration: "0.30",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "ea4",
      name: "TASK4",
      type: "STANDARD",
      duration: "1.30",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "ea5",
      name: "TASK5",
      type: "PREMIUM",
      duration: "3.00",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "ea6",
      name: "TASK6",
      type: "STANDARD",
      duration: "1.00",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "ea7",
      name: "TASK7",
      type: "PREMIUM",
      duration: "2.30",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "ea8",
      name: "TASK8",
      type: "STANDARD",
      duration: "1.00",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  // Task per High Priority (12 task)
  const highPriorityTasks: Task[] = [
    {
      id: "hp1",
      name: "TASK9",
      type: "PREMIUM",
      duration: "2.00",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp2",
      name: "TASK10",
      type: "STANDARD",
      duration: "1.30",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp3",
      name: "TASK11",
      type: "PREMIUM",
      duration: "3.00",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp4",
      name: "TASK12",
      type: "STANDARD",
      duration: "2.00",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp5",
      name: "TASK13",
      type: "PREMIUM",
      duration: "1.00",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp6",
      name: "TASK14",
      type: "STANDARD",
      duration: "0.30",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp7",
      name: "TASK15",
      type: "PREMIUM",
      duration: "2.30",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp8",
      name: "TASK16",
      type: "STANDARD",
      duration: "1.00",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp9",
      name: "TASK17",
      type: "PREMIUM",
      duration: "3.30",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp10",
      name: "TASK18",
      type: "STANDARD",
      duration: "2.00",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp11",
      name: "TASK19",
      type: "PREMIUM",
      duration: "1.30",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "hp12",
      name: "TASK20",
      type: "STANDARD",
      duration: "1.00",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  // Task per Low Priority (20 task)
  const lowPriorityTasks: Task[] = [
    {
      id: "lp1",
      name: "TASK21",
      type: "STANDARD",
      duration: "1.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp2",
      name: "TASK22",
      type: "PREMIUM",
      duration: "2.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp3",
      name: "TASK23",
      type: "STANDARD",
      duration: "0.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp4",
      name: "TASK24",
      type: "PREMIUM",
      duration: "3.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp5",
      name: "TASK25",
      type: "STANDARD",
      duration: "1.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp6",
      name: "TASK26",
      type: "PREMIUM",
      duration: "1.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp7",
      name: "TASK27",
      type: "STANDARD",
      duration: "2.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp8",
      name: "TASK28",
      type: "PREMIUM",
      duration: "1.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp9",
      name: "TASK29",
      type: "STANDARD",
      duration: "0.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp10",
      name: "TASK30",
      type: "PREMIUM",
      duration: "2.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp11",
      name: "TASK31",
      type: "STANDARD",
      duration: "1.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp12",
      name: "TASK32",
      type: "PREMIUM",
      duration: "3.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp13",
      name: "TASK33",
      type: "STANDARD",
      duration: "1.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp14",
      name: "TASK34",
      type: "PREMIUM",
      duration: "2.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp15",
      name: "TASK35",
      type: "STANDARD",
      duration: "0.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp16",
      name: "TASK36",
      type: "PREMIUM",
      duration: "1.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp17",
      name: "TASK37",
      type: "STANDARD",
      duration: "1.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp18",
      name: "TASK38",
      type: "PREMIUM",
      duration: "2.30",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp19",
      name: "TASK39",
      type: "STANDARD",
      duration: "3.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: "lp20",
      name: "TASK40",
      type: "PREMIUM",
      duration: "1.00",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  // Aggiunge lo stato per gestire le task e un effetto per aggiornare l'altezza massima
  const [allTasks, setAllTasks] = useState<Task[]>([
    ...earlyOutTasks,
    ...highPriorityTasks,
    ...lowPriorityTasks,
  ]);

  // Calcola il numero massimo di task tra tutte le colonne
  const maxTaskCount = Math.max(
    earlyOutTasks.length,
    highPriorityTasks.length,
    lowPriorityTasks.length
  );

  // Calcola l'altezza massima necessaria tra tutte le colonne
  useEffect(() => {
    const taskHeight = 48; // Altezza stimata per una card task
    const headerHeight = 60; // Altezza stimata per l'header della colonna
    const padding = 32; // Padding interno della colonna

    const calculateHeight = (tasks: Task[]) => (tasks.length * taskHeight) + headerHeight + padding;

    const earlyOutHeight = calculateHeight(earlyOutTasks);
    const highPriorityHeight = calculateHeight(highPriorityTasks);
    const lowPriorityHeight = calculateHeight(lowPriorityTasks);

    const maxHeight = Math.max(earlyOutHeight, highPriorityHeight, lowPriorityHeight, 300); // Minimo 300px per evitare colonne troppo piccole
    setMaxColumnHeight(maxHeight);
  }, [earlyOutTasks.length, highPriorityTasks.length, lowPriorityTasks.length]);


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
              syncedHeight={maxColumnHeight}
              maxTaskCount={maxTaskCount}
            />
            <PriorityColumn
              title="HIGH PRIORITY"
              priority="high"
              tasks={highPriorityTasks}
              droppableId="high"
              icon="alert-circle"
              syncedHeight={maxColumnHeight}
              maxTaskCount={maxTaskCount}
            />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={lowPriorityTasks}
              droppableId="low"
              icon="arrow-down"
              syncedHeight={maxColumnHeight}
              maxTaskCount={maxTaskCount}
            />
          </div>
        </DragDropContext>
      </div>
    </div>
  );
}