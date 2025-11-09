import { Personnel, TaskType as Task } from "@shared/schema";
import { Calendar, RotateCcw, Users, RefreshCw, UserPlus, Maximize2, Minimize2, Printer, Copy } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Crown } from "lucide-react"; // Import Crown for Premium badge

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

// Definizione dell'interfaccia per le task nella timeline, includendo isDuplicate
interface TimelineTask extends Task {
  task_id: string; // Assumendo che task_id sia una stringa univoca
  logistic_code: string;
  premium?: boolean;
  straordinaria?: boolean;
  confirmed_operation?: boolean | number | string;
  assignedCleaner?: number;
  start_time?: string;
  sequence?: number;
  travel_time?: number | string;
  travelTime?: number | string;
}

// Definizione dell'interfaccia per SortableTask, aggiungendo isDuplicate
interface SortableTaskProps {
  task: TimelineTask;
  cleanerId: number;
  taskIndex: number;
  isPastDate: boolean;
  isDuplicate?: boolean;
}

// Componente SortableTask che riceve la prop isDuplicate
function SortableTask({ task, cleanerId, taskIndex, isPastDate, isDuplicate = false }: SortableTaskProps) {
  const { toast } = useToast();
  const { cleaners } = React.useContext(TimelineViewContext); // Assumendo che cleaners sia disponibile nel contesto

  const handleTaskClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Evita che click sulla task attivi click sul cleaner
    // Implementa la logica per aprire la modale di dettaglio task se necessario
    // toast({ title: `Task ${task.task_id} cliccata`, description: `Logistic code: ${task.logistic_code}` });
  };

  const handleTaskDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Implementa la logica per la doppia clic su task, es. modifica
    // toast({ title: `Task ${task.task_id} doppiopiccata` });
  };

  // Calcola la larghezza della task basandosi sul tempo di inizio e travel_time
  const calculateTaskWidth = () => {
    // La timeline copre 600 minuti (10:00-19:00)
    const totalTimelineMinutes = 600; 
    let currentOffsetMinutes = 0;

    // Calcola l'offset iniziale se non è la prima task o se ha un start_time specifico
    if (task.start_time) {
      const [hours, minutes] = task.start_time.split(':').map(Number);
      const taskStartMinutes = (hours * 60 + minutes) - (10 * 60); // minuti dall'inizio timeline (10:00)
      if (taskStartMinutes > 0) {
        currentOffsetMinutes = taskStartMinutes;
      }
    }
    
    // Estrae e normalizza travel_time
    let travelTime = 0;
    if (task.travel_time !== undefined && task.travel_time !== null) {
      travelTime = typeof task.travel_time === 'number' ? task.travel_time : parseInt(String(task.travel_time), 10);
    } else if (task.travelTime !== undefined && task.travelTime !== null) {
      travelTime = typeof task.travelTime === 'number' ? task.travelTime : parseInt(String(task.travelTime), 10);
    }
    if (isNaN(travelTime)) {
      travelTime = 0;
    }

    // Larghezza minima per garantire visibilità anche senza travel_time definito
    const minWidthPercentage = 1; // 1% della timeline

    // Calcola larghezza effettiva, considerando offset e travel_time
    const effectiveWidth = currentOffsetMinutes + travelTime;
    
    // Limita la larghezza per non eccedere la timeline
    const finalWidthPercentage = Math.min(100, (effectiveWidth / totalTimelineMinutes) * 100);

    return {
      widthPercentage: Math.max(minWidthPercentage, finalWidthPercentage),
      offsetPercentage: (currentOffsetMinutes / totalTimelineMinutes) * 100,
    };
  };

  const { widthPercentage, offsetPercentage } = calculateTaskWidth();

  // Trova il colore del cleaner associato
  const cleanerIndex = cleaners.findIndex(c => c.id === cleanerId);
  const cleanerColor = cleanerIndex !== -1 ? getCleanerColor(cleanerIndex) : { bg: '#e5e7eb', text: '#1f2937' }; // Grigio di default

  // Assicurati che task.task_id esista o usa un fallback
  const uniqueKey = task.task_id || `task-${taskIndex}-${cleanerId}`;

  return (
    <Draggable draggableId={uniqueKey} index={taskIndex} isDragDisabled={isPastDate}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={`absolute top-1/2 -translate-y-1/2 h-[calc(100%-16px)] rounded-md shadow-sm cursor-grab touch-manipulation z-10 ${
            snapshot.isDragging ? 'opacity-50 shadow-lg' : ''
          } ${isPastDate ? 'cursor-not-allowed opacity-70' : ''}`}
          style={{
            left: `${offsetPercentage}%`,
            width: `${widthPercentage}%`,
            backgroundColor: cleanerColor.bg,
            color: cleanerColor.text,
            boxShadow: snapshot.isDragging ? '0 0 0 3px rgba(59, 130, 246, 0.5)' : 'none',
          }}
          onClick={handleTaskClick}
          onDoubleClick={handleTaskDoubleClick}
          data-testid={`task-card-${task.task_id}`}
        >
          <div className="p-2 h-full flex flex-col justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-xs truncate w-full block">{task.logistic_code}</span>
              {task.premium && (
                <Badge variant="secondary" className="bg-amber-100 text-amber-800 border-amber-300">
                  <Crown className="h-3 w-3 mr-1" />
                  Premium
                </Badge>
              )}
              {isDuplicate && (
                <Badge variant="secondary" className="bg-yellow-100 text-yellow-800 border-yellow-400">
                  <Copy className="h-3 w-3 mr-1" />
                  Duplicato
                </Badge>
              )}
            </div>
            <div className="flex items-center justify-between text-xs opacity-70">
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>{task.start_time || "00:00"}</span>
              </div>
              {task.travel_time !== undefined && task.travel_time !== null && (
                <div className="flex items-center gap-1" title={`${task.travel_time} min`}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className="text-gray-600">
                    <path d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9L7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/>
                  </svg>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </Draggable>
  );
}

// Contesto per rendere disponibili cleaners e altre funzioni globali
const TimelineViewContext = React.createContext<{
  cleaners: Cleaner[];
  // Aggiungi qui altre funzioni o stati globali se necessario
}>({ cleaners: [] });


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
  const [lastSavedFilename, setLastSavedFilename] = useState<string | null>(null);
  const [timelineCleaners, setTimelineCleaners] = useState<any[]>([]);

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

  // Palette di colori azzurri per i cleaners (non usata attualmente, ma mantenuta)
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

  // Funzione per ottenere un colore dal cleaner basato sull'indice
  const getCleanerColor = (index: number) => {
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
      const [selectedResponse, timelineResponse] = await Promise.all([
        fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`),
        fetch(`/data/output/timeline.json?t=${Date.now()}`)
      ]);

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
      let cleanersList = selectedData.cleaners || [];

      // Se selected_cleaners.json è vuoto ma timeline.json ha cleaners, usali
      if (cleanersList.length === 0 && timelineResponse.ok) {
        try {
          const timelineData = await timelineResponse.json();
          const timelineCleanersWithTasks = timelineData.cleaners_assignments?.map((c: any) => ({
            id: c.cleaner?.id,
            name: c.cleaner?.name,
            lastname: c.cleaner?.lastname,
            role: c.cleaner?.role,
          })).filter((c: any) => c.id) || [];

          if (timelineCleanersWithTasks.length > 0) {
            console.log(`⚠️ selected_cleaners.json vuoto ma timeline.json ha ${timelineCleanersWithTasks.length} cleaners`);
            const cleanersResponse = await fetch(`/data/cleaners/cleaners.json?t=${Date.now()}`);
            if (cleanersResponse.ok) {
              const allCleanersData = await cleanersResponse.json();
              const allCleaners = Object.values(allCleanersData.dates || {})
                .flatMap((d: any) => d.cleaners || []);

              cleanersList = timelineCleanersWithTasks.map((tc: any) => {
                const fullData = allCleaners.find((c: any) => c.id === tc.id);
                return fullData || tc;
              });
              console.log(`✅ Caricati ${cleanersList.length} cleaners dalla timeline`);
            }
          }
        } catch (e) {
          console.warn('Errore parsing timeline.json:', e);
        }
      }

      setCleaners(cleanersList);
    } catch (error) {
      console.error("Errore nel caricamento dei cleaners selezionati:", error);
      setCleaners([]);
    }
  };

  // Carica gli alias dei cleaner
  const loadAliases = async () => {
    try {
      const response = await fetch(`/data/cleaners/cleaners_aliases.json?t=${Date.now()}`);
      if (!response.ok) {
        console.warn('File aliases non trovato, uso nomi default');
        return;
      }
      const aliasesData = await response.json();
      setCleanersAliases(aliasesData.aliases || {});
    } catch (error) {
      console.error("Errore nel caricamento degli alias:", error);
    }
  };

  // Carica i cleaner dalla timeline (anche quelli rimossi che hanno task)
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
      setTimelineCleaners(timelineData.cleaners_assignments || []);
    } catch (error) {
      console.error("Errore nel caricamento timeline cleaners:", error);
      setTimelineCleaners([]);
    }
  };

  // Effettua i caricamenti iniziali al mount del componente
  useEffect(() => {
    loadCleaners();
    loadAliases();
    loadTimelineCleaners();
    // Esponi la funzione per ricaricare i cleaners della timeline globalmente
    (window as any).loadTimelineCleaners = loadTimelineCleaners;
  }, []);

  // Gestione click singolo/doppio sul cleaner per filtro mappa o dettaglio
  const handleCleanerClick = (cleaner: Cleaner, e: React.MouseEvent) => {
    e.preventDefault();
    if (clickTimer) {
      clearTimeout(clickTimer);
      setClickTimer(null);
      // Doppio click: filtra mappa
      if (filteredCleanerId === cleaner.id) {
        setFilteredCleanerId(null);
        (window as any).mapFilteredCleanerId = null;
        toast({ title: "Filtro mappa rimosso" });
      } else {
        setFilteredCleanerId(cleaner.id);
        (window as any).mapFilteredCleanerId = cleaner.id;
        toast({ title: "Filtro mappa attivato" });
      }
    } else {
      // Singolo click: avvia timer per distinguere da doppio click
      const timer = setTimeout(() => {
        setSelectedCleaner(cleaner);
        setIsModalOpen(true);
        setClickTimer(null);
      }, 250);
      setClickTimer(timer);
    }
  };

  // Carica cleaner disponibili per aggiungerli alla timeline
  const loadAvailableCleaners = async () => {
    try {
      const [cleanersResponse, selectedCleanersResponse] = await Promise.all([
        fetch(`/data/cleaners/cleaners.json?t=${Date.now()}`),
        fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`)
      ]);

      const data = await cleanersResponse.json();
      let dateCleaners = data.dates?.[workDate]?.cleaners || [];

      // Se non ci sono cleaner per la data, cerca nella data più recente disponibile
      if (dateCleaners.length === 0) {
        const allDates = Object.keys(data.dates || {}).sort().reverse();
        if (allDates.length > 0) {
          dateCleaners = data.dates[allDates[0]]?.cleaners || [];
        }
      }

      const selectedCleanersData = selectedCleanersResponse.ok ? await selectedCleanersResponse.json() : { cleaners: [] };
      const selectedCleanerIds = new Set<number>((selectedCleanersData.cleaners || []).map((c: any) => Number(c.id)));

      const available = dateCleaners.filter((c: Cleaner) => 
        c.active && !selectedCleanerIds.has(Number(c.id))
      );

      // Ordina i cleaner disponibili per priorità di ruolo e poi ore lavorate
      available.sort((a, b) => {
        const getSectionPriority = (c: Cleaner) => {
          if (c.role === "Formatore") return 1;
          if (c.role === "Premium" && c.can_do_straordinaria) return 2;
          if (c.role === "Premium") return 3;
          return 4;
        };
        const sectionA = getSectionPriority(a);
        const sectionB = getSectionPriority(b);
        if (sectionA !== sectionB) return sectionA - sectionB;
        return b.counter_hours - a.counter_hours; // Decrescente
      });

      setAvailableCleaners(available);
    } catch (error) {
      console.error('Errore nel caricamento dei cleaner disponibili:', error);
      toast({ title: "Errore", description: "Impossibile caricare i cleaner disponibili", variant: "destructive" });
    }
  };

  // Gestisce l'aggiunta o sostituzione di un cleaner
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
      addCleanerMutation.mutate(cleanerId);
    }
  };

  // Calcola la larghezza dinamica della colonna cleaner
  const calculateCleanerColumnWidth = () => {
    if (cleaners.length === 0) return 96; 
    const maxLength = cleaners.reduce((max, cleaner) => {
      const alias = cleanersAliases[cleaner.id]?.alias || `${cleaner.name} ${cleaner.lastname}`;
      return Math.max(max, alias.length);
    }, 0);
    const baseWidth = 60; 
    const charWidth = 7.5; 
    const badgeSpace = 30; 
    return Math.max(96, baseWidth + (maxLength * charWidth) + badgeSpace);
  };

  const cleanerColumnWidth = calculateCleanerColumnWidth();

  // Gestione modalità schermo intero
  const toggleFullscreen = async () => {
    if (!timelineRef.current) return;
    try {
      if (!isFullscreen) {
        if (timelineRef.current.requestFullscreen) await timelineRef.current.requestFullscreen();
      } else {
        if (document.exitFullscreen) await document.exitFullscreen();
      }
    } catch (error) {
      console.error('Errore fullscreen:', error);
      toast({ title: "Errore", description: "Impossibile attivare/disattivare la modalità a schermo intero", variant: "destructive" });
    }
  };

  // Listener per cambiamenti stato fullscreen
  useEffect(() => {
    const handleFullscreenChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Stampa la timeline
  const handlePrint = () => window.print();

  // Reset tutte le assegnazioni per la data corrente
  const handleResetAssignments = async () => {
    const dateStr = localStorage.getItem('selected_work_date') || format(new Date(), 'yyyy-MM-dd');
    try {
      const resetResponse = await fetch('/api/reset-timeline-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });
      if (!resetResponse.ok) throw new Error('Errore nel reset della timeline');
      
      setLastSavedFilename(null);
      localStorage.removeItem('last_saved_assignment');
      if ((window as any).reloadAllTasks) await (window as any).reloadAllTasks();
      if ((window as any).setHasUnsavedChanges) (window as any).setHasUnsavedChanges(true);

      toast({ title: "Reset completato", description: "Timeline svuotata con successo", variant: "success" });
    } catch (error) {
      console.error('Errore nel reset:', error);
      toast({ title: "Errore", description: "Errore durante il reset delle assegnazioni", variant: "destructive" });
    }
  };

  // Conferma e salva le assegnazioni correnti come immutabili
  const handleConfirmAssignments = async () => {
    const dateStr = localStorage.getItem('selected_work_date') || format(new Date(), 'yyyy-MM-dd');
    try {
      toast({ title: "Conferma in corso...", description: "Salvataggio delle assegnazioni in corso" });
      const response = await fetch('/api/confirm-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr }),
      });
      if (!response.ok) throw new Error('Errore nel salvataggio delle assegnazioni');
      
      const result = await response.json();
      setLastSavedFilename(result.formattedDateTime || result.filename);
      localStorage.setItem('last_saved_assignment', result.formattedDateTime || result.filename);
      if ((window as any).setHasUnsavedChanges) (window as any).setHasUnsavedChanges(false);

      toast({ title: "✅ Assegnazioni confermate!", description: `Salvate il ${result.formattedDateTime}`, variant: "success" });
    } catch (error) {
      console.error('Errore nella conferma:', error);
      toast({ title: "Errore", description: "Errore durante la conferma delle assegnazioni", variant: "destructive" });
    }
  };

  // Effettua il mount per caricare lo stato del filename salvato
  useEffect(() => {
    const savedFilename = localStorage.getItem('last_saved_assignment');
    if (savedFilename) {
      setLastSavedFilename(savedFilename);
    }
    checkSavedAssignmentExists(); // Verifica se esiste un salvataggio per la data corrente
  }, [workDate]); // Ricarica se la data cambia

  // Funzione per verificare SE esistono assegnazioni salvate per la data corrente
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

  // Combina cleaners da selected_cleaners.json e timeline.json (per quelli rimossi)
  const allCleanersToShow = React.useMemo(() => {
    const selectedCleanerIds = new Set(cleaners.map(c => c.id));
    const timelineCleanersWithTasks = timelineCleaners
      .filter(tc => tc.tasks && tc.tasks.length > 0) // Solo cleaners con task
      .filter(tc => !selectedCleanerIds.has(tc.cleaner?.id)) // Esclude quelli già in selected_cleaners
      .map(tc => ({ ...tc.cleaner, isRemoved: true })); // Marca come rimosso
    return [...cleaners, ...timelineCleanersWithTasks];
  }, [cleaners, timelineCleaners]);

  // Set di ID cleaner rimossi per lookup rapido
  const removedCleanerIds = React.useMemo(() => {
    const selectedIds = new Set(cleaners.map(c => c.id));
    return new Set(
      timelineCleaners
        .filter(tc => tc.tasks && tc.tasks.length > 0 && !selectedIds.has(tc.cleaner?.id))
        .map(tc => tc.cleaner?.id)
    );
  }, [cleaners, timelineCleaners]);

  // Normalizza i dati delle task per coerenza (es. flag premium/straordinaria)
  const normalizeTask = (task: any): TimelineTask => {
    const isPremium = Boolean(task.premium);
    const isStraordinaria = Boolean(task.straordinaria);
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
      task_id: task.id || task.task_id, // Assicurati che task_id sia presente
      logistic_code: task.logistic_code || 'N/A', // Fallback per logistic_code
      premium: isPremium,
      straordinaria: isStraordinaria,
      confirmed_operation: isConfirmedOperation,
      assignedCleaner: task.assignedCleaner,
      start_time: task.start_time,
      sequence: task.sequence,
      travel_time: task.travel_time,
      travelTime: task.travelTime,
    };
  };

  // Monitora cambiamenti nelle task per marcare modifiche non salvate
  useEffect(() => {
    if (tasks.length === 0) return;
    if (onTaskMoved) onTaskMoved();
  }, [tasks]);

  // Costruisci la struttura dati necessaria per il rendering della timeline
  // groups tasks by cleaner and includes logistic code for duplicate checking
  const timelineDataForRendering = React.useMemo(() => {
    const dataByCleaner: Record<number, { cleaner: Cleaner; tasks: TimelineTask[] }> = {};

    // Inizializza la struttura con tutti i cleaner (selezionati e rimossi con task)
    allCleanersToShow.forEach(cleaner => {
      dataByCleaner[cleaner.id] = { cleaner: cleaner as Cleaner, tasks: [] };
    });

    // Mappa le task ai rispettivi cleaner
    tasks.forEach(task => {
      const taskWithCleaner = task as any; // Assumi che task abbia assignedCleaner
      const cleanerId = taskWithCleaner.assignedCleaner;
      if (cleanerId && dataByCleaner[cleanerId]) {
        dataByCleaner[cleanerId].tasks.push(normalizeTask(task));
      }
    });

    // Ordina le task per ogni cleaner in base a sequence o start_time
    Object.values(dataByCleaner).forEach(group => {
      group.tasks.sort((a, b) => {
        if (a.sequence !== undefined && b.sequence !== undefined) {
          return a.sequence - b.sequence;
        }
        const timeA = a.start_time || a.fw_start_time || a.startTime || "00:00";
        const timeB = b.start_time || b.fw_start_time || b.startTime || "00:00";
        return timeA.localeCompare(timeB);
      });
    });

    return Object.values(dataByCleaner);
  }, [allCleanersToShow, tasks]);


  return (
    <TimelineViewContext.Provider value={{ cleaners }}>
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
            <div className="flex gap-2">
              <Button
                onClick={toggleFullscreen}
                variant="outline"
                size="sm"
                className="flex items-center gap-2 print:hidden"
                title={isFullscreen ? "Esci da schermo intero" : "Schermo intero"}
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </Button>
              <Button
                onClick={() => {
                  const dateStr = localStorage.getItem('selected_work_date') || format(new Date(), 'yyyy-MM-dd');
                  setLocation(`/convocazioni?date=${dateStr}`);
                }}
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
            </div>
          </div>
        </div>
        <div className="p-4 overflow-x-auto">
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

          <div className="flex-1 overflow-auto px-4 pb-4">
            {timelineDataForRendering.length === 0 && !isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-yellow-50 dark:bg-yellow-950/20 border-2 border-yellow-300 dark:border-yellow-700 rounded-lg">
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
            ) : timelineDataForRendering.length === 0 && isReadOnly ? (
              <div className="flex items-center justify-center h-64 bg-red-50 dark:bg-red-950/20 border-2 border-red-300 dark:border-red-700 rounded-lg">
                <div className="text-center p-6">
                  <Calendar className="mx-auto h-12 w-12 text-red-600 dark:text-red-400 mb-3" />
                  <h3 className="text-lg font-semibold text-red-800 dark:text-red-200 mb-2">
                    Nessuna assegnazione presente per questa data
                  </h3>
                  <p className="text-red-700 dark:text-red-300">
                    Non sono disponibili dati salvati per questa data passata
                  </p>
                </div>
              </div>
            ) : (
              timelineDataForRendering.map(({ cleaner, tasks: cleanerTasks }) => {
                const index = cleaners.findIndex(c => c.id === cleaner.id); // Trova indice per colore
                const color = getCleanerColor(index);
                const isRemoved = removedCleanerIds.has(cleaner.id);

                // Verifica se questa task è duplicata (stesso logistic_code in altre task della timeline)
                const allTasksForDuplicateCheck = timelineDataForRendering.flatMap(item => item.tasks);
                const duplicateLogisticCodes = new Map<string, number>();
                allTasksForDuplicateCheck.forEach(t => {
                  duplicateLogisticCodes.set(t.logistic_code, (duplicateLogisticCodes.get(t.logistic_code) || 0) + 1);
                });
                const isDuplicateTask = (task: TimelineTask) => (duplicateLogisticCodes.get(task.logistic_code) || 0) > 1;


                return (
                  <div key={cleaner.id} className="flex mb-0.5">
                    <div
                      className="flex-shrink-0 p-1 flex items-center border cursor-pointer hover:opacity-90 transition-opacity"
                      style={{ 
                        width: `${cleanerColumnWidth}px`,
                        backgroundColor: isRemoved ? '#9CA3AF' : filteredCleanerId === cleaner.id ? `${color.bg}` : color.bg,
                        color: isRemoved ? '#1F2937' : color.text,
                        boxShadow: filteredCleanerId === cleaner.id ? '0 0 0 3px rgba(59, 130, 246, 0.5)' : 'none',
                        userSelect: 'none',
                        opacity: isRemoved ? 0.7 : 1
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        if (isRemoved) {
                          setCleanerToReplace(cleaner.id);
                          loadAvailableCleaners();
                          setIsAddCleanerDialogOpen(true);
                        } else {
                          handleCleanerClick(cleaner, e);
                        }
                      }}
                      title={isRemoved ? "Cleaner rimosso - Click per sostituire" : "Click: dettagli | Doppio click: filtra mappa"}
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
                          <div className="bg-yellow-500 text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">P</div>
                        )}
                        {!isRemoved && cleaner.role === "Formatore" && (
                          <div className="bg-orange-500 text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">F</div>
                        )}
                        {!isRemoved && cleaner.can_do_straordinaria && (
                          <div className="bg-red-500 text-white font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">S</div>
                        )}
                      </div>
                    </div>
                    <Droppable droppableId={`cleaner-timeline-${cleaner.id}`} direction="horizontal" isDropDisabled={isReadOnly}>
                      {(provided, snapshot) => (
                        <div
                          ref={provided.innerRef}
                          {...provided.droppableProps}
                          data-testid={`timeline-cleaner-${cleaner.id}`}
                          data-cleaner-id={cleaner.id}
                          className={`relative min-h-[45px] flex-1 ${snapshot.isDraggingOver && !isReadOnly ? 'bg-primary/20 ring-2 ring-primary' : ''}`}
                          style={{ backgroundColor: snapshot.isDraggingOver && !isReadOnly ? `${color.bg}40` : `${color.bg}10` }}
                        >
                          <div className="absolute inset-0 grid grid-cols-10 pointer-events-none opacity-10">
                            {timeSlots.map((slot, idx) => ( <div key={idx} className="border-r border-border"></div> ))}
                          </div>

                          <div className="relative z-10 flex items-center h-full">
                            {cleanerTasks.map((task, taskIndex) => {
                              const isDuplicate = isDuplicateTask(task);
                              return (
                                <SortableTask 
                                  key={task.task_id || task.id} // Usa task.task_id se disponibile
                                  task={task}
                                  cleanerId={cleaner.id}
                                  taskIndex={taskIndex}
                                  isPastDate={false} // Implementa logica se necessario
                                  isDuplicate={isDuplicate}
                                />
                              );
                            })}
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
              <div className="flex-shrink-0 p-1 flex items-center justify-center border border-border" style={{ width: `${cleanerColumnWidth}px` }}>
                <Button
                  onClick={() => {
                    setCleanerToReplace(null);
                    loadAvailableCleaners();
                    setIsAddCleanerDialogOpen(true);
                  }}
                  variant="ghost"
                  size="sm"
                  className="w-full h-full"
                  disabled={isReadOnly}
                >
                  <UserPlus className="w-5 h-5" />
                </Button>
              </div>
              <div className="flex-1 p-1 border-t border-border flex gap-2">
                {!isReadOnly && (
                  <Button
                    onClick={handleConfirmAssignments}
                    disabled={!hasUnsavedChanges}
                    className={`flex-1 h-full ${hasUnsavedChanges ? 'bg-green-500 hover:bg-green-600 animate-pulse' : 'bg-green-500 hover:bg-green-600 opacity-50 cursor-not-allowed'}`}
                    data-testid="button-confirm-assignments"
                  >
                    <Users className="w-4 h-4 mr-2" />
                    {hasUnsavedChanges ? 'Conferma Assegnazioni ⚠️' : 'Assegnazioni Confermate'}
                  </Button>
                )}
                <Button
                  onClick={handlePrint}
                  variant="outline"
                  className={isReadOnly ? "flex-1 h-full" : "h-full px-6"}
                >
                  <Printer className="w-4 h-4 mr-2" />
                  Stampa
                </Button>
              </div>
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
                        {cleaner.role} • Contratto: {cleaner.contract_type} • {cleaner.counter_hours?.toFixed(2) || '0.00'}h
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
                          .filter(c => c.id !== selectedCleaner.id) 
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
                  onClick={() => removeCleanerMutation.mutate(selectedCleaner.id)}
                  disabled={removeCleanerMutation.isPending || isReadOnly}
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
    </TimelineViewContext.Provider>
  );
}