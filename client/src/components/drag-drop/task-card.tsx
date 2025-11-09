import { Draggable } from "react-beautiful-dnd";
import { TaskType as Task } from "@shared/schema";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { useState, useEffect } from "react";
import { HelpCircle, ChevronLeft, ChevronRight, Save, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
  allTasks?: Task[];
  currentContainer?: 'early-out' | 'high' | 'low' | string;
  isDuplicate?: boolean;
  isDragDisabled?: boolean; // Aggiunta questa prop
}

interface AssignedTask {
  task_id: number;
  logistic_code: number;
  start_time: string;
  end_time: string;
  travel_time?: number;
}

export default function TaskCard({
  task,
  index,
  isInTimeline = false,
  allTasks = [],
  currentContainer = '',
  isDuplicate = false,
  isDragDisabled = false, // Aggiunta questa prop con valore di default
}: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [currentTaskId, setCurrentTaskId] = useState(task.id);
  const [assignmentTimes, setAssignmentTimes] = useState<{ start_time?: string; end_time?: string; travel_time?: number }>({});
  const { toast } = useToast();

  // Stati per editing
  const [editingField, setEditingField] = useState<'duration' | 'checkout' | 'checkin' | 'paxin' | 'operation' | null>(null);
  const [editedCheckoutDate, setEditedCheckoutDate] = useState("");
  const [editedCheckoutTime, setEditedCheckoutTime] = useState("");
  const [editedCheckinDate, setEditedCheckinDate] = useState("");
  const [editedCheckinTime, setEditedCheckinTime] = useState("");
  const [editedDuration, setEditedDuration] = useState("");
  const [editedPaxIn, setEditedPaxIn] = useState("");
  const [editedOperationId, setEditedOperationId] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Determina le task navigabili in base al contesto
  const getNavigableTasks = (): Task[] => {
    if (isInTimeline) {
      const taskAssignedCleaner = (task as any).assignedCleaner;
      const allHaveAssigned = allTasks.every(t => (t as any).assignedCleaner != null);
      return allHaveAssigned
        ? allTasks.filter(t => (t as any).assignedCleaner === taskAssignedCleaner)
        : allTasks; // fallback, le tasks che arrivano da TimelineView sono già del cleaner corrente
    } else {
      return allTasks.filter(t => t.priority === task.priority);
    }
  };

  const navigableTasks = getNavigableTasks();

  // IMPORTANTE: Ricalcola displayTask ogni volta che currentTaskId cambia
  const { effectiveCurrentId, currentTaskInNavigable, displayTask } = (() => {
    // Se currentTaskId non è impostato o non è valido, usa l'id della task corrente
    const effId = currentTaskId && navigableTasks.some(t => String(t.id) === String(currentTaskId))
      ? currentTaskId
      : task.id;

    const currIdx = navigableTasks.findIndex(t => String(t.id) === String(effId));

    // Task corrente da visualizzare
    const dispTask = navigableTasks.find(t => String(t.id) === String(effId)) || task;

    return {
      effectiveCurrentId: effId,
      currentTaskInNavigable: currIdx,
      displayTask: dispTask
    };
  })();

  console.log('🔍 Stato navigazione:', {
    currentTaskId,
    effectiveCurrentId,
    navigableTasksCount: navigableTasks.length,
    currentIndex: currentTaskInNavigable,
    canGoPrev: navigableTasks.length > 1 && currentTaskInNavigable > 0,
    canGoNext: navigableTasks.length > 1
      && currentTaskInNavigable >= 0
      && currentTaskInNavigable < navigableTasks.length - 1
  });

  const canGoPrev = navigableTasks.length > 1 && currentTaskInNavigable > 0;
  const canGoNext = navigableTasks.length > 1
    && currentTaskInNavigable >= 0
    && currentTaskInNavigable < navigableTasks.length - 1;

  const handlePrevTask = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!canGoPrev) {
      console.warn('⚠️ PREV bloccato:', { canGoPrev, currentTaskInNavigable, navigableTasksCount: navigableTasks.length });
      return;
    }

    const prevTask = navigableTasks[currentTaskInNavigable - 1];
    if (!prevTask) {
      console.error('❌ prevTask non trovato!');
      return;
    }

    console.log('✅ Navigazione PREV:', {
      from: currentTaskId,
      to: prevTask.id,
      currentIndex: currentTaskInNavigable,
      totalTasks: navigableTasks.length
    });
    setCurrentTaskId(prevTask.id);
  };

  const handleNextTask = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!canGoNext) {
      console.warn('⚠️ NEXT bloccato:', { canGoNext, currentTaskInNavigable, navigableTasksCount: navigableTasks.length });
      return;
    }

    const nextTask = navigableTasks[currentTaskInNavigable + 1];
    if (!nextTask) {
      console.error('❌ nextTask non trovato!');
      return;
    }

    console.log('✅ Navigazione NEXT:', {
      from: currentTaskId,
      to: nextTask.id,
      currentIndex: currentTaskInNavigable,
      totalTasks: navigableTasks.length,
      nextTaskData: {
        name: (nextTask as any).logistic_code || nextTask.name,
        premium: nextTask.premium,
        straordinaria: nextTask.straordinaria
      }
    });
    setCurrentTaskId(nextTask.id);
  };

  // Reset currentTaskId quando il modale si apre
  useEffect(() => {
    if (isModalOpen) {
      console.log('🔓 Modale aperto per task:', {
        taskId: task.id,
        allTasksCount: allTasks?.length || 0,
        allTasksIds: allTasks?.map(t => t.id) || [],
        isInTimeline,
        currentContainer
      });

      setCurrentTaskId(task.id); // Assicura che currentTaskId sia all'inizio quando si apre il modale
      setEditingField(null);

      // Inizializza campi editabili con i valori attuali della task visualizzata
      setEditedCheckoutDate((displayTask as any).checkout_date || "");
      setEditedCheckoutTime((displayTask as any).checkout_time || "");
      setEditedCheckinDate((displayTask as any).checkin_date || "");
      setEditedCheckinTime((displayTask as any).checkin_time || "");

      // Converti duration da "1.30" a "90" minuti
      const duration = displayTask.duration || "0.0";
      const [hours, mins] = duration.split('.').map(Number);
      const totalMinutes = (hours || 0) * 60 + (mins || 0);
      setEditedDuration(totalMinutes.toString());

      // Inizializza pax-in
      setEditedPaxIn(String((displayTask as any).pax_in || 0));

      // Inizializza operation_id
      setEditedOperationId(String((displayTask as any).operation_id || ""));
    }
  }, [isModalOpen, task.id, displayTask, allTasks, isInTimeline, currentContainer]);

  // DEBUG: verifica se displayTask è corretto
  useEffect(() => {
    if (displayTask.id !== effectiveCurrentId) {
      console.warn('⚠️ MISMATCH: displayTask.id !== effectiveCurrentId', {
        displayTaskId: displayTask.id,
        effectiveCurrentId: effectiveCurrentId,
        displayTaskName: (displayTask as any).logistic_code || displayTask.name,
        allTasksIds: allTasks.map(t => t.id)
      });
    }
  }, [displayTask, effectiveCurrentId, allTasks]);

  // DEBUG: Log per verificare i flag della task durante navigazione
  useEffect(() => {
    if (isModalOpen) {
      console.log(`Task ${(displayTask as any).logistic_code || displayTask.name}:`, {
        premium: displayTask.premium,
        straordinaria: displayTask.straordinaria,
        currentTaskId: effectiveCurrentId
      });
    }
  }, [effectiveCurrentId, isModalOpen, displayTask]);

  // Normalizza confirmed_operation da boolean/number/string a boolean sicuro
  // USA displayTask invece di task
  const rawConfirmed = (displayTask as any).confirmed_operation;
  const isConfirmedOperation =
    typeof rawConfirmed === "boolean"
      ? rawConfirmed
      : typeof rawConfirmed === "number"
        ? rawConfirmed !== 0
        : typeof rawConfirmed === "string"
          ? ["true", "1", "yes"].includes(rawConfirmed.toLowerCase().trim())
          : false;

  // Determina il tipo della CARD dai flag dell'oggetto *task* (non quelli della navigazione nel modale)
  const cardIsPremium = Boolean(task.premium);
  const cardIsStraordinaria = Boolean(task.straordinaria);

  // Il modale invece usa displayTask (vedi più sotto)

  const getTaskTypeStyle = (isStraord: boolean, isPrem: boolean) => {
    if (isStraord) {
      return { label: "STRAORDINARIA", colorClass: "task-straordinaria" };
    }
    if (isPrem) {
      return { label: "PREMIUM", colorClass: "task-premium" };
    }
    return { label: "STANDARD", colorClass: "task-standard" };
  };

  const { label: typeLabel, colorClass: cardColorClass } =
    getTaskTypeStyle(cardIsStraordinaria, cardIsPremium);

  useEffect(() => {
    const calculateAssignmentTimes = () => {
      const taskObj = displayTask as any;
      if (taskObj.startTime || taskObj.start_time) {
        setAssignmentTimes({
          start_time: taskObj.start_time || taskObj.startTime,
          end_time: taskObj.end_time || taskObj.endTime,
          travel_time: taskObj.travel_time || taskObj.travelTime
        });
      }
    };

    if (isModalOpen) {
      calculateAssignmentTimes();
    }
  }, [isModalOpen, displayTask]);

  // Supporto navigazione con frecce da tastiera
  useEffect(() => {
    if (!isModalOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && canGoPrev) {
        handlePrevTask(new MouseEvent('click') as any);
      }
      if (e.key === "ArrowRight" && canGoNext) {
        handleNextTask(new MouseEvent('click') as any);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, canGoPrev, canGoNext, currentTaskInNavigable, navigableTasks]);


  const handleCardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsModalOpen(true);
  };

  const handleSaveChanges = async () => {
    try {
      setIsSaving(true);

      const response = await fetch('/api/update-task-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: displayTask.id,
          logisticCode: displayTask.name,
          checkoutDate: editedCheckoutDate,
          checkoutTime: editedCheckoutTime,
          checkinDate: editedCheckinDate,
          checkinTime: editedCheckinTime,
          cleaningTime: parseInt(editedDuration),
          paxIn: parseInt(editedPaxIn),
          operationId: parseInt(editedOperationId) || null,
        }),
      });

      const result = await response.json();

      if (result.success) {
        toast({
          title: "Modifiche salvate!",
          description: "I dettagli della task sono stati aggiornati con successo.",
        });

        setEditingField(null);
        setIsModalOpen(false);

        // Ricarica i task per mostrare le modifiche
        if ((window as any).reloadAllTasks) {
          await (window as any).reloadAllTasks();
        }
      } else {
        throw new Error(result.error || 'Errore nel salvataggio');
      }
    } catch (error: any) {
      console.error("Errore nel salvataggio:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare le modifiche",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Calcola la larghezza in base alla durata
  const calculateWidth = (duration: string, forTimeline: boolean) => {
    const parts = duration.split(".");
    const hours = parseInt(parts[0] || "0");
    const minutes = parts[1] ? parseInt(parts[1]) : 0;
    const totalMinutes = hours * 60 + minutes;

    // Se 0 minuti, usa almeno 30 minuti
    const effectiveMinutes = totalMinutes === 0 ? 30 : totalMinutes;

    if (forTimeline) {
      // La timeline copre 10 ore (dalle 10:00 alle 19:00 = 600 minuti)
      // Ogni ora occupa il 10% della larghezza totale
      const widthPercentage = (effectiveMinutes / 600) * 100;
      return `${widthPercentage}%`;
    } else {
      // Per le colonne di priorità:
      // Se la task è < 60 minuti, usa sempre 60 minuti (larghezza di 1 ora)
      const displayMinutes = effectiveMinutes < 60 ? 60 : effectiveMinutes;
      const halfHours = Math.ceil(displayMinutes / 30);
      const baseWidth = halfHours * 50;
      return `${baseWidth}px`;
    }
  };

  // Verifica se end_time sfora checkin_time (considerando le date!)
  const isOverdue = (() => {
    const taskObj = displayTask as any;
    const endTime = assignmentTimes.end_time || taskObj.end_time || taskObj.endTime;
    const checkinTime = taskObj.checkin_time;
    const checkoutDate = taskObj.checkout_date;
    const checkinDate = taskObj.checkin_date;

    if (!endTime || !checkinTime || !isInTimeline) return false;

    // Se non abbiamo le date, non possiamo determinare con certezza
    if (!checkoutDate || !checkinDate) return false;

    // Converti date in oggetti Date per confronto corretto
    const checkoutDateTime = new Date(checkoutDate + 'T' + endTime + ':00');
    const checkinDateTime = new Date(checkinDate + 'T' + checkinTime + ':00');

    // Overdue solo se end_time è DOPO checkin_time (considerando data + ora)
    return checkoutDateTime > checkinDateTime;
  })();

  // Determina se il drag è disabilitato in base alla data e se la task è già salvata
  const shouldDisableDrag = isDragDisabled || (displayTask as any).checkin_date;

  return (
    <>
      <Draggable
        draggableId={task.id}
        index={index}
        isDragDisabled={shouldDisableDrag} // Usa la prop per disabilitare il drag
      >
        {(provided, snapshot) => {
          const cardWidth = calculateWidth(task.duration, isInTimeline);

          return (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    ref={provided.innerRef}
                    {...provided.draggableProps}
                    {...provided.dragHandleProps}
                    className={`
                      ${cardColorClass}
                      rounded-sm px-2 py-1 shadow-sm border transition-all duration-200
                      ${snapshot.isDragging ? "shadow-lg scale-105" : ""}
                      ${isOverdue ? "animate-blink" : ""}
                      ${isDuplicate && !isInTimeline ? "animate-blink-yellow" : ""}
                      hover:shadow-md cursor-pointer
                      flex-shrink-0 relative
                    `}
                    style={{
                      ...provided.draggableProps.style,
                      width: cardWidth,
                      minHeight: "40px",
                    }}
                    data-testid={`task-card-${task.id}`}
                    onClick={(e) => {
                      if (!snapshot.isDragging) {
                        handleCardClick(e);
                      }
                    }}
                  >
                    {!isConfirmedOperation && (
                      <div className="absolute top-0.5 right-0.5 z-50">
                        <HelpCircle
                          className="w-3 h-3 text-gray-900"
                          strokeWidth={2.5}
                        />
                      </div>
                    )}
                    <div
                      className="flex flex-col items-center justify-center h-full gap-0"
                    >
                      <div className="flex items-center gap-1">
                        <span
                          className="text-[13px] text-[#ff0000] font-extrabold"
                          data-testid={`task-name-${task.id}`}
                        >
                          {task.name}
                        </span>
                        <span className="text-[11px] opacity-60 leading-none font-bold text-[#000000]">
                          ({task.duration.replace(".", ":")}h)
                        </span>
                      </div>
                      {task.alias && (
                        <span className="text-[11px] opacity-70 leading-none mt-0.5 text-[#000000] font-bold">
                          {task.alias}{(task as any).type_apt ? ` (${(task as any).type_apt})` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-base px-3 py-2">
                  <p className="font-semibold">{displayTask.address?.toLowerCase() || "indirizzo non disponibile"}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
          }}
      </Draggable>
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto [&>button]:hidden">
          <DialogHeader>
            <div className="flex items-center justify-between w-full">
              <Button
                variant="ghost"
                size="icon"
                onClick={handlePrevTask}
                disabled={!canGoPrev}
                className={cn(
                  "h-8 w-8",
                  !canGoPrev && "opacity-30 cursor-not-allowed"
                )}
                type="button"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>

              <DialogTitle className="flex items-center gap-2 flex-1 justify-center">
                Dettagli Task #{(displayTask as any).task_id ?? displayTask.id}
                <Badge
                  variant="outline"
                  className={cn(
                    "text-xs shrink-0",
                    Boolean(displayTask.straordinaria)
                      ? "bg-red-500 text-white border-red-700"
                      : Boolean(displayTask.premium)
                        ? "bg-yellow-400 text-black border-yellow-600"
                        : "bg-green-500 text-white border-green-700"
                  )}
                >
                  {getTaskTypeStyle(Boolean(displayTask.straordinaria), Boolean(displayTask.premium)).label}
                </Badge>
                {(displayTask as any).priority && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-xs shrink-0",
                      (displayTask as any).priority === "early_out"
                        ? "bg-blue-500 text-white border-blue-700"
                        : (displayTask as any).priority === "high_priority"
                          ? "bg-orange-500 text-white border-orange-700"
                          : "bg-gray-500 text-white border-gray-700"
                    )}
                  >
                    {(displayTask as any).priority === "early_out"
                      ? "EO"
                      : (displayTask as any).priority === "high_priority"
                        ? "HP"
                        : "LP"}
                  </Badge>
                )}
              </DialogTitle>

              <Button
                variant="ghost"
                size="icon"
                onClick={handleNextTask}
                disabled={!canGoNext}
                className={cn(
                  "h-8 w-8",
                  !canGoNext && "opacity-30 cursor-not-allowed"
                )}
                type="button"
              >
                <ChevronRight className="h-5 w-5" />
              </Button>
            </div>
          </DialogHeader>
          <div className="space-y-4">
            {/* Prima riga: Codice ADAM - Cliente */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Codice ADAM
                </p>
                <p className="text-sm">{displayTask.name}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Cliente
                </p>
                <p className="text-sm">{displayTask.customer_name || "non migrato"}</p>
              </div>
            </div>

            {/* Seconda riga: Indirizzo - Durata pulizie */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Indirizzo
                </p>
                <p className="text-sm">{displayTask.address?.toLowerCase() || "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Durata pulizia
                  {!isDragDisabled && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'duration' && !isDragDisabled ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={editedDuration}
                      onChange={(e) => {
                        const value = e.target.value.replace(/\D/g, '');
                        setEditedDuration(value);
                      }}
                      className="text-sm w-20 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      min="0"
                      autoFocus
                    />
                    <span className="text-sm text-muted-foreground">minuti</span>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isDragDisabled ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isDragDisabled && setEditingField('duration')}
                  >
                    {displayTask.duration.replace(".", ":")} ore
                  </p>
                )}
              </div>
            </div>

            {/* Terza riga: Check-out - Check-in */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Check-out
                  {!isDragDisabled && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'checkout' && !isDragDisabled ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <Input
                        id="checkout-date-input"
                        type="date"
                        value={editedCheckoutDate}
                        onChange={(e) => setEditedCheckoutDate(e.target.value)}
                        onFocus={(e) => e.target.showPicker?.()}
                        className="text-sm cursor-text"
                        autoFocus
                      />
                    </div>
                    <div className="relative">
                      <Input
                        id="checkout-time-input"
                        type="time"
                        value={editedCheckoutTime}
                        onChange={(e) => setEditedCheckoutTime(e.target.value)}
                        onFocus={(e) => e.target.showPicker?.()}
                        className="text-sm cursor-text"
                      />
                    </div>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isDragDisabled ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isDragDisabled && setEditingField('checkout')}
                  >
                    {(displayTask as any).checkout_date
                      ? new Date((displayTask as any).checkout_date).toLocaleDateString(
                          "it-IT",
                          { day: "2-digit", month: "2-digit", year: "numeric" },
                        )
                      : "non migrato"}
                    {(displayTask as any).checkout_date
                      ? ((displayTask as any).checkout_time
                          ? ` - ${(displayTask as any).checkout_time}`
                          : " - orario non migrato")
                      : ""}
                  </p>
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Check-in
                  {!isDragDisabled && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'checkin' && !isDragDisabled ? (
                  <div className="space-y-2">
                    <div className="relative">
                      <Input
                        id="checkin-date-input"
                        type="date"
                        value={editedCheckinDate}
                        onChange={(e) => setEditedCheckinDate(e.target.value)}
                        onFocus={(e) => e.target.showPicker?.()}
                        className="text-sm cursor-text"
                        autoFocus
                      />
                    </div>
                    <div className="relative">
                      <Input
                        id="checkin-time-input"
                        type="time"
                        value={editedCheckinTime}
                        onChange={(e) => setEditedCheckinTime(e.target.value)}
                        onFocus={(e) => e.target.showPicker?.()}
                        className="text-sm cursor-text"
                      />
                    </div>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isDragDisabled ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isDragDisabled && setEditingField('checkin')}
                  >
                    {(displayTask as any).checkin_date
                      ? new Date((displayTask as any).checkin_date).toLocaleDateString(
                          "it-IT",
                          { day: "2-digit", month: "2-digit", year: "numeric" },
                        )
                      : "non migrato"}
                    {(displayTask as any).checkin_date
                      ? ((displayTask as any).checkin_time
                          ? ` - ${(displayTask as any).checkin_time}`
                          : " - orario non migrato")
                      : ""}
                  </p>
                )}
              </div>
            </div>

            {/* Quarta riga: Tipologia appartamento - Tipologia intervento */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Tipologia appartamento
                </p>
                <p className="text-sm">{(displayTask as any).type_apt ?? "non migrato"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Tipologia intervento
                  {!isDragDisabled && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'operation' && !isDragDisabled ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={editedOperationId}
                      onChange={(e) => {
                        const value = e.target.value.replace(/\D/g, '');
                        setEditedOperationId(value);
                      }}
                      className="text-sm w-20 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      min="0"
                      autoFocus
                    />
                    <span className="text-sm text-muted-foreground">ID operazione</span>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isDragDisabled ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isDragDisabled && setEditingField('operation')}
                  >
                    {!isConfirmedOperation ? "non migrato" : (displayTask as any).operation_id ?? "-"}
                  </p>
                )}
              </div>
            </div>

            {/* Quinta riga: Pax-In - Pax-Out */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Pax-In
                  {!isDragDisabled && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'paxin' && !isDragDisabled ? (
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={editedPaxIn}
                      onChange={(e) => {
                        const value = e.target.value.replace(/\D/g, '');
                        setEditedPaxIn(value);
                      }}
                      className="text-sm w-20 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      min="0"
                      autoFocus
                    />
                    <span className="text-sm text-muted-foreground">persone</span>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isDragDisabled ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isDragDisabled && setEditingField('paxin')}
                  >
                    {(displayTask as any).pax_in ?? "non migrato"}
                  </p>
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Pax-Out
                </p>
                <p className="text-sm">{(displayTask as any).pax_out ?? "non migrato"}</p>
              </div>
            </div>

            {/* Sesta riga: Travel Time - Start Time/End Time */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground">
                  Travel Time
                </p>
                <p className="text-sm">
                  {assignmentTimes.travel_time !== undefined
                    ? `${assignmentTimes.travel_time} minuti`
                    : "non assegnato"}
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">
                    Start Time
                  </p>
                  <p className="text-sm">{assignmentTimes.start_time ?? "non assegnato"}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">
                    End Time
                  </p>
                  <p className="text-sm">{assignmentTimes.end_time ?? "non assegnato"}</p>
                </div>
              </div>
            </div>

            {/* Pulsante Salva Modifiche */}
            {editingField && !isDragDisabled && (
              <div className="pt-4 border-t mt-4 flex gap-2">
                <Button
                  onClick={handleSaveChanges}
                  disabled={isSaving}
                  className="flex-1"
                >
                  <Save className="w-4 h-4 mr-2" />
                  {isSaving ? "Salvataggio..." : "Salva Modifiche"}
                </Button>
                <Button
                  onClick={() => {
                    setEditingField(null);
                    // Ripristina i valori originali
                    setEditedCheckoutDate((displayTask as any).checkout_date || "");
                    setEditedCheckoutTime((displayTask as any).checkout_time || "");
                    setEditedCheckinDate((displayTask as any).checkin_date || "");
                    setEditedCheckinTime((displayTask as any).checkin_time || "");
                    const duration = displayTask.duration || "0.0";
                    const [hours, mins] = duration.split('.').map(Number);
                    const totalMinutes = (hours || 0) * 60 + (mins || 0);
                    setEditedDuration(totalMinutes.toString());
                    setEditedPaxIn(String((displayTask as any).pax_in || 0));
                    setEditedOperationId(String((displayTask as any).operation_id || ""));
                  }}
                  variant="outline"
                >
                  Annulla
                </Button>
              </div>
            )}

          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}