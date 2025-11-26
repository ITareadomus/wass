import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar as CalendarIcon, RotateCcw, Users, RefreshCw, UserPlus, Maximize2, Minimize2, Check, CheckCircle, Save, Pencil, ChevronLeft, ChevronRight } from "lucide-react";
import { useState, useEffect, useRef } from "react";
import * as React from "react";
import { Droppable, Draggable } from "react-beautiful-dnd";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import TaskCard from "@/components/drag-drop/task-card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLocation } from 'wouter';
import { format } from 'date-fns';
import { loadValidationRules, canCleanerHandleTaskSync } from "@/lib/taskValidation";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
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

interface TimelineViewProps {
  personnel: Personnel[];
  tasks: Task[];
  hasUnsavedChanges?: boolean; // Stato delle modifiche non salvate dal parent
  onTaskMoved?: () => void; // Callback quando una task viene spostata
  isReadOnly?: boolean; // Modalità read-only: disabilita tutte le modifiche
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
  weekly_hours?: number;
  available: boolean;
  contract_type: string;
  preferred_customers: number[];
  telegram_id: number | null;
  start_time: string | null;
  can_do_straordinaria?: boolean;
}

export default function TimelineView({
  personnel,
  tasks,
  hasUnsavedChanges = false,
  onTaskMoved,
  isReadOnly = false,
}: TimelineViewProps) {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedCleaner, setSelectedCleaner] = useState<Cleaner | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedSwapCleaner, setSelectedSwapCleaner] = useState<string>("");
  const [filteredCleanerId, setFilteredCleanerId] = useState<number | null>(null);
  const [clickTimer, setClickTimer] = useState<NodeJS.Timeout | null>(null);
  const [cleanersAliases, setCleanersAliases] = useState<Record<number, {alias: string}>>({});
  const [isAddCleanerDialogOpen, setIsAddCleanerDialogOpen] = useState(false);
  const [availableCleaners, setAvailableCleaners] = useState<Cleaner[]>([]);
  const [cleanerToReplace, setCleanerToReplace] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const [confirmUnavailableDialog, setConfirmUnavailableDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const [confirmRemovalDialog, setConfirmRemovalDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const [incompatibleDialog, setIncompatibleDialog] = useState<{ open: boolean; cleanerId: number | null; tasks: Array<{ logisticCode: string; taskType: string }> }>({ open: false, cleanerId: null, tasks: [] });
  const [startTimeDialog, setStartTimeDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string; isAvailable: boolean }>({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
  const [pendingStartTime, setPendingStartTime] = useState<string>("10:00");
  const [pendingCleaner, setPendingCleaner] = useState<any>(null); // Added to track pending cleaner ID
  const [showAdamTransferDialog, setShowAdamTransferDialog] = useState(false); // Stato per il dialog di trasferimento ADAM

  // Stato per tracciare acknowledge per coppie (task, cleaner)
  type IncompatibleKey = string; // chiave del tipo `${taskId}-${cleanerId}`
  const [acknowledgedIncompatibleAssignments, setAcknowledgedIncompatibleAssignments] = useState<Set<IncompatibleKey>>(new Set());

  // Helper per costruire la chiave univoca task-cleaner
  const getIncompatibleKey = (task: any, cleanerId: number): IncompatibleKey => {
    const taskId = task.task_id ?? task.id ?? task.logisticCode;
    return `${taskId}-${cleanerId}`;
  };

  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [editingAlias, setEditingAlias] = useState<string>("");
  const [isSavingAlias, setIsSavingAlias] = useState(false);
  const [aliasDialog, setAliasDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string }>({ open: false, cleanerId: null, cleanerName: '' });
  const [editingStartTime, setEditingStartTime] = useState<string>("10:00");
  const [startTimeEditDialog, setStartTimeEditDialog] = useState<{ open: boolean; cleanerId: number | null; cleanerName: string }>({ open: false, cleanerId: null, cleanerName: '' });
  const [isSavingStartTime, setIsSavingStartTime] = useState(false);

  // Stato per le regole di validazione task-cleaner
  const [validationRules, setValidationRules] = useState<any>(null);

  // Ref per tracciare i toast già mostrati (previene duplicati)
  const shownToastsRef = useRef<Set<string>>(new Set());

  // Carica le regole di validazione una sola volta all'init
  useEffect(() => {
    loadValidationRules().then(rules => {
      setValidationRules(rules);
    }).catch(err => {
      console.error('Failed to load validation rules:', err);
      setValidationRules(null); // Fallback permissive
    });
  }, []);

  // Stato per memorizzare i dati della timeline (inclusi i metadata)
  const [timelineData, setTimelineData] = useState<any>(null);

  // Carica anche i cleaner dalla timeline.json per mostrare quelli nascosti
  // DEVE essere definito PRIMA di allCleanersToShow che lo usa
  const [timelineCleaners, setTimelineCleaners] = useState<any[]>([]);

  // Normalizza la data da localStorage per coerenza ovunque
  const workDate = localStorage.getItem('selected_work_date') || (() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  })();

  // Mostra cleaners da selected_cleaners.json + cleaners che hanno task in timeline.json
  // DEVE essere definito PRIMA di getGlobalStartTime() che lo usa
  const allCleanersToShow = React.useMemo(() => {
    const selectedCleanerIds = new Set(cleaners.map(c => c.id));
    const timelineCleanersWithTasks = timelineCleaners
      .filter(tc => tc.tasks && tc.tasks.length > 0) // Solo cleaners con task
      .filter(tc => !selectedCleanerIds.has(tc.cleaner?.id)) // Non già in selected_cleaners
      .map(tc => ({ ...tc.cleaner, isRemoved: true })); // Marca come rimosso

    // Combina selected_cleaners + timeline cleaners con task (quelli rimossi andranno in fondo)
    return [...cleaners, ...timelineCleanersWithTasks];
  }, [cleaners, timelineCleaners]);

  // Crea Set di ID cleaner rimossi per facile lookup
  const removedCleanerIds = React.useMemo(() => {
    const selectedIds = new Set(cleaners.map(c => c.id));
    return new Set(
      timelineCleaners
        .filter(tc => tc.tasks && tc.tasks.length > 0 && !selectedIds.has(tc.cleaner?.id))
        .map(tc => tc.cleaner?.id)
    );
  }, [cleaners, timelineCleaners]);



  // Mutation per rimuovere un cleaner da selected_cleaners.json
  const removeCleanerMutation = useMutation({
    mutationFn: async (cleanerId: number) => {
      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const response = await apiRequest("POST", "/api/remove-cleaner-from-selected", {
        cleanerId,
        date: workDate,
        modified_by: currentUser.username || 'unknown'
      });
      return await response.json();
    },
    onSuccess: async (data) => {
      // CRITICAL: Marca modifiche SOLO dopo azioni utente
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
      if (onTaskMoved) {
        onTaskMoved();
      }

      // CRITICAL: Ricarica PRIMA la timeline per vedere i cleaners con task
      await loadTimelineCleaners();
      // Aggiorna i dati della timeline per mostrare i metadata aggiornati
      await loadTimelineData();

      // POI ricarica selected_cleaners
      await loadCleaners();

      const message = data.removedFromTimeline
        ? `${selectedCleaner?.name} ${selectedCleaner?.lastname} è stato rimosso completamente (nessuna task).`
        : `${selectedCleaner?.name} ${selectedCleaner?.lastname} è è stato rimosso dalla selezione. Le sue task rimangono in timeline.`;

      toast({
        title: "Cleaner rimosso",
        description: message,
        variant: "success",
      });
      setIsModalOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile rimuovere il cleaner",
        variant: "destructive",
      });
    },
  });

  // Mutation per aggiungere un cleaner alla timeline
  const addCleanerMutation = useMutation({
    mutationFn: async (cleanerId: number) => {
      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const response = await apiRequest("POST", "/api/add-cleaner-to-timeline", {
        cleanerId,
        date: workDate,
        modified_by: currentUser.username || 'unknown'
      });
      return await response.json();
    },
    onSuccess: async (data, cleanerId) => {
      if (onTaskMoved) {
        onTaskMoved();
      }

      // Con il sistema per coppie (task, cleaner), non serve invalidare nulla:
      // le nuove coppie non sono ackate di default

      // Ricarica ENTRAMBI i file per sincronizzare la vista
      await Promise.all([
        loadCleaners(),
        loadTimelineCleaners()
      ]);
      // Aggiorna i dati della timeline per mostrare i metadata aggiornati
      await loadTimelineData();

      // Ricarica anche le task se necessario
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks(true);
      }

      // IMPORTANTE: ricarica timeline.json PRIMA di ricalcolare gli available
      // Questo previene race conditions tra cache e stato locale
      await new Promise(resolve => setTimeout(resolve, 100)); // Small delay per file system sync

      // Trova il cleaner appena aggiunto per mostrare nome e cognome
      const cleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const cleanersData = await cleanersResponse.json();
      const addedCleaner = cleanersData.cleaners.find((c: any) => c.id === cleanerId);
      const cleanerName = addedCleaner ? `${addedCleaner.name} ${addedCleaner.lastname}` : `ID ${cleanerId}`;

      toast({
        title: "Cleaner aggiunto",
        description: `${cleanerName} è stato aggiunto alla selezione`,
        variant: "success",
      });
      setIsAddCleanerDialogOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile aggiungere il cleaner alla timeline",
        variant: "destructive",
      });
    },
  });

  // Mutation per scambiare task tra cleaners
  const swapCleanersMutation = useMutation({
    mutationFn: async ({ sourceCleanerId, destCleanerId }: { sourceCleanerId: number; destCleanerId: number }) => {
      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const response = await apiRequest("POST", "/api/swap-cleaners-tasks", {
        sourceCleanerId,
        destCleanerId,
        date: workDate,
        modified_by: currentUser.username || 'unknown'
      });
      return await response.json();
    },
    onSuccess: async (data, variables) => {
      if (onTaskMoved) {
        onTaskMoved();
      }

      // Ricarica i task per mostrare immediatamente lo swap
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
      // Aggiorna i dati della timeline per mostrare i metadata aggiornati
      await loadTimelineData();

      // Trova i nomi dei cleaner coinvolti
      const sourceCleaner = cleaners.find(c => c.id === variables.sourceCleanerId);
      const destCleaner = cleaners.find(c => c.id === variables.destCleanerId);

      const sourceCleanerName = sourceCleaner ? `${sourceCleaner.name} ${sourceCleaner.lastname}` : `ID ${variables.sourceCleanerId}`;
      const destCleanerName = destCleaner ? `${destCleaner.name} ${destCleaner.lastname}` : `ID ${variables.destCleanerId}`;

      toast({
        title: "Successo",
        description: `Task di ${sourceCleanerName} scambiate con successo con le task di ${destCleanerName}`,
        variant: "success",
      });
      setSelectedSwapCleaner("");
      setIsModalOpen(false);
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Errore nello scambio delle task",
        variant: "destructive",
      });
    },
  });

  const handleSwapCleaners = () => {
    if (!selectedSwapCleaner || !selectedCleaner) return;

    const destCleanerId = parseInt(selectedSwapCleaner, 10);

    swapCleanersMutation.mutate({
      sourceCleanerId: selectedCleaner.id,
      destCleanerId: destCleanerId,
    });
  };

  // Trova lo start time minimo tra tutti i cleaner
  const getGlobalStartTime = () => {
    if (allCleanersToShow.length === 0) return "10:00";

    const startTimes = allCleanersToShow.map(c => c.start_time || "10:00");
    const minTime = startTimes.reduce((min, current) => {
      const [minH, minM] = min.split(':').map(Number);
      const [curH, curM] = current.split(':').map(Number);
      const minMinutes = minH * 60 + minM;
      const curMinutes = curH * 60 + curM;
      return curMinutes < minMinutes ? current : min;
    });

    return minTime;
  };

  // Genera time slots globali basati sullo start time minimo
  const generateGlobalTimeSlots = () => {
    const globalStartTime = getGlobalStartTime();
    const [startHour, startMin] = globalStartTime.split(':').map(Number);
    const endHour = 19; // Fine fissa alle 19:00

    const slots: string[] = [];
    let currentHour = startHour;
    let currentMin = startMin;

    // Genera slot ogni ora fino alle 19:00
    while (currentHour < endHour || (currentHour === endHour && currentMin === 0)) {
      slots.push(`${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`);
      currentHour++;
    }

    // Aggiungi sempre 19:00 come ultimo slot
    if (slots[slots.length - 1] !== "19:00") {
      slots.push("19:00");
    }

    return slots;
  };

  // Calcola i minuti totali della timeline globale
  const getGlobalTimelineMinutes = () => {
    const globalStartTime = getGlobalStartTime();
    const [startHour, startMin] = globalStartTime.split(':').map(Number);
    const startMinutes = startHour * 60 + startMin;
    const endMinutes = 19 * 60; // 19:00
    return endMinutes - startMinutes;
  };

  // Genera gli slot una volta sola
  const globalTimeSlots = generateGlobalTimeSlots();
  const globalTimelineMinutes = getGlobalTimelineMinutes();
  const globalStartTime = getGlobalStartTime();

  // Esponi globalTimelineMinutes e globalTimeSlotsCount come variabili globali per permettere a TaskCard di usarle
  // IMPORTANTE: La griglia usa N slot, ma rappresenta N-1 intervalli. Per far corrispondere
  // la larghezza dei task alle colonne della griglia, usiamo N slot * 60 minuti come base.
  React.useEffect(() => {
    (window as any).globalTimelineMinutes = globalTimelineMinutes;
    (window as any).globalTimeSlotsCount = globalTimeSlots.length;
  }, [globalTimelineMinutes, globalTimeSlots.length]);

  // Palette di colori azzurri per i cleaners
  const cleanerColors = [
    { bg: '#0EA5E9', text: '#FFFFFF' }, // Azzurro
    { bg: '#38BDF8', text: '#FFFFFF' }, // Azzurro chiaro
    { bg: '#0284C7', text: '#FFFFFF' }, // Azzurro scuro
    { bg: '#7DD3FC', text: '#000000' }, // Azzurro molto chiaro
    { bg: '#06B6D4', text: '#FFFFFF' }, // Ciano
    { bg: '#22D3EE', text: '#000000' }, // Ciano chiaro
    { bg: '#0891B2', text: '#FFFFFF' }, // Ciano scuro
    { bg: '#67E8F9', text: '#000000' }, // Ciano molto chiaro
    { bg: '#164E63', text: '#FFFFFF' }, // Ciano molto scuro
  ];

  const getCleanerColor = (index: number) => {
    // Colori distribuiti per massimo contrasto visivo tra consecutivi
    const colors = [
      { bg: "#EF4444", text: "#FFFFFF" }, // rosso
      { bg: "#3B82F6", text: "#FFFFFF" }, // blu
      { bg: "#22C55E", text: "#000000" }, // verde
      { bg: "#D946EF", text: "#FFFFFF" }, // fucsia
      { bg: "#F59E0B", text: "#000000" }, // ambra
      { bg: "#8B5CF6", text: "#FFFFFF" }, // viola
      { bg: "#14B8A6", text: "#000000" }, // teal
      { bg: "#F97316", text: "#FFFFFF" }, // arancione
      { bg: "#6366F1", text: "#FFFFFF" }, // indaco
      { bg: "#84CC16", text: "#000000" }, // lime
      { bg: "#EC4899", text: "#FFFFFF" }, // rosa
      { bg: "#0EA5E9", text: "#FFFFFF" }, // sky
      { bg: "#DC2626", text: "#FFFFFF" }, // rosso scuro
      { bg: "#10B981", text: "#000000" }, // smeraldo
      { bg: "#A855F7", text: "#FFFFFF" }, // viola chiaro
      { bg: "#EAB308", text: "#000000" }, // giallo
      { bg: "#06B6D4", text: "#000000" }, // ciano
      { bg: "#F43F5E", text: "#FFFFFF" }, // rose
      { bg: "#2563EB", text: "#FFFFFF" }, // blu scuro
      { bg: "#16A34A", text: "#FFFFFF" }, // verde scuro
      { bg: "#C026D3", text: "#FFFFFF" }, // fucsia scuro
      { bg: "#EA580C", text: "#FFFFFF" }, // arancione scuro
      { bg: "#7C3AED", text: "#FFFFFF" }, // viola medio
      { bg: "#0891B2", text: "#FFFFFF" }, // ciano scuro
      { bg: "#CA8A04", text: "#000000" }, // giallo scuro
      { bg: "#DB2777", text: "#FFFFFF" }, // rosa scuro
      { bg: "#4F46E5", text: "#FFFFFF" }, // indaco scuro
      { bg: "#65A30D", text: "#FFFFFF" }, // lime scuro
      { bg: "#059669", text: "#FFFFFF" }, // smeraldo scuro
      { bg: "#9333EA", text: "#FFFFFF" }, // viola profondo
      { bg: "#D97706", text: "#FFFFFF" }, // ambra scuro
      { bg: "#E11D48", text: "#FFFFFF" }, // rose scuro
      { bg: "#0284C7", text: "#FFFFFF" }, // sky scuro
      { bg: "#15803D", text: "#FFFFFF" }, // verde molto scuro
      { bg: "#0D9488", text: "#FFFFFF" }, // teal scuro
    ];
    return colors[index % colors.length];
  };

  // Funzione per caricare i cleaner da selected_cleaners.json
  const loadCleaners = async (skipLoadSaved = false) => {
    try {
      // Carica sia selected_cleaners.json che timeline.json per verificare la sincronizzazione
      const [selectedResponse, timelineResponse] = await Promise.all([
        fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        }),
        fetch(`/data/output/timeline.json?t=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        })
      ]);

      // Verifica selected_cleaners.json
      if (!selectedResponse.ok) {
        console.warn(`HTTP error loading cleaners! status: ${selectedResponse.status}`);
        setCleaners([]);
        return;
      }

      const contentType = selectedResponse.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.error('Risposta non JSON:', contentType);
        setCleaners([]);
        return;
      }

      const selectedText = await selectedResponse.text();

      // Verifica che il contenuto sia JSON valido
      if (!selectedText.trim().startsWith('{') && !selectedText.trim().startsWith('[')) {
        console.error('File corrotto, non è JSON:', selectedText.substring(0, 100));
        setCleaners([]);
        return;
      }

      const selectedData = JSON.parse(selectedText);
      console.log("Cleaners caricati da selected_cleaners.json:", selectedData);

      // Verifica se timeline.json esiste e ha cleaners
      let timelineCleaners: any[] = [];
      if (timelineResponse.ok) {
        try {
          const timelineText = await timelineResponse.text();

          // Verifica che il contenuto sia JSON valido
          if (!timelineText.trim().startsWith('{') && !timelineText.trim().startsWith('[')) {
            console.warn('Timeline.json corrotto, non è JSON:', timelineText.substring(0, 100));
          } else {
            const timelineData = JSON.parse(timelineText);
            timelineCleaners = timelineData.cleaners_assignments?.map((c: any) => ({
              id: c.cleaner?.id,
              name: c.cleaner?.name,
              lastname: c.cleaner?.lastname,
              role: c.cleaner?.role,
            })).filter((c: any) => c.id) || [];
          }
        } catch (e) {
          console.warn('Errore parsing timeline.json:', e);
        }
      }

      // Se selected_cleaners.json è vuoto MA timeline.json ha cleaners,
      // usa quelli dalla timeline (caso di ritorno a data precedente)
      let cleanersList = selectedData.cleaners || [];
      if (cleanersList.length === 0 && timelineCleaners.length > 0) {
        console.log(`⚠️ selected_cleaners.json vuoto ma timeline.json ha ${timelineCleaners.length} cleaners`);
        console.log('🔄 Caricamento cleaners dalla timeline per visualizzazione');

        // Carica i dati completi dei cleaners da cleaners.json
        const cleanersResponse = await fetch(`/data/cleaners/cleaners.json?t=${Date.now()}`);
        if (cleanersResponse.ok) {
          const cleanersData = await cleanersResponse.json();
          const allCleaners = Object.values(cleanersData.dates || {})
            .flatMap((d: any) => d.cleaners || []);

          cleanersList = timelineCleaners.map((tc: any) => {
            const fullData = allCleaners.find((c: any) => c.id === tc.id);
            return fullData || tc;
          });

          console.log(`✅ Caricati ${cleanersList.length} cleaners dalla timeline`);
        }
      }

      setCleaners(cleanersList);
    } catch (error) {
      console.error("Errore nel caricamento dei cleaners selezionati:", error);
      setCleaners([]);
    }
  };

  const loadAliases = async () => {
    try {
      const response = await fetch(`/data/cleaners/cleaners_aliases.json?t=${Date.now()}`);
      if (!response.ok) {
        console.warn('File aliases non trovato, uso nomi default');
        return;
      }
      const aliasesData = await response.json();
      setCleanersAliases(aliasesData.aliases || {});
      console.log("Alias cleaners caricati:", aliasesData.aliases);
    } catch (error) {
      console.error("Errore nel caricamento degli alias:", error);
    }
  };

  // Funzione per caricare i dati della timeline (inclusi i metadata)
  const loadTimelineData = async () => {
    try {
      const response = await fetch(`/data/output/timeline.json?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      if (!response.ok) {
        console.warn(`Timeline file not found (${response.status}), using empty data`);
        setTimelineData(null); // Resetta i dati se il file non esiste o c'è un errore
        return;
      }
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.warn('Timeline file is not JSON, using empty data');
        setTimelineData(null);
        return;
      }
      const data = await response.json();
      setTimelineData(data);
    } catch (error) {
      console.error("Errore nel caricamento dei dati della timeline:", error);
      setTimelineData(null);
    }
  };

  useEffect(() => {
    loadCleaners();
    loadAliases();
    loadTimelineCleaners();
    loadTimelineData(); // Carica i dati della timeline anche qui

    // Esponi la funzione per ricaricare i cleaners della timeline
    (window as any).loadTimelineCleaners = loadTimelineCleaners;
  }, []);

  const handleCleanerClick = (cleaner: Cleaner, e?: React.MouseEvent) => {
    // Solo click singolo apre il dialog
    if (clickTimer) {
      // È un doppio click, annulla il click singolo
      clearTimeout(clickTimer);
      setClickTimer(null);

      // Gestione doppio click: filtro mappa
      if (filteredCleanerId === cleaner.id) {
        setFilteredCleanerId(null);
        (window as any).mapFilteredCleanerId = null;
        toast({
          title: "Filtro rimosso",
          description: "Ora visualizzi tutti gli appartamenti sulla mappa",
        });
      } else {
        setFilteredCleanerId(cleaner.id);
        (window as any).mapFilteredCleanerId = cleaner.id;
        toast({
          title: "Filtro attivato",
          description: `Visualizzi solo gli appartamenti di ${cleaner.name} ${cleaner.lastname}`,
        });
      }
    } else {
      // Primo click: avvia timer
      const timer = setTimeout(() => {
        // Verifica se ci sono task incompatibili NON ancora ackate
        if (validationRules && cleaner?.role) {
          const cleanerTasks = tasks
            .filter(task => (task as any).assignedCleaner === cleaner.id)
            .map(normalizeTask);

          const incompatibleTasks = cleanerTasks.filter(task => {
            if (canCleanerHandleTaskSync(
              cleaner.role,
              task,
              validationRules,
              cleaner.can_do_straordinaria ?? false
            )) return false;
            const key = getIncompatibleKey(task, cleaner.id);
            return !acknowledgedIncompatibleAssignments.has(key);
          });

          if (incompatibleTasks.length > 0) {
            // Mostra dialog incompatibilità invece del modal normale
            const tasksInfo = incompatibleTasks.map(task => {
              const taskType = task.straordinaria ? 'Straordinaria' : task.premium ? 'Premium' : 'Standard';
              const aptType = (task as any).apt_type || (task as any).aptType || (task as any).type_apt || '';

              // Determina priorità
              const isEarlyOut = Boolean((task as any).early_out || (task as any).earlyOut || (task as any).is_early_out);
              const isHighPriority = Boolean((task as any).high_priority || (task as any).highPriority || (task as any).is_high_priority);
              const priority = isEarlyOut ? 'EO' : isHighPriority ? 'HP' : 'LP';

              let fullType = taskType;
              if (aptType) fullType += ` (Tipo ${aptType})`;
              fullType += ` [${priority}]`;

              return {
                logisticCode: task.name,
                taskType: fullType
              };
            });
            setIncompatibleDialog({ open: true, cleanerId: cleaner.id, tasks: tasksInfo });
            setClickTimer(null);
            return;
          }
        }

        // Singolo click: apri modal normale se non ci sono incompatibilità
        setSelectedCleaner(cleaner);
        // Inizializza l'alias dal cleanersAliases
        const currentAlias = cleanersAliases[cleaner.id]?.alias || "";
        setEditingAlias(currentAlias);
        // Inizializza lo start time
        setEditingStartTime(cleaner.start_time || "10:00");
        setIsModalOpen(true);
        setClickTimer(null);
      }, 250); // 250ms per distinguere singolo da doppio click

      setClickTimer(timer);
    }
  };

  // Funzione per caricare i cleaner disponibili (non già in timeline)
  const loadAvailableCleaners = async () => {
    try {
      // CRITICAL: Prima estrai i cleaners dal database per la data corrente
      // Questo assicura che anche per date future (es. domani) i cleaners siano disponibili
      console.log(`🔄 Estrazione cleaners dal database per ${workDate}...`);
      const extractResponse = await fetch('/api/extract-cleaners-optimized', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: workDate })
      });

      if (!extractResponse.ok) {
        console.error('Errore durante l\'estrazione dei cleaners');
        // Continua comunque a provare a caricare cleaners.json
      } else {
        const extractResult = await extractResponse.json();
        console.log('✅ Cleaners estratti:', extractResult);
      }

      // Carica tutti i cleaners per la data corrente
      const cleanersResponse = await fetch(`/data/cleaners/cleaners.json?t=${Date.now()}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });

      if (!cleanersResponse.ok) {
        console.error('Impossibile caricare cleaners.json');
        setAvailableCleaners([]);
        return;
      }

      const cleanersData = await cleanersResponse.json();
      const dateCleaners = cleanersData.dates?.[workDate]?.cleaners || [];

      console.log(`✅ Cleaners trovati per ${workDate}:`, dateCleaners.length);

      // CRITICAL: Filtra cleaners già presenti in timeline (sia selezionati che rimossi)
      // Questo previene di avere duplicati (cleaner rimosso + stesso cleaner aggiunto)
      const selectedCleanerIds = new Set(cleaners.map(c => c.id));
      const timelineCleanerIds = new Set(timelineCleaners.map(tc => tc.cleaner?.id).filter(Boolean));

      const available = dateCleaners.filter((c: any) =>
        c.active === true &&
        !selectedCleanerIds.has(c.id) &&
        !timelineCleanerIds.has(c.id) // NUOVO: escludi anche quelli già in timeline
      );

      // Ordina per tipologia (Formatori → Straordinari → Premium → Standard)
      // e per ore della settimana (weekly_hours) DESC all'interno di ogni gruppo
      available.sort((a: any, b: any) => {
        const getPriority = (cleaner: any) => {
          // 1. Formatore
          if (cleaner.role === "Formatore") return 1;
          // 2. Straordinario (ruolo esplicito O flag straordinaria attivo)
          if (cleaner.role === "Straordinario" || cleaner.can_do_straordinaria) return 2;
          // 3. Premium
          if (cleaner.role === "Premium") return 3;
          // 4. Standard / qualsiasi altro
          return 4;
        };

        const priorityA = getPriority(a);
        const priorityB = getPriority(b);

        if (priorityA !== priorityB) {
          return priorityA - priorityB;
        }

        // Stessa tipologia → ordina per ore DESC.
        // Usa weekly_hours, se mancante fai fallback su counter_hours.
        const hoursA = Number(
          a.weekly_hours !== undefined && a.weekly_hours !== null
            ? a.weekly_hours
            : a.counter_hours ?? 0
        );
        const hoursB = Number(
          b.weekly_hours !== undefined && b.weekly_hours !== null
            ? b.weekly_hours
            : b.counter_hours ?? 0
        );

        return hoursB - hoursA;
      });

      console.log(`✅ Cleaners disponibili da aggiungere: ${available.length}`);
      setAvailableCleaners(available);
    } catch (error) {
      console.error('Errore nel caricamento dei cleaners disponibili:', error);
      setAvailableCleaners([]);
    }
  };

  // Handler per aprire il dialog di aggiunta cleaner
  const handleOpenAddCleanerDialog = async () => {
    setIsAddCleanerDialogOpen(true); // Apri il dialog subito per mostrare loading
    await loadAvailableCleaners(); // Attendi il caricamento
  };

  // Handler per aggiungere/sostituire un cleaner
  const handleAddCleaner = (cleanerId: number, isAvailable: boolean) => {
    // Trova il nome del cleaner per mostrarlo nel dialog
    const cleaner = availableCleaners.find(c => c.id === cleanerId);
    const cleanerName = cleaner ? `${cleaner.name} ${cleaner.lastname}` : `ID ${cleanerId}`;

    // Imposta il cleaner in pending
    setPendingCleaner(cleaner);

    // Usa start_time esistente del cleaner o default a "10:00"
    const defaultStartTime = cleaner?.start_time || "10:00";

    // Apri il dialog per richiedere lo start time
    setStartTimeDialog({
      open: true,
      cleanerId,
      cleanerName,
      isAvailable
    });
    setPendingStartTime(defaultStartTime); // Usa start_time del cleaner se disponibile
    setIsAddCleanerDialogOpen(false); // Chiudi il dialog di selezione cleaner
  };

  // Handler per confermare start time e aggiungere cleaner
  const handleConfirmStartTimeAndAdd = async () => {
    if (!startTimeDialog.cleanerId) return; // Ensure we have a cleaner ID

    const cleanerId = startTimeDialog.cleanerId;

    try {
      // Salva lo start_time usando l'API dedicata
      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const response = await fetch('/api/update-cleaner-start-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId: cleanerId,
          startTime: pendingStartTime,
          date: workDate,
          modified_by: currentUser.username || 'unknown'
        }),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio dello start time');
      }

      console.log(`✅ Start time ${pendingStartTime} salvato per cleaner ${cleanerId}`);
    } catch (error) {
      console.error("Errore nel salvataggio dello start time:", error);
      toast({
        title: "Errore",
        description: "Impossibile salvare lo start time",
        variant: "destructive",
      });
      return;
    }

    // Aggiorna lo stato locale SUBITO con il nuovo start time
    setAvailableCleaners(prev => prev.map(c =>
      c.id === cleanerId ? { ...c, start_time: pendingStartTime } : c
    ));

    // Se non disponibile, chiedi ulteriore conferma
    if (!startTimeDialog.isAvailable) {
      setConfirmUnavailableDialog({ open: true, cleanerId: cleanerId });
      return;
    }

    // Procedi con l'aggiunta del cleaner (che ora includerà lo start time)
    if ((window as any).setHasUnsavedChanges) {
      (window as any).setHasUnsavedChanges(true);
    }

    if (cleanerToReplace) {
      removeCleanerMutation.mutate(cleanerToReplace, {
        onSuccess: () => {
          addCleanerMutation.mutate(cleanerId);
          setCleanerToReplace(null);
        }
      });
    } else {
      addCleanerMutation.mutate(cleanerId);
    }
    setIsAddCleanerDialogOpen(false);
    setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true }); // Chiudi il dialog dello start time
    setPendingCleaner(null); // Clear pending cleaner
  };


  // Handler per confermare l'aggiunta di un cleaner non disponibile
  const handleConfirmAddUnavailableCleaner = async () => {
    if (confirmUnavailableDialog.cleanerId) {
      // Prima salva lo start time aggiornato
      try {
        const selectedCleanersPath = '/data/cleaners/selected_cleaners.json';
        const selectedResponse = await fetch(`${selectedCleanersPath}?t=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });
        const selectedData = await selectedResponse.json();

        const cleanerIndex = selectedData.cleaners.findIndex((c: Cleaner) => c.id === confirmUnavailableDialog.cleanerId);
        const cleanerToUpdate = selectedData.cleaners[cleanerIndex];

        if (cleanerIndex !== -1) {
          selectedData.cleaners[cleanerIndex] = {
            ...cleanerToUpdate,
            start_time: pendingStartTime,
            available: true // Imposta come disponibile
          };

          // Invia la modifica al backend
          await fetch('/api/update-cleaner-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filePath: selectedCleanersPath,
              data: selectedData,
              date: workDate,
              cleanerId: confirmUnavailableDialog.cleanerId
            }),
          });
          console.log(`✅ Cleaner ${confirmUnavailableDialog.cleanerId} impostato come disponibile con start time ${pendingStartTime}`);
        }
      } catch (error) {
        console.error("Errore nel salvataggio dello start time e disponibilità:", error);
      }

      // Aggiorna lo stato locale per riflettere la modifica
      setAvailableCleaners(prev => prev.map(c =>
        c.id === confirmUnavailableDialog.cleanerId ? { ...c, start_time: pendingStartTime, available: true } : c
      ));


      // Chiudi il dialog di conferma e procedi con l'aggiunta
      setConfirmUnavailableDialog({ open: false, cleanerId: null });

      // Procedi con l'aggiunta/sostituzione come al solito
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
      if (cleanerToReplace) {
        removeCleanerMutation.mutate(cleanerToReplace, {
          onSuccess: () => {
            addCleanerMutation.mutate(confirmUnavailableDialog.cleanerId!);
            setCleanerToReplace(null);
          }
        });
      } else {
        addCleanerMutation.mutate(confirmUnavailableDialog.cleanerId!);
      }
      setIsAddCleanerDialogOpen(false); // Chiudi anche il dialog di aggiunta
      setPendingCleaner(null); // Clear pending cleaner
    }
  };

  // Handler per confermare la rimozione di un cleaner
  const handleConfirmRemoveCleaner = () => {
    if (confirmRemovalDialog.cleanerId) {
      removeCleanerMutation.mutate(confirmRemovalDialog.cleanerId);
      setConfirmRemovalDialog({ open: false, cleanerId: null });
    }
  };

  // Apri dialog modifica alias
  const handleOpenAliasDialog = (cleaner: Cleaner) => {
    const currentAlias = cleanersAliases[cleaner.id]?.alias || "";
    setEditingAlias(currentAlias);
    setAliasDialog({
      open: true,
      cleanerId: cleaner.id,
      cleanerName: `${cleaner.name} ${cleaner.lastname}`
    });
  };

  // Apri dialog modifica start time
  const handleOpenStartTimeDialog = (cleaner: Cleaner) => {
    const currentStartTime = cleaner.start_time || "10:00";
    setEditingStartTime(currentStartTime);
    setStartTimeEditDialog({
      open: true,
      cleanerId: cleaner.id,
      cleanerName: `${cleaner.name} ${cleaner.lastname}`
    });
  };

  // Salva l'alias modificato
  const handleSaveAlias = async () => {
    if (!aliasDialog.cleanerId) return;
    setIsSavingAlias(true);
    try {
      const response = await fetch('/api/update-cleaner-alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId: aliasDialog.cleanerId,
          alias: editingAlias,
        }),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio dell\'alias');
      }

      const result = await response.json();

      // Ricarica gli alias dal file aggiornato
      await loadAliases();

      toast({
        title: "Alias salvato",
        description: `L'alias è stato aggiornato con successo.`,
        variant: "success",
      });

      // Chiudi il dialog
      setAliasDialog({ open: false, cleanerId: null, cleanerName: '' });

    } catch (error: any) {
      console.error("Errore nel salvataggio dell'alias:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare l'alias",
        variant: "destructive",
      });
    } finally {
      setIsSavingAlias(false);
    }
  };

  // Salva lo start time modificato
  const handleSaveStartTime = async () => {
    if (!startTimeEditDialog.cleanerId) return;

    // Valida il formato dell'orario
    if (!/^\d{2}:\d{2}$/.test(editingStartTime)) {
      toast({
        variant: "destructive",
        title: "⚠️ Formato orario non valido",
        description: "Inserisci un orario nel formato HH:mm (es. 10:00)"
      });
      return;
    }

    setIsSavingStartTime(true);
    try {
      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const response = await fetch('/api/update-cleaner-start-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cleanerId: startTimeEditDialog.cleanerId,
          startTime: editingStartTime,
          date: workDate,
          modified_by: currentUser.username || 'unknown'
        }),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio dello start time');
      }

      // Aggiorna lo stato locale
      setCleaners(prev => prev.map(c =>
        c.id === startTimeEditDialog.cleanerId ? { ...c, start_time: editingStartTime } : c
      ));

      // Aggiorna anche selectedCleaner se è lo stesso
      if (selectedCleaner && selectedCleaner.id === startTimeEditDialog.cleanerId) {
        setSelectedCleaner({ ...selectedCleaner, start_time: editingStartTime });
      }

      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }

      toast({
        title: "Start Time salvato",
        description: `Orario di inizio aggiornato a ${editingStartTime}`,
        variant: "success",
      });

      // Chiudi il dialog
      setStartTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' });

    } catch (error: any) {
      console.error("Errore nel salvataggio dello start time:", error);
      toast({
        title: "Errore",
        description: error.message || "Impossibile salvare lo start time",
        variant: "destructive",
      });
    } finally {
      setIsSavingStartTime(false);
    }
  };

  // Calcola la larghezza dinamica della colonna cleaners in base all'alias più lungo
  const calculateCleanerColumnWidth = () => {
    if (cleaners.length === 0) return 96; // default 24 (w-24 = 96px)

    const maxLength = cleaners.reduce((max, cleaner) => {
      const alias = cleanersAliases[cleaner.id]?.alias ||
                    `${cleaner.name} ${cleaner.lastname}`;
      return Math.max(max, alias.length);
    }, 0);

    // Formula: larghezza base + (caratteri * pixel per carattere)
    // Aggiungi spazio extra per il badge
    const baseWidth = 60; // padding e margini
    const charWidth = 7.5; // circa 7.5px per carattere con font bold 13px
    const badgeSpace = 30; // spazio per il badge P/F

    return Math.max(96, baseWidth + (maxLength * charWidth) + badgeSpace);
  };

  const cleanerColumnWidth = calculateCleanerColumnWidth();

  // Gestione fullscreen
  const toggleFullscreen = async () => {
    if (!timelineRef.current) return;

    try {
      if (!isFullscreen) {
        // Entra in fullscreen
        if (timelineRef.current.requestFullscreen) {
          await timelineRef.current.requestFullscreen();
        }
      } else {
        // Esci da fullscreen
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch (error) {
      console.error('Errore fullscreen:', error);
      toast({
        title: "Errore",
        description: "Impossibile attivare/disattivare la modalità a schermo intero",
        variant: "destructive",
      });
    }
  };

  // Listener per cambiamenti fullscreen
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);



  const handleResetAssignments = async () => {
    try {
      // La data è già nel formato corretto yyyy-MM-dd nel localStorage
      const dateStr = localStorage.getItem('selected_work_date') || (() => {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      })();

      // 1. Reset timeline_assignments.json (file principale)
      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const resetResponse = await apiRequest("POST", "/api/reset-timeline-assignments", {
        date: workDate,
        modified_by: currentUser.username || 'unknown'
      });

      if (!resetResponse.ok) {
        throw new Error('Errore nel reset della timeline');
      }

      // 2. CRITICAL: Resetta il lastSavedFilename per indicare che non ci sono salvataggi
      setLastSavedFilename(null);
      localStorage.removeItem('last_saved_assignment');

      // 3. CRITICAL: Ricarica SOLO i file JSON locali senza chiamare extract-data
      // Il backend ha già resettato timeline.json e ricreato containers.json
      // Dobbiamo solo ricaricare il frontend con i nuovi dati
      const timestamp = Date.now();

      // Ricarica containers.json (che ora contiene tutte le task)
      const containersResponse = await fetch(`/data/output/containers.json?t=${timestamp}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });

      // Ricarica timeline.json (che ora è vuota)
      const timelineResponse = await fetch(`/data/output/timeline.json?t=${timestamp}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (containersResponse.ok && timelineResponse.ok) {
        // Triggera il reload dei containers nella pagina principale
        if ((window as any).reloadAllTasks) {
          await (window as any).reloadAllTasks();
        }

        if ((window as any).setHasUnsavedChanges) {
          (window as any).setHasUnsavedChanges(true);
        }
        // Aggiorna i dati della timeline per mostrare i metadata aggiornati
        await loadTimelineData();

        toast({
          title: "Reset completato",
          description: "Timeline svuotata, task tornate nei containers",
          variant: "success",
        });
      } else {
        throw new Error('Errore nel ricaricamento dei file JSON');
      }
    } catch (error) {
      console.error('Errore nel reset:', error);
      toast({
        title: "Errore",
        description: "Errore durante il reset delle assegnazioni",
        variant: "destructive",
      });
    }
  };


  const handleConfirmAssignments = async () => {
    try {
      const dateStr = localStorage.getItem('selected_work_date') || (() => {
        const today = new Date();
        const year = today.getFullYear();
        const month = String(today.getMonth() + 1).padStart(2, '0');
        const day = String(today.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
      })();

      toast({
        title: "Conferma in corso...",
        description: "Salvataggio delle assegnazioni in corso",
      });

      // Chiama l'API per salvare la copia immutabile
      const response = await fetch('/api/confirm-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr }),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio delle assegnazioni');
      }

      const result = await response.json();

      setLastSavedFilename(result.formattedDateTime || result.filename);
      localStorage.setItem('last_saved_assignment', result.formattedDateTime || result.filename);
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(false);
      }

      // Aggiorna i dati della timeline per mostrare i metadata aggiornati
      await loadTimelineData();

      toast({
        title: "✅ Assegnazioni confermate!",
        description: `Salvate il ${result.formattedDateTime}`,
        variant: "success",
      });
    } catch (error) {
      console.error('Errore nella conferma:', error);
      toast({
        title: "Errore",
        description: "Errore durante la conferma delle assegnazioni",
        variant: "destructive",
      });
    }
  };

  const [lastSavedFilename, setLastSavedFilename] = useState<string | null>(null);

  const loadTimelineCleaners = async () => {
    try {
      const response = await fetch(`/data/output/timeline.json?t=${Date.now()}`);
      if (!response.ok) {
        console.warn(`Timeline file not found (${response.status}), using empty timeline`);
        setTimelineCleaners([]);
        return;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.warn('Timeline file is not JSON, using empty timeline');
        setTimelineCleaners([]);
        return;
      }

      const timelineData = await response.json();
      const timelineCleanersList = timelineData.cleaners_assignments || [];
      setTimelineCleaners(timelineCleanersList);
    } catch (error) {
      console.error("Errore nel caricamento timeline cleaners:", error);
      setTimelineCleaners([]);
    }
  };

  // Nota: il tracking delle modifiche avviene SOLO tramite onTaskMoved
  // chiamato esplicitamente durante drag-and-drop e altre azioni utente

  // --- NORMALIZZAZIONI TIMELINE ---
  // NON normalizzare task.type - lo determiniamo dai flag
  const normalizeTask = (task: any) => {
    // Normalizza SOLO i flag straordinaria/premium, NON il type
    const isPremium = Boolean(task.premium);
    const isStraordinaria = Boolean(task.straordinaria);

    // Normalizza confirmed_operation
    const rawConfirmed = task.confirmed_operation;
    const isConfirmedOperation =
      typeof rawConfirmed === "boolean"
        ? rawConfirmed
        : typeof rawConfirmed === "number"
          ? rawConfirmed !== 0
          : typeof rawConfirmed === "string"
            ? ["true", "1", "yes"].includes(rawConfirmed.toLowerCase().trim())
            : false;

    return {
      ...task,
      // NON sovrascrivere task.type - lascialo undefined se non esiste
      premium: isPremium,
      straordinaria: isStraordinaria,
      confirmed_operation: isConfirmedOperation,
    };
  };

  // Gestione toast per incompatibilità task-cleaner (con sistema per coppie)
  useEffect(() => {
    if (!validationRules) return;

    const incompatibleAssignments: Array<{ cleanerId: number; cleanerName: string; role: string; taskNames: string }> = [];

    allCleanersToShow.forEach(cleaner => {
      if (removedCleanerIds.has(cleaner.id)) return;
      if (!cleaner.role) return;

      const cleanerTasks = tasks
        .filter(task => (task as any).assignedCleaner === cleaner.id)
        .map(normalizeTask);

      // CRITICAL: Verifica TUTTE le task incompatibili, ignorando lo stato di acknowledge
      // L'acknowledge serve solo per non mostrare il dialog al click, NON per nascondere i toast
      const incompatibleTasks = cleanerTasks.filter(task => {
        return !canCleanerHandleTaskSync(
          cleaner.role,
          task,
          validationRules,
          cleaner.can_do_straordinaria ?? false
        );
      });

      if (incompatibleTasks.length > 0) {
        incompatibleAssignments.push({
          cleanerId: cleaner.id,
          cleanerName: `${cleaner.name} ${cleaner.lastname}`,
          role: cleaner.role,
          taskNames: incompatibleTasks.map(t => t.name).join(', ')
        });
      }
    });

    // Mostra toast SEMPRE per incompatibilità, resettando i toast mostrati ad ogni cambio
    shownToastsRef.current.clear();

    if (incompatibleAssignments.length > 0) {
      incompatibleAssignments.forEach(assignment => {
        // Crea una chiave univoca per questo toast
        const toastKey = `${assignment.cleanerId}-${assignment.taskNames}`;

        // Mostra solo se non è già stato mostrato in questo ciclo
        if (!shownToastsRef.current.has(toastKey)) {
          shownToastsRef.current.add(toastKey);

          toast({
            title: "⚠️ Assegnazione incompatibile",
            description: `${assignment.cleanerName} (${assignment.role}) ha task incompatibili: ${assignment.taskNames}`,
            variant: "default",
            className: "bg-yellow-200 dark:bg-yellow-800 border-2 border-yellow-600 dark:border-yellow-500 text-yellow-900 dark:text-yellow-50 shadow-lg",
          });
        }
      });
    }
  }, [validationRules, allCleanersToShow, tasks, removedCleanerIds, toast]);

  // Funzione per verificare SE esistono assegnazioni salvate (senza caricarle)
  const checkSavedAssignmentExists = async () => {
    try {
      const response = await fetch('/api/check-saved-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: workDate })
      });

      if (response.ok) {
        const result = await response.json();
        if (result.found && result.formattedDateTime) {
          setLastSavedFilename(result.formattedDateTime);
          localStorage.setItem('last_saved_assignment', result.formattedDateTime);
        } else {
          setLastSavedFilename(null);
          localStorage.removeItem('last_saved_assignment');
        }
      }
    } catch (error) {
      console.error("Errore nel controllo delle assegnazioni salvate:", error);
    }
  };

  // Variabile per determinare se ci sono task assegnate (per mostrare/nascondere pulsante conferma)
  const hasAssignedTasks = tasks.some(task => (task as any).assignedCleaner !== undefined);

  // Mutation per rimuovere task dalla timeline
  const removeTaskMutation = useMutation({
    mutationFn: async ({ taskId, logisticCode }: { taskId: number | string; logisticCode: number | string }) => {
      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const response = await apiRequest("POST", "/api/remove-timeline-assignment", {
        taskId,
        logisticCode,
        date: workDate,
        modified_by: currentUser.username || 'unknown'
      });
      return await response.json();
    },
    onSuccess: async (data) => {
      if (onTaskMoved) onTaskMoved();
      if ((window as any).setHasUnsavedChanges) (window as any).setHasUnsavedChanges(true);
      await loadTimelineCleaners(); // Ricarica i cleaners della timeline
      await loadTimelineData(); // Aggiorna i metadata
      toast({
        title: "Task rimossa",
        description: "Task rimossa dalla timeline",
        variant: "success",
      });
    },
    onError: (error: any) => {
      toast({
        title: "Errore",
        description: error.message || "Impossibile rimuovere la task",
        variant: "destructive",
      });
    },
  });


  // Funzione per il trasferimento dei dati ad ADAM
  const handleTransferToAdam = async () => {
    try {
      setShowAdamTransferDialog(false); // Chiudi il dialog di conferma

      toast({
        title: "Trasferimento in corso...",
        description: "Invio dati al database ADAM",
        variant: "default",
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 secondi timeout

      const currentUser = JSON.parse(localStorage.getItem('currentUser') || '{}');
      const response = await fetch('/api/transfer-to-adam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: workDate,
          username: currentUser.username || 'system'
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Server error: ${response.status} ${response.statusText}`);
      }

      const result = await response.json();

      if (result.success) {
        toast({
          title: "✅ Trasferimento completato",
          description: result.message || `Task aggiornate sul database ADAM`,
        });
      } else {
        toast({
          title: "❌ Errore trasferimento",
          description: result.message || "Errore durante il trasferimento",
          variant: "destructive",
        });
      }
    } catch (error: any) {
      console.error('Errore trasferimento ADAM:', error);
      let errorMessage = "Impossibile comunicare con il server";

      if (error.name === 'AbortError') {
        errorMessage = "Timeout: il server impiega troppo tempo a rispondere";
      } else if (error.message) {
        errorMessage = error.message;
      }

      toast({
        title: "❌ Errore connessione",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <div
        ref={timelineRef}
        className={`bg-custom-blue-light rounded-lg border-2 border-custom-blue shadow-sm ${isFullscreen ? 'fixed inset-0 z-50 overflow-auto' : ''}`}
      >
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <h2 className="text-xl font-bold text-foreground flex items-center">
                <CalendarIcon className="w-5 h-5 mr-2 text-custom-blue" />
                Timeline Assegnazioni - {cleaners.length} Cleaners
              </h2>
              {timelineData?.metadata?.last_modified_by && (
                <p className="text-xs text-muted-foreground">
                  Ultima modifica: {timelineData.metadata.last_modified_by}
                  {timelineData.metadata.last_updated &&
                    ` - ${new Date(timelineData.metadata.last_updated).toLocaleString('it-IT')}`
                  }
                </p>
              )}
            </div>
            <div className="flex gap-3 print:hidden">
              <Button
                onClick={() => setLocation('/convocazioni')}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 border-2 border-custom-blue"
                disabled={isReadOnly}
              >
                <Users className="w-4 h-4" />
                Convocazioni
              </Button>
              <Button
                onClick={handleResetAssignments}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 border-2 border-custom-blue"
                disabled={isReadOnly}
              >
                <RotateCcw className="w-4 h-4" />
                Reset Assegnazioni
              </Button>
            </div>
          </div>
        </div>
        <div className="p-4 overflow-x-auto">
          {/* Header con orari - unico per tutti i cleaner */}
          <div className="flex mb-2 px-4">
            <div className="flex-shrink-0" style={{ width: `${cleanerColumnWidth}px` }}></div>
            <div className="flex-1" style={{ display: 'grid', gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}>
              {globalTimeSlots.map((slot, idx) => (
                <div key={idx} className="text-center text-xs font-semibold text-foreground border-r border-border px-1">
                  {slot}
                </div>
              ))}
            </div>
          </div>

          {/* Righe dei cleaners - mostra solo se ci sono cleaners selezionati */}
          <div className="flex-1 overflow-auto px-4 pb-4">
            {allCleanersToShow.length === 0 && !isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-yellow-100 dark:bg-yellow-950/50 border-2 border-yellow-300 dark:border-yellow-700 rounded-lg">
                <div className="text-center p-6">
                  <Users className="mx-auto h-12 w-12 text-yellow-600 dark:text-yellow-400 mb-3" />
                  <h3 className="text-lg font-semibold text-yellow-800 dark:text-yellow-200 mb-2">
                    Nessun cleaner selezionato
                  </h3>
                  <p className="text-yellow-700 dark:text-yellow-300">
                    Vai alla pagina Convocazioni per selezionare i cleaner da convocare
                  </p>
                </div>
              </div>
            ) : allCleanersToShow.length === 0 && isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-red-50 dark:bg-red-950/20 border-2 border-red-300 dark:border-blue-800 rounded-lg">
                <div className="text-center p-6">
                  <CalendarIcon className="mx-auto h-12 w-12 text-red-600 dark:text-red-400 mb-3" />
                  <h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
                    Nessuna assegnazione presente per questa data
                  </h3>
                  <p className="text-red-700 dark:text-red-300">
                    Non sono disponibili dati salvati per questa data passata
                  </p>
                </div>
              </div>
            ) : (
              allCleanersToShow.map((cleaner, index) => {
                const color = getCleanerColor(index);
                const droppableId = `cleaner-${cleaner.id}`;

                // Trova tutte le task assegnate a questo cleaner
                const cleanerTasks = tasks.filter(task =>
                  (task as any).assignedCleaner === cleaner.id
                ).map(normalizeTask); // Applica la normalizzazione qui

                const isRemoved = removedCleanerIds.has(cleaner.id);

                // Verifica se ci sono task incompatibili per questo cleaner
                // Controlla ogni coppia (task, cleaner) invece del solo cleanerId
                const hasIncompatibleTasks = validationRules && cleaner?.role
                  ? cleanerTasks.some(task => {
                      if (canCleanerHandleTaskSync(
                        cleaner.role,
                        task,
                        validationRules,
                        cleaner.can_do_straordinaria ?? false
                      )) return false;
                      const key = getIncompatibleKey(task, cleaner.id);
                      return !acknowledgedIncompatibleAssignments.has(key);
                    })
                  : false;

                // Usa la timeline globale
                const cleanerStartTime = cleaner.start_time || "10:00";

                return (
                  <div key={cleaner.id} className="flex mb-0.5">
                    {/* Info cleaner */}
                    <div
                      className="flex-shrink-0 p-1 flex items-center border-2 border-custom-blue bg-custom-blue/10 cursor-pointer hover:opacity-90 transition-opacity"
                      style={{
                        width: `${cleanerColumnWidth}px`,
                        boxShadow: hasIncompatibleTasks && !isRemoved
                          ? '0 0 0 3px #EAB308, 0 0 20px 5px rgba(234, 179, 8, 0.6), inset 0 0 15px rgba(234, 179, 8, 0.3)'
                          : filteredCleanerId === cleaner.id ? '0 0 0 3px #3B82F6, 0 0 20px 5px rgba(59, 130, 246, 0.5)' : 'none',
                        transform: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 'scale(1.05)' : 'none',
                        zIndex: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 20 : 'auto',
                        position: 'relative',
                        userSelect: 'none',
                        opacity: isRemoved ? 0.7 : 1,
                        animation: hasIncompatibleTasks && !isRemoved ? 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite' : 'none'
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        if (isRemoved) {
                          // Cleaner rimosso: apri dialog sostituzione
                          setCleanerToReplace(cleaner.id);
                          loadAvailableCleaners();
                          setIsAddCleanerDialogOpen(true);
                        } else {
                          // Cleaner attivo: gestione normale (singolo/doppio click)
                          handleCleanerClick(cleaner, e);
                        }
                      }}
                      title={isRemoved ? "Cleaner rimosso - Click per sostituire" : hasIncompatibleTasks ? "⚠️ Cleaner con task incompatibili" : "Click: dettagli | Doppio click: filtra mappa"}
                    >
                      <div className="w-full flex items-center gap-2">
                        {/* Pallino colorato identificativo */}
                        {!isRemoved && (
                          <div
                            className="flex-shrink-0 w-3 h-3 rounded-full"
                            style={{ backgroundColor: color.bg }}
                          />
                        )}
                        <div className="break-words font-bold text-[13px] flex-1">
                          {cleanersAliases[cleaner.id]?.alias || `${cleaner.name.toUpperCase()} ${cleaner.lastname.toUpperCase()}`}
                        </div>
                        {isRemoved && (
                          <div className="bg-red-600 text-white font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            RIMOSSO
                          </div>
                        )}
                        {/* Se straordinario, mostra SOLO badge S */}
                        {!isRemoved && cleaner.can_do_straordinaria ? (
                          <div className="bg-red-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            S
                          </div>
                        ) : (
                          /* Altrimenti mostra badge role normale */
                          <>
                            {!isRemoved && cleaner.role === "Premium" && (
                              <div className="bg-yellow-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                P
                              </div>
                            )}
                            {!isRemoved && cleaner.role === "Formatore" && (
                              <div className="bg-orange-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                                F
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                    {/* Timeline per questo cleaner - area unica droppable */}
                    <Droppable droppableId={`timeline-${cleaner.id}`} direction="horizontal" isDropDisabled={isReadOnly}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.droppableProps}
                          data-testid={`timeline-cleaner-${cleaner.id}`}
                          data-cleaner-id={cleaner.id}
                          className={`relative min-h-[45px] flex-1 border-l border-border ${
                            snapshot.isDraggingOver && !isReadOnly ? 'bg-primary/20 ring-2 ring-primary' : 'bg-background'
                          }`}
                          style={{
                            zIndex: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 15 : 'auto'
                          }}
                        >
                          {/* Griglia oraria di sfondo (solo visiva) con alternanza colori */}
                          <div className="absolute inset-0 pointer-events-none" style={{ display: 'grid', gridTemplateColumns: `repeat(${globalTimeSlots.length}, 1fr)` }}>
                            {globalTimeSlots.map((slot, idx) => {
                              const isEvenHour = idx % 2 === 0;
                              return (
                                <div
                                  key={idx}
                                  className={`border-r border-border ${
                                    isEvenHour
                                      ? 'bg-blue-50/30 dark:bg-blue-950/10'
                                      : 'bg-sky-100/30 dark:bg-sky-900/10'
                                  }`}
                                  title={slot}
                                ></div>
                              );
                            })}
                          </div>

                          {/* Task posizionate in sequenza con indicatori di travel time */}
                          <div className="relative z-10 flex items-center h-full">
                            {(() => {
                              // Calcola l'array delle task per questo cleaner una sola volta
                              const cleanerTasks = tasks
                                .filter((task) =>
                                  (task as any).assignedCleaner === cleaner.id
                                )
                                .map(normalizeTask)
                                .sort((a, b) => {
                                  const taskA = a as any;
                                  const taskB = b as any;

                                  if (taskA.sequence !== undefined && taskB.sequence !== undefined) {
                                    return taskA.sequence - taskB.sequence;
                                  }

                                  const timeA = taskA.start_time || taskA.fw_start_time || taskA.startTime || "00:00";
                                  const timeB = taskB.start_time || taskB.fw_start_time || taskB.startTime || "00:00";
                                  return timeA.localeCompare(timeB);
                                });

                              return cleanerTasks.map((task, idx) => {
                                const taskObj = task as any;

                                // Per il drag and drop, usa l'indice locale (idx) non globalIndex
                                // React-beautiful-dnd richiede indici sequenziali 0,1,2,3... per ogni Droppable

                                // Leggi travel_time dalla task normalizzata (che viene da timeline_assignments.json)
                                // Prova sia travel_time che travelTime per compatibilità
                                let travelTime = 0;
                                if (taskObj.travel_time !== undefined && taskObj.travel_time !== null) {
                                  travelTime = typeof taskObj.travel_time === 'number'
                                    ? taskObj.travel_time
                                    : parseInt(String(taskObj.travel_time), 10);
                                } else if (taskObj.travelTime !== undefined && taskObj.travelTime !== null) {
                                  travelTime = typeof taskObj.travelTime === 'number'
                                    ? taskObj.travelTime
                                    : parseInt(String(taskObj.travelTime), 10);
                                }

                                // Se il parsing fallisce, usa 0
                                if (isNaN(travelTime)) {
                                  travelTime = 0;
                                }

                                // Calcola offset iniziale basato sulla differenza tra start time del cleaner e start time globale
                                let timeOffset = 0;
                                if (idx === 0) {
                                  const [globalStartHour, globalStartMin] = globalStartTime.split(':').map(Number);
                                  const globalStartMinutes = globalStartHour * 60 + globalStartMin;

                                  const [cleanerStartHour, cleanerStartMin] = cleanerStartTime.split(':').map(Number);
                                  const cleanerStartMinutes = cleanerStartHour * 60 + cleanerStartMin;

                                  // Se il cleaner inizia dopo lo start globale, aggiungi offset
                                  const cleanerOffset = cleanerStartMinutes - globalStartMinutes;
                                  if (cleanerOffset > 0) {
                                    timeOffset = cleanerOffset;
                                  }

                                  // Se la task ha un start_time specifico, aggiungi ulteriore offset
                                  if (taskObj.start_time) {
                                    const [taskHours, taskMinutes] = taskObj.start_time.split(':').map(Number);
                                    const taskStartMinutes = taskHours * 60 + taskMinutes;

                                    const additionalOffset = taskStartMinutes - cleanerStartMinutes;
                                    if (additionalOffset > 0) {
                                      timeOffset += additionalOffset;
                                    }
                                  }
                                }

                                // Calcola larghezza EFFETTIVA in base ai minuti reali di travel_time
                                // Usa la stessa base di calcolo dei task (slot * 60 minuti virtuali)
                                const effectiveTravelMinutes = idx > 0 && travelTime > 0 ? travelTime : 0;
                                const virtualMinutes = globalTimeSlots.length * 60;
                                const totalWidth = effectiveTravelMinutes > 0 ? (effectiveTravelMinutes / virtualMinutes) * 100 : 0;

                                // Usa task.id o task.task_id come chiave univoca (non logistic_code che può essere duplicato)
                                const uniqueKey = taskObj.task_id || taskObj.id;

                                // Verifica compatibilità task-cleaner
                                const isIncompatible = validationRules && cleaner?.role
                                  ? !canCleanerHandleTaskSync(
                                      cleaner.role,
                                      task,
                                      validationRules,
                                      cleaner.can_do_straordinaria ?? false
                                    )
                                  : false;


                                return (
                                  <React.Fragment key={`task-fragment-${uniqueKey}`}>
                                    {/* Spazio vuoto per prima task con offset dal tempo globale */}
                                    {idx === 0 && timeOffset > 0 && (
                                      <div
                                        key={`offset-${uniqueKey}`}
                                        className="flex-shrink-0"
                                        style={{ width: `${(timeOffset / virtualMinutes) * 100}%` }}
                                      />
                                    )}

                                    {/* Indicatore di travel time: solo se idx > 0 E travel_time > 0 */}
                                    {idx > 0 && travelTime > 0 && (
                                      <div
                                        key={`marker-${uniqueKey}`}
                                        className="flex items-center justify-center flex-shrink-0 py-3"
                                        style={{ width: `${totalWidth}%`, minHeight: '50px' }}
                                        title={`${travelTime} min`}
                                      >
                                        <svg
                                          width="20"
                                          height="20"
                                          viewBox="0 0 24 24"
                                          fill="currentColor"
                                          className="text-custom-blue flex-shrink-0"
                                        >
                                          <path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/>
                                        </svg>
                                      </div>
                                    )}

                                    <TaskCard
                                      key={uniqueKey}
                                      task={task}
                                      index={idx}
                                      isInTimeline={true}
                                      allTasks={cleanerTasks}
                                      isDragDisabled={isReadOnly}
                                      isReadOnly={isReadOnly}
                                    />
                                  </React.Fragment>
                                );
                              });
                            })()}
                            {provided.placeholder}
                          </div>
                        </div>
                      )}
                    </Droppable>
                  </div>
                );
              })
            )}

            {/* Riga finale con pulsanti */}
            <div className="flex mb-2">
              {/* Pulsante + sotto il nome dell'ultimo cleaner */}
              <div className="flex-shrink-0 p-1 flex items-center justify-center border border-border" style={{ width: `${cleanerColumnWidth}px` }}>
                <Button
                  onClick={() => {
                    setCleanerToReplace(null);
                    handleOpenAddCleanerDialog();
                  }}
                  variant="ghost"
                  size="sm"
                  className="w-full h-full border-2 border-custom-blue"
                  disabled={isReadOnly}
                >
                  <UserPlus className="w-5 h-5" />
                </Button>
              </div>
              {/* Pulsanti nella riga finale */}
              <div className="flex-1 p-1 border-t border-border flex gap-2">
                {!isReadOnly && (
                  <Button
                    onClick={handleConfirmAssignments}
                    disabled={!hasUnsavedChanges}
                    variant="outline"
                    className={`flex-1 h-full border-2 border-custom-blue ${
                      hasUnsavedChanges
                        ? 'bg-green-600 hover:bg-green-700 text-white animate-pulse'
                        : 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 cursor-default'
                    }`}
                    data-testid="button-confirm-assignments"
                  >
                    <CheckCircle className="w-4 h-4 mr-2" />
                    {hasUnsavedChanges ? 'Conferma Assegnazioni ⚠️' : '✅ Assegnazioni Confermate'}
                  </Button>
                )}
                {isReadOnly && (
                  <Button
                    disabled
                    variant="outline"
                    className="flex-1 h-full border-2 border-custom-blue bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 cursor-default"
                  >
                    📜 Sei in modalità storico
                  </Button>
                )}
                <Button
                  onClick={() => setShowAdamTransferDialog(true)} // Apri il dialog di conferma
                  size="sm"
                  variant="outline"
                  className="ml-2 border-2 border-custom-blue"
                >
                  <svg className="mr-2 h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  Trasferisci su ADAM
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Incompatible Tasks Warning Dialog */}
      <Dialog open={incompatibleDialog.open} onOpenChange={(open) => !open && setIncompatibleDialog({ open: false, cleanerId: null, tasks: [] })}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-yellow-600 dark:text-yellow-400 flex items-center gap-2">
              ⚠️ Attenzione: Task Incompatibili
            </DialogTitle>
            <DialogDescription asChild>
              <div className="text-base space-y-3">
                {incompatibleDialog.cleanerId && (() => {
                  const cleaner = allCleanersToShow.find(c => c.id === incompatibleDialog.cleanerId);
                  return cleaner ? (
                    <>
                      <p className="font-semibold text-foreground">
                        Il cleaner <span className="text-black dark:text-white">{cleaner.name} {cleaner.lastname}</span> ({cleaner.role}) ha delle task non compatibili con il suo ruolo:
                      </p>
                      <ul className="list-disc list-inside space-y-2 pl-2">
                        {incompatibleDialog.tasks.map((task, idx) => (
                          <li key={idx} className="text-foreground">
                            Task <span className="font-bold text-red-600">{task.logisticCode}</span> di tipo <span className="font-bold">{task.taskType}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null;
                })()}
              </div>
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end mt-4">
            <Button
              onClick={() => {
                if (incompatibleDialog.cleanerId) {
                  const cleanerId = incompatibleDialog.cleanerId;
                  const cleaner = allCleanersToShow.find(c => c.id === incompatibleDialog.cleanerId);

                  if (cleaner && validationRules) {
                    // Recupera tutte le task di questo cleaner
                    const cleanerTasks = tasks
                      .filter(task => (task as any).assignedCleaner === cleanerId)
                      .map(normalizeTask);

                    // Aggiungi tutte le coppie (task incompatibile, cleaner) al Set
                    setAcknowledgedIncompatibleAssignments(prev => {
                      const next = new Set(prev);

                      cleanerTasks.forEach(task => {
                        if (!canCleanerHandleTaskSync(
                          cleaner.role,
                          task,
                          validationRules,
                          cleaner.can_do_straordinaria ?? false
                        )) {
                          const key = getIncompatibleKey(task, cleanerId);
                          next.add(key);
                        }
                      });

                      return next;
                    });
                  }
                }
                setIncompatibleDialog({ open: false, cleanerId: null, tasks: [] });
              }}
              variant="outline"
              className="border-2 border-custom-blue"
            >
              Ho capito
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Alias Edit Dialog */}
      <Dialog open={aliasDialog.open} onOpenChange={(open) => !open && setAliasDialog({ open: false, cleanerId: null, cleanerName: '' })}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Alias
            </DialogTitle>
            <DialogDescription>
              Stai modificando l'alias di <strong>{aliasDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Nuovo Alias
              </label>
              <Input
                value={editingAlias}
                onChange={(e) => setEditingAlias(e.target.value)}
                placeholder="Inserisci alias"
                className="w-full"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveAlias();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAliasDialog({ open: false, cleanerId: null, cleanerName: '' })}
              disabled={isSavingAlias}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveAlias}
              disabled={isSavingAlias}
              className="border-2 border-custom-blue"
            >
              {isSavingAlias ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Salvataggio...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Salva
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Start Time Edit Dialog */}
      <Dialog open={startTimeEditDialog.open} onOpenChange={(open) => !open && setStartTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' })}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Pencil className="w-5 h-5 text-custom-blue" />
              Modifica Start Time
            </DialogTitle>
            <DialogDescription>
              Stai modificando l'orario di inizio di <strong>{startTimeEditDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Nuovo Start Time
              </label>
              <Input
                type="time"
                value={editingStartTime}
                onChange={(e) => setEditingStartTime(e.target.value)}
                placeholder="Inserisci orario (HH:mm)"
                className="w-full"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleSaveStartTime();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStartTimeEditDialog({ open: false, cleanerId: null, cleanerName: '' })}
              disabled={isSavingStartTime}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleSaveStartTime}
              disabled={isSavingStartTime}
              className="border-2 border-custom-blue"
            >
              {isSavingStartTime ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Salvataggio...
                </>
              ) : (
                <>
                  <Save className="w-4 h-4 mr-2" />
                  Salva
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Cleaner Removal */}
      <Dialog open={confirmRemovalDialog.open} onOpenChange={(open) => setConfirmRemovalDialog({ open, cleanerId: null })}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle>Conferma Rimozione Cleaner</DialogTitle>
            <DialogDescription>
              Sei sicuro di voler rimuovere "{confirmRemovalDialog.cleanerId ? (() => {
                const cleaner = allCleanersToShow.find(c => c.id === confirmRemovalDialog.cleanerId);
                return cleaner ? `${cleaner.name} ${cleaner.lastname}` : 'Unknown';
              })() : ''}" dalla selezione? Le sue task rimarranno in timeline finché non verrà sostituito.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setConfirmRemovalDialog({ open: false, cleanerId: null })}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              onClick={handleConfirmRemoveCleaner}
              variant="destructive"
            >
              Conferma Rimozione
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Cleaner Dialog */}
      <Dialog open={isAddCleanerDialogOpen} onOpenChange={(open) => {
        setIsAddCleanerDialogOpen(open);
        if (!open) {
          setCleanerToReplace(null);
          setConfirmUnavailableDialog({ open: false, cleanerId: null }); // Chiudi anche il dialog di conferma
          setPendingCleaner(null); // Clear pending cleaner when dialog is closed
        }
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {cleanerToReplace ? "Sostituisci Cleaner Rimosso" : "Aggiungi Cleaner alla Timeline"}
            </DialogTitle>
            <DialogDescription>
              {cleanerToReplace ? (
                <>
                  Sostituendo <strong>
                    {(() => {
                      const removedCleaner = allCleanersToShow.find(c => c.id === cleanerToReplace);
                      return removedCleaner
                        ? `${removedCleaner.name} ${removedCleaner.lastname}`
                        : `ID ${cleanerToReplace}`;
                    })()}
                  </strong> - Le sue task verranno assegnate al nuovo cleaner
                </>
              ) : (
                "Seleziona un cleaner disponibile da aggiungere alla timeline"
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-4">
            {availableCleaners.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <RefreshCw className="h-6 w-6 animate-spin text-custom-blue mr-2" />
                <p className="text-muted-foreground">Caricamento cleaners disponibili...</p>
              </div>
            ) : (
              availableCleaners.map((cleaner) => {
                const isAvailable = cleaner.available !== false;

                return (
                  <div
                    key={cleaner.id}
                    className={`flex items-center justify-between p-3 border rounded-lg cursor-pointer ${
                      !isAvailable ? 'opacity-70 hover:opacity-80' : 'hover:bg-accent'
                    }`}
                    onClick={() => handleAddCleaner(cleaner.id, isAvailable)}
                    data-testid={`cleaner-option-${cleaner.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-semibold">
                          {cleaner.name} {cleaner.lastname}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {cleaner.role} • Contratto: {cleaner.contract_type} • {cleaner.counter_hours?.toFixed(2) || '0.00'}h
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {!isAvailable && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                          Non disponibile
                        </span>
                      )}
                      {cleaner.role === "Formatore" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                          Formatore
                        </span>
                      )}
                      {cleaner.role === "Standard" && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                          Standard
                        </span>
                      )}
                      {cleaner.can_do_straordinaria && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700">
                          Straordinario
                        </span>
                      )}
                      {cleaner.role === "Premium" && !cleaner.can_do_straordinaria && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700">
                          Premium
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Dialog per richiedere start time */}
      <Dialog open={startTimeDialog.open} onOpenChange={(open) => {
        if (!open) {
          setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
          // Riapri il dialog di selezione cleaner se l'utente annulla
          setIsAddCleanerDialogOpen(true);
        }
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Inserisci Start Time</DialogTitle>
            <DialogDescription>
              Inserisci l'orario di inizio per <strong>{startTimeDialog.cleanerName}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 mt-4">
            <div>
              <label className="text-sm font-semibold text-muted-foreground mb-2 block">
                Start Time
              </label>
              <div className="flex items-center justify-center gap-1 bg-background border-2 border-custom-blue rounded-lg px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingStartTime.split(':').map(Number);
                    let totalMinutes = hours * 60 + minutes - 30;
                    if (totalMinutes < 0) totalMinutes += 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                    setPendingStartTime(newTime);
                  }}
                >
                  <span className="text-lg font-bold">−</span>
                </Button>
                <span className="text-lg font-mono font-bold min-w-[60px] text-center">
                  {pendingStartTime}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                  onClick={(e) => {
                    e.stopPropagation();
                    const [hours, minutes] = pendingStartTime.split(':').map(Number);
                    let totalMinutes = hours * 60 + minutes + 30;
                    if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                    const newHours = Math.floor(totalMinutes / 60);
                    const newMinutes = totalMinutes % 60;
                    const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                    setPendingStartTime(newTime);
                  }}
                >
                  <span className="text-lg font-bold">+</span>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Usa i pulsanti + e − per regolare a intervalli di 30 minuti
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-6">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStartTimeDialog({ open: false, cleanerId: null, cleanerName: '', isAvailable: true });
                setIsAddCleanerDialogOpen(true);
              }}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleConfirmStartTimeAndAdd}
              className="border-2 border-custom-blue"
            >
              Conferma e Aggiungi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Unavailable Cleaners */}
      <Dialog open={confirmUnavailableDialog.open} onOpenChange={(open) => setConfirmUnavailableDialog({ open, cleanerId: null })}>
        <DialogContent className="sm:max-md">
          <DialogHeader>
            <DialogTitle>Conferma Aggiunta Cleaner</DialogTitle>
            <DialogDescription>
              Il cleaner selezionato "{confirmUnavailableDialog.cleanerId ? (() => {
                const cleaner = availableCleaners.find(c => c.id === confirmUnavailableDialog.cleanerId);
                return cleaner ? `${cleaner.name} ${cleaner.lastname}` : 'Unknown';
              })() : ''}" non è attualmente disponibile. Vuoi comunque aggiungerlo?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setConfirmUnavailableDialog({ open: false, cleanerId: null })}
              className="border-2 border-custom-blue"
            >
              Annulla
            </Button>
            <Button
              onClick={handleConfirmAddUnavailableCleaner}
              className="bg-custom-blue hover:bg-custom-blue/90 text-white"
            >
              Conferma e Aggiungi
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Cleaner Details Dialog */}
      <Dialog open={isModalOpen} onOpenChange={setIsModalOpen}>
        <DialogContent className={`sm:max-w-2xl max-h-[80vh] overflow-y-auto ${
          selectedCleaner?.can_do_straordinaria
            ? "bg-red-100/50 dark:bg-red-950/50 border-2 border-red-300 dark:border-red-700"
            : selectedCleaner?.role === "Formatore"
            ? "bg-orange-100/50 dark:bg-orange-950/50 border-2 border-orange-300 dark:border-orange-700"
            : selectedCleaner?.role === "Premium"
            ? "bg-yellow-100/50 dark:bg-yellow-950/50 border-2 border-yellow-300 dark:border-yellow-700"
            : selectedCleaner?.role === "Standard"
            ? "bg-green-100/50 dark:bg-green-950/50 border-2 border-green-300 dark:border-green-700"
            : ""
        }`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Dettagli Cleaner #{selectedCleaner?.id}
              {selectedCleaner && (
                <>
                  {/* Se straordinario, mostra SOLO badge straordinario */}
                  {selectedCleaner.can_do_straordinaria ? (
                    <span className="px-2 py-0.5 rounded border font-medium text-sm bg-red-500/20 text-red-700 dark:text-red-300 border-red-500">
                      Straordinario
                    </span>
                  ) : (
                    /* Altrimenti mostra badge role normale */
                    <>
                      {selectedCleaner.role === "Formatore" ? (
                        <span className="px-2 py-0.5 rounded border font-medium text-sm bg-orange-500/30 text-orange-800 dark:bg-orange-500/40 dark:text-orange-200 border-orange-600 dark:border-orange-400">
                          Formatore
                        </span>
                      ) : selectedCleaner.role === "Premium" ? (
                        <span className="px-2 py-0.5 rounded border font-medium text-sm bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400">
                          Premium
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded border font-medium text-sm bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400">
                          Standard
                        </span>
                      )}
                    </>
                  )}
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedCleaner && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                    Alias
                    {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                  </p>
                  <p
                    className={`text-sm p-2 rounded border ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50 border-border hover:border-custom-blue' : 'border-border'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) handleOpenAliasDialog(selectedCleaner);
                    }}
                  >
                    {cleanersAliases[selectedCleaner.id]?.alias || `${selectedCleaner.name} ${selectedCleaner.lastname}`}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-1">Nome</p>
                    <p className="text-sm">{selectedCleaner.name.toUpperCase()}</p>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-muted-foreground mb-1">Cognome</p>
                    <p className="text-sm">{selectedCleaner.lastname.toUpperCase()}</p>
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Giorni lavorati</p>
                  <p className="text-sm">{selectedCleaner.counter_days}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Ore lavorate questa settimana</p>
                  <p className="text-sm">{selectedCleaner.counter_hours}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                    Start Time
                    {!isReadOnly && <Pencil className="w-3 h-3 text-muted-foreground/60" />}
                  </p>
                  <p
                    className={`text-sm p-2 rounded border ${!isReadOnly ? 'cursor-pointer hover:bg-muted/50 border-border hover:border-custom-blue' : 'border-border'}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!isReadOnly) handleOpenStartTimeDialog(selectedCleaner);
                    }}
                  >
                    {selectedCleaner.start_time || "10:00"}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Tipo contratto</p>
                  <p className="text-sm">{selectedCleaner.contract_type}</p>
                </div>
              </div>

              {/* Sezione Scambia Cleaner */}
              <div className="border-t pt-4 mt-4">
                <p className="text-sm font-semibold text-muted-foreground mb-3">
                  Scambia Cleaner
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  Seleziona un altro cleaner per scambiare le task assegnate.
                </p>
                <div className="flex gap-3 items-end">
                  <div className="flex-1">
                    <Select
                      value={selectedSwapCleaner}
                      onValueChange={setSelectedSwapCleaner}
                      disabled={swapCleanersMutation.isPending || isReadOnly}
                    >
                      <SelectTrigger data-testid="select-swap-cleaner">
                        <SelectValue placeholder="Seleziona cleaner..." />
                      </SelectTrigger>
                      <SelectContent>
                        {cleaners
                          .filter(c => c.id !== selectedCleaner.id) // Escludi cleaner corrente
                          .map(cleaner => (
                            <SelectItem
                              key={cleaner.id}
                              value={String(cleaner.id)}
                              data-testid={`option-cleaner-${cleaner.id}`}
                            >
                              {cleaner.name} {cleaner.lastname}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    onClick={handleSwapCleaners}
                    disabled={!selectedSwapCleaner || swapCleanersMutation.isPending || isReadOnly}
                    variant="default"
                    className="flex gap-2"
                    data-testid="button-swap-cleaner"
                  >
                    {swapCleanersMutation.isPending ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Scambio...
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4" />
                        Scambia
                      </>
                    )}
                  </Button>
                </div>
              </div>

              {/* Sezione Rimuovi Cleaner */}
              <div className="border-t pt-4 mt-4">
                <p className="text-sm font-semibold text-muted-foreground mb-3">
                  Rimuovi Cleaner
                </p>
                <p className="text-xs text-muted-foreground mb-3">
                  Il cleaner sarà rimosso dalla selezione, ma le sue task rimarranno in timeline. Sarà necessario assegnarle a un altro cleaner.
                </p>
                <Button
                  onClick={() => {
                    setConfirmRemovalDialog({ open: true, cleanerId: selectedCleaner.id });
                    setIsModalOpen(false);
                  }}
                  disabled={removeCleanerMutation.isPending || isReadOnly}
                  variant="destructive"
                  className="w-full"
                  data-testid="button-remove-cleaner"
                >
                  Rimuovi dalla selezione
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Dialog di conferma per il trasferimento su ADAM */}
      <AlertDialog open={showAdamTransferDialog} onOpenChange={setShowAdamTransferDialog}>
        <AlertDialogContent className="sm:max-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
              <CheckCircle className="w-5 h-5" />
              Conferma Trasferimento su ADAM
            </AlertDialogTitle>
            <AlertDialogDescription>
              <p className="text-base text-foreground font-semibold mb-3">
                Salvando su ADAM eventuali assegnazioni salvate precedentemente in questa data, VERRANNO SOVRASCRITTE!
              </p>
              <p className="text-sm text-muted-foreground">
                Sei sicuro di voler procedere? Questa azione è irreversibile.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => setShowAdamTransferDialog(false)}
              className="border-2 border-custom-blue"
            >
              Annulla
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTransferToAdam}
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Ho capito
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}