import { Personnel, Task } from "@shared/schema";
import { Calendar } from "lucide-react";
import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface TimelineViewProps {
  personnel: Personnel[];
  tasks: Task[];
}

interface Cleaner {
  id: number;
  name: string;
  lastname: string;
  role: string;
  active: boolean;
  ranking: number;
  counter_hours: number;
  counter_days: number;
  available: boolean;
  contract_type: string;
  preferred_customers: number[];
  telegram_id: number | null;
  start_time: string | null;
}

export default function TimelineView({
  personnel,
  tasks,
}: TimelineViewProps) {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedCleaner, setSelectedCleaner] = useState<Cleaner | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);

  const timeSlots = [
    "08:00", "09:00", "10:00", "11:00", "12:00",
    "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00"
  ];

  useEffect(() => {
    const loadCleaners = async () => {
      try {
        const response = await fetch('/data/cleaners/selected_cleaners.json');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        console.log("Cleaners caricati:", data);
        setCleaners(data.cleaners || []);
      } catch (error) {
        console.error("Errore nel caricamento dei cleaners:", error);
      }
    };
    loadCleaners();
  }, []);

  const handleCleanerClick = (cleaner: Cleaner) => {
    setSelectedCleaner(cleaner);
    setIsModalOpen(true);
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
    <>
      <div className="bg-card rounded-lg border shadow-sm">
        <div className="p-4 border-b border-border">
          <h3 className="font-semibold text-foreground flex items-center">
            <Calendar className="w-5 h-5 mr-2 text-primary" />
            Timeline Assegnazioni - {cleaners.length} Cleaners
          </h3>
        </div>
        <div className="p-4 overflow-x-auto">
          <div
            className="grid"
            style={{ gridTemplateColumns: "200px repeat(12, 80px)" }}
          >
            {/* Header Row */}
            <div className="timeline-cell p-2 bg-secondary font-semibold text-sm border border-border">
              CLEANER
            </div>
            {timeSlots.map((slot) => (
              <div
                key={slot}
                className="timeline-cell p-2 bg-secondary text-center text-xs font-medium border border-border"
              >
                {slot}
              </div>
            ))}

            {/* Cleaner Rows */}
            {cleaners.map((cleaner) => (
              <div key={cleaner.id} className="contents">
                {/* Cleaner Info Cell */}
                <div
                  className="timeline-cell p-2 bg-card flex items-center border border-border cursor-pointer hover:bg-accent"
                  onClick={() => handleCleanerClick(cleaner)}
                >
                  <div>
                    <div className="text-sm font-medium">
                      {cleaner.name} {cleaner.lastname}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {cleaner.role}
                    </div>
                  </div>
                </div>

                {/* Time Slots */}
                {timeSlots.map((slot) => (
                  <div
                    key={`${cleaner.id}-${slot}`}
                    className="timeline-cell border border-border bg-card"
                  />
                ))}
              </div>
            ))}

            {/* Personnel Rows (Existing logic if needed, currently commented out for cleaner focus) */}
            {/*
            {personnel.slice(0, 8).map((person, personIndex) => (
              <div key={person.id} className="contents">
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

                {timeSlots.map((slot, slotIndex) => {
                  const assignment = getAssignmentForPersonnel(person.id, slot);
                  const hasAssignment = assignment !== null;
                  const priority = assignment?.priority || null;
                  const showAssignmentBar = hasAssignment && slotIndex <= 2;

                  return (
                    <div
                      key={`${person.id}-${slot}`}
                      className={`timeline-cell border border-border relative ${getTimelineBgClass(priority)}`}
                      data-testid={`timeline-cell-${person.id}-${slotIndex}`}
                    >
                      {showAssignmentBar && (
                        <div className={`assignment-bar ${getAssignmentBarClass(priority)} rounded text-xs p-1 m-1`}>
                          {assignment?.name?.substring(0, 8) ||
                           (priority === "early-out" ? "EARLY" :
                            priority === "high" ? "HIGH" : "LOW")}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            */}
          </div>
        </div>
      </div>

      {/* Cleaner Details Dialog */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Dettagli Cleaner #{selectedCleaner?.id}
            </DialogTitle>
          </DialogHeader>
          {selectedCleaner && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">id</p>
                  <p className="text-sm">{selectedCleaner.id}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">name</p>
                  <p className="text-sm">{selectedCleaner.name}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">lastname</p>
                  <p className="text-sm">{selectedCleaner.lastname}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">role</p>
                  <p className="text-sm">{selectedCleaner.role}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">active</p>
                  <p className="text-sm">{selectedCleaner.active ? 'true' : 'false'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">ranking</p>
                  <p className="text-sm">{selectedCleaner.ranking}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">counter_hours</p>
                  <p className="text-sm">{selectedCleaner.counter_hours}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">counter_days</p>
                  <p className="text-sm">{selectedCleaner.counter_days}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">available</p>
                  <p className="text-sm">{selectedCleaner.available ? 'true' : 'false'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">contract_type</p>
                  <p className="text-sm">{selectedCleaner.contract_type}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">telegram_id</p>
                  <p className="text-sm">{selectedCleaner.telegram_id ?? 'null'}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">start_time</p>
                  <p className="text-sm">{selectedCleaner.start_time ?? 'null'}</p>
                </div>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">preferred_customers</p>
                <p className="text-sm">[{selectedCleaner.preferred_customers.join(', ')}]</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}