
import { DragDropContext, DropResult } from "react-beautiful-dnd";
import { Task } from "@shared/schema";
import PriorityColumn from "@/components/drag-drop/priority-column";

export default function GenerateAssignments() {
  const onDragEnd = (result: DropResult) => {
    // Per ora vuoto
    console.log(result);
  };

  // Task per Early Out (3 task)
  const earlyOutTasks: Task[] = [
    {
      id: "ea1",
      name: "TASK1",
      type: "PREMIUM",
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
      id: "ea2",
      name: "TASK2",
      type: "STANDARD",
      duration: "2.0",
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
      duration: "1.0",
      priority: "early-out",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  // Task per High Priority (5 task)
  const highPriorityTasks: Task[] = [
    {
      id: "hp1",
      name: "TASK4",
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
      id: "hp2",
      name: "TASK5",
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
      name: "TASK6",
      type: "PREMIUM",
      duration: "3.0",
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
      name: "TASK7",
      type: "STANDARD",
      duration: "2.0",
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
      name: "TASK8",
      type: "PREMIUM",
      duration: "1.0",
      priority: "high",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

  // Task per Low Priority (8 task)
  const lowPriorityTasks: Task[] = [
    {
      id: "lp1",
      name: "TASK9",
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
      id: "lp2",
      name: "TASK10",
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
      id: "lp3",
      name: "TASK11",
      type: "STANDARD",
      duration: "1.0",
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
      name: "TASK12",
      type: "PREMIUM",
      duration: "3.0",
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
      name: "TASK13",
      type: "STANDARD",
      duration: "2.0",
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
      name: "TASK14",
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
      id: "lp7",
      name: "TASK15",
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
      name: "TASK16",
      type: "PREMIUM",
      duration: "1.0",
      priority: "low",
      assignedTo: null,
      status: "pending",
      scheduledTime: null,
      address: "",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ];

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
