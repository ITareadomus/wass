
import { DragDropContext, DropResult } from "react-beautiful-dnd";
import PriorityColumn from "@/components/drag-drop/priority-column";

export default function GenerateAssignments() {
  const onDragEnd = (result: DropResult) => {
    // Per ora vuoto
    console.log(result);
  };

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
              tasks={[]}
              droppableId="early-out"
              icon="clock"
            />
            <PriorityColumn
              title="HIGH PRIORITY"
              priority="high"
              tasks={[]}
              droppableId="high"
              icon="alert-circle"
            />
            <PriorityColumn
              title="LOW PRIORITY"
              priority="low"
              tasks={[]}
              droppableId="low"
              icon="arrow-down"
            />
          </div>
        </DragDropContext>
      </div>
    </div>
  );
}
