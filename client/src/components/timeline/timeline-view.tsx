import { Personnel, Task } from "@shared/schema";
import { Calendar } from "lucide-react";

interface TimelineViewProps {
  personnel: Personnel[];
  tasks: Task[];
}

export default function TimelineView({ personnel, tasks }: TimelineViewProps) {
  const timeSlots = [
    "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
    "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"
  ];

  const getPersonnelInitials = (name: string) => {
    return name.split(" ").map(n => n[0]).join("").substring(0, 2);
  };

  const getAssignmentForPersonnel = (personId: string, timeSlot: string) => {
    // This is a simplified version - in a real app you'd have proper time slot assignments
    const assignedTasks = tasks.filter(task => task.assignedTo === personId);
    if (assignedTasks.length > 0) {
      const task = assignedTasks[0];
      return {
        task,
        isActive: Math.random() > 0.7, // Simplified for demo
      };
    }
    return null;
  };

  const getTimelineBgClass = (priority: string | null) => {
    switch (priority) {
      case "early-out":
        return "bg-orange-200";
      case "high":
        return "bg-green-200";
      case "low":
        return "bg-lime-200";
      default:
        return "bg-card";
    }
  };

  const getAssignmentBarClass = (priority: string | null) => {
    switch (priority) {
      case "early-out":
        return "bg-orange-400 text-white";
      case "high":
        return "bg-green-500 text-white";
      case "low":
        return "bg-lime-500 text-white";
      default:
        return "bg-gray-400 text-white";
    }
  };

  return (
    <div className="bg-card rounded-lg border shadow-sm">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground flex items-center">
          <Calendar className="w-5 h-5 mr-2 text-primary" />
          Timeline Assegnazioni
        </h3>
      </div>
      
      <div className="overflow-x-auto">
        <div 
          className="grid min-w-max"
          style={{ gridTemplateColumns: "150px repeat(12, 80px)" }}
          data-testid="timeline-grid"
        >
          {/* Header Row */}
          <div className="timeline-cell p-2 bg-secondary font-semibold text-sm border border-border">
            PERSONA
          </div>
          {timeSlots.map((slot, index) => (
            <div 
              key={slot}
              className="timeline-cell p-2 bg-secondary text-center text-xs font-medium border border-border"
              data-testid={`time-slot-${index}`}
            >
              {slot}
            </div>
          ))}

          {/* Personnel Rows */}
          {personnel.slice(0, 8).map((person, personIndex) => (
            <div key={person.id} className="contents">
              {/* Personnel Info Cell */}
              <div className="timeline-cell p-2 bg-card flex items-center border border-border">
                <div className="flex items-center">
                  <div 
                    className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs mr-2"
                    style={{ backgroundColor: person.color }}
                    data-testid={`person-avatar-${person.id}`}
                  >
                    {getPersonnelInitials(person.name)}
                  </div>
                  <div>
                    <div className="text-sm font-medium" data-testid={`person-name-${person.id}`}>
                      {person.name}
                    </div>
                    <div className="text-xs text-muted-foreground" data-testid={`person-type-${person.id}`}>
                      {person.type}
                    </div>
                  </div>
                </div>
              </div>

              {/* Time Slot Cells */}
              {timeSlots.map((slot, slotIndex) => {
                // Simplified assignment logic for demo
                const hasAssignment = personIndex < 4 && slotIndex >= personIndex && slotIndex < personIndex + 3;
                const priority = hasAssignment ? 
                  (personIndex === 0 ? "early-out" : 
                   personIndex === 1 ? "high" : 
                   personIndex === 2 ? "low" : "early-out") : null;
                
                return (
                  <div 
                    key={`${person.id}-${slot}`}
                    className={`timeline-cell border border-border relative ${getTimelineBgClass(priority)}`}
                    data-testid={`timeline-cell-${person.id}-${slotIndex}`}
                  >
                    {hasAssignment && slotIndex === personIndex && (
                      <div className={`assignment-bar ${getAssignmentBarClass(priority)} rounded text-xs p-1 m-1`}>
                        {priority === "early-out" ? "EARLY" : 
                         priority === "high" ? "HIGH" : "LOW"}
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
