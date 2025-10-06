
import { Task } from "@shared/schema";
import { Calendar } from "lucide-react";

interface AssignmentsTimelineProps {
  earlyOutTasks: Task[];
  highPriorityTasks: Task[];
  lowPriorityTasks: Task[];
}

export default function AssignmentsTimeline({ 
  earlyOutTasks, 
  highPriorityTasks, 
  lowPriorityTasks 
}: AssignmentsTimelineProps) {
  const timeSlots = [
    "08:00", "08:30", "09:00", "09:30", "10:00", "10:30",
    "11:00", "11:30", "12:00", "12:30", "13:00", "13:30",
    "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
    "17:00", "17:30"
  ];

  const cleanerGroups = [
    { name: "LOPEZ ERNESTO", tasks: earlyOutTasks, bgClass: "bg-orange-100", barClass: "bg-orange-400" },
    { name: "GARCIA MARIA", tasks: highPriorityTasks, bgClass: "bg-green-100", barClass: "bg-green-500" },
    { name: "ROSSI PAOLO", tasks: lowPriorityTasks, bgClass: "bg-lime-100", barClass: "bg-lime-500" }
  ];

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

              {/* Time Slot Cells */}
              {timeSlots.map((slot, slotIndex) => {
                const hasTask = group.tasks.length > 0;
                const showTaskBar = hasTask && slotIndex <= 3;
                const task = group.tasks[0];
                
                return (
                  <div 
                    key={`${groupIndex}-${slot}`}
                    className={`timeline-cell border border-border relative ${group.bgClass}`}
                  >
                    {showTaskBar && task && (
                      <div className={`assignment-bar ${group.barClass} text-white rounded text-xs p-1 m-1`}>
                        {task.name.substring(0, 6)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
