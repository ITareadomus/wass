import React, { useState, useEffect } from "react";
import { Draggable } from "react-beautiful-dnd";
import { useQuery } from "@tanstack/react-query";
import { TaskType as Task } from "@shared/schema";
import { fetchWithOperation } from '@/lib/operationManager';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { HelpCircle, ChevronLeft, ChevronRight, Save, Pencil, Calendar, Lock, LockOpen, Users, UserPlus, Trash2 } from "lucide-react";
import { CleanerSelectorDialog } from "@/components/dialogs/cleaner-selector-dialog";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// Normalizza la chiave di una task indipendentemente dal campo usato
const getTaskKey = (t: any) => String(t?.id ?? t?.task_id ?? t?.logistic_code ?? "");

// Genera chiave univoca per DnD includendo cleanerId (per task collaborative)
const getUniqueDraggableId = (t: any, cleanerId?: number | null) => {
  const taskKey = getTaskKey(t);
  return cleanerId != null ? `${taskKey}-cleaner-${cleanerId}` : taskKey;
};

// Legge le pending edits da sessionStorage
const getPendingEdits = (): Record<string, any> => {
  try {
    return JSON.parse(sessionStorage.getItem('pending_task_edits') || '{}');
  } catch {
    return {};
  }
};

// Applica le pending edits a una task per la visualizzazione
const applyPendingEdits = (task: any): any => {
  const taskKey = getTaskKey(task);
  const pendingEdits = getPendingEdits();
  const edits = pendingEdits[taskKey];
  
  if (!edits) return task;
  
  // CRITICAL: Per operation_id, usa il flag operationIdModified per sapere se è stato modificato
  // Se operationIdModified è true, usa il valore (anche se null)
  // Se operationIdModified è false/undefined, usa il valore originale
  const operationIdToUse = edits.operationIdModified 
    ? edits.operationId 
    : task.operation_id;
  
  // Crea una copia della task con le modifiche applicate
  return {
    ...task,
    checkout_date: edits.checkoutDate !== undefined ? edits.checkoutDate : task.checkout_date,
    checkout_time: edits.checkoutTime !== undefined ? edits.checkoutTime : task.checkout_time,
    checkin_date: edits.checkinDate !== undefined ? edits.checkinDate : task.checkin_date,
    checkin_time: edits.checkinTime !== undefined ? edits.checkinTime : task.checkin_time,
    pax_in: edits.paxIn !== undefined ? edits.paxIn : task.pax_in,
    operation_id: operationIdToUse,
    // Converti cleaningTime in duration formato "H.MM"
    duration: edits.cleaningTime !== undefined 
      ? `${Math.floor(edits.cleaningTime / 60)}.${String(edits.cleaningTime % 60).padStart(2, '0')}`
      : task.duration,
    _hasPendingEdits: true, // Flag per indicare che ha modifiche pendenti
  };
};

// Normalizza data nel formato YYYY-MM-DD per il picker HTML5
const normalizeDate = (dateStr: any): string => {
  if (!dateStr) return "";
  try {
    // Se è già nel formato YYYY-MM-DD, ritorna così
    if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return dateStr;
    }
    // Prova a convertire da vari formati
    const parsed = new Date(dateStr);
    if (!isNaN(parsed.getTime())) {
      const year = parsed.getFullYear();
      const month = String(parsed.getMonth() + 1).padStart(2, '0');
      const day = String(parsed.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  } catch (e) {
    // Silenziosamente fallisce
  }
  return "";
};

// Normalizza ora nel formato HH:MM per il picker HTML5
const normalizeTime = (timeStr: any): string => {
  if (!timeStr) return "";
  try {
    // Se è già nel formato HH:MM, ritorna così
    if (typeof timeStr === 'string' && /^\d{2}:\d{2}$/.test(timeStr)) {
      return timeStr;
    }
    // Se è HH:MM:SS, rimuovi i secondi
    if (typeof timeStr === 'string' && /^\d{2}:\d{2}:\d{2}$/.test(timeStr)) {
      return timeStr.substring(0, 5);
    }
  } catch (e) {
    // Silenziosamente fallisce
  }
  return "";
};

interface MultiSelectContextType {
  isMultiSelectMode: boolean;
  selectedTasks: Array<{ taskId: string; order: number; container?: string }>;
  toggleMode: () => void;
  toggleTask: (taskId: string, container?: string) => void;
  clearSelection: () => void;
  isTaskSelected: (taskId: string) => boolean;
  getTaskOrder: (taskId: string) => number | undefined;
}

interface TaskCardProps {
  task: Task;
  index: number;
  isInTimeline?: boolean;
  allTasks?: Task[];
  currentContainer?: 'early-out' | 'high' | 'low' | string;
  isDuplicate?: boolean;
  isDragDisabled?: boolean;
  isReadOnly?: boolean;
  multiSelectContext?: MultiSelectContextType | null;
  isIncompatible?: boolean;
  timeOffset?: number;
  globalTimeSlots?: number;
  travelTime?: number;
  travelWidthPx?: number;
  waitingGap?: number;
  waitingGapWidthPx?: number;
  isHighlighted?: boolean;
  cleanerId?: number | null;
  isPriorityWindowViolation?: boolean;
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
  multiSelectContext = null,
  isIncompatible = false,
  timeOffset = 0,
  globalTimeSlots = 0,
  travelTime = 0,
  travelWidthPx = 0,
  waitingGap = 0,
  waitingGapWidthPx = 0,
  isHighlighted = false,
  cleanerId = null,
  isPriorityWindowViolation = false,
}: TaskCardProps) {
  console.log('🔧 TaskCard render - isReadOnly:', isReadOnly, 'for task:', task.name);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [showDissolveDialog, setShowDissolveDialog] = useState(false);
  const [isDissolvingCollaboration, setIsDissolvingCollaboration] = useState(false);
  
  const [clickTimer, setClickTimer] = useState<NodeJS.Timeout | null>(null);

  // Carica le operazioni da operations.json
  const { data: operationsData } = useQuery<{ active_operations: { id: number; name: string }[] }>({
    queryKey: ["/data/input/operations.json"],
    queryFn: async () => {
      const response = await fetch("/data/input/operations.json");
      if (!response.ok) throw new Error("Failed to fetch operations");
      return response.json();
    },
    staleTime: 60000,
  });
  
  const operationNames: Record<number, string> = operationsData?.active_operations?.reduce(
    (acc, op) => ({ ...acc, [op.id]: op.name }),
    {} as Record<number, string>
  ) || { 1: "FERMATA", 2: "PARTENZA", 3: "PULIZIA STRAORDINARIA", 4: "RIPASSO" };

  const [isMapFiltered, setIsMapFiltered] = useState(false);
  
  // Estrai locked e locked_reason dal task per dependency stabili
  const taskLocked = (task as any).locked ?? false;
  const taskLockedReason = (task as any).locked_reason ?? '';
  
  // Stato per blocco task
  const [isLocked, setIsLocked] = useState(taskLocked);
  const [lockedReason, setLockedReason] = useState(taskLockedReason);
  const [isEditingReason, setIsEditingReason] = useState(false);

  // Sincronizza isLocked quando il task cambia (es. dopo ricaricamento containers)
  useEffect(() => {
    setIsLocked(taskLocked);
    setLockedReason(taskLockedReason);
  }, [taskLocked, taskLockedReason, task.id]);

  // Usa il context multi-select dalla prop (solo per container, non timeline)
  const isMultiSelectMode = multiSelectContext?.isMultiSelectMode ?? false;
  const isSelected = multiSelectContext?.isTaskSelected(String(task.id)) ?? false; // Pass String ID
  const selectionOrder = multiSelectContext?.getTaskOrder(String(task.id)); // Pass String ID

  // Sincronizza con il filtro mappa per evidenziazione
  useEffect(() => {
    const checkMapFilter = setInterval(() => {
      const currentFilteredTaskId = (window as any).mapFilteredTaskId;
      // Per task collaborativi, controlla sia ID composto che task.name semplice
      const collaboratorIds = (task as any).collaborator_ids as number[] | null;
      const isCollaborativeTask = collaboratorIds && Array.isArray(collaboratorIds) && collaboratorIds.length > 1;
      const assignedCleaner = (task as any).assignedCleaner as number | null;
      const markerId = isCollaborativeTask && assignedCleaner 
        ? `${task.name}:${assignedCleaner}` 
        : task.name;
      
      const shouldBeFiltered = currentFilteredTaskId === markerId;
      if (shouldBeFiltered !== isMapFiltered) {
        setIsMapFiltered(shouldBeFiltered);
      }
    }, 100);

    return () => clearInterval(checkMapFilter);
  }, [task.name, isMapFiltered, task]);

  // Gestisce il click sulla card: se multi-select toggle selezione, altrimenti apri modale
  const handleCardClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    // In multi-select mode nei container: toggle selezione invece di aprire modale
    if (isMultiSelectMode && !isInTimeline && multiSelectContext) {
      multiSelectContext.toggleTask(String(task.id), currentContainer);
      return;
    }

    // Gestione doppio click per mostrare task sulla mappa
    if (clickTimer) {
      // Doppio click rilevato
      clearTimeout(clickTimer);
      setClickTimer(null);

      // Toggle filtro mappa per questa task (attiva/disattiva animazione)
      // Per task collaborativi usa ID composto "taskName:cleanerId" per identificare il marker specifico
      const collaboratorIds = (task as any).collaborator_ids as number[] | null;
      const isCollaborativeTask = collaboratorIds && Array.isArray(collaboratorIds) && collaboratorIds.length > 1;
      const assignedCleaner = (task as any).assignedCleaner as number | null;
      const markerId = isCollaborativeTask && assignedCleaner 
        ? `${task.name}:${assignedCleaner}` 
        : task.name;
      
      const currentFilteredTaskId = (window as any).mapFilteredTaskId;
      if (currentFilteredTaskId === markerId) {
        // Spegni animazione
        (window as any).mapFilteredTaskId = null;
      } else {
        // Accendi animazione
        (window as any).mapFilteredTaskId = markerId;
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

  // Handler per toggle blocco task
  const handleToggleLock = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newLocked = !isLocked;
    const newReason = newLocked ? lockedReason : '';
    
    // Ottieni la data selezionata da localStorage
    const selectedWorkDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
    
    // Usa task_id se disponibile, altrimenti task.id
    const taskId = (task as any).task_id || task.id;
    
    try {
      const response = await fetch('/api/lock-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: taskId,
          logistic_code: task.name,
          locked: newLocked,
          locked_reason: newReason,
          date: selectedWorkDate,
        }),
      });
      
      if (response.ok) {
        setIsLocked(newLocked);
        if (!newLocked) {
          setLockedReason('');
          setIsEditingReason(false);
        }
        toast({
          title: newLocked ? "Task bloccata" : "Task sbloccata",
          description: newLocked ? "La task non può essere assegnata o trascinata" : "La task è ora disponibile",
        });
        // Ricarica i container per aggiornare lo stato del pulsante Assegna
        if ((window as any).reloadAllTasks) {
          await (window as any).reloadAllTasks();
        }
      }
    } catch (error) {
      console.error('Errore nel blocco task:', error);
      toast({
        title: "Errore",
        description: "Impossibile modificare lo stato del blocco",
        variant: "destructive",
      });
    }
  };

  const handleSaveLockedReason = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    // Ottieni la data selezionata da localStorage
    const selectedWorkDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
    
    // Usa task_id se disponibile, altrimenti task.id
    const taskId = (task as any).task_id || task.id;
    
    try {
      const response = await fetch('/api/lock-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: taskId,
          logistic_code: task.name,
          locked: isLocked,
          locked_reason: lockedReason,
          date: selectedWorkDate,
        }),
      });
      
      if (response.ok) {
        setIsEditingReason(false);
        toast({
          title: "Motivo salvato",
          description: "Il motivo del blocco è stato aggiornato",
        });
      }
    } catch (error) {
      console.error('Errore nel salvataggio motivo:', error);
    }
  };

  // Handler per aggiungere collaboratori a task esistente in timeline
  const handleCollaboratorSelection = async (selectedCleanerIds: number[]) => {
    if (selectedCleanerIds.length === 0) return;
    
    const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
    const taskId = (task as any).task_id || task.id;
    
    setIsCollaboratorLoading(true);
    
    try {
      // Aggiungi collaboratori a task esistente in timeline
      for (const cleanerId of selectedCleanerIds) {
        const response = await fetch(`/api/tasks/${taskId}/collaborators/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date: workDate,
            cleanerId: cleanerId,
          }),
        });
        
        const data = await response.json();
        
        if (response.status === 409) {
          toast({
            title: "Collisione oraria",
            description: data.message || "Il collaboratore ha già task che si sovrappongono",
            variant: "destructive",
          });
          continue;
        }
        
        if (!response.ok) {
          throw new Error(data.error || "Errore nell'aggiunta collaboratore");
        }
      }
      
      toast({
        title: "Collaboratori aggiunti",
        description: `${selectedCleanerIds.length} cleaner(s) aggiunti alla task`,
      });
      
      // Chiudi dialog e modale
      setIsCleanerSelectorOpen(false);
      setIsModalOpen(false);
      
      // IMPORTANTE: Prima ricarica i selected_cleaners (per includere auto-convocati)
      if ((window as any).loadSelectedCleaners) {
        await (window as any).loadSelectedCleaners();
      }
      
      // Poi ricarica timeline e containers
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
      
    } catch (error: any) {
      console.error('Errore nella gestione collaboratori:', error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile completare l'operazione",
        variant: "destructive",
      });
    } finally {
      setIsCollaboratorLoading(false);
    }
  };

  // Apri il dialog per aggiungere collaboratori (solo timeline)
  const openAddCollaboratorDialog = () => {
    setIsCleanerSelectorOpen(true);
  };

  // Stati per editing - ora un set di campi invece di uno solo
  const [editingFields, setEditingFields] = useState<Set<'duration' | 'checkout' | 'checkin' | 'paxin' | 'operation'>>(new Set());
  const [editedCheckoutDate, setEditedCheckoutDate] = useState("");
  const [editedCheckoutTime, setEditedCheckoutTime] = useState("");
  const [editedCheckinDate, setEditedCheckinDate] = useState("");
  const [editedCheckinTime, setEditedCheckinTime] = useState("");
  const [editedDuration, setEditedDuration] = useState("");
  const [editedPaxIn, setEditedPaxIn] = useState("");
  const [editedOperationId, setEditedOperationId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  
  // Stato per il dialog di selezione collaboratori
  const [isCleanerSelectorOpen, setIsCleanerSelectorOpen] = useState(false);
  const [isCollaboratorLoading, setIsCollaboratorLoading] = useState(false);
  
  // Stato per forzare re-render quando pending edits cambiano
  const [pendingEditsVersion, setPendingEditsVersion] = useState(0);

  // Stato per i collaboratori caricati
  const [taskCollaborators, setTaskCollaborators] = useState<any[]>([]);
  const [isLoadingCollabs, setIsLoadingCollabs] = useState(false);

  // Carica i dettagli della collaborazione quando il modale si apre
  useEffect(() => {
    if (isModalOpen) {
      const fetchCollaborators = async () => {
        setIsLoadingCollabs(true);
        try {
          const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
          const taskId = (task as any).task_id || task.id;
          const response = await fetch(`/api/tasks/${taskId}/collaborators?date=${workDate}`);
          const data = await response.json();
          if (data.success) {
            setTaskCollaborators(data.collaborators || []);
          }
        } catch (error) {
          console.error("Errore caricamento collaboratori:", error);
        } finally {
          setIsLoadingCollabs(false);
        }
      };
      fetchCollaborators();
    }
  }, [isModalOpen, task.id]);

  // CRITICAL: Applica le pending edits alla task per la visualizzazione nella card
  const taskWithPendingEdits = React.useMemo(() => applyPendingEdits(task), [task, pendingEditsVersion]);

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
      // NON escludere task senza assignedCleaner: basta che sia lo stesso cleaner della corrente
      return sameCleaner;
    });
    // Mappa con una chiave consistente
    return tasks.map(t => ({ ...t, __key: getTaskKey(t) }));
  }, [allTasks, task]);

  // Trova l'indice effettivo della task nel cleaner
  const { currentIndex, effectiveCurrentId, currentTaskInNavigable, displayTask, canGoPrev, canGoNext } = React.useMemo(() => {
    const normalizedCurrentId = currentTaskId ? String(currentTaskId) : null;
    const normalizedTaskId    = getTaskKey(task);

    // CRITICAL: Cerca l'indice della task corrente (quella cliccata)
    let currIdx = navigableTasks.findIndex(t => (t as any).__key === (normalizedCurrentId || normalizedTaskId));

    // Se non trovato, usa l'indice della task originale
    if (currIdx === -1) {
      currIdx = navigableTasks.findIndex(t => (t as any).__key === normalizedTaskId);
    }

    // Se ancora non trovato, usa 0 come fallback
    const safeIdx = currIdx >= 0 ? currIdx : 0;
    const effId = currIdx >= 0 ? (navigableTasks[currIdx] as any).__key : normalizedTaskId;
    const curr = navigableTasks[safeIdx];
    // CRITICAL: Applica le pending edits per la visualizzazione immediata
    const disp = applyPendingEdits(curr || task);

    const prev = safeIdx > 0;
    const next = safeIdx < navigableTasks.length - 1;

    return {
      currentIndex: safeIdx,
      effectiveCurrentId: effId,
      currentTaskInNavigable: curr,
      displayTask: disp,
      canGoPrev: prev,
      canGoNext: next
    };
  }, [navigableTasks, currentTaskId, task, pendingEditsVersion]);

  console.log('🔍 Stato navigazione:', {
    currentTaskId,
    effectiveCurrentId,
    navigableTasksCount: navigableTasks.length,
    currentIndex: currentIndex,
    canGoPrev: canGoPrev,
    canGoNext: canGoNext
  });

  const handlePrevTask = () => {
    if (canGoPrev && currentIndex > 0) {
      const prevTask = navigableTasks[currentIndex - 1];
      setCurrentTaskId((prevTask as any).__key);
    }
  };

  const handleNextTask = () => {
    if (canGoNext && currentIndex < navigableTasks.length - 1) {
      const nextTask = navigableTasks[currentIndex + 1];
      setCurrentTaskId((nextTask as any).__key);
    }
  };

  // Reset editingFields quando il modal si chiude o quando diventa readonly
  useEffect(() => {
    if (!isModalOpen || isReadOnly) {
      setEditingFields(new Set());
    }
  }, [isModalOpen, isReadOnly]);

  // Helper per toggleare un campo in editing
  const toggleEditingField = (field: 'duration' | 'checkout' | 'checkin' | 'paxin' | 'operation') => {
    setEditingFields(prev => {
      const newSet = new Set(prev);
      if (newSet.has(field)) {
        newSet.delete(field);
      } else {
        newSet.add(field);
      }
      return newSet;
    });
  };

  // Inizializza i campi quando il modale si apre o quando displayTask cambia
  // MA NON se l'utente sta già modificando campi o se è readonly
  useEffect(() => {
    if (isModalOpen && editingFields.size === 0 && !isReadOnly) {
      console.log('🔓 Modale aperto per task:', {
        taskId: task.id,
        allTasksCount: allTasks?.length || 0,
        allTasksIds: allTasks?.map(t => getTaskKey(t)) || [],
        isInTimeline,
        currentContainer
      });

      // CRITICAL: Sincronizza currentTaskId con displayTask corrente
      setCurrentTaskId(getTaskKey(displayTask));

      // Inizializza campi editabili con i valori attuali della task visualizzata (normalizzati)
      setEditedCheckoutDate(normalizeDate((displayTask as any).checkout_date));
      setEditedCheckoutTime(normalizeTime((displayTask as any).checkout_time));
      setEditedCheckinDate(normalizeDate((displayTask as any).checkin_date));
      setEditedCheckinTime(normalizeTime((displayTask as any).checkin_time));

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
  }, [isModalOpen, task.id, displayTask, allTasks, isInTimeline, currentContainer, editingFields.size]);

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
  // CRITICAL: Se l'utente ha modificato operation_id tramite pending edits, considera confermato
  // Questo distingue tra operation_id=2 di default (sistema) e operation_id=2 scelto manualmente
  const taskKeyForConfirm = getTaskKey(task);
  const pendingEditsForTask = getPendingEdits()[taskKeyForConfirm];
  // Usa il flag operationIdModified per determinare se l'utente ha modificato l'operazione
  // Se l'utente seleziona "Nessuna operazione" (null), operationIdModified è true ma operationId è null
  // In quel caso NON è confermato, il punto di domanda rimane
  const hasPendingOperationEdit = pendingEditsForTask?.operationIdModified === true && pendingEditsForTask?.operationId !== null;
  
  const rawConfirmed = (task as any).confirmed_operation; // Usa task originale per confirmed_operation
  const originalConfirmed = 
    typeof rawConfirmed === "boolean"
      ? rawConfirmed
      : typeof rawConfirmed === "number"
        ? rawConfirmed !== 0
        : typeof rawConfirmed === "string"
          ? ["true", "1", "yes"].includes(rawConfirmed.toLowerCase().trim())
          : false;
  
  // Confermato se: utente ha modificato manualmente operation_id (con valore non-null) O confirmed_operation originale è true
  const isConfirmedOperation = hasPendingOperationEdit || originalConfirmed;

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

  const { label: typeLabel, colorClass: baseCardColorClass } =
    getTaskTypeStyle(cardIsStraordinaria, cardIsPremium);
  
  // Se la task è bloccata, usa grigio invece del colore normale
  const cardColorClass = isLocked && !isInTimeline ? "bg-gray-100 opacity-70 dark:bg-gray-500 dark:opacity-90" : baseCardColorClass;

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

    // CRITICAL: Carica assignmentTimes sempre per le task in timeline (per isOverdue),
    // non solo quando il modale si apre
    if (isInTimeline || isModalOpen) {
      calculateAssignmentTimes();
    }
  }, [isInTimeline, isModalOpen, displayTask]);

  // Supporto navigazione con frecce da tastiera
  useEffect(() => {
    if (!isModalOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && canGoPrev) {
        handlePrevTask();
      }
      if (e.key === "ArrowRight" && canGoNext) {
        handleNextTask();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isModalOpen, canGoPrev, canGoNext, currentIndex, navigableTasks]);

  const handleSaveChanges = async () => {
    try {
      setIsSaving(true);

      // Validazione: checkout - se hai ora, devi avere anche data
      if (editingFields.has('checkout')) {
        const hasCheckoutDate = !!editedCheckoutDate;
        const hasCheckoutTime = !!editedCheckoutTime;
        // Non puoi avere ora senza data, ma puoi avere data senza ora
        if (hasCheckoutTime && !hasCheckoutDate) {
          toast({
            title: "Errore di validazione",
            description: "Check-out: se inserisci l'orario, devi inserire anche la data",
            variant: "destructive",
          });
          setIsSaving(false);
          return;
        }
      }

      // Validazione: checkin - se hai ora, devi avere anche data
      if (editingFields.has('checkin')) {
        const hasCheckinDate = !!editedCheckinDate;
        const hasCheckinTime = !!editedCheckinTime;
        // Non puoi avere ora senza data, ma puoi avere data senza ora
        if (hasCheckinTime && !hasCheckinDate) {
          toast({
            title: "Errore di validazione",
            description: "Check-in: se inserisci l'orario, devi inserire anche la data",
            variant: "destructive",
          });
          setIsSaving(false);
          return;
        }
      }

      // Validazione: il check-in non può essere precedente al check-out (solo se entrambi sono riempiti)
      if (editedCheckoutDate && editedCheckoutTime && editedCheckinDate && editedCheckinTime) {
        const checkoutDateTime = new Date(`${editedCheckoutDate}T${editedCheckoutTime}:00`);
        const checkinDateTime = new Date(`${editedCheckinDate}T${editedCheckinTime}:00`);

        if (checkinDateTime < checkoutDateTime) {
          toast({
            title: "Errore di validazione",
            description: "Il check-in non può essere precedente al check-out",
            variant: "destructive",
          });
          setIsSaving(false);
          return;
        }
      }

      // Validazione: durata pulizia deve essere > 0
      if (editingFields.has('duration') && parseInt(editedDuration) <= 0) {
        toast({
          title: "Errore di validazione",
          description: "La durata della pulizia deve essere maggiore di 0 minuti",
          variant: "destructive",
        });
        setIsSaving(false);
        return;
      }

      // Validazione: pax-in deve essere >= 0
      if (editingFields.has('paxin') && parseInt(editedPaxIn) < 0) {
        toast({
          title: "Errore di validazione",
          description: "Il numero di ospiti non può essere negativo",
          variant: "destructive",
        });
        setIsSaving(false);
        return;
      }

      const taskKey = getTaskKey(displayTask);
      
      // Gestisce operation_id: "none" = null (scelta esplicita di nessuna operazione)
      // Altrimenti parseInt, se è un numero valido
      const operationIdValue = editedOperationId === "none" 
        ? null 
        : (parseInt(editedOperationId) || null);
      
      const pendingEdits = {
        taskId: taskKey,
        logisticCode: displayTask.name,
        checkoutDate: editedCheckoutDate || null,  // null se vuoto
        checkoutTime: editedCheckoutTime || null,  // null se vuoto
        checkinDate: editedCheckinDate || null,    // null se vuoto
        checkinTime: editedCheckinTime || null,    // null se vuoto
        cleaningTime: parseInt(editedDuration),
        paxIn: parseInt(editedPaxIn),
        paxOut: displayTask.pax_out,
        operationId: operationIdValue,
        // CRITICAL: Flag per indicare che l'utente ha modificato operation_id
        // Questo distingue tra "non modificato" e "impostato a null esplicitamente"
        operationIdModified: editingFields.has('operation'),
      };

      // Salva in sessionStorage per UI ottimistica
      const existingEdits = JSON.parse(sessionStorage.getItem('pending_task_edits') || '{}');
      existingEdits[taskKey] = pendingEdits;
      sessionStorage.setItem('pending_task_edits', JSON.stringify(existingEdits));

      // CRITICAL: Salva anche su PostgreSQL (ma NON su ADAM) 
      // ADAM verrà aggiornato solo con "Trasferisci su ADAM"
      const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
      const currentUser = JSON.parse(localStorage.getItem('user') || '{}');
      
      const response = await fetch('/api/update-task-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: (displayTask as any).task_id || displayTask.id,
          logisticCode: displayTask.name,
          checkoutDate: editedCheckoutDate || null,
          checkoutTime: editedCheckoutTime || null,
          checkinDate: editedCheckinDate || null,
          checkinTime: editedCheckinTime || null,
          cleaningTime: parseInt(editedDuration),
          paxIn: parseInt(editedPaxIn),
          operationId: operationIdValue,
          date: workDate,
          modified_by: currentUser.username || 'unknown',
          skipAdam: true  // NON propagare su ADAM, solo PostgreSQL
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Errore nel salvataggio su PostgreSQL');
      }

      toast({
        title: "Modifiche salvate",
        description: "I campi della task sono stati salvati. Premi 'Trasferisci su ADAM' per sincronizzare.",
      });

      setEditingFields(new Set());
      // CRITICAL: Incrementa versione per forzare re-render con i nuovi valori
      setPendingEditsVersion(v => v + 1);
      setIsModalOpen(false);

    } catch (error: any) {
      console.error("Errore nella preparazione:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile preparare le modifiche",
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
      // Usa la larghezza della timeline in pixel se disponibile
      const timelineWidth = (window as any).timelineWidthPx || 0;
      const slotsCount = (window as any).globalTimeSlotsCount || 10;
      const virtualMinutes = slotsCount * 60; // Minuti virtuali basati su slot
      
      if (timelineWidth > 0) {
        // Calcola in pixel assoluti
        const widthPx = (effectiveMinutes / virtualMinutes) * timelineWidth;
        return `${widthPx}px`;
      } else {
        // Fallback a percentuale se larghezza non disponibile
        const widthPercentage = (effectiveMinutes / virtualMinutes) * 100;
        return `${widthPercentage}%`;
      }
    } else {
      // Per le colonne di priorità:
      // Se la task è < 60 minuti, usa sempre 60 minuti (larghezza di 1 ora)
      const displayMinutes = effectiveMinutes < 60 ? 60 : effectiveMinutes;
      const halfHours = Math.ceil(displayMinutes / 30);
      const baseWidth = halfHours * 50;
      return `${baseWidth}px`;
    }
  };

  // Mostra frecce solo per task >= 1 ora
  const duration = task.duration || "0.0";
  const [hours, mins] = duration.split('.').map(Number);
  const totalMinutes = (hours || 0) * 60 + (mins || 0);

  // CRITICAL: In timeline, mostra frecce SOLO se >= 1h
  // Nei container, mostra frecce SEMPRE (anche per < 1h)
  const shouldShowCheckInOutArrows = isInTimeline ? totalMinutes >= 60 : true;

  // Mostra orari nel tooltip solo per task < 1 ora E quando le frecce sono nascoste
  const shouldShowTooltipTimes = totalMinutes < 60 && !shouldShowCheckInOutArrows;

  // Verifica violazioni temporali (considerando le date!)
  const isOverdue = (() => {
    const taskObj = displayTask as any;
    // CRITICAL: Normalizza TUTTI i tempi per evitare date invalide (es. "15:55:00" -> "15:55")
    const startTime = normalizeTime(assignmentTimes.start_time || taskObj.start_time || taskObj.startTime);
    const endTime = normalizeTime(assignmentTimes.end_time || taskObj.end_time || taskObj.endTime);
    const checkoutTime = normalizeTime(taskObj.checkout_time);
    const checkinTime = normalizeTime(taskObj.checkin_time);
    const checkoutDate = normalizeDate(taskObj.checkout_date);
    const checkinDate = normalizeDate(taskObj.checkin_date);

    if (!isInTimeline) return false;

    // CRITICAL: Caso 1 - start_time PRIMA di checkout_time (cleaner arriva prima che proprietà sia libera)
    if (startTime && checkoutTime && checkoutDate) {
      const taskStartDateTime = new Date(checkoutDate + 'T' + startTime + ':00');
      const checkoutDateTime = new Date(checkoutDate + 'T' + checkoutTime + ':00');
      if (taskStartDateTime < checkoutDateTime) return true;
    }

    // Caso 2: end_time sfora checkin_time
    if (endTime && checkinTime && checkoutDate && checkinDate) {
      const checkoutDateTime = new Date(checkoutDate + 'T' + endTime + ':00');
      const checkinDateTime = new Date(checkinDate + 'T' + checkinTime + ':00');
      if (checkoutDateTime > checkinDateTime) return true;
    }

    // Caso 3: start_time è dopo o uguale a checkin_time (task inizia quando ospiti sono già arrivati)
    if (startTime && checkinTime && checkoutDate && checkinDate) {
      const taskStartDateTime = new Date(checkoutDate + 'T' + startTime + ':00');
      const checkinDateTime = new Date(checkinDate + 'T' + checkinTime + ':00');
      if (taskStartDateTime >= checkinDateTime) return true;
    }

    return false;
  })();

  // Verifica se il check-in è per una data futura (rispetto alla data selezionata)
  // Include anche i casi dove l'orario non è migrato ma la data è futura
  const isFutureCheckin = (() => {
    const taskObj = task as any;
    const checkinDate = taskObj.checkin_date;

    if (!checkinDate) return false;

    // Ottieni la data selezionata da localStorage
    const selectedWorkDate = localStorage.getItem('selected_work_date');
    if (!selectedWorkDate) return false;

    const [year, month, day] = selectedWorkDate.split('-').map(Number);
    const selectedDate = new Date(year, month - 1, day);
    selectedDate.setHours(0, 0, 0, 0);

    const checkin = new Date(checkinDate);
    checkin.setHours(0, 0, 0, 0);

    return checkin > selectedDate;
  })();

  // Determina se il drag è disabilitato in base alla data, se la task è già salvata, o se è bloccata
  const shouldDisableDrag = isDragDisabled || (displayTask as any).checkin_date || isLocked;

  // Calcola offset in pixel
  const timelineWidth = (window as any).timelineWidthPx || 0;
  const virtualMinutes = globalTimeSlots * 60;
  
  const offsetWidthPx = timeOffset > 0 && virtualMinutes > 0 && timelineWidth > 0 
    ? (timeOffset / virtualMinutes) * timelineWidth 
    : 0;

  // Usa sequence per determinare se è la prima task o successive (più robusto di index)
  const seq = (displayTask as any).sequence ?? (index + 1);

  return (
    <>
      <Draggable
        draggableId={getUniqueDraggableId(task, cleanerId)}
        index={index}
        isDragDisabled={shouldDisableDrag}
      >
        {(provided, snapshot) => {
          const cardWidth = calculateWidth(task.duration, isInTimeline);

          return (
            <div
              ref={provided.innerRef}
              {...provided.draggableProps}
              style={{
                ...provided.draggableProps.style,
                zIndex: snapshot.isDragging ? 9999 : 'auto',
              }}
              className={isInTimeline ? "flex items-center" : ""}
            >
              {/* Offset spacer per prima task (sequence === 1) - DENTRO il Draggable */}
              {isInTimeline && seq === 1 && timeOffset > 0 && offsetWidthPx > 0 && (
                <div
                  className="flex-shrink-0"
                  style={{ width: `${offsetWidthPx}px` }}
                />
              )}

          {/* Task card con drag handle */}
          <div {...provided.dragHandleProps}>
            {/* Task card effettiva */}
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={`
                      ${cardColorClass}
                      rounded-sm px-2 py-1 shadow-sm transition-all duration-200 border
                      ${snapshot.isDragging ? "shadow-lg" : ""}
                      ${isOverdue && isInTimeline ? "animate-blink" : ""}
                      ${isDuplicate && !isInTimeline ? "animate-blink-yellow" : ""}
                      ${isPriorityWindowViolation && isInTimeline ? "animate-blink-orange" : ""}
                      ${isSelected && isMultiSelectMode && !isInTimeline ? "ring-2 ring-sky-500" : ""}
                      hover:shadow-md cursor-pointer
                      flex-shrink-0 relative group
                    `}
                    style={{
                      width: cardWidth,
                      minWidth: cardWidth,
                      maxWidth: cardWidth,
                      minHeight: "40px",
                      zIndex: isMapFiltered ? 10 : 'auto',
                      ...(isHighlighted && !snapshot.isDragging ? {
                        boxShadow: '0 0 0 3px #FBBF24, 0 0 15px 3px rgba(251, 191, 36, 0.6)',
                        transform: 'scale(1.02)',
                      } : {}),
                      ...(isMapFiltered && !snapshot.isDragging ? {
                        boxShadow: '0 0 0 3px #3B82F6, 0 0 20px 5px rgba(59, 130, 246, 0.5)',
                        transform: 'scale(1.05)',
                      } : {})
                    }}
                    data-testid={`task-card-${getTaskKey(task)}`}
                    onClick={(e) => {
                      if (!snapshot.isDragging) {
                        handleCardClick(e);
                      }
                    }}
                  >

                    {/* Selection indicator (top-left) */}
                    {isMultiSelectMode && !isInTimeline && (
                      <div className="absolute -top-1.5 -left-1 z-[60]">
                        <div
                          className={[
                            "w-4 h-4 rounded-full flex items-center justify-center",
                            "text-[10px] font-bold leading-none border-2 transition-all duration-150",
                            isSelected
                              ? "opacity-100"
                              : "opacity-0 group-hover:opacity-100",
                            isSelected
                            ? "bg-sky-600 text-white border-sky-700 shadow-md"
                            : "bg-transparent text-sky-600 border-sky-600"                          
                          ].join(" ")}
                          onClick={(e) => {
                            e.stopPropagation();
                            multiSelectContext?.toggleTask(String(task.id), currentContainer);
                          }}
                          role="checkbox"
                          aria-checked={isSelected}
                        >
                          {isSelected ? selectionOrder : ""}
                        </div>
                      </div>
                    )}

                    {!isConfirmedOperation && !isSelected && (
                      <div className="absolute -top-1.5 -right-1.5 z-10">
                        <div className="w-4 h-4 rounded-full flex items-center justify-center bg-gray-900 text-white border-2 border-gray-800 shadow-md">
                          <HelpCircle className="w-3 h-3" strokeWidth={2.5} />
                        </div>
                      </div>
                    )}

                    {/* Frecce check-in e check-out */}
                    {shouldShowCheckInOutArrows &&
                      ((taskWithPendingEdits as any).checkout_time ||
                        (taskWithPendingEdits as any).checkin_time ||
                        isFutureCheckin) && (() => {
                        const hasCheckout = Boolean((taskWithPendingEdits as any).checkout_time);
                        const hasCheckin = Boolean((taskWithPendingEdits as any).checkin_time) || isFutureCheckin;
                        const linesCount = (hasCheckout ? 1 : 0) + (hasCheckin ? 1 : 0);
                        const shouldCenterSingleLine = linesCount === 1;

                        return (
                          <div
                            className={[
                              "absolute right-1 top-[5px] z-40 whitespace-nowrap",
                              "flex flex-col items-end gap-0.5",
                              // altezza “slot” da 2 righe: così 1 riga può essere centrata
                              "min-h-[28px]",
                              shouldCenterSingleLine ? "justify-center" : "justify-start",
                            ].join(" ")}
                          >
                            {hasCheckout && (
                              <div className="flex items-center gap-0.5 leading-none">
                                <span className="font-black text-[15px] leading-none text-[#257537]">↑</span>
                                <span className="text-[11px] leading-none text-[#137537] font-bold">
                                  {(taskWithPendingEdits as any).checkout_time}
                                </span>
                              </div>
                            )}

                            {hasCheckin && (
                              <div className="flex items-center gap-0.5 leading-none">
                                {isFutureCheckin ? (
                                  <>
                                    <Calendar className="w-3.5 h-3.5 text-red-600" strokeWidth={2.5} />
                                    {(taskWithPendingEdits as any).checkin_time && (
                                      <span className="text-red-600 text-[11px] leading-none font-bold">
                                        {(taskWithPendingEdits as any).checkin_time}
                                      </span>
                                    )}
                                  </>
                                ) : (
                                  (taskWithPendingEdits as any).checkin_time && (
                                    <>
                                      <span className="text-red-600 font-black text-[15px] leading-none">↓</span>
                                      <span className="text-red-600 text-[11px] leading-none font-bold">
                                        {(taskWithPendingEdits as any).checkin_time}
                                      </span>
                                    </>
                                  )
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                    <div
                      className="flex flex-col items-start justify-start h-full gap-0 p-[0.5px] pl-0"
                    >
                      <div className="flex items-center gap-1">
                        <span
                          className="text-[#ff0000] font-extrabold text-[13px]"
                          data-testid={`task-name-${getTaskKey(task)}`}
                        >
                          {task.name}
                        </span>
                        {(task as any).customer_reference && (
                          <span className="text-[#ff0000] font-bold text-[11px]">
                            ({(task as any).customer_reference})
                          </span>
                        )}
                        {(task as any).collaborator_count > 1 && (
                          <Badge className="bg-purple-500 hover:bg-purple-600 px-0.5 py-0 h-3.5 flex items-center">
                            <span className="text-[10px]">👥</span>
                          </Badge>
                        )}
                      </div>
                      {task.alias && (
                        <span className="opacity-70 leading-none mt-0.5 text-[#000000] font-bold text-[9px]">
                          {task.alias}{(task as any).type_apt ? ` (${(task as any).type_apt})` : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs text-base px-3 py-2">
                  <div className="flex flex-col items-center gap-2">
                    <p className="font-semibold">{displayTask.address?.toUpperCase() || "INDIRIZZO NON DISPONIBILE"}</p>
                    {shouldShowTooltipTimes && ((displayTask as any).checkout_time || (displayTask as any).checkin_time) && (
                      <div className="flex items-center gap-3 text-sm">
                        {(displayTask as any).checkout_time && (
                          <div className="flex items-center gap-1">
                            <span className="text-green-500">↑</span>
                            <span>{(displayTask as any).checkout_time}</span>
                          </div>
                        )}
                        {(displayTask as any).checkin_time && (
                          <div className="flex items-center gap-1">
                            <span className="text-red-500">↓</span>
                            <span>{(displayTask as any).checkin_time}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
              </div>
            </div>
          );
        }}
      </Draggable>
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
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
                    "text-xs shrink-0 px-2 py-0.5 rounded border font-medium",
                    Boolean(displayTask.straordinaria)
                      ? "bg-red-500/20 text-red-700 dark:text-red-300 border-red-500"
                      : Boolean(displayTask.premium)
                        ? "bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400"
                        : "bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400"
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
                <p className="text-sm">{displayTask.address?.toUpperCase() || "NON MIGRATO"}</p>
              </div>
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1">
                  Durata pulizia
                </p>
                <p className="text-sm p-1">
                  {(displayTask.duration || "0.0").replace(".", ":")} ore
                </p>
              </div>
            </div>

            {/* Terza riga: Check-out - Check-in */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  Check-out
                  {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                </p>
                {editingFields.has('checkout') && !isReadOnly ? (
                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                    <div className="relative">
                      <Input
                        id="checkout-date-input"
                        type="date"
                        value={editedCheckoutDate}
                        onChange={(e) => setEditedCheckoutDate(e.target.value)}
                        onFocus={(e) => {
                          e.stopPropagation();
                          // Normalizza prima di aprire il picker per evitare errori
                          setEditedCheckoutDate(prev => normalizeDate(prev));
                          setTimeout(() => (e.target as HTMLInputElement).showPicker?.(), 0);
                        }}
                        onBlur={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm cursor-text"
                      />
                    </div>
                    <div className="relative">
                      <Input
                        id="checkout-time-input"
                        type="time"
                        value={editedCheckoutTime}
                        onChange={(e) => setEditedCheckoutTime(e.target.value)}
                        onFocus={(e) => {
                          e.stopPropagation();
                          // Normalizza prima di aprire il picker per evitare errori
                          setEditedCheckoutTime(prev => normalizeTime(prev));
                          setTimeout(() => (e.target as HTMLInputElement).showPicker?.(), 0);
                        }}
                        onBlur={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm cursor-text"
                      />
                    </div>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) toggleEditingField('checkout');
                    }}
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
                {editingFields.has('checkin') && !isReadOnly ? (
                  <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                    <div className="relative">
                      <Input
                        id="checkin-date-input"
                        type="date"
                        value={editedCheckinDate}
                        onChange={(e) => setEditedCheckinDate(e.target.value)}
                        onFocus={(e) => {
                          e.stopPropagation();
                          // Normalizza prima di aprire il picker per evitare errori
                          setEditedCheckinDate(prev => normalizeDate(prev));
                          setTimeout(() => (e.target as HTMLInputElement).showPicker?.(), 0);
                        }}
                        onBlur={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm cursor-text"
                      />
                    </div>
                    <div className="relative">
                      <Input
                        id="checkin-time-input"
                        type="time"
                        value={editedCheckinTime}
                        onChange={(e) => setEditedCheckinTime(e.target.value)}
                        onFocus={(e) => {
                          e.stopPropagation();
                          // Normalizza prima di aprire il picker per evitare errori
                          setEditedCheckinTime(prev => normalizeTime(prev));
                          setTimeout(() => (e.target as HTMLInputElement).showPicker?.(), 0);
                        }}
                        onBlur={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                        className="text-sm cursor-text"
                      />
                    </div>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) toggleEditingField('checkin');
                    }}
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
                {editingFields.has('operation') && !isReadOnly ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <Select
                      value={editedOperationId}
                      onValueChange={(value) => setEditedOperationId(value)}
                    >
                      <SelectTrigger className="text-sm">
                        <SelectValue placeholder="Seleziona operazione" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— Nessuna operazione —</SelectItem>
                        {(operationsData?.active_operations || []).map((op) => (
                          <SelectItem key={op.id} value={String(op.id)}>{op.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) toggleEditingField('operation');
                    }}
                  >
                    {(() => {
                      // Controlla se l'utente ha scelto esplicitamente "Nessuna operazione"
                      const taskKeyDisplay = getTaskKey(displayTask);
                      const pendingEditsDisplay = getPendingEdits()[taskKeyDisplay];
                      const userChoseNone = pendingEditsDisplay?.operationIdModified === true && pendingEditsDisplay?.operationId === null;
                      
                      if (userChoseNone) {
                        return "— Nessuna operazione —";
                      }
                      if (!isConfirmedOperation) {
                        return "non migrato";
                      }
                      const opId = (displayTask as any).operation_id;
                      if (opId) {
                        return operationNames[opId] || `Operazione ${opId}`;
                      }
                      return "-";
                    })()}
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
                {editingFields.has('paxin') && !isReadOnly ? (
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <Input
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={editedPaxIn}
                      onChange={(e) => {
                        const value = e.target.value.replace(/\D/g, '');
                        setEditedPaxIn(value);
                      }}
                      onFocus={(e) => e.stopPropagation()}
                      onBlur={(e) => e.stopPropagation()}
                      onClick={(e) => e.stopPropagation()}
                      className="text-sm w-20 [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      min="0"
                    />
                    <span className="text-sm text-muted-foreground">persone</span>
                  </div>
                ) : (
                  <p
                    className={`text-sm p-1 rounded ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) toggleEditingField('paxin');
                    }}
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

            {/* Settima riga: Gestione Collaboratori - solo per task in timeline */}
            {isInTimeline && (
              <div className="pt-3 border-t mt-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-purple-600" />
                    <span className="text-sm font-semibold text-muted-foreground">
                      Collaboratori
                    </span>
                    {/* Lista collaboratori con alias con badge inline */}
                    {taskCollaborators.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 ml-1">
                        {taskCollaborators.map((collab) => (
                          <Badge 
                            key={collab.id} 
                            variant={collab.isPrimary ? "default" : "secondary"}
                            className={cn(
                              "text-[10px] px-1.5 py-0 h-5 flex items-center gap-1",
                              collab.isPrimary && "bg-blue-600 hover:bg-blue-700"
                            )}
                          >
                            {collab.alias || collab.name}
                            {collab.isPrimary && <span className="text-[9px] font-bold">(P)</span>}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {(displayTask as any).collaborator_count > 1 && taskCollaborators.length === 0 && (
                      <Badge variant="secondary" className="text-xs">
                        {(displayTask as any).collaborator_count} cleaners
                      </Badge>
                    )}
                  </div>
                  {!isReadOnly && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={openAddCollaboratorDialog}
                      className="flex items-center gap-1 border-2 border-purple-300 dark:border-purple-700 hover:bg-purple-50 dark:hover:bg-purple-900/20"
                    >
                      <UserPlus className="w-3 h-3" />
                      Aggiungi collaboratore
                    </Button>
                  )}
                </div>

                {/* Info collaborazione attuale */}
                {(displayTask as any).collaborator_count > 1 && (
                  <div className="text-xs text-muted-foreground mb-2 p-3 bg-purple-50 dark:bg-purple-900/20 rounded border border-purple-300 dark:border-purple-700">
                    <div className="flex items-center gap-2 mb-2">
                      <Users className="w-4 h-4 text-purple-600" />
                      <span className="font-semibold text-purple-700 dark:text-purple-300">
                        Collaborazione ({(displayTask as any).collaborator_count} cleaners)
                      </span>
                    </div>
                    <p>
                      <strong>Durata originale:</strong> {(() => {
                        const baseTime = (displayTask as any).base_cleaning_time || 0;
                        const hours = Math.floor(baseTime / 60);
                        const mins = baseTime % 60;
                        return `${hours}:${String(mins).padStart(2, '0')} ore`;
                      })()}
                    </p>
                    <p>
                      <strong>Durata per cleaner:</strong> {(displayTask.duration || "0.0").replace(".", ":")} ore
                    </p>
                    {(displayTask as any).is_primary && (
                      <p className="text-blue-600 font-semibold mt-1">Questo cleaner è il Primary</p>
                    )}
                    {!isReadOnly && (
                      <Button
                        variant="destructive"
                        size="sm"
                        className="mt-3 w-full flex items-center justify-center gap-2"
                        onClick={() => setShowDissolveDialog(true)}
                        disabled={isDissolvingCollaboration}
                      >
                        <Trash2 className="w-4 h-4" />
                        {isDissolvingCollaboration ? "Rimozione..." : "Rimuovi collaborazione"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}


            {/* Ottava riga: Blocco Task - solo nei container */}
            {!isInTimeline && (
              <div className="pt-3 border-t mt-3">
                <div className="flex items-center gap-3">
                  <Button
                    variant={isLocked ? "destructive" : "outline"}
                    size="sm"
                    onClick={handleToggleLock}
                    className="flex items-center gap-2"
                    data-testid={`lock-task-btn-${getTaskKey(task)}`}
                  >
                    {isLocked ? <Lock className="w-4 h-4" /> : <LockOpen className="w-4 h-4" />}
                    {isLocked ? "Sblocca" : "Blocca"}
                  </Button>
                  {isLocked && (
                    <div className="flex-1">
                      <Input
                        type="text"
                        value={lockedReason}
                        onChange={(e) => setLockedReason(e.target.value)}
                        onBlur={() => handleSaveLockedReason({ stopPropagation: () => {} } as any)}
                        placeholder="Motivo del blocco..."
                        className="text-sm"
                        data-testid={`lock-reason-input-${getTaskKey(task)}`}
                      />
                    </div>
                  )}
                </div>
                {isLocked && (
                  <p className="text-xs text-red-600 mt-1">
                    Questa task non può essere assegnata o trascinata
                  </p>
                )}
              </div>
            )}

            {/* Pulsante Salva Modifiche */}
            {editingFields.size > 0 && !isReadOnly && (
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
                    setEditingFields(new Set());
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

      {/* Dialog di conferma per dissoluzione collaborazione */}
      <AlertDialog open={showDissolveDialog} onOpenChange={setShowDissolveDialog}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <Trash2 className="w-5 h-5" />
              Conferma Rimozione Collaborazione
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="text-base text-foreground font-semibold mb-3">
                  La collaborazione verrà rimossa e la task tornerà nei containers con la durata originale.
                </p>
                <div className="bg-purple-50 dark:bg-purple-900/20 rounded p-3 mb-3 text-sm">
                  <p><strong>Durata originale:</strong> {(() => {
                    const baseTime = (displayTask as any).base_cleaning_time || 0;
                    const hours = Math.floor(baseTime / 60);
                    const mins = baseTime % 60;
                    return `${hours}:${String(mins).padStart(2, '0')} ore`;
                  })()}</p>
                  <p><strong>Durata attuale per cleaner:</strong> {(displayTask.duration || "0.0").replace(".", ":")} ore</p>
                  <p><strong>Cleaners coinvolti:</strong> {(displayTask as any).collaborator_count || 0}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setShowDissolveDialog(false)}
              className="border-2 border-purple-300 dark:border-purple-700"
              disabled={isDissolvingCollaboration}
            >
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const workDate = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
                const taskId = (displayTask as any).task_id || displayTask.id;
                
                setIsDissolvingCollaboration(true);
                
                try {
                  const response = await fetch(`/api/tasks/${taskId}/collaborators/dissolve`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ date: workDate })
                  });
                  
                  const result = await response.json();
                  
                  if (result.success) {
                    toast({
                      title: "Collaborazione rimossa",
                      description: `Task ${result.logisticCode} riportata in ${result.priority} con durata ${result.originalDuration} min`,
                    });
                    setShowDissolveDialog(false);
                    setIsModalOpen(false);
                    window.dispatchEvent(new CustomEvent('refresh-assignments'));
                  } else {
                    toast({
                      title: "Errore",
                      description: result.error || "Impossibile rimuovere la collaborazione",
                      variant: "destructive"
                    });
                  }
                } catch (error: any) {
                  toast({
                    title: "Errore",
                    description: error.message || "Errore nella rimozione della collaborazione",
                    variant: "destructive"
                  });
                } finally {
                  setIsDissolvingCollaboration(false);
                }
              }}
              disabled={isDissolvingCollaboration}
              className="bg-background hover:bg-accent text-foreground border-2 border-purple-300 dark:border-purple-700 shadow-sm"
            >
              {isDissolvingCollaboration ? "Rimozione..." : "Conferma Rimozione"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dialog per selezione collaboratori */}
      <CleanerSelectorDialog
        isOpen={isCleanerSelectorOpen}
        onClose={() => setIsCleanerSelectorOpen(false)}
        onConfirm={handleCollaboratorSelection}
        excludeCleanerId={(displayTask as any).cleaner_id || (displayTask as any).assignedCleaner}
        workDate={localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0]}
        title="Aggiungi Collaboratori"
        description="Seleziona uno o più cleaners da aggiungere come collaboratori a questa task"
        confirmLabel="Aggiungi"
        baseCleaningTime={(() => {
          const currentCount = (displayTask as any).collaborator_count || 1;
          let baseTime = (displayTask as any).base_cleaning_time;
          if (!baseTime) {
            const durationStr = displayTask.duration || "0.0";
            const [h, m] = durationStr.split('.').map(Number);
            baseTime = ((h || 0) * 60 + (m || 0)) * currentCount;
          }
          return baseTime;
        })()}
        existingCollaboratorCount={(displayTask as any).collaborator_count || 1}
        isLoading={isCollaboratorLoading}
      />
    </>
  );
}