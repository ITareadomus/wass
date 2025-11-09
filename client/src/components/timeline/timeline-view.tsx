import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar, User, Clock, Save, RotateCcw, Users, Eye, AlertCircle, Printer, Maximize2, Minimize2 } from "lucide-react";
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
import { cn } from "@/lib/utils"; // Assicurati che cn sia importato correttamente

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
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [isConfirming, setIsConfirming] = useState(false); // Stato per il pulsante di conferma
  const [selectedTask, setSelectedTask] = useState<any>(null); // Stato per task selezionata per dettagli
  const [isDialogOpen, setIsDialogOpen] = useState(false); // Stato per visibilità dialog dettagli task

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
      const response = await apiRequest("POST", "/api/remove-cleaner-from-selected", {
        cleanerId,
        date: workDate // Passa la data selezionata
      });
      return await response.json();
    },
    onSuccess: async (data) => {
      // CRITICAL: Notifica PRIMA del reload per mantenere lo stato
      if (onTaskMoved) {
        onTaskMoved();
      }
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }

      // CRITICAL: Ricarica PRIMA la timeline per vedere i cleaners con task
      await loadTimelineCleaners();

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
      const response = await apiRequest("POST", "/api/add-cleaner-to-timeline", {
        cleanerId,
        date: workDate
      });
      return await response.json();
    },
    onSuccess: async (data, cleanerId) => {
      // CRITICAL: Notifica PRIMA del reload per mantenere lo stato
      if (onTaskMoved) {
        onTaskMoved();
      }
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }

      // Ricarica ENTRAMBI i file per sincronizzare la vista
      await Promise.all([
        loadCleaners(),
        loadTimelineCleaners()
      ]);

      // Ricarica anche le task se necessario
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks(true);
      }

      // IMPORTANTE: ricarica timeline.json PRIMA di ricalcolare gli available
      // Questo previene race conditions tra cache e stato locale
      await new Promise(resolve => setTimeout(resolve, 100)); // Small delay per file system sync

      // Trova il cleaner appena aggiunto per mostrare nome e cognome
      const cleanersResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`);
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
      const response = await apiRequest("POST", "/api/swap-cleaners-tasks", {
        sourceCleanerId,
        destCleanerId,
        date: workDate
      });
      return await response.json();
    },
    onSuccess: async (data, variables) => {
      // CRITICAL: Notifica PRIMA del reload per mantenere lo stato
      if (onTaskMoved) {
        onTaskMoved();
      }
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }

      // Ricarica i task per mostrare immediatamente lo swap
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }

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
        fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`),
        fetch(`/data/output/timeline.json?t=${Date.now()}`)
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

  useEffect(() => {
    loadCleaners();
    loadAliases();
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
      // Singolo click: avvia timer
      const timer = setTimeout(() => {
        // Singolo click: apri modal
        setSelectedCleaner(cleaner);
        setIsModalOpen(true);
        setClickTimer(null);
      }, 250); // 250ms per distinguere singolo da doppio click

      setClickTimer(timer);
    }
  };

  // Carica cleaner disponibili per aggiungerli alla timeline
  // FILTRA CONTRO selected_cleaners.json (cleaners già selezionati)
  // NON contro timeline.json (che contiene anche cleaners rimossi con task)
  const loadAvailableCleaners = async () => {
    try {
      const [cleanersResponse, selectedCleanersResponse] = await Promise.all([
        fetch(`/data/cleaners/cleaners.json?t=${Date.now()}`),
        fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`)
      ]);

      const data = await cleanersResponse.json();

      console.log('🔍 DEBUG loadAvailableCleaners:');
      console.log('   - workDate (normalizzata):', workDate);
      console.log('   - Date disponibili in cleaners.json:', Object.keys(data.dates || {}));

      // Trova i cleaner per la data selezionata
      let dateCleaners = data.dates?.[workDate]?.cleaners || [];

      // Se non ci sono cleaners per la data, prova a cercare in tutte le date disponibili
      if (dateCleaners.length === 0) {
        console.log(`⚠️ Nessun cleaner trovato per ${workDate}, cerco in tutte le date...`);
        const allDates = Object.keys(data.dates || {});
        if (allDates.length > 0) {
          // Usa la data più recente disponibile
          const latestDate = allDates.sort().reverse()[0];
          console.log(`   - Uso la data più recente disponibile: ${latestDate}`);
          dateCleaners = data.dates[latestDate]?.cleaners || [];
        }
      }

      console.log(`   - Cleaner trovati per la data: ${dateCleaners.length}`);

      // FILTRA CONTRO selected_cleaners.json (NON timeline.json)
      // Questo permette di sostituire cleaners rimossi dalla selezione ma ancora con task
      const selectedCleanersData = selectedCleanersResponse.ok
        ? await selectedCleanersResponse.json()
        : { cleaners: [] };

      // Crea Set di ID già selezionati
      const selectedCleanerIds = new Set<number>(
        (selectedCleanersData.cleaners || []).map((c: any) => Number(c.id))
      );

      console.log(`   - Cleaner già in selected_cleaners.json: ${selectedCleanerIds.size}`, Array.from(selectedCleanerIds));

      // Escludi solo i cleaners già in selected_cleaners.json
      const available = dateCleaners.filter((c: Cleaner) =>
        c.active && !selectedCleanerIds.has(Number(c.id))
      );

      console.log(`   - Cleaner disponibili da aggiungere: ${available.length}/${dateCleaners.length}`);

      // Ordina in 4 sezioni con priorità:
      // 1. Formatore
      // 2. Premium/Straordinario (Premium che possono fare straordinaria)
      // 3. Premium (senza straordinaria)
      // 4. Standard
      // All'interno di ogni sezione, ordina per counter_hours decrescente
      available.sort((a, b) => {
        // Determina la sezione di appartenenza
        const getSectionPriority = (c: Cleaner) => {
          if (c.role === "Formatore") return 1;
          if (c.role === "Premium" && c.can_do_straordinaria) return 2;
          if (c.role === "Premium") return 3;
          return 4; // Standard
        };

        const sectionA = getSectionPriority(a);
        const sectionB = getSectionPriority(b);

        // Prima ordina per sezione
        if (sectionA !== sectionB) {
          return sectionA - sectionB;
        }

        // All'interno della stessa sezione, ordina per counter_hours decrescente
        return b.counter_hours - a.counter_hours;
      });

      setAvailableCleaners(available);

      console.log(`✅ Cleaner disponibili da aggiungere: ${available.length}/${dateCleaners.length}`);
    } catch (error) {
      console.error('Errore nel caricamento dei cleaner disponibili:', error);
      toast({
        title: "Errore",
        description: "Impossibile caricare i cleaner disponibili",
        variant: "destructive",
      });
    }
  };

  // Handler per aprire il dialog di aggiunta cleaner
  const handleOpenAddCleanerDialog = () => {
    loadAvailableCleaners();
    setIsAddCleanerDialogOpen(true);
  };

  // Handler per aggiungere/sostituire un cleaner
  const handleAddCleaner = (cleanerId: number) => {
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

  // Funzione per stampare la timeline
  const handlePrint = () => {
    window.print();
  };

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
      const resetResponse = await fetch('/api/reset-timeline-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      if (!resetResponse.ok) {
        throw new Error('Errore nel reset della timeline');
      }

      // 2. CRITICAL: Resetta il lastSavedFilename per indicare che non ci sono salvataggi
      setLastSavedFilename(null);
      localStorage.removeItem('last_saved_assignment');

      // 3. Ricarica i task senza ricaricare la pagina (mantiene la data)
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
      if ((window as any).setHasUnsavedChanges) {
        (window as any).setHasUnsavedChanges(true);
      }

      toast({
        title: "Reset completato",
        description: "Timeline svuotata con successo",
        variant: "success",
      });
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
    setIsConfirming(true); // Inizia la conferma
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
    } finally {
      setIsConfirming(false); // Termina la conferma
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

  useEffect(() => {
    loadCleaners();
    loadAliases();
    loadTimelineCleaners();

    // Esponi la funzione per ricaricare i cleaners della timeline
    (window as any).loadTimelineCleaners = loadTimelineCleaners;
  }, []);

  // Monitora cambiamenti nelle task per marcare modifiche non salvate
  useEffect(() => {
    // Skip al primo render
    if (tasks.length === 0) return;

    // Quando le task cambiano (drag-and-drop), notifica il parent
    if (onTaskMoved) {
      onTaskMoved();
    }
  }, [tasks]);

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

  // Handler per aggiornare task
  const handleTaskUpdate = async (updatedTask: any) => {
    // Implementazione logica per aggiornare la task (es. chiamata API)
    console.log("Task aggiornata:", updatedTask);
    // Ricarica le task o aggiorna lo stato locale
    if ((window as any).reloadAllTasks) {
      await (window as any).reloadAllTasks();
    }
    if ((window as any).setHasUnsavedChanges) {
      (window as any).setHasUnsavedChanges(true);
    }
    setIsDialogOpen(false); // Chiudi dialog dopo salvataggio
  };

  // Effettua il controllo all'avvio
  useEffect(() => {
    checkSavedAssignmentExists();
  }, [workDate]);

  return (
    <>
      <div
        ref={timelineRef}
        className={`bg-card rounded-lg border shadow-sm ${isFullscreen ? 'fixed inset-0 z-50 overflow-auto' : ''}`}
      >
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground flex items-center">
              <Calendar className="w-5 h-5 mr-2 text-primary" />
              Timeline Assegnazioni - {cleaners.length} Cleaners
            </h3>
            <div className="flex gap-3 print:hidden">
              <Button
                onClick={() => setLocation('/convocazioni')}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 print:hidden"
                disabled={isReadOnly}
              >
                <Users className="w-4 h-4" />
                Convocazioni
              </Button>
              <Button
                onClick={handleResetAssignments}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 print:hidden"
                disabled={isReadOnly}
              >
                <RotateCcw className="w-4 h-4" />
                Reset Assegnazioni
              </Button>
              <Button
                onClick={handlePrint}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 print:hidden"
              >
                <Printer className="w-4 h-4" />
                Stampa Timeline
              </Button>
              <Button
                onClick={toggleFullscreen}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 print:hidden"
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                {isFullscreen ? 'Esci Fullscreen' : 'Fullscreen'}
              </Button>
              {isReadOnly ? (
                <Button
                  disabled
                  className="bg-yellow-500 hover:bg-yellow-600 text-white font-semibold print:hidden"
                >
                  📖 Sei in modalità storico
                </Button>
              ) : (
                <Button
                  onClick={handleConfirmAssignments}
                  className="bg-green-600 hover:bg-green-700 text-white font-semibold print:hidden"
                  disabled={isConfirming}
                >
                  {isConfirming ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Salvataggio...
                    </>
                  ) : (
                    <>
                      <Save className="w-4 h-4 mr-2" />
                      Conferma Assegnazioni
                    </>
                  )}
                </Button>
              )}
            </div>
          </div>
        </div>

        {lastSavedFilename && (
          <div className="px-4 py-2 bg-muted/50 border-b border-border flex items-center justify-between print:hidden">
            <span className="text-sm text-muted-foreground flex items-center gap-2">
              <Clock className="w-4 h-4" />
              Ultime assegnazioni salvate: <strong className="text-foreground">{lastSavedFilename}</strong>
            </span>
          </div>
        )}

        <div className="p-4 overflow-x-auto" style={{ maxHeight: isFullscreen ? 'calc(100vh - 120px)' : 'auto' }}>
          {timelineCleaners.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Users className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium">Nessun cleaner convocato</p>
              <p className="text-sm mt-2">Vai alla sezione Convocazioni per selezionare i cleaners</p>
            </div>
          ) : (
            <div className="space-y-4 min-w-[800px]">
              {/* Cleaners attivi */}
              {timelineCleaners
                .filter(tc => !removedCleanerIds.has(tc.cleaner?.id))
                .map((tc) => {
                  const cleanerId = tc.cleaner?.id;
                  if (!cleanerId) return null;

                  const cleanerTasks = (tc.tasks || [])
                    .map(normalizeTask)
                    .sort((a, b) => {
                      const seqA = a.sequence ?? 0;
                      const seqB = b.sequence ?? 0;
                      return seqA - seqB;
                    });

                  const totalDuration = cleanerTasks.reduce((sum, task) => {
                    const durationParts = task.duration?.toString().split('.') || ['0', '0'];
                    const hours = parseInt(durationParts[0], 10) || 0;
                    const minutes = parseInt(durationParts[1], 10) || 0;
                    return sum + hours * 60 + minutes;
                  }, 0);

                  const totalTravelTime = cleanerTasks.reduce((sum, task) => {
                    return sum + (task.travelTime || 0);
                  }, 0);

                  const totalMinutes = totalDuration + totalTravelTime;
                  const hours = Math.floor(totalMinutes / 60);
                  const minutes = totalMinutes % 60;

                  return (
                    <CleanerTimeline
                      key={`cleaner-${cleanerId}`}
                      cleaner={tc.cleaner}
                      tasks={cleanerTasks}
                      totalDuration={`${hours}h ${minutes}m`}
                      isDragDisabled={isReadOnly}
                    />
                  );
                })}

              {/* Cleaners rimossi con task */}
              {Array.from(removedCleanerIds).map((cleanerId) => {
                const tc = timelineCleaners.find(tc => tc.cleaner?.id === cleanerId);
                if (!tc) return null;

                const cleanerTasks = (tc.tasks || [])
                  .map(normalizeTask)
                  .sort((a, b) => {
                    const seqA = a.sequence ?? 0;
                    const seqB = b.sequence ?? 0;
                    return seqA - seqB;
                  });

                const totalDuration = cleanerTasks.reduce((sum, task) => {
                  const durationParts = task.duration?.toString().split('.') || ['0', '0'];
                  const hours = parseInt(durationParts[0], 10) || 0;
                  const minutes = parseInt(durationParts[1], 10) || 0;
                  return sum + hours * 60 + minutes;
                }, 0);

                const totalTravelTime = cleanerTasks.reduce((sum, task) => {
                  return sum + (task.travelTime || 0);
                }, 0);

                const totalMinutes = totalDuration + totalTravelTime;
                const hours = Math.floor(totalMinutes / 60);
                const minutes = totalMinutes % 60;

                return (
                  <CleanerTimeline
                    key={`removed-cleaner-${cleanerId}`}
                    cleaner={tc.cleaner}
                    tasks={cleanerTasks}
                    totalDuration={`${hours}h ${minutes}m`}
                    isDragDisabled={isReadOnly}
                    isRemoved={true}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      <TaskDetailsDialog
        task={selectedTask}
        open={isDialogOpen}
        onOpenChange={setIsDialogOpen}
        onSave={handleTaskUpdate}
        isReadOnly={isReadOnly}
      />
    </>
  );
}

// Componente per timeline di un singolo cleaner
interface CleanerTimelineProps {
  cleaner: any;
  tasks: any[];
  totalDuration: string;
  isDragDisabled?: boolean;
  isRemoved?: boolean;
}

function CleanerTimeline({ cleaner, tasks, totalDuration, isDragDisabled = false, isRemoved = false }: CleanerTimelineProps) {
  const droppableId = `timeline-${cleaner.id}`;

  return (
    <div className={cn(
      "bg-muted/30 rounded-lg p-4 border-2 border-dashed",
      isRemoved ? "border-red-500/50 bg-red-50/50 dark:bg-red-950/20" : "border-muted"
    )}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <User className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h4 className="font-semibold text-foreground flex items-center gap-2">
              {cleaner.name} {cleaner.lastname}
              {isRemoved && (
                <span className="text-xs bg-red-500 text-white px-2 py-0.5 rounded">
                  NON CONVOCATO
                </span>
              )}
            </h4>
            <p className="text-sm text-muted-foreground">
              {tasks.length} task • {totalDuration}
            </p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">Inizio: {cleaner.start_time || '10:00'}</p>
        </div>
      </div>

      <Droppable droppableId={droppableId} direction="horizontal">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex gap-2 min-h-[100px] p-2 rounded-lg transition-colors overflow-x-auto",
              snapshot.isDraggingOver ? "bg-primary/10" : "bg-background/50"
            )}
          >
            {tasks.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
                Nessuna task assegnata
              </div>
            ) : (
              tasks.map((task, index) => (
                <TaskCard
                  key={`${task.id}-${index}`}
                  task={task}
                  index={index}
                  isDragDisabled={isDragDisabled}
                  allTasks={tasks}
                  currentContainer={droppableId}
                />
              ))
            )}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}

// Placeholder per TaskDetailsDialog se non definito altrove
// Assicurati che questo componente sia definito nel tuo progetto
function TaskDetailsDialog({ task, open, onOpenChange, onSave, isReadOnly }: any) {
  // Implementazione fittizia o reale del dialog
  return null;
}