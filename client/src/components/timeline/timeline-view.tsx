import { Personnel, Task } from "@shared/schema";
import { Calendar } from "lucide-react";
import React from "react"; // Import React

interface TimelineViewProps {
  personnel: Personnel[];
  tasks: Task[];
}

export default function TimelineView({ personnel, tasks }: TimelineViewProps) {
  const timeSlots = [
    "10:00", "10:30", "11:00", "11:30", "12:00", "12:30",
    "13:00", "13:30", "14:00", "14:30", "15:00", "15:30"
  ];

  // Helper function to get tasks for a specific time slot (assuming it's defined elsewhere or needs to be added)
  // For this example, let's assume it's a placeholder and would need proper implementation.
  const getTasksForTimeSlot = (personTasks: Task[], slot: string): Task[] => {
    // This is a placeholder function. A real implementation would need to parse the slot and check task times.
    // For now, it returns all tasks for the person, which isn't accurate for a specific time slot.
    // A more robust solution would involve matching the 'slot' string to a time range.
    return personTasks; 
  };

  const getPersonnelInitials = (name: string) => {
    return name.split(" ").map(n => n[0]).join("").substring(0, 2);
  };

  const getAssignmentForPersonnel = (personId: string, timeSlot: string) => {
    // Find tasks assigned to this person with priorities
    const assignedTasks = tasks.filter(task => 
      task.assignedTo === personId && task.priority !== null
    );

    if (assignedTasks.length > 0) {
      // For now, show the first assigned task across time slots
      // In a real system, you'd have proper time slot mapping
      const task = assignedTasks[0];
      return {
        task,
        priority: task.priority,
        name: task.name,
        duration: task.duration,
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

      <div className="max-h-[500px] overflow-hidden">
        <div className="min-w-[800px]">
          <div className="grid grid-cols-[200px_repeat(8,_1fr)] gap-1">
            {/* Header Row */}
            <div className="font-semibold p-2 bg-muted text-muted-foreground border border-border">
              Personale
            </div>
            {timeSlots.map((slot) => (
              <div
                key={slot}
                className="font-semibold p-2 bg-muted text-muted-foreground text-center border border-border text-xs"
              >
                {slot}
              </div>
            ))}

            {/* Personnel Rows - Limitato a 6 persone per evitare scroll */}
            {personnel.slice(0, 6).map((person) => {
              const personTasks = tasks.filter(task => task.assignedTo === person.name);
              return (
                <React.Fragment key={person.name}>
                  <div className="p-2 bg-card border border-border font-medium text-sm">
                    <div className="truncate">{person.name}</div>
                    <div className="text-xs text-muted-foreground">{person.type}</div>
                  </div>
                  {timeSlots.map((slot) => {
                    const slotTasks = getTasksForTimeSlot(personTasks, slot);
                    return (
                      <div key={`${person.name}-${slot}`} className="p-1 bg-card border border-border h-[50px]">
                        {slotTasks.slice(0, 2).map((task) => (
                          <div
                            key={task.id}
                            className={`assignment-bar text-xs truncate ${
                              task.priority === "early-out" ? "bg-amber-500 text-white" :
                              task.priority === "high" ? "bg-green-600 text-white" :
                              task.priority === "low" ? "bg-lime-500 text-white" :
                              "bg-gray-400 text-white"
                            }`}
                          >
                            {task.name}
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}