
import { Task } from "@shared/schema";
import { Calendar } from "lucide-react";
import { Droppable } from "react-beautiful-dnd";
import TaskCard from "@/components/drag-drop/task-card";

interface AssignmentsTimelineProps {
  lopezTasks: Task[];
  garciaTasks: Task[];
  rossiTasks: Task[];
}

export default function AssignmentsTimeline({ 
  lopezTasks, 
  garciaTasks, 
  rossiTasks 
}: AssignmentsTimelineProps) {
  const timeSlots = [
    "08:00", "08:30", "09:00", "09:30", "10:00", "10:30",
    "11:00", "11:30", "12:00", "12:30", "13:00", "13:30",
    "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
    "17:00", "17:30"
  ];

  const cleanerGroups = [
    { name: "LOPEZ ERNESTO", tasks: lopezTasks, bgClass: "bg-orange-100", barClass: "bg-orange-400", droppableId: "lopez" },
    { name: "GARCIA MARIA", tasks: garciaTasks, bgClass: "bg-green-100", barClass: "bg-green-500", droppableId: "garcia" },
    { name: "ROSSI PAOLO", tasks: rossiTasks, bgClass: "bg-lime-100", barClass: "bg-lime-500", droppableId: "rossi" }
  ];

  // Calcola la larghezza in base alla durata (ogni slot = 80px, ogni slot è 30 minuti)
  const calculateTaskWidth = (duration: string) => {
    const parts = duration.split(".");
    const hours = parseInt(parts[0] || "0");
    const minutes = parts[1] ? parseInt(parts[1]) : 0;
    const totalMinutes = hours * 60 + minutes;
    const slots = totalMinutes / 30; // Ogni slot è 30 minuti
    return slots * 80; // 80px per slot
  };

  return (
    <div className="bg-card rounded-lg border shadow-sm mt-8">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground flex items-center">
          <Calendar className="w-5 h-5 mr-2 text-primary" />
          Timeline Temporale (8:00 - 18:00)
        </h3>
      </div>
      
      <div className="overflow-x-auto">
        <div 
          className="grid min-w-max"
          style={{ gridTemplateColumns: "150px repeat(20, 80px)" }}
        >
          {/* Header Row */}
          <div className="timeline-cell p-2 bg-secondary font-semibold text-sm border border-border">
            CLEANER
          </div>
          {timeSlots.map((slot, index) => (
            <div 
              key={slot}
              className="timeline-cell p-2 bg-secondary text-center text-xs font-medium border border-border"
            >
              {slot}
            </div>
          ))}

          {/* Cleaner Rows */}
          {cleanerGroups.map((group, groupIndex) => (
            <div key={groupIndex} className="contents">
              {/* Cleaner Info Cell */}
              <div className="timeline-cell p-2 bg-card flex items-center border border-border">
                <div>
                  <div className="text-sm font-medium">
                    {group.name}
                  </div>
                </div>
              </div>

              {/* Time Slot Cells - Area Droppable */}
              <div 
                className="col-span-20 border border-border relative"
                style={{ gridColumn: "2 / -1" }}
              >
                <Droppable droppableId={group.droppableId} direction="horizontal">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      className={`
                        flex gap-1 p-2 min-h-[60px] items-center
                        ${snapshot.isDraggingOver ? "bg-blue-50" : group.bgClass}
                        transition-colors duration-200
                      `}
                    >
                      {group.tasks.map((task, index) => (
                        <div 
                          key={task.id}
                          style={{ width: `${calculateTaskWidth(task.duration)}px` }}
                        >
                          <TaskCard task={task} index={index} />
                        </div>
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
