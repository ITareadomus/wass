import { useState, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Users, CalendarIcon, ArrowLeft, Save, UserPlus } from "lucide-react";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from 'wouter';

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
}

interface TaskStats {
  total: number;
  premium: number;
  standard: number;
  straordinarie: number;
}

export default function Convocazioni() {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [taskStats, setTaskStats] = useState<TaskStats>({ total: 0, premium: 0, standard: 0, straordinarie: 0 });
  const [selectedCleaners, setSelectedCleaners] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState("Inizializzazione...");
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    // Leggi la data dal parametro URL se presente
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get('date');

    if (dateParam) {
      // Converte yyyy-MM-dd in Date senza problemi di timezone
      const [year, month, day] = dateParam.split('-').map(Number);
      return new Date(year, month - 1, day);
    }

    // Altrimenti usa la data salvata in localStorage
    const savedDate = localStorage.getItem('selected_work_date');
    if (savedDate) {
      const [year, month, day] = savedDate.split('-').map(Number);
      return new Date(year, month - 1, day);
    }

    return new Date();
  });
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Aggiunto uno stato per i cleaners filtrati per evitare che vengano sovrascritti quando cambia la data
  const [filteredCleaners, setFilteredCleaners] = useState<Cleaner[]>([]);

  useEffect(() => {
    const loadCleaners = async () => {
      try {
        setIsLoading(true);
        setLoadingMessage("Estrazione cleaners dal database...");

        // Salva la data selezionata in localStorage
        const dateStr = format(selectedDate, "yyyy-MM-dd");
        localStorage.setItem('selected_work_date', dateStr);

        // Esegui extract_cleaners_optimized.py
        const extractResponse = await fetch('/api/extract-cleaners-optimized', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: dateStr })
        });

        if (!extractResponse.ok) {
          throw new Error('Errore durante l\'estrazione dei cleaners');
        }

        const extractResult = await extractResponse.json();
        console.log("Estrazione cleaners completata:", extractResult);

        setLoadingMessage("Caricamento cleaners...");

        // Carica cleaners da API (PostgreSQL)
        const cleanersResponse = await fetch(`/api/cleaners?date=${dateStr}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });
        if (!cleanersResponse.ok) {
          throw new Error('Impossibile caricare i cleaners');
        }

        const cleanersData = await cleanersResponse.json();
        let dateCleaners = cleanersData.cleaners || [];

        console.log(`📅 Cleaners totali per ${dateStr} (PostgreSQL):`, dateCleaners.length);

        // Carica selected_cleaners da API per gestire la persistenza delle selezioni
        const selectedResponse = await fetch(`/api/selected-cleaners?date=${dateStr}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });
        let alreadySelectedIds = new Set<number>();
        let preselectedIds = new Set<number>(); // IDs da mantenere selezionati nell'UI

        if (selectedResponse.ok) {
          const selectedData = await selectedResponse.json();
          // Verifica che la data in selected_cleaners corrisponda
          const selectedDateFromFile = selectedData.metadata?.date;
          console.log(`🔍 Data in selected_cleaners API: ${selectedDateFromFile}, data richiesta: ${dateStr}`);

          // Filtra solo se la data corrisponde
          if (selectedDateFromFile === dateStr) {
            const selectedCleanerIds = selectedData.cleaners?.map((c: any) => c.id) || [];
            alreadySelectedIds = new Set(selectedCleanerIds);
            preselectedIds = new Set(selectedCleanerIds); // Mantieni la selezione visiva
            console.log(`✅ Cleaners già selezionati per ${dateStr}:`, Array.from(alreadySelectedIds));
          } else {
            console.log(`⚠️ Data non corrispondente (API: ${selectedDateFromFile}, richiesta: ${dateStr}), mostro TUTTI i cleaners`);
          }
        } else {
          console.log(`ℹ️ selected_cleaners API vuoto, mostro TUTTI i cleaners`);
        }

        // NUOVO: Carica anche cleaners dalla timeline (DB) per pre-selezionarli
        const timelineResponse = await fetch(`/api/timeline?date=${dateStr}`);
        if (timelineResponse.ok) {
          try {
            const timelineData = await timelineResponse.json();
            const timelineDateFromFile = timelineData.metadata?.date;

            // Solo se la data corrisponde
            if (timelineDateFromFile === dateStr && timelineData.cleaners_assignments) {
              for (const cleanerEntry of timelineData.cleaners_assignments) {
                if (cleanerEntry.cleaner?.id) {
                  const cleanerId = cleanerEntry.cleaner.id;
                  // Pre-seleziona visivamente (NON aggiungere ad alreadySelectedIds per renderlo visibile)
                  preselectedIds.add(cleanerId);
                  console.log(`✅ Cleaner ${cleanerId} trovato nella timeline - pre-selezionato visivamente`);
                }
              }
            }
          } catch (e) {
            console.warn('⚠️ Errore parsing timeline:', e);
          }
        }

        // Mostra TUTTI i cleaners attivi (NON filtrare quelli già selezionati)
        const availableCleaners = dateCleaners.filter((c: any) => c.active === true);

        console.log(`📊 Risultato filtro cleaners:`);
        console.log(`   - Totali per ${dateStr}: ${dateCleaners.length}`);
        console.log(`   - Già in selected_cleaners: ${alreadySelectedIds.size}`);
        console.log(`   - Pre-selezionati dalla timeline: ${preselectedIds.size}`);
        console.log(`   - Disponibili da mostrare: ${availableCleaners.length}`);

        // Ordina per counter_hours (decrescente - più ore prima)
        availableCleaners.sort((a, b) => b.counter_hours - a.counter_hours);

        setCleaners(availableCleaners);
        setFilteredCleaners(availableCleaners);

        // Unisci TUTTI i cleaners pre-selezionati (da selected_cleaners API E dalla timeline)
        const allPreselectedIds = new Set([...alreadySelectedIds, ...preselectedIds]);
        setSelectedCleaners(allPreselectedIds);

        console.log(`✅ Cleaners mostrati: ${availableCleaners.length}, pre-selezionati totali: ${allPreselectedIds.size}`);

        console.log(`✅ Cleaners mostrati: ${availableCleaners.length}, pre-selezionati: ${preselectedIds.size}`);

        // Carica statistiche task
        setLoadingMessage("Caricamento statistiche task...");
        await loadTaskStats(dateStr);

        setIsLoading(false);
        setLoadingMessage("Caricamento completato!");
      } catch (error) {
        console.error("Errore nel caricamento dei cleaners:", error);
        setLoadingMessage("Errore nel caricamento dei cleaners");
        setIsLoading(false);
      }
    };

    loadCleaners();
  }, [selectedDate]);

  const loadTaskStats = async (dateStr: string) => {
    try {
      // Esegui extract_tasks_for_convocazioni per avere i dati freschi
      const extractStatsResponse = await fetch('/api/extract-convocazioni-tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: dateStr })
      });

      if (!extractStatsResponse.ok) {
        throw new Error('Errore durante l\'estrazione delle statistiche task');
      }

      // Carica convocazioni_tasks.json
      const statsResponse = await fetch('/data/output/convocazioni_tasks.json');
      if (!statsResponse.ok) {
        console.warn('convocazioni_tasks.json non trovato');
        return;
      }

      const statsData = await statsResponse.json();

      // Usa le statistiche direttamente
      const stats = statsData.task_stats || {
        total: 0,
        premium: 0,
        standard: 0,
        straordinarie: 0
      };

      console.log('Statistiche task da convocazioni_tasks.json:', stats);
      setTaskStats(stats);
    } catch (error) {
      console.error('Errore nel caricamento delle statistiche task:', error);
    }
  };

  const toggleCleanerSelection = (cleanerId: number, isAvailable: boolean) => {
    // Se il cleaner è già selezionato, lo deseleziona
    if (selectedCleaners.has(cleanerId)) {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        newSet.delete(cleanerId);
        return newSet;
      });
      return;
    }

    // Se non è disponibile, mostra il dialog di conferma
    if (!isAvailable) {
      setConfirmDialog({ open: true, cleanerId });
      return;
    }

    // Altrimenti seleziona direttamente il cleaner
    setSelectedCleaners(prev => {
      const newSet = new Set(prev);
      newSet.add(cleanerId);
      return newSet;
    });
  };

  const handleConfirmUnavailable = () => {
    if (confirmDialog.cleanerId !== null) {
      setSelectedCleaners(prev => {
        const newSet = new Set(prev);
        if (newSet.has(confirmDialog.cleanerId!)) {
          newSet.delete(confirmDialog.cleanerId!);
        } else {
          newSet.add(confirmDialog.cleanerId!);
        }
        return newSet;
      });
    }
    setConfirmDialog({ open: false, cleanerId: null });
  };

  const handleSaveSelection = async () => {
    if (selectedCleaners.size === 0) {
      toast({
        variant: "destructive",
        title: "⚠️ Nessun cleaner selezionato",
        description: "Seleziona almeno un cleaner prima di salvare"
      });
      return;
    }

    try {
      const dateStr = format(selectedDate, "yyyy-MM-dd");

      // Carica cleaners dalla timeline (DB) per includerli nel salvataggio
      const timelineResponse = await fetch(`/api/timeline?date=${dateStr}`);
      let timelineCleaners: Cleaner[] = [];
      if (timelineResponse.ok) {
        try {
          const timelineData = await timelineResponse.json();
          if (timelineData.metadata?.date === dateStr && timelineData.cleaners_assignments) {
            timelineCleaners = timelineData.cleaners_assignments
              .map((ca: any) => ca.cleaner)
              .filter((c: any) => c && selectedCleaners.has(c.id));
          }
        } catch (e) {
          console.warn('⚠️ Errore caricamento timeline cleaners:', e);
        }
      }

      // Combina cleaners dall'UI con quelli dalla timeline (evita duplicati)
      // IMPORTANTE: usa l'oggetto completo del cleaner da cleaners/filteredCleaners
      const cleanersFromUI = filteredCleaners.filter(c => selectedCleaners.has(c.id));
      const timelineCleanerIds = new Set(timelineCleaners.map(c => c.id));
      const uniqueCleanersFromUI = cleanersFromUI.filter(c => !timelineCleanerIds.has(c.id));
      const selectedCleanersData = [...timelineCleaners, ...uniqueCleanersFromUI];

      const dataToSave = {
        cleaners: selectedCleanersData,
        total_selected: selectedCleanersData.length,
        date: dateStr
      };

      const response = await fetch('/api/save-selected-cleaners', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dataToSave),
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio dei cleaners');
      }

      const result = await response.json();
      console.log("Cleaners salvati con successo:", result);
      toast({
        variant: "success",
        title: `${selectedCleanersData.length} cleaner salvati con successo!`,
        description: `I cleaners sono stati salvati per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`
      });
    } catch (error) {
      console.error("Errore nel salvataggio:", error);
      toast({
        variant: "destructive",
        title: "❌ Errore nel salvataggio",
        description: "Si è verificato un errore nel salvataggio dei cleaners selezionati"
      });
    }
  };

  const handleAddCleaners = async () => {
    if (selectedCleaners.size === 0) {
      toast({
        variant: "destructive",
        title: "⚠️ Nessun cleaner selezionato",
        description: "Seleziona almeno un cleaner prima di aggiungere"
      });
      return;
    }

    try {
      const dateStr = format(selectedDate, "yyyy-MM-dd");

      // Carica cleaners dalla timeline (DB) per includerli
      const timelineResponse = await fetch(`/api/timeline?date=${dateStr}`);
      let timelineCleaners: Cleaner[] = [];
      if (timelineResponse.ok) {
        try {
          const timelineData = await timelineResponse.json();
          if (timelineData.metadata?.date === dateStr && timelineData.cleaners_assignments) {
            timelineCleaners = timelineData.cleaners_assignments
              .map((ca: any) => ca.cleaner)
              .filter((c: any) => c && selectedCleaners.has(c.id));
          }
        } catch (e) {
          console.warn('⚠️ Errore caricamento timeline cleaners:', e);
        }
      }

      // Carica la selezione attuale da API
      const currentResponse = await fetch(`/api/selected-cleaners?date=${dateStr}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
      });
      const currentData = await currentResponse.json();
      const currentCleaners = currentData.cleaners || [];

      // Combina cleaners dall'UI con quelli dalla timeline
      // IMPORTANTE: usa l'oggetto completo del cleaner da filteredCleaners
      const cleanersFromUI = filteredCleaners.filter(c => selectedCleaners.has(c.id));
      const timelineCleanerIds = new Set(timelineCleaners.map(c => c.id));
      const uniqueCleanersFromUI = cleanersFromUI.filter(c => !timelineCleanerIds.has(c.id));
      const allSelectedCleaners = [...timelineCleaners, ...uniqueCleanersFromUI];

      // Unisci con cleaners esistenti (evita duplicati)
      const existingIds = new Set(currentCleaners.map((c: any) => c.id));
      const newCleaners = allSelectedCleaners.filter(c => !existingIds.has(c.id));
      const mergedCleaners = [...currentCleaners, ...newCleaners];

      const dataToSave = {
        cleaners: mergedCleaners,
        total_selected: mergedCleaners.length,
        date: dateStr
      };

      const response = await fetch('/api/save-selected-cleaners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dataToSave)
      });

      if (!response.ok) {
        throw new Error('Errore nel salvataggio');
      }

      if (newCleaners.length === 0) {
        toast({
          variant: "warning",
          title: "Nessun nuovo cleaner aggiunto",
          description: `Tutti i cleaners selezionati sono già presenti per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
          duration: 4000
        });
      } else {
        toast({
          variant: "success",
          title: `${newCleaners.length} cleaner aggiunti correttamente!`,
          description: `Totale cleaners: ${mergedCleaners.length} per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`,
          duration: 3000
        });
      }

      // Torna alla pagina principale SENZA resettare la timeline
      sessionStorage.setItem('preserveAssignments', 'true');
      setLocation('/');
    } catch (error) {
      console.error('Errore nell\'aggiunta cleaners:', error);
      toast({
        variant: "destructive",
        title: "❌ Errore nell'aggiunta",
        description: "Si è verificato un errore durante l\'aggiunta dei cleaners"
      });
    }
  };

  if (isLoading) {
    return (
      <div className="bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary"></div>
          </div>
          <h2 className="text-2xl font-bold text-foreground">Caricamento Convocazioni</h2>
          <p className="text-muted-foreground">{loadingMessage}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background text-foreground min-h-screen">
      <div className="p-4 w-full">
        <div className="mb-6 space-y-4">
          {/* Header con titolo e selettore data */}
          <div className="flex justify-between items-center flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
                <Users className="w-8 h-8 text-custom-blue" />
                CONVOCAZIONI del
              </h1>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className={cn(
                      "justify-start text-left font-normal",
                      !selectedDate && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {selectedDate ? format(selectedDate, "dd/MM/yyyy", { locale: it }) : <span>Seleziona data</span>}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={selectedDate}
                    onSelect={(date) => date && setSelectedDate(date)}
                    initialFocus
                    locale={it}
                  />
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle />
            </div>
          </div>

          {/* Barra Contatore */}
          <div className="bg-custom-blue-light rounded-xl border-2 border-custom-blue shadow-lg p-6">
            <div className="flex items-center gap-4">
              <div className="text-lg font-semibold text-foreground">CLEANERS SELEZIONATI</div>
              <div className="text-lg font-bold">
                <span className="text-primary">{selectedCleaners.size}</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span className="text-foreground">{filteredCleaners.length}</span> {/* Utilizza filteredCleaners per il conteggio totale */}
              </div>
            </div>
          </div>
        </div>

        {/* Grid con lista cleaners e statistiche affiancate */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-200px)]">
          {/* Lista Cleaners - 2/3 dello spazio */}
          <Card className="p-6 lg:col-span-2 flex flex-col overflow-hidden border-2 border-custom-blue bg-custom-blue-light">
          <div className="space-y-3 flex-1 overflow-y-auto pr-2">
            {filteredCleaners.map((cleaner) => { // Itera su filteredCleaners
              const isPremium = cleaner.role === "Premium";
              const isAvailable = cleaner.available !== false;
              const isFormatore = cleaner.role === "Formatore";
              const canDoStraordinaria = (cleaner as any).can_do_straordinaria === true;

              const borderColor = !isAvailable
                ? "border-gray-300 dark:border-gray-700"
                : isFormatore ? "border-orange-300 dark:border-orange-700"
                : canDoStraordinaria ? "border-red-300 dark:border-red-700"
                : isPremium ? "border-yellow-300 dark:border-yellow-700" 
                : "border-green-300 dark:border-green-700";
              const bgColor = !isAvailable
                ? "bg-gray-100 dark:bg-gray-950/50"
                : isFormatore ? "bg-orange-100 dark:bg-orange-950/50"
                : canDoStraordinaria ? "bg-red-100 dark:bg-red-950/50"
                : isPremium ? "bg-yellow-100 dark:bg-yellow-950/50" 
                : "bg-green-100 dark:bg-green-950/50";

              return (
                <div
                  key={cleaner.id}
                  onClick={() => toggleCleanerSelection(cleaner.id, isAvailable)}
                  className={`flex items-center justify-between p-4 border-2 rounded-lg transition-all ${borderColor} ${bgColor} ${
                    !isAvailable
                      ? 'opacity-60 cursor-pointer hover:opacity-70'
                      : 'hover:opacity-80 cursor-pointer'
                  }`}
                >
                  <div className="flex items-start gap-4 flex-1">
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground text-lg">
                          {cleaner.name.toUpperCase()} {cleaner.lastname.toUpperCase()}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {!isAvailable && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                              Non disponibile
                            </span>
                          )}
                          {isFormatore && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-500/30 text-orange-800 dark:bg-orange-500/40 dark:text-orange-200 border-orange-600 dark:border-orange-400">
                              Formatore
                            </span>
                          )}
                          {canDoStraordinaria && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-500/30 text-red-800 dark:bg-red-500/40 dark:text-red-200 border-red-600 dark:border-red-400">
                              Straordinario
                            </span>
                          )}
                          {isPremium && !canDoStraordinaria && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400">
                              Premium
                            </span>
                          )}
                          {!isPremium && !isFormatore && !canDoStraordinaria && (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400">
                              Standard
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-foreground/80">
                        <span className="font-semibold">Ore questa settimana:</span> {(() => {
                          const hours = cleaner.counter_hours;
                          // Handle if counter_hours is accidentally a time string like "10:00"
                          if (typeof hours === 'string' && hours.includes(':')) {
                            return '0.00';
                          }
                          return Number(hours || 0).toFixed(2);
                        })()}h
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Giorni consecutivi:</span> {cleaner.counter_days}
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Contratto:</span> {cleaner.contract_type}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-6">
                    <div className={`flex items-center gap-1 bg-background border-2 rounded-lg px-3 py-1 ${borderColor}`}>
                      <span className="text-xs font-semibold text-foreground mr-2">Start Time:</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-red-100 dark:hover:bg-red-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.start_time || "10:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes - 30;
                          if (totalMinutes < 0) totalMinutes += 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          // Aggiorna ENTRAMBI gli stati (cleaners E filteredCleaners)
                          setCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">−</span>
                      </Button>
                      <span className="text-sm font-mono font-bold min-w-[45px] text-center">
                        {cleaner.start_time || "10:00"}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 hover:bg-green-100 dark:hover:bg-green-900"
                        onClick={(e) => {
                          e.stopPropagation();
                          const currentTime = cleaner.start_time || "10:00";
                          const [hours, minutes] = currentTime.split(':').map(Number);
                          let totalMinutes = hours * 60 + minutes + 30;
                          if (totalMinutes >= 24 * 60) totalMinutes -= 24 * 60;
                          const newHours = Math.floor(totalMinutes / 60);
                          const newMinutes = totalMinutes % 60;
                          const newTime = `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
                          // Aggiorna ENTRAMBI gli stati (cleaners E filteredCleaners)
                          setCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                          setFilteredCleaners(prev => prev.map(c => 
                            c.id === cleaner.id ? { ...c, start_time: newTime } : c
                          ));
                        }}
                      >
                        <span className="text-base font-bold">+</span>
                      </Button>
                    </div>
                    <Switch
                      checked={selectedCleaners.has(cleaner.id)}
                      onCheckedChange={() => toggleCleanerSelection(cleaner.id, isAvailable)}
                      className="scale-150 pointer-events-none"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <Dialog open={confirmDialog.open} onOpenChange={(open) => setConfirmDialog({ open, cleanerId: null })}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Cleaner Non Disponibile</DialogTitle>
                <DialogDescription>
                  Questo cleaner risulta non disponibile. Sei sicuro di volerlo selezionare?
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button 
                  variant="outline" 
                  onClick={() => setConfirmDialog({ open: false, cleanerId: null })}
                  className="border-2 border-custom-blue"
                >
                  Annulla
                </Button>
                <Button 
                  onClick={handleConfirmUnavailable}
                  className="bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
                >
                  Conferma
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <div className="flex justify-center mt-4 pt-4 border-t">
            <Button
              onClick={async () => {
                await handleSaveSelection();
                setLocation('/');
              }}
              size="lg"
              disabled={selectedCleaners.size === 0}
              className="flex items-center gap-2 bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
            >
              <Save className="w-4 h-4 mr-1" />
              Salva e Torna alla Home
              <ArrowLeft className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </Card>

        {/* Pannello Statistiche - 1/3 dello spazio - FISSO */}
        <Card className="p-6 border-2 bg-background flex flex-col h-full overflow-hidden">
          <h3 className="text-lg font-semibold text-foreground mb-4 flex items-center">
            <svg
              className="w-5 h-5 mr-2 text-custom-blue"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            Statistiche
          </h3>

          {/* Statistiche Task */}
          <div className="mb-4 pb-3 border-b border-border">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">Task Giornata</h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-blue-100 dark:bg-blue-950/50 rounded-lg p-2 border-2 border-blue-300 dark:border-blue-700">
                <div className="text-lg font-bold text-blue-800 dark:text-blue-200">{taskStats.total}</div>
                <div className="text-[10px] text-blue-800 dark:text-blue-200">Totale</div>
              </div>
              <div className="bg-yellow-100 dark:bg-yellow-950/50 rounded-lg p-2 border-2 border-yellow-300 dark:border-yellow-700">
                <div className="text-lg font-bold text-yellow-800 dark:text-yellow-200">{taskStats.premium}</div>
                <div className="text-[10px] text-yellow-800 dark:text-yellow-200">Premium</div>
              </div>
              <div className="bg-green-100 dark:bg-green-950/50 rounded-lg p-2 border-2 border-green-300 dark:border-green-700">
                <div className="text-lg font-bold text-green-800 dark:text-green-200">{taskStats.standard}</div>
                <div className="text-[10px] text-green-800 dark:text-green-200">Standard</div>
              </div>
              <div className="bg-red-100 dark:bg-red-950/50 rounded-lg p-2 border-2 border-red-300 dark:border-red-700">
                <div className="text-lg font-bold text-red-800 dark:text-red-200">{taskStats.straordinarie}</div>
                <div className="text-[10px] text-red-800 dark:text-red-200">Straordinarie</div>
              </div>
            </div>
          </div>

          {/* Statistiche Cleaners */}
          <h4 className="text-xs font-semibold text-muted-foreground mb-2">Cleaners</h4>
          <div className="grid grid-cols-2 gap-2 flex-1">
            {/* Disponibili */}
            <div className="bg-blue-100 dark:bg-blue-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-blue-300 dark:border-blue-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-blue-200 dark:text-blue-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.available !== false).length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-blue-500 dark:text-blue-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-blue-600 dark:fill-blue-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.available !== false).length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-blue-800 dark:text-blue-200 text-center">Disponibili</span>
              <span className="text-[9px] text-blue-800 dark:text-blue-200">
                {filteredCleaners.filter(c => c.available !== false).length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Non Disponibili */}
            <div className="bg-gray-100 dark:bg-gray-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-gray-300 dark:border-gray-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-gray-200 dark:text-gray-800"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.available === false).length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-gray-500 dark:text-gray-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-gray-600 dark:fill-gray-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.available === false).length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-gray-800 dark:text-gray-200 text-center">Non Disponibili</span>
              <span className="text-[9px] text-gray-800 dark:text-gray-200">
                {filteredCleaners.filter(c => c.available === false).length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Premium */}
            <div className="bg-yellow-100 dark:bg-yellow-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-yellow-300 dark:border-yellow-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-yellow-200 dark:text-yellow-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.role === "Premium").length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-yellow-500 dark:text-yellow-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-yellow-600 dark:fill-yellow-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.role === "Premium").length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-yellow-800 dark:text-yellow-200 text-center">Premium</span>
              <span className="text-[9px] text-yellow-800 dark:text-yellow-200">
                {filteredCleaners.filter(c => c.role === "Premium").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Standard */}
            <div className="bg-green-100 dark:bg-green-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-green-300 dark:border-green-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-green-200 dark:text-green-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.role === "Standard").length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-green-500 dark:text-green-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-green-600 dark:fill-green-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.role === "Standard").length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-green-800 dark:text-green-200 text-center">Standard</span>
              <span className="text-[9px] text-green-800 dark:text-green-200">
                {filteredCleaners.filter(c => c.role === "Standard").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Formatori */}
            <div className="bg-orange-100 dark:bg-orange-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-orange-300 dark:border-orange-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-orange-200 dark:text-orange-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => c.role === "Formatore").length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-orange-500 dark:text-orange-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-orange-600 dark:fill-orange-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => c.role === "Formatore").length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-orange-800 dark:text-orange-200 text-center">Formatori</span>
              <span className="text-[9px] text-orange-800 dark:text-orange-200">
                {filteredCleaners.filter(c => c.role === "Formatore").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Straordinari */}
            <div className="bg-red-100 dark:bg-red-950/50 rounded-lg p-2 flex flex-col items-center justify-center border-2 border-red-300 dark:border-red-700">
              <svg className="w-16 h-16 mb-1" viewBox="0 0 100 100">
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  className="text-red-200 dark:text-red-900"
                />
                <circle
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="8"
                  strokeDasharray={`${filteredCleaners.length > 0 ? (filteredCleaners.filter(c => (c as any).can_do_straordinaria === true).length / filteredCleaners.length) * 251.2 : 0} 251.2`}
                  strokeDashoffset="0"
                  transform="rotate(-90 50 50)"
                  className="text-red-500 dark:text-red-600 transition-all duration-500"
                  strokeLinecap="round"
                />
                <text
                  x="50"
                  y="50"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="text-lg font-bold fill-red-600 dark:fill-red-400"
                >
                  {filteredCleaners.length > 0 ? Math.round((filteredCleaners.filter(c => (c as any).can_do_straordinaria === true).length / filteredCleaners.length) * 100) : 0}%
                </text>
              </svg>
              <span className="text-[10px] font-semibold text-red-800 dark:text-red-200 text-center">Straordinari</span>
              <span className="text-[9px] text-red-800 dark:text-red-200">
                {filteredCleaners.filter(c => (c as any).can_do_straordinaria === true).length}/{filteredCleaners.length}
              </span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  </div>
  );
}