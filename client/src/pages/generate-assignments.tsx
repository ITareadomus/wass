
import { useState, useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import TimelineView from "@/components/timeline/timeline-view";

export default function GenerateAssignments() {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <TimelineView />
    </div>
  );
}
