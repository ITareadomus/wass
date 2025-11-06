import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar, RotateCcw, Users, RefreshCw, UserPlus } from "lucide-react";
import { useState, useEffect } from "react";
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
  can_do_straordinaria?: boolean;
}

export default function TimelineView({
  personnel,
  tasks,
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
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Usa sempre la data odierna all'apertura dell'app
  const workDate = new Date().toISOString().split('T')[0];

  // Mutation per rimuovere un cleaner da selected_cleaners.json
  const removeCleanerMutation = useMutation({
    mutationFn: async (cleanerId: number) => {
      const response = await apiRequest("POST", "/api/remove-cleaner-from-selected", {
        cleanerId,
        date: workDate // Passa la data selezionata
      });
      return await response.json();
    },
    onSuccess: async () => {
      // Ricarica ENTRAMBI i file per sincronizzare la vista
      await Promise.all([
        loadCleaners(),
        loadTimelineCleaners()
      ]);

      toast({
        title: "Cleaner rimosso",
        description: `${selectedCleaner?.name} ${selectedCleaner?.lastname} è stato rimosso dalla selezione.`,
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
      // Ricarica ENTRAMBI i file per sincronizzare la vista
      await Promise.all([
        loadCleaners(),
        loadTimelineCleaners()
      ]);

      // Ricarica anche le task se necessario
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks(true);
      }

      // Trova il cleaner appena aggiunto per mostrare nome e cognome
      const cleanersResponse = await fetch('/data/cleaners/selected_cleaners.json');
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
  const loadCleaners = async () => {
    try {
      // Aggiungi timestamp per evitare caching
      const response = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Verifica che la risposta sia JSON
      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('application/json')) {
        console.error('Risposta non JSON:', contentType);
        setCleaners([]);
        return;
      }

      const selectedData = await response.json();
      console.log("Cleaners caricati da selected_cleaners.json:", selectedData);

      // I cleaners sono già nel formato corretto
      const cleanersList = selectedData.cleaners || [];
      setCleaners(cleanersList);
    } catch (error) {
      console.error("Errore nel caricamento dei cleaners selezionati:", error);
      setCleaners([]); // Imposta array vuoto invece di lasciare undefined
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
      // Primo click: avvia timer
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
  const loadAvailableCleaners = async () => {
    try {
      const response = await fetch(`/data/cleaners/cleaners.json`);
      const data = await response.json();

      // Trova i cleaner per la data selezionata
      const dateCleaners = data.dates[workDate]?.cleaners || [];

      // Filtra i cleaner che NON sono già VISIBILI nella timeline
      // (solo i cleaner con task vengono mostrati, quindi escludiamo quelli)
      const currentCleanerIds = cleaners.map(c => c.id);
      const available = dateCleaners.filter((c: Cleaner) => 
        !currentCleanerIds.includes(c.id) && c.active
      );

      // Ordina per role (Premium prima) e poi per nome
      available.sort((a, b) => {
        if (a.role === "Premium" && b.role !== "Premium") return -1;
        if (a.role !== "Premium" && b.role === "Premium") return 1;
        return a.name.localeCompare(b.name);
      });

      setAvailableCleaners(available);

      console.log(`📋 Cleaner disponibili da aggiungere: ${available.length}/${dateCleaners.length}`);
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

      // 2. Ricarica i task senza ricaricare la pagina (mantiene la data)
      if ((window as any).reloadAllTasks) {
        await (window as any).reloadAllTasks();
      }
    } catch (error) {
      console.error('Errore nel reset:', error);
      alert('Errore durante il reset delle assegnazioni');
    }
  };

  const [lastSavedFilename, setLastSavedFilename] = useState<string | null>(null);

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
    // Carica la data formattata se esiste un salvataggio
    loadSavedAssignmentDate();
    
    // Esponi la funzione per ricaricare i cleaners della timeline
    (window as any).loadTimelineCleaners = loadTimelineCleaners;
  }, []);

  const loadSavedAssignmentDate = async () => {
    try {
      const response = await fetch('/api/load-saved-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: workDate })
      });

      if (response.ok) {
        const result = await response.json();
        if (result.found && result.formattedDateTime) {
          setLastSavedFilename(result.formattedDateTime);
          localStorage.setItem('last_saved_assignment', result.formattedDateTime);
        }
      }
    } catch (error) {
      console.error("Errore nel caricamento della data di salvataggio:", error);
    }
  };

  // Mostra SEMPRE tutti i cleaners da selected_cleaners.json
  // Questo permette di vedere tutti i cleaners disponibili anche prima di assegnare le task
  const allCleanersToShow = React.useMemo(() => {
    return cleaners;
  }, [cleaners]);

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

  return (
    <>
      <div className="bg-card rounded-lg border shadow-sm">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-foreground flex items-center">
              <Calendar className="w-5 h-5 mr-2 text-primary" />
              Timeline Assegnazioni - {cleaners.length} Cleaners
            </h3>
            <div className="flex gap-2">
              <Button
                onClick={() => setLocation('/convocazioni')}
                variant="outline"
                size="sm"
                className="flex items-center gap-2"
              >
                <Users className="w-4 h-4" />
                Convocazioni
              </Button>
              <Button
                onClick={handleResetAssignments}
                variant="outline"
                size="sm"
                className="flex items-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Reset Assegnazioni
              </Button>
            </div>
          </div>
        </div>
        <div className="p-4 overflow-x-auto">
          {/* Header con orari */}
          <div className="flex mb-2">
            <div className="flex-shrink-0" style={{ width: `${cleanerColumnWidth}px` }}></div>
            <div className="flex-1 flex">
              {timeSlots.map((slot) => (
                <div
                  key={slot}
                  className="flex-1 text-center text-sm font-medium text-muted-foreground border-l border-border first:border-l-0 py-1"
                >
                  {slot}
                </div>
              ))}
            </div>
          </div>

          {/* Righe dei cleaners - mostra solo se ci sono cleaners selezionati */}
          {allCleanersToShow.length === 0 ? (
            <div className="flex mb-2">
              <div
                className="flex-1 p-4 flex items-center justify-center border bg-yellow-50 dark:bg-yellow-950/20 border-yellow-300 dark:border-yellow-700"
              >
                <p className="text-yellow-800 dark:text-yellow-200 font-semibold text-center">
                  Nessun cleaner selezionato, fare le convocazioni
                </p>
              </div>
            </div>
          ) : allCleanersToShow.map((cleaner, index) => {
            const color = getCleanerColor(index);
            const droppableId = `cleaner-${cleaner.id}`;

            // Trova tutte le task assegnate a questo cleaner
            const cleanerTasks = tasks.filter(task => 
              (task as any).assignedCleaner === cleaner.id
            ).map(normalizeTask); // Applica la normalizzazione qui

            return (
              <div key={cleaner.id} className="flex mb-0.5">
                {/* Info cleaner */}
                <div
                  className="flex-shrink-0 p-1 flex items-center border cursor-pointer hover:opacity-90 transition-opacity"
                  style={{ 
                    width: `${cleanerColumnWidth}px`,
                    backgroundColor: filteredCleanerId === cleaner.id ? `${color.bg}` : color.bg,
                    color: color.text,
                    boxShadow: filteredCleanerId === cleaner.id ? '0 0 0 3px rgba(59, 130, 246, 0.5)' : 'none',
                    userSelect: 'none'
                  }}
                  onClick={(e) => handleCleanerClick(cleaner, e)}
                  title="Click: dettagli | Doppio click: filtra mappa"
                >
                  <div className="w-full flex items-center gap-1">
                    <div className="break-words font-bold text-[13px] flex-1">
                      {cleanersAliases[cleaner.id]?.alias || `${cleaner.name.toUpperCase()} ${cleaner.lastname.toUpperCase()}`}
                    </div>
                    {cleaner.role === "Premium" && (
                      <div className="bg-yellow-500 text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                        P
                      </div>
                    )}
                    {cleaner.role === "Formatore" && (
                      <div className="bg-orange-500 text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                        F
                      </div>
                    )}
                    {cleaner.can_do_straordinaria && (
                      <div className="bg-red-500 text-white font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
                        S
                      </div>
                    )}
                  </div>
                </div>
                {/* Timeline per questo cleaner - area unica droppable */}
                <Droppable droppableId={`timeline-${cleaner.id}`} direction="horizontal">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      {...provided.droppableProps}
                      data-testid={`timeline-cleaner-${cleaner.id}`}
                      data-cleaner-id={cleaner.id}
                      className={`relative border-t border-border transition-colors min-h-[45px] flex-1 ${
                        snapshot.isDraggingOver ? 'bg-primary/20 ring-2 ring-primary' : ''
                      }`}
                      style={{ 
                        backgroundColor: snapshot.isDraggingOver 
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

                            // Se la task ha sequence=1 e start_time=11:00, aggiungi 1 ora di offset (60 minuti)
                            let timeOffset = 0;
                            if (taskObj.sequence === 1 && taskObj.start_time === "11:00") {
                              timeOffset = 60; // 60 minuti di spazio vuoto
                            }

                            // DEBUG: log per capire cosa sta succedendo
                            if (idx > 0) {
                              console.log(`Task ${taskObj.task_id || taskObj.id}: travel_time=${travelTime} min`);
                            }

                            // Calcola larghezza EFFETTIVA in base ai minuti reali di travel_time
                            // La timeline copre 600 minuti (10:00-19:00)
                            // Se travelTime è 0, usa almeno 1 minuto per visibilità
                            const effectiveTravelMinutes = travelTime === 0 ? 1 : travelTime;
                            const totalWidth = (effectiveTravelMinutes / 600) * 100;

                            // Usa task.id o task.task_id come chiave univoca (non logistic_code che può essere duplicato)
                            const uniqueKey = taskObj.task_id || taskObj.id;

                            return (
                              <>
                                {/* Spazio vuoto per task con sequence=1 e start_time=11:00 */}
                                {timeOffset > 0 && (
                                  <div 
                                    key={`offset-${uniqueKey}`}
                                    className="flex-shrink-0"
                                    style={{ width: `${(timeOffset / 600) * 100}%` }}
                                  />
                                )}

                                {/* Indicatore di travel time: solo omino */}
                                {idx > 0 && (
                                  <div 
                                    key={`marker-${uniqueKey}`} 
                                    className="flex items-center justify-center flex-shrink-0 py-3 px-2"
                                    style={{ width: `${totalWidth}%`, minHeight: '50px' }}
                                    title={`${travelTime} min`}
                                  >
                                    <svg
                                      width="20"
                                      height="20"
                                      viewBox="0 0 24 24"
                                      fill="currentColor"
                                      className="text-gray-600 flex-shrink-0"
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
          })}

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
                className="w-full h-full"
              >
                <UserPlus className="w-5 h-5" />
              </Button>
            </div>
            {/* Pulsante Conferma Assegnazioni che prende tutto lo spazio della timeline */}
            <div className="flex-1 p-1 border-t border-border">
              <Button
                onClick={handleConfirmAssignments}
                className="w-full h-full bg-green-500 hover:bg-green-600"
                data-testid="button-confirm-assignments"
              >
                <Users className="w-4 h-4 mr-2" />
                Conferma Assegnazioni
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Add Cleaner Dialog */}
      <Dialog open={isAddCleanerDialogOpen} onOpenChange={(open) => {
        setIsAddCleanerDialogOpen(open);
        if (!open) setCleanerToReplace(null);
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {cleanerToReplace ? "Sostituisci Cleaner" : "Aggiungi Cleaner alla Timeline"}
            </DialogTitle>
            <DialogDescription>
              {cleanerToReplace 
                ? "Seleziona un cleaner disponibile per sostituire quello rimosso"
                : "Seleziona un cleaner disponibile da aggiungere alla timeline"}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 mt-4">
            {availableCleaners.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                Nessun cleaner disponibile da aggiungere
              </p>
            ) : (
              availableCleaners.map((cleaner) => (
                <div
                  key={cleaner.id}
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-accent cursor-pointer"
                  onClick={() => handleAddCleaner(cleaner.id)}
                  data-testid={`cleaner-option-${cleaner.id}`}
                >
                  <div className="flex items-center gap-3">
                    <div>
                      <p className="font-semibold">
                        {cleaner.name} {cleaner.lastname}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {cleaner.role} • Contratto: {cleaner.contract_type}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {cleaner.role === "Premium" && (
                      <span className="px-2 py-1 rounded bg-yellow-400 text-black text-xs font-bold">
                        Premium
                      </span>
                    )}
                    {cleaner.role === "Formatore" && (
                      <span className="px-2 py-1 rounded bg-orange-500 text-white text-xs font-bold">
                        Formatore
                      </span>
                    )}
                    {cleaner.role === "Standard" && (
                      <span className="px-2 py-1 rounded bg-green-500 text-white text-xs font-bold">
                        Standard
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
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
                    <span className="px-3 py-1 rounded-md bg-orange-500 text-black border-2 border-black font-semibold text-sm">
                      Formatore
                    </span>
                  ) : selectedCleaner.role === "Premium" ? (
                    <span className="px-3 py-1 rounded-md bg-yellow-400 text-black border-2 border-black font-semibold text-sm">
                      Premium
                    </span>
                  ) : (
                    <span className="px-3 py-1 rounded-md bg-green-500 text-white border-2 border-black font-semibold text-sm">
                      Standard
                    </span>
                  )}
                  {selectedCleaner.can_do_straordinaria && (
                    <span className="px-3 py-1 rounded-md bg-red-500 text-black border-2 border-black font-semibold text-sm">
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
                  <p className="text-sm font-semibold text-muted-foreground">Ore lavorate</p>
                  <p className="text-sm">{selectedCleaner.counter_hours}</p>
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
                      disabled={swapCleanersMutation.isPending}
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
                    disabled={!selectedSwapCleaner || swapCleanersMutation.isPending}
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
                  onClick={() => removeCleanerMutation.mutate(selectedCleaner.id)}
                  disabled={removeCleanerMutation.isPending}
                  variant="destructive"
                  className="w-full"
                  data-testid="button-remove-cleaner"
                >
                  {removeCleanerMutation.isPending ? "Rimozione..." : "Rimuovi dalla selezione"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}