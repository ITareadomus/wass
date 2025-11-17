import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar as CalendarIcon, RotateCcw, Users, RefreshCw, UserPlus, Maximize2, Minimize2, Check, CheckCircle } from "lucide-react";
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
  const { toast } = useToast();
  const [, setLocation] = useLocation();

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

  // Normalizza la data da localStorage per coerenza ovunque
  const workDate = localStorage.getItem('selected_work_date') || (() => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  })();



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
        : `${selectedCleaner?.name} ${selectedCleaner?.lastname} è stato rimosso dalla selezione. Le sue task rimangono in timeline.`;

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
      // CRITICAL: Marca modifiche SOLO dopo azioni utente
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
      if (onTaskMoved) {
        onTaskMoved();
      }

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
      // CRITICAL: Marca modifiche SOLO dopo azioni utente
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
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

  const timeSlots = [
    "10:00", "11:00", "12:00", "13:00", "14:00",
    "15:00", "16:00", "17:00", "18:00", "19:00"
  ];

  // Palette di colori azzurri per i cleaners
  const cleanerColors = [
    { bg: '#0EA5E9', text: '#FFFFFF' }, // Azzurro
    { bg: '#38BDF8', text: '#FFFFFF' }, // Azzurro chiaro
    { bg: '#0284C7', text: '#FFFFFF' }, // Azzurro scuro
    { bg: '#7DD3FC', text: '#000000' }, // Azzurro molto chiaro
    { bg: '#075985', text: '#FFFFFF' }, // Azzurro molto scuro
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
        throw new Error(`HTTP error! status: ${selectedResponse.status}`);
      }

      const contentType = selectedResponse.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.error('Risposta non JSON:', contentType);
        setCleaners([]);
        return;
      }

      const selectedData = await selectedResponse.json();
      console.log("Cleaners caricati da selected_cleaners.json:", selectedData);

      // Verifica se timeline.json esiste e ha cleaners
      let timelineCleaners: any[] = [];
      if (timelineResponse.ok) {
        try {
          const timelineData = await timelineResponse.json();
          timelineCleaners = timelineData.cleaners_assignments?.map((c: any) => ({
            id: c.cleaner?.id,
            name: c.cleaner?.name,
            lastname: c.cleaner?.lastname,
            role: c.cleaner?.role,
          })).filter((c: any) => c.id) || [];
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

  const handleCleanerClick = (cleaner: Cleaner, e: React.MouseEvent) => {
    e.preventDefault();

    // Se c'è già un timer attivo, è un doppio click
    if (clickTimer) {
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
        // Verifica se ci sono task incompatibili
        if (validationRules && cleaner?.role) {
          const cleanerTasks = tasks
            .filter(task => (task as any).assignedCleaner === cleaner.id)
            .map(normalizeTask);

          const incompatibleTasks = cleanerTasks.filter(
            task => !canCleanerHandleTaskSync(cleaner.role, task, validationRules)
          );

          if (incompatibleTasks.length > 0) {
            // Mostra dialog incompatibilità invece del modal normale
            const tasksInfo = incompatibleTasks.map(task => ({
              logisticCode: task.name,
              taskType: task.straordinaria ? 'Straordinaria' : task.premium ? 'Premium' : 'Standard'
            }));
            setIncompatibleDialog({ open: true, cleanerId: cleaner.id, tasks: tasksInfo });
            setClickTimer(null);
            return;
          }
        }

        // Singolo click: apri modal normale se non ci sono incompatibilità
        setSelectedCleaner(cleaner);
        setIsModalOpen(true);
        setClickTimer(null);
      }, 250); // 250ms per distinguere singolo da doppio click

      setClickTimer(timer);
    }
  };

  // Funzione per caricare i cleaners disponibili (non già in timeline)
  const loadAvailableCleaners = async () => {
    try {
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

      // Filtra solo i cleaners attivi e non già selezionati
      const selectedCleanerIds = new Set(cleaners.map(c => c.id));
      const available = dateCleaners.filter((c: any) =>
        c.active === true && !selectedCleanerIds.has(c.id)
      );

      // Ordina per counter_hours (decrescente)
      available.sort((a: any, b: any) => b.counter_hours - a.counter_hours);

      setAvailableCleaners(available);
    } catch (error) {
      console.error('Errore nel caricamento dei cleaners disponibili:', error);
      setAvailableCleaners([]);
    }
  };

  // Handler per aprire il dialog di aggiunta cleaner
  const handleOpenAddCleanerDialog = () => {
    loadAvailableCleaners();
    setIsAddCleanerDialogOpen(true);
  };

  // Handler per aggiungere/sostituire un cleaner
  const handleAddCleaner = (cleanerId: number, isAvailable: boolean) => {
    if (!isAvailable) {
      // Se il cleaner non è disponibile, apri il dialog di conferma
      setConfirmUnavailableDialog({ open: true, cleanerId: cleanerId });
    } else {
      // Altrimenti, procedi con l'aggiunta/sostituzione normale
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }
      if (cleanerToReplace) {
        // Sostituzione: prima rimuovi il vecchio, poi aggiungi il nuovo
        removeCleanerMutation.mutate(cleanerToReplace, {
          onSuccess: () => {
            addCleanerMutation.mutate(cleanerId);
            setCleanerToReplace(null);
          }
        });
      } else {
        // Aggiunta normale
        addCleanerMutation.mutate(cleanerId);
      }
      setIsAddCleanerDialogOpen(false); // Chiudi il dialog di aggiunta
    }
  };

  // Handler per confermare l'aggiunta di un cleaner non disponibile
  const handleConfirmAddUnavailableCleaner = () => {
    if (confirmUnavailableDialog.cleanerId) {
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
    }
  };

  // Handler per confermare la rimozione di un cleaner
  const handleConfirmRemoveCleaner = () => {
    if (confirmRemovalDialog.cleanerId) {
      removeCleanerMutation.mutate(confirmRemovalDialog.cleanerId);
      setConfirmRemovalDialog({ open: false, cleanerId: null });
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

  // Carica anche i cleaner dalla timeline.json per mostrare quelli nascosti
  const [timelineCleaners, setTimelineCleaners] = useState<any[]>([]);

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

  // Mostra cleaners da selected_cleaners.json + cleaners che hanno task in timeline.json
  // Questo permette di vedere cleaners rimossi che hanno ancora task assegnate
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

  // Gestione toast per incompatibilità task-cleaner
  useEffect(() => {
    if (!validationRules) return;

    const incompatibleAssignments: Array<{ cleanerId: number; cleanerName: string; role: string; taskNames: string }> = [];

    allCleanersToShow.forEach(cleaner => {
      if (removedCleanerIds.has(cleaner.id)) return;
      if (!cleaner.role) return;

      const cleanerTasks = tasks
        .filter(task => (task as any).assignedCleaner === cleaner.id)
        .map(normalizeTask);

      const incompatibleTasks = cleanerTasks.filter(
        task => !canCleanerHandleTaskSync(cleaner.role, task, validationRules)
      );

      if (incompatibleTasks.length > 0) {
        incompatibleAssignments.push({
          cleanerId: cleaner.id,
          cleanerName: `${cleaner.name} ${cleaner.lastname}`,
          role: cleaner.role,
          taskNames: incompatibleTasks.map(t => t.name).join(', ')
        });
      }
    });

    // Mostra toast solo se ci sono incompatibilità E non sono già state notificate
    if (incompatibleAssignments.length > 0) {
      incompatibleAssignments.forEach(assignment => {
        // Crea una chiave univoca per questo toast
        const toastKey = `${assignment.cleanerId}-${assignment.taskNames}`;
        
        // Mostra solo se non è già stato mostrato
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
    
    // Pulisci i toast mostrati quando non ci sono più incompatibilità
    if (incompatibleAssignments.length === 0) {
      shownToastsRef.current.clear();
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
          {/* Header con orari */}
          <div className="flex mb-2 px-4">
            <div className="flex-shrink-0" style={{ width: `${cleanerColumnWidth}px` }}></div>
            <div className="flex-1 grid grid-cols-10">
              {timeSlots.map((slot, idx) => (
                <div
                  key={slot}
                  className="text-center text-sm font-medium text-muted-foreground border-l border-border first:border-l-0 py-1"
                >
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
                const hasIncompatibleTasks = validationRules && cleaner?.role
                  ? cleanerTasks.some(task => !canCleanerHandleTaskSync(cleaner.role, task, validationRules))
                  : false;

                return (
                  <div key={cleaner.id} className="flex mb-0.5">
                    {/* Info cleaner */}
                    <div
                      className="flex-shrink-0 p-1 flex items-center border cursor-pointer hover:opacity-90 transition-opacity"
                      style={{
                        width: `${cleanerColumnWidth}px`,
                        backgroundColor: isRemoved
                          ? '#9CA3AF' // Grigio per cleaners rimossi
                          : filteredCleanerId === cleaner.id ? `${color.bg}` : color.bg,
                        color: isRemoved ? '#1F2937' : color.text,
                        boxShadow: hasIncompatibleTasks && !isRemoved
                          ? '0 0 0 3px #EAB308, 0 0 20px 5px rgba(234, 179, 8, 0.6), inset 0 0 15px rgba(234, 179, 8, 0.3)'
                          : filteredCleanerId === cleaner.id
                            ? '0 0 0 3px #3B82F6, 0 0 20px 5px rgba(59, 130, 246, 0.5)'
                            : 'none',
                        transform: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 'scale(1.05)' : 'none',
                        zIndex: filteredCleanerId === cleaner.id || hasIncompatibleTasks ? 10 : 'auto',
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
                      <div className="w-full flex items-center gap-1">
                        <div className="break-words font-bold text-[13px] flex-1">
                          {cleanersAliases[cleaner.id]?.alias || `${cleaner.name.toUpperCase()} ${cleaner.lastname.toUpperCase()}`}
                        </div>
                        {isRemoved && (
                          <div className="bg-red-600 text-white font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0 animate-pulse">
                            RIMOSSO
                          </div>
                        )}
                        {!isRemoved && cleaner.role === "Premium" && (
                          <div className="bg-yellow-500 text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            P
                          </div>
                        )}
                        {!isRemoved && cleaner.role === "Formatore" && (
                          <div className="bg-orange-500 text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            F
                          </div>
                        )}
                        {!isRemoved && cleaner.can_do_straordinaria && (
                          <div className="bg-red-500 text-white font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                            S
                          </div>
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
                          className={`relative min-h-[45px] flex-1 ${
                            snapshot.isDraggingOver && !isReadOnly ? 'bg-primary/20 ring-2 ring-primary' : ''
                          }`}
                          style={{
                            backgroundColor: snapshot.isDraggingOver && !isReadOnly
                              ? `${color.bg}40`
                              : `${color.bg}10`
                          }}
                        >
                          {/* Griglia oraria di sfondo (solo visiva) */}
                          <div className="absolute inset-0 grid grid-cols-10 pointer-events-none opacity-10">
                            {timeSlots.map((slot, idx) => (
                              <div key={idx} className="border-r border-border"></div>
                            ))}
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

                                // Calcola offset dinamico basato su start_time della task
                                let timeOffset = 0;
                                if (idx === 0 && taskObj.start_time) {
                                  // La timeline inizia alle 10:00 (= 0 minuti dall'inizio)
                                  const [hours, minutes] = taskObj.start_time.split(':').map(Number);
                                  const taskStartMinutes = (hours * 60 + minutes) - (10 * 60); // minuti dall'inizio timeline
                                  if (taskStartMinutes > 0) {
                                    timeOffset = taskStartMinutes; // offset in minuti
                                  }
                                }

                                // Calcola larghezza EFFETTIVA in base ai minuti reali di travel_time
                                // La timeline copre 600 minuti (10:00-19:00)
                                // Per idx=0 (prima task), non c'è travel time indicator
                                // Per idx>0, mostra l'indicatore SOLO se c'è travel_time > 0
                                const effectiveTravelMinutes = idx > 0 && travelTime > 0 ? travelTime : 0;
                                const totalWidth = effectiveTravelMinutes > 0 ? (effectiveTravelMinutes / 600) * 100 : 0;

                                // Usa task.id o task.task_id come chiave univoca (non logistic_code che può essere duplicato)
                                const uniqueKey = taskObj.task_id || taskObj.id;

                                // Verifica compatibilità task-cleaner
                                const isIncompatible = validationRules && cleaner?.role
                                  ? !canCleanerHandleTaskSync(cleaner.role, task, validationRules)
                                  : false;


                                return (
                                  <>
                                    {/* Spazio vuoto per prima task con start_time posticipato */}
                                    {idx === 0 && timeOffset > 0 && (
                                      <div
                                        key={`offset-${uniqueKey}`}
                                        className="flex-shrink-0"
                                        style={{ width: `${(timeOffset / 600) * 100}%` }}
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
                                      isIncompatible={isIncompatible}
                                    />
                                  </>
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
            <DialogDescription className="text-base space-y-3">
              {incompatibleDialog.cleanerId && (() => {
                const cleaner = allCleanersToShow.find(c => c.id === incompatibleDialog.cleanerId);
                return cleaner ? (
                  <>
                    <p className="font-semibold text-foreground">
                      Il cleaner <span className="text-yellow-600 dark:text-yellow-400">{cleaner.name} {cleaner.lastname}</span> ({cleaner.role}) ha delle task non compatibili con il suo ruolo:
                    </p>
                    <ul className="list-disc list-inside space-y-2 pl-2">
                      {incompatibleDialog.tasks.map((task, idx) => (
                        <li key={idx} className="text-foreground">
                          Task <span className="font-bold text-red-600">{task.logisticCode}</span> di tipo <span className="font-bold">{task.taskType}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-sm text-muted-foreground mt-4">
                      Si consiglia di riassegnare queste task a un cleaner più appropriato.
                    </p>
                  </>
                ) : null;
              })()}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end mt-4">
            <Button
              onClick={() => setIncompatibleDialog({ open: false, cleanerId: null, tasks: [] })}
              className="bg-yellow-600 hover:bg-yellow-700 text-white"
            >
              Ho capito
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmation Dialog for Cleaner Removal */}
      <Dialog open={confirmRemovalDialog.open} onOpenChange={(open) => setConfirmRemovalDialog({ open, cleanerId: null })}>
        <DialogContent className="sm:max-w-md">
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
              <p className="text-center text-muted-foreground py-8">
                Nessun cleaner disponibile da aggiungere
              </p>
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
                        <span className="px-2 py-1 rounded bg-gray-400 text-white text-xs font-bold">
                          Non disponibile
                        </span>
                      )}
                      {cleaner.role === "Premium" && (
                        <span className="px-2 py-1 rounded bg-yellow-400 text-black text-xs font-bold">
                          Premium
                        </span>
                      )}
                      {cleaner.role === "Formatore" && (
                        <span className="px-2 py-1 rounded bg-orange-500 text-black text-xs font-bold">
                          Formatore
                        </span>
                      )}
                      {cleaner.role === "Standard" && (
                        <span className="px-2 py-1 rounded bg-green-500 text-white text-xs font-bold">
                          Standard
                        </span>
                      )}
                      {cleaner.can_do_straordinaria && (
                        <span className="px-2 py-1 rounded bg-red-500 text-black text-xs font-bold">
                          Straordinario
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

      {/* Confirmation Dialog for Unavailable Cleaners */}
      <Dialog open={confirmUnavailableDialog.open} onOpenChange={(open) => setConfirmUnavailableDialog({ open, cleanerId: null })}>
        <DialogContent className="sm:max-w-md">
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
          selectedCleaner?.role === "Formatore"
            ? "border-4 border-orange-500 bg-orange-500/30"
            : selectedCleaner?.role === "Premium"
            ? "border-4 border-yellow-500 bg-yellow-500/30"
            : selectedCleaner?.role === "Standard"
            ? "border-4 border-green-500 bg-green-500/30"
            : ""
        }`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              Dettagli Cleaner #{selectedCleaner?.id}
              {selectedCleaner && (
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
                  {selectedCleaner.can_do_straordinaria && (
                    <span className="px-2 py-0.5 rounded border font-medium text-sm bg-red-500/20 text-red-700 dark:text-red-300 border-red-500">
                      Straordinario
                    </span>
                  )}
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedCleaner && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Nome</p>
                  <p className="text-sm">{selectedCleaner.name.toUpperCase()}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Cognome</p>
                  <p className="text-sm">{selectedCleaner.lastname.toUpperCase()}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Giorni lavorati</p>
                  <p className="text-sm">{selectedCleaner.counter_days}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Ore lavorate (totali)</p>
                  <p className="text-sm">{selectedCleaner.counter_hours}</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Ore questa settimana</p>
                  <p className="text-sm">{selectedCleaner.weekly_hours?.toFixed(2) || '0.00'}</p>
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
                  Il cleaner sarà rimosso dalla timeline ma le sue task rimarranno finché non verrà sostituito.
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
    </>
  );
}