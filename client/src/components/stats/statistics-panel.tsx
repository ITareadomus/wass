import { TaskType as Task } from "@shared/schema";
import { BarChart3 } from "lucide-react";

interface StatisticsPanelProps {
  tasks: Task[];
}

export default function StatisticsPanel({ tasks }: StatisticsPanelProps) {
  const earlyOutCount = tasks.filter(task => task.priority === "early-out").length;
  const highPriorityCount = tasks.filter(task => task.priority === "high").length;
  const lowPriorityCount = tasks.filter(task => task.priority === "low").length;
  const unassignedCount = tasks.filter(task => !task.priority).length;
  
  const totalTasks = tasks.length;
  const assignedTasks = totalTasks - unassignedCount;
  const completionPercentage = totalTasks > 0 ? Math.round((assignedTasks / totalTasks) * 100) : 0;

  return (
    <div className="bg-card rounded-lg border shadow-sm">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground flex items-center">
          <BarChart3 className="w-5 h-5 mr-2 text-primary" />
          Statistiche Giornaliere
        </h3>
      </div>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-orange-600" data-testid="stats-early-out">
              {earlyOutCount}
            </div>
            <div className="text-xs text-muted-foreground">Early Out</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600" data-testid="stats-high-priority">
              {highPriorityCount}
            </div>
            <div className="text-xs text-muted-foreground">High Priority</div>
          </div>
        </div>
        
        <div className="grid grid-cols-2 gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-lime-600" data-testid="stats-low-priority">
              {lowPriorityCount}
            </div>
            <div className="text-xs text-muted-foreground">Low Priority</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-600" data-testid="stats-unassigned">
              {unassignedCount}
            </div>
            <div className="text-xs text-muted-foreground">Non Assegnati</div>
          </div>
        </div>

        <div className="pt-4 border-t border-border">
          <div className="flex justify-between items-center">
            <span className="text-sm text-muted-foreground">Completamento:</span>
            <span className="text-sm font-medium" data-testid="stats-completion">
              {completionPercentage}%
            </span>
          </div>
          <div className="w-full bg-muted rounded-full h-2 mt-2">
            <div 
              className="bg-primary h-2 rounded-full transition-all duration-300" 
              style={{ width: `${completionPercentage}%` }}
              data-testid="completion-bar"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center text-sm">
            <div className="w-3 h-3 bg-orange-400 rounded mr-2"></div>
            <span className="text-muted-foreground">Mattina:</span>
            <span className="ml-auto font-medium" data-testid="stats-morning">
              {earlyOutCount + Math.floor(highPriorityCount / 2)} task
            </span>
          </div>
          <div className="flex items-center text-sm">
            <div className="w-3 h-3 bg-green-500 rounded mr-2"></div>
            <span className="text-muted-foreground">Pomeriggio:</span>
            <span className="ml-auto font-medium" data-testid="stats-afternoon">
              {lowPriorityCount + Math.ceil(highPriorityCount / 2)} task
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
