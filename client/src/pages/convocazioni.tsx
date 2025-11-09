import { useState, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

        // Carica cleaners.json per la data
        const cleanersResponse = await fetch(`/data/cleaners/cleaners.json?t=${Date.now()}`);
        if (!cleanersResponse.ok) {
          throw new Error('Impossibile caricare i cleaners');
        }

        const cleanersData = await cleanersResponse.json();

        // Trova i cleaners per la data specifica
        let dateCleaners = cleanersData.dates?.[dateStr]?.cleaners || [];

        // Se non ci sono cleaners per questa data, usa la data più recente disponibile
        if (dateCleaners.length === 0) {
          const availableDates = Object.keys(cleanersData.dates || {}).sort().reverse();
          if (availableDates.length > 0) {
            const latestDate = availableDates[0];
            dateCleaners = cleanersData.dates[latestDate]?.cleaners || [];
            console.log(`⚠️ Nessun cleaner per ${dateStr}, usando data ${latestDate}`);
          }
        }

        console.log(`📅 Cleaners totali per ${dateStr}:`, dateCleaners.length);

        // Carica selected_cleaners.json per gestire la persistenza delle selezioni
        const selectedResponse = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`);
        let alreadySelectedIds = new Set<number>();
        let preselectedIds = new Set<number>(); // IDs da mantenere selezionati nell'UI

        if (selectedResponse.ok) {
          const selectedData = await selectedResponse.json();
          // Verifica che la data in selected_cleaners corrisponda
          const selectedDateFromFile = selectedData.metadata?.date;
          console.log(`🔍 Data in selected_cleaners.json: ${selectedDateFromFile}, data richiesta: ${dateStr}`);

          // Filtra solo se la data corrisponde
          if (selectedDateFromFile === dateStr) {
            const selectedCleanerIds = selectedData.cleaners?.map((c: any) => c.id) || [];
            alreadySelectedIds = new Set(selectedCleanerIds);
            preselectedIds = new Set(selectedCleanerIds); // Mantieni la selezione visiva
            console.log(`✅ Cleaners già selezionati per ${dateStr}:`, Array.from(alreadySelectedIds));
          } else {
            console.log(`⚠️ Data non corrispondente (file: ${selectedDateFromFile}, richiesta: ${dateStr}), mostro TUTTI i cleaners`);
          }
        } else {
          console.log(`ℹ️ selected_cleaners.json non trovato, mostro TUTTI i cleaners`);
        }

        // NUOVO: Carica anche cleaners dalla timeline.json per pre-selezionarli
        const timelineResponse = await fetch(`/data/output/timeline.json?t=${Date.now()}`);
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
            console.warn('⚠️ Errore parsing timeline.json:', e);
          }
        }

        // Filtra cleaners: escludi SOLO quelli in selected_cleaners.json E mostra solo attivi
        // NON escludere quelli dalla timeline - li mostreremo come già selezionati
        const availableCleaners = dateCleaners.filter((c: any) => 
          !alreadySelectedIds.has(c.id) && c.active === true
        );

        console.log(`📊 Risultato filtro cleaners:`);
        console.log(`   - Totali per ${dateStr}: ${dateCleaners.length}`);
        console.log(`   - Già in selected_cleaners.json: ${alreadySelectedIds.size}`);
        console.log(`   - Pre-selezionati dalla timeline: ${preselectedIds.size}`);
        console.log(`   - Disponibili da mostrare: ${availableCleaners.length}`);

        // Ordina per counter_hours (decrescente - più ore prima)
        availableCleaners.sort((a, b) => b.counter_hours - a.counter_hours);

        setCleaners(availableCleaners);
        setFilteredCleaners(availableCleaners);
        
        // Mantieni la selezione visiva dei cleaner dalla timeline
        setSelectedCleaners(preselectedIds);
        
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
    if (!isAvailable) {
      setConfirmDialog({ open: true, cleanerId });
      return;
    }

    setSelectedCleaners(prev => {
      const newSet = new Set(prev);
      if (newSet.has(cleanerId)) {
        newSet.delete(cleanerId);
      } else {
        newSet.add(cleanerId);
      }
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
      const selectedCleanersData = cleaners.filter(c => selectedCleaners.has(c.id));
      const dateStr = format(selectedDate, "yyyy-MM-dd");

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

      // Carica la selezione attuale
      const currentResponse = await fetch('/data/cleaners/selected_cleaners.json');
      const currentData = await currentResponse.json();
      const currentCleaners = currentData.cleaners || [];

      // Unisci i cleaners esistenti con i nuovi selezionati (evita duplicati)
      const existingIds = new Set(currentCleaners.map((c: any) => c.id));
      const newCleanersToFilter = cleaners.filter(c => selectedCleaners.has(c.id));
      const newCleaners = newCleanersToFilter.filter(c => !existingIds.has(c.id));
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

      toast({
        variant: "success",
        title: `${newCleaners.length} cleaner selezionati correttamente!`,
        description: `Totale cleaners: ${mergedCleaners.length} per il ${format(selectedDate, "dd/MM/yyyy", { locale: it })}`
      });

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
            <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
              <Users className="w-8 h-8 text-primary" />
              CONVOCAZIONI
              <span className="text-2xl font-normal text-muted-foreground ml-4">
                del {format(selectedDate, "dd/MM/yyyy", { locale: it })}
              </span>
            </h1>

            {/* Selettore Data e Dark Mode Toggle */}
            <div className="flex items-center gap-3">
              <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-[240px] justify-start text-left font-normal",
                    !selectedDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {selectedDate ? format(selectedDate, "PPP", { locale: it }) : <span>Seleziona data</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(date) => date && setSelectedDate(date)}
                  initialFocus
                  locale={it}
                />
              </PopoverContent>
            </Popover>
              <ThemeToggle />
            </div>
          </div>

          {/* Barra Contatore */}
          <div className="bg-gradient-to-r from-primary/10 via-primary/20 to-primary/10 rounded-xl border-2 border-primary/30 shadow-lg p-6">
            <div className="flex items-center gap-4">
              <div className="text-lg font-semibold text-muted-foreground">CLEANERS SELEZIONATI</div>
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
          <Card className="p-6 lg:col-span-2 flex flex-col overflow-hidden">
          <div className="space-y-3 flex-1 overflow-y-auto pr-2">
            {filteredCleaners.map((cleaner) => { // Itera su filteredCleaners
              const isPremium = cleaner.role === "Premium";
              const isAvailable = cleaner.available !== false;
              const isFormatore = cleaner.role === "Formatore";
              const canDoStraordinaria = (cleaner as any).can_do_straordinaria === true;

              const borderColor = !isAvailable
                ? "border-gray-400"
                : isFormatore ? "border-orange-500"
                : isPremium ? "border-yellow-500" : "border-green-500";
              const bgColor = !isAvailable
                ? "bg-gray-300/30 dark:bg-gray-700/30"
                : isFormatore ? "bg-orange-500/10"
                : isPremium ? "bg-yellow-500/10" : "bg-green-500/10";
              const badgeColor = !isAvailable
                ? "bg-gray-400/20 text-gray-700 dark:text-gray-200 border-gray-400 dark:border-gray-500"
                : isFormatore ? "bg-orange-500/20 text-orange-700 border-orange-500"
                : isPremium ? "bg-yellow-500/20 text-yellow-700 border-yellow-500" : "bg-green-500/20 text-green-700 border-green-500";

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
                          <span className={`px-2 py-0.5 rounded border font-medium text-sm ${badgeColor}`}>
                            {cleaner.role}
                          </span>
                          {canDoStraordinaria && (
                            <span className="px-2 py-0.5 rounded border font-medium text-sm bg-red-500/20 text-red-700 dark:text-red-300 border-red-500">
                              Straordinario
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-xs text-foreground/80">
                        <span className="font-semibold">Ore questa settimana:</span> {cleaner.counter_hours}h
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Giorni consecutivi:</span> {cleaner.counter_days}
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Contratto:</span> {cleaner.contract_type}
                        <span className="mx-2">|</span>
                        <span className="font-semibold">Start Time:</span> {cleaner.start_time || "10:00"}
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={selectedCleaners.has(cleaner.id)}
                    onCheckedChange={() => toggleCleanerSelection(cleaner.id, isAvailable)}
                    className="scale-150 pointer-events-none"
                  />
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
                <Button variant="outline" onClick={() => setConfirmDialog({ open: false, cleanerId: null })}>
                  Annulla
                </Button>
                <Button onClick={handleConfirmUnavailable}>
                  Conferma
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <div className="flex justify-between mt-4 pt-4 border-t">
            <Button
              onClick={handleSaveSelection}
              size="lg"
              disabled={selectedCleaners.size === 0}
              className="flex items-center gap-2"
            >
              <Save className="w-4 h-4" />
              Salva
            </Button>
            <Button
              variant="outline"
              onClick={() => setLocation('/')}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Torna Indietro
            </Button>
          </div>
        </Card>

        {/* Pannello Statistiche - 1/3 dello spazio - FISSO */}
        <Card className="p-6 border-2 flex flex-col h-full overflow-hidden">
          <h3 className="text-lg font-semibold text-foreground mb-4">Statistiche</h3>

          {/* Statistiche Task */}
          <div className="mb-4 pb-3 border-b border-border">
            <h4 className="text-xs font-semibold text-muted-foreground mb-2">Task Giornata</h4>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-blue-50 dark:bg-blue-950/20 rounded-lg p-2 border border-blue-200 dark:border-blue-800">
                <div className="text-lg font-bold text-blue-600">{taskStats.total}</div>
                <div className="text-[10px] text-blue-700 dark:text-blue-300">Totale</div>
              </div>
              <div className="bg-yellow-50 dark:bg-yellow-950/20 rounded-lg p-2 border border-yellow-200 dark:border-yellow-800">
                <div className="text-lg font-bold text-yellow-600">{taskStats.premium}</div>
                <div className="text-[10px] text-yellow-700 dark:text-yellow-300">Premium</div>
              </div>
              <div className="bg-green-50 dark:bg-green-950/20 rounded-lg p-2 border border-green-200 dark:border-green-800">
                <div className="text-lg font-bold text-green-600">{taskStats.standard}</div>
                <div className="text-[10px] text-green-700 dark:text-green-300">Standard</div>
              </div>
              <div className="bg-red-50 dark:bg-red-950/20 rounded-lg p-2 border border-red-200 dark:border-red-800">
                <div className="text-lg font-bold text-red-600">{taskStats.straordinarie}</div>
                <div className="text-[10px] text-red-700 dark:text-red-300">Straordinarie</div>
              </div>
            </div>
          </div>

          {/* Statistiche Cleaners */}
          <h4 className="text-xs font-semibold text-muted-foreground mb-2">Cleaners</h4>
          <div className="grid grid-cols-2 gap-2 flex-1">
            {/* Disponibili */}
            <div className="bg-blue-50 dark:bg-blue-950/20 rounded-lg p-2 flex flex-col items-center justify-center border border-blue-200 dark:border-blue-800">
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
              <span className="text-[10px] font-semibold text-blue-700 dark:text-blue-300 text-center">Disponibili</span>
              <span className="text-[9px] text-blue-600 dark:text-blue-400">
                {filteredCleaners.filter(c => c.available !== false).length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Non Disponibili */}
            <div className="bg-gray-50 dark:bg-gray-950/20 rounded-lg p-2 flex flex-col items-center justify-center border border-gray-200 dark:border-gray-700">
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
              <span className="text-[10px] font-semibold text-gray-700 dark:text-gray-300 text-center">Non Disponibili</span>
              <span className="text-[9px] text-gray-600 dark:text-gray-400">
                {filteredCleaners.filter(c => c.available === false).length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Premium */}
            <div className="bg-yellow-50 dark:bg-yellow-950/20 rounded-lg p-2 flex flex-col items-center justify-center border border-yellow-200 dark:border-yellow-800">
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
              <span className="text-[10px] font-semibold text-yellow-700 dark:text-yellow-300 text-center">Premium</span>
              <span className="text-[9px] text-yellow-600 dark:text-yellow-400">
                {filteredCleaners.filter(c => c.role === "Premium").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Standard */}
            <div className="bg-green-50 dark:bg-green-950/20 rounded-lg p-2 flex flex-col items-center justify-center border border-green-200 dark:border-green-800">
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
              <span className="text-[10px] font-semibold text-green-700 dark:text-green-300 text-center">Standard</span>
              <span className="text-[9px] text-green-600 dark:text-green-400">
                {filteredCleaners.filter(c => c.role === "Standard").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Formatori */}
            <div className="bg-orange-50 dark:bg-orange-950/20 rounded-lg p-2 flex flex-col items-center justify-center border border-orange-200 dark:border-orange-800">
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
              <span className="text-[10px] font-semibold text-orange-700 dark:text-orange-300 text-center">Formatori</span>
              <span className="text-[9px] text-orange-600 dark:text-orange-400">
                {filteredCleaners.filter(c => c.role === "Formatore").length}/{filteredCleaners.length}
              </span>
            </div>

            {/* Straordinari */}
            <div className="bg-red-50 dark:bg-red-950/20 rounded-lg p-2 flex flex-col items-center justify-center border border-red-200 dark:border-red-800">
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
              <span className="text-[10px] font-semibold text-red-700 dark:text-red-300 text-center">Straordinari</span>
              <span className="text-[9px] text-red-600 dark:text-red-400">
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