import React, { useState, useEffect } from "react";
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
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { HelpCircle, ChevronLeft, ChevronRight, Save, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useMultiSelect } from "@/pages/generate-assignments";

// Normalizza la chiave di una task indipendentemente dal campo usato
const getTaskKey = (t: any) => String(t?.id ?? t?.task_id ?? t?.logistic_code ?? "");

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
  allTasks?: Task[];
  currentContainer?: 'early-out' | 'high' | 'low' | string;
  isDuplicate?: boolean;
  isDragDisabled?: boolean;
  isReadOnly?: boolean;
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
  isDragDisabled = false,
  isReadOnly = false,
}: TaskCardProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [clickTimer, setClickTimer] = useState<NodeJS.Timeout | null>(null);
  
  // Usa il context per multi-select (solo per container, non timeline)
  const multiSelectContext = !isInTimeline ? useMultiSelect() : null;
  const isMultiSelectMode = multiSelectContext?.isMultiSelectMode ?? false;
  const isSelected = multiSelectContext?.isTaskSelected(task.id) ?? false;
  const selectionOrder = multiSelectContext?.getTaskOrder(task.id);
  
  // Gestisce il click sulla card: se multi-select toggle selezione, altrimenti apri modale
  const handleCardClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // In multi-select mode nei container: toggle selezione invece di aprire modale
    if (isMultiSelectMode && !isInTimeline && multiSelectContext) {
      multiSelectContext.toggleTask(task.id);
      return;
    }
    
    // Gestione doppio click per mostrare task sulla mappa
    if (clickTimer) {
      // Doppio click rilevato
      clearTimeout(clickTimer);
      setClickTimer(null);
      
      // Toggle filtro mappa per questa task
      const currentFilteredTaskId = (window as any).mapFilteredTaskId;
      if (currentFilteredTaskId === task.name) {
        // Rimuovi filtro
        (window as any).mapFilteredTaskId = null;
        toast({
          title: "Filtro rimosso",
          description: "Ora visualizzi tutti gli appartamenti sulla mappa",
        });
      } else {
        // Applica filtro
        (window as any).mapFilteredTaskId = task.name;
        toast({
          title: "Task evidenziata",
          description: `Visualizzi solo ${task.name} sulla mappa`,
        });
      }
    } else {
      // Primo click: avvia timer
      const timer = setTimeout(() => {
        // Singolo click: apri modale
        setIsModalOpen(true);
        setClickTimer(null);
      }, 250);
      
      setClickTimer(timer);
    }
  };

  const [currentTaskId, setCurrentTaskId] = useState(getTaskKey(task));
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

  // CRITICAL: Memoizza navigableTasks per evitare ricalcoli che causano mismatch
  const navigableTasks = React.useMemo(() => {
    const tasks = allTasks.filter(t => {
      const sameCleaner = (t as any).assignedCleaner === (task as any).assignedCleaner;
      const notCurrent  = getTaskKey(t) !== getTaskKey(task);
      // NON escludere task senza assignedCleaner: basta che sia lo stesso cleaner della corrente
      return sameCleaner && notCurrent;
    });
    // Mappa con una chiave consistente
    return tasks.map(t => ({ ...t, __key: getTaskKey(t) }));
  }, [allTasks, task]);

  // Trova l'indice effettivo della task nel cleaner
  const { effectiveCurrentId, currentTaskInNavigable, displayTask, canGoPrev, canGoNext } = (() => {
    const normalizedCurrentId = currentTaskId ? String(currentTaskId) : null;
    const normalizedTaskId    = getTaskKey(task);

    const effId = normalizedCurrentId && navigableTasks.some(t => (t as any).__key === normalizedCurrentId)
      ? normalizedCurrentId
      : normalizedTaskId;

    const currIdx = navigableTasks.findIndex(t => (t as any).__key === effId);
    const safeIdx = currIdx >= 0 ? currIdx : 0;

    return {
      effectiveCurrentId: effId,
      currentTaskInNavigable: currIdx,
      displayTask: currIdx >= 0 ? navigableTasks[currIdx] : { ...task, __key: normalizedTaskId },
      canGoPrev: navigableTasks.length > 0 && safeIdx > 0,
      canGoNext: navigableTasks.length > 0 && safeIdx < navigableTasks.length - 1
    };
  })();

  console.log('🔍 Stato navigazione:', {
    currentTaskId,
    effectiveCurrentId,
    navigableTasksCount: navigableTasks.length,
    currentIndex: currentTaskInNavigable,
    canGoPrev: canGoPrev,
    canGoNext: canGoNext
  });

  const handlePrevTask = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canGoPrev && currentTaskInNavigable > 0) {
      const prevTask = navigableTasks[currentTaskInNavigable - 1];
      setCurrentTaskId(getTaskKey(prevTask));
      console.log(`⬅️ Navigazione verso task precedente: ${prevTask.name}`);
    }
  };

  const handleNextTask = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (canGoNext && currentTaskInNavigable < navigableTasks.length - 1) {
      const nextTask = navigableTasks[currentTaskInNavigable + 1];
      setCurrentTaskId(getTaskKey(nextTask));
      console.log(`➡️ Navigazione verso task successiva: ${nextTask.name}`);
    }
  };

  // Reset currentTaskId quando il modale si apre
  useEffect(() => {
    if (isModalOpen) {
      console.log('🔓 Modale aperto per task:', {
        taskId: task.id,
        allTasksCount: allTasks?.length || 0,
        allTasksIds: allTasks?.map(t => getTaskKey(t)) || [],
        isInTimeline,
        currentContainer
      });

      setCurrentTaskId(getTaskKey(task)); // Assicura che currentTaskId sia all'inizio quando si apre il modale
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
    if (getTaskKey(displayTask) !== effectiveCurrentId) {
      console.warn('⚠️ MISMATCH: displayTask.id !== effectiveCurrentId', {
        displayTaskId: getTaskKey(displayTask),
        effectiveCurrentId: effectiveCurrentId,
        displayTaskName: (displayTask as any).logistic_code || displayTask.name,
        allTasksIds: allTasks.map(t => getTaskKey(t))
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

  const handleSaveChanges = async () => {
    try {
      setIsSaving(true);

      const response = await fetch('/api/update-task-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: getTaskKey(displayTask),
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
  const calculateWidth = (duration: string | undefined, forTimeline: boolean) => {
    const safeDuration = duration || "0.0";
    const parts = safeDuration.split(".");
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
        draggableId={getTaskKey(task)}
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
                      ${isOverdue && isInTimeline ? "animate-blink" : ""}
                      ${isDuplicate && !isInTimeline ? "animate-blink-yellow" : ""}
                      hover:shadow-md cursor-pointer
                      flex-shrink-0 relative
                    `}
                    style={{
                      ...provided.draggableProps.style,
                      width: cardWidth,
                      minHeight: "40px",
                      ...(((window as any).mapFilteredTaskId === task.name) ? {
                        boxShadow: '0 0 0 3px #3B82F6, 0 0 20px 5px rgba(59, 130, 246, 0.5)',
                        transform: 'scale(1.05)',
                        zIndex: 10,
                      } : {})
                    }}
                    data-testid={`task-card-${getTaskKey(task)}`}
                    onClick={(e) => {
                      if (!snapshot.isDragging) {
                        handleCardClick(e);
                      }
                    }}
                  >
                    {/* Checkbox overlay per multi-select (solo container) */}
                    {isMultiSelectMode && !isInTimeline && (
                      <div className="absolute top-0.5 left-0.5 z-50">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => multiSelectContext?.toggleTask(task.id)}
                          className="w-4 h-4 bg-white border-2 border-sky-600"
                          data-testid={`checkbox-task-${task.id}`}
                        />
                      </div>
                    )}
                    
                    {/* Badge ordine selezione (solo se selezionata) */}
                    {isSelected && selectionOrder && !isInTimeline && (
                      <div className="absolute top-0.5 right-0.5 z-50">
                        <div className="bg-sky-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                          {selectionOrder}
                        </div>
                      </div>
                    )}
                    
                    {!isConfirmedOperation && !isSelected && (
                      <div className="absolute top-0.5 right-0.5 z-50">
                        <HelpCircle
                          className="w-3 h-3 text-gray-900"
                          strokeWidth={2.5}
                        />
                      </div>
                    )}
                    <div
                      className="flex flex-col items-start justify-center h-full gap-0"
                    >
                      <div className="flex items-center gap-1">
                        <span
                          className="text-[13px] text-[#ff0000] font-extrabold"
                          data-testid={`task-name-${getTaskKey(task)}`}
                        >
                          {task.name}
                        </span>
                        <span className="text-[11px] opacity-60 leading-none font-bold text-[#000000]">
                          ({(task.duration || "0.0").replace(".", ":")}h)
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
                Dettagli Task #{getTaskKey(displayTask)}
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
                  {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'duration' && !isReadOnly ? (
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
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isReadOnly && setEditingField('duration')}
                  >
                    {(displayTask.duration || "0.0").replace(".", ":")} ore
                  </p>
                )}
              </div>
            </div>

            {/* Terza riga: Check-out - Check-in */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Check-out
                  {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'checkout' && !isReadOnly ? (
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
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isReadOnly && setEditingField('checkout')}
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
                  {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'checkin' && !isReadOnly ? (
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
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isReadOnly && setEditingField('checkin')}
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
                  {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'operation' && !isReadOnly ? (
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
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isReadOnly && setEditingField('operation')}
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
                  {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingField === 'paxin' && !isReadOnly ? (
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
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={() => !isReadOnly && setEditingField('paxin')}
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
            {editingField && !isReadOnly && (
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