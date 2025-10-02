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

  // Task per Low Priority (40 task)
  const lowPriorityTasks: Task[] = [
    {
      id: "lp1",
      name: "TASK41",
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
      name: "TASK42",
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
      name: "TASK43",
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
      name: "TASK44",
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
      name: "TASK45",
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
      name: "TASK46",
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
      name: "TASK47",
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
      id: "lp8",
      name: "TASK48",
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
      id: "lp9",
      name: "TASK49",
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
      id: "lp10",
      name: "TASK50",
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
      id: "lp11",
      name: "TASK51",
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
      id: "lp12",
      name: "TASK52",
      type: "PREMIUM",
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
      id: "lp13",
      name: "TASK53",
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
      id: "lp14",
      name: "TASK54",
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
      id: "lp15",
      name: "TASK55",
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
      id: "lp16",
      name: "TASK56",
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
      id: "lp17",
      name: "TASK57",
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
      id: "lp18",
      name: "TASK58",
      type: "PREMIUM",
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
      id: "lp19",
      name: "TASK59",
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
      id: "lp20",
      name: "TASK60",
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
      id: "lp21",
      name: "TASK61",
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
      id: "lp22",
      name: "TASK62",
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
      id: "lp23",
      name: "TASK63",
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
      id: "lp24",
      name: "TASK64",
      type: "PREMIUM",
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
      id: "lp25",
      name: "TASK65",
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
      id: "lp26",
      name: "TASK66",
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
      id: "lp27",
      name: "TASK67",
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
      id: "lp28",
      name: "TASK68",
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
      id: "lp29",
      name: "TASK69",
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
      id: "lp30",
      name: "TASK70",
      type: "PREMIUM",
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
      id: "lp31",
      name: "TASK71",
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
      id: "lp32",
      name: "TASK72",
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
      id: "lp33",
      name: "TASK73",
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
      id: "lp34",
      name: "TASK74",
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
      id: "lp35",
      name: "TASK75",
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
      id: "lp36",
      name: "TASK76",
      type: "PREMIUM",
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
      id: "lp37",
      name: "TASK77",
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
      id: "lp38",
      name: "TASK78",
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
      id: "lp39",
      name: "TASK79",
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
      id: "lp40",
      name: "TASK80",
      type: "PREMIUM",
      duration: "3.0",
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