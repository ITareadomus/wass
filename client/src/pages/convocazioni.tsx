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

export default function Convocazioni() {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedCleaners, setSelectedCleaners] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState("Inizializzazione...");
  const [selectedDate, setSelectedDate] = useState<Date>(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow;
  });
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; cleanerId: number | null }>({ open: false, cleanerId: null });
  const { toast } = useToast();
  const [, setLocation] = useLocation();

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

        const response = await fetch('/data/cleaners/cleaners.json');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const cleanersData = await response.json();
        console.log("Cleaners caricati da cleaners.json:", cleanersData);

        // Estrai i cleaners dalla struttura del file
        let cleanersList: Cleaner[] = [];
        if (cleanersData.dates) {
          const latestDate = Object.keys(cleanersData.dates).sort().reverse()[0];
          cleanersList = cleanersData.dates[latestDate]?.cleaners || [];
        } else if (cleanersData.cleaners) {
          cleanersList = cleanersData.cleaners;
        }

        // Ordina per counter_hours (decrescente - più ore prima)
        cleanersList.sort((a, b) => b.counter_hours - a.counter_hours);

        setCleaners(cleanersList);
        setSelectedCleaners(new Set()); // Reset selezioni quando cambia la data
        setIsLoading(false);
        setLoadingMessage("Cleaners caricati con successo!");
      } catch (error) {
        console.error("Errore nel caricamento dei cleaners:", error);
        setLoadingMessage("Errore nel caricamento dei cleaners");
        setIsLoading(false);
      }
    };

    loadCleaners();
  }, [selectedDate]);

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

      const dataToSave = {
        cleaners: selectedCleanersData,
        total_selected: selectedCleanersData.length
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
        title: `${selectedCleanersData.length} cleaner selezionati correttamente!`,
        description: ""
      });
      setLocation('/');
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
        total_selected: mergedCleaners.length
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
        description: `Totale cleaners: ${mergedCleaners.length}`
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
              <ThemeToggle />
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
            </div>
          </div>

          {/* Barra Contatore */}
          <div className="bg-gradient-to-r from-primary/10 via-primary/20 to-primary/10 rounded-xl border-2 border-primary/30 shadow-lg p-6">
            <div className="flex items-center gap-4">
              <div className="text-lg font-semibold text-muted-foreground">CLEANERS SELEZIONATI</div>
              <div className="text-lg font-bold">
                <span className="text-primary">{selectedCleaners.size}</span>
                <span className="text-muted-foreground mx-1">/</span>
                <span className="text-foreground">{cleaners.length}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Grid con lista cleaners e statistiche affiancate */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[calc(100vh-200px)]">
          {/* Lista Cleaners - 2/3 dello spazio */}
          <Card className="p-6 lg:col-span-2 flex flex-col overflow-hidden">
          <div className="space-y-3 flex-1 overflow-y-auto pr-2">
            {cleaners.map((cleaner) => {
              const isPremium = cleaner.role === "Premium";
              const isAvailable = cleaner.available !== false;
              const isFormatore = cleaner.role === "Formatore";

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
                        <span className={`px-2 py-0.5 rounded border font-medium text-sm ${badgeColor}`}>
                          {cleaner.role}
                        </span>
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
          <div className="flex justify-start mt-4 pt-4 border-t">
            <Button
              onClick={handleSaveSelection}
              size="lg"
              disabled={selectedCleaners.size === 0}
            >
              Conferma
            </Button>
          </div>
        </Card>

        {/* Pannello Statistiche - 1/3 dello spazio - FISSO */}
        <Card className="p-6 border-2 flex flex-col h-full overflow-hidden">
          <h3 className="text-lg font-semibold text-foreground mb-4">Statistiche Cleaners</h3>
          <div className="space-y-3 text-sm flex-1 overflow-y-auto">
            <div className="space-y-3">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Disponibili:</span>
                <span className="font-bold text-green-600">
                  {cleaners.filter(c => c.available !== false).length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Non Disponibili:</span>
                <span className="font-bold text-gray-500">
                  {cleaners.filter(c => c.available === false).length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Premium:</span>
                <span className="font-bold text-yellow-600">
                  {cleaners.filter(c => c.role === "Premium").length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Standard:</span>
                <span className="font-bold text-green-600">
                  {cleaners.filter(c => c.role === "Standard").length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Formatori:</span>
                <span className="font-bold text-orange-600">
                  {cleaners.filter(c => c.role === "Formatore").length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Premium Disp.:</span>
                <span className="font-bold text-yellow-600">
                  {cleaners.filter(c => c.role === "Premium" && c.available !== false).length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Standard Disp.:</span>
                <span className="font-bold text-green-600">
                  {cleaners.filter(c => c.role === "Standard" && c.available !== false).length}
                </span>
              </div>
              <div className="flex justify-between items-center pt-2 border-t">
                <span className="text-muted-foreground">Contratto A:</span>
                <span className="font-bold text-blue-600">
                  {cleaners.filter(c => c.contract_type === "A").length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">Contratto B:</span>
                <span className="font-bold text-blue-600">
                  {cleaners.filter(c => c.contract_type === "B").length}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">A Chiamata:</span>
                <span className="font-bold text-purple-600">
                  {cleaners.filter(c => c.contract_type === "a chiamata").length}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Pulsanti Annulla, Aggiungi, Sostituisci */}
      <div className="p-4 border-t flex justify-between items-center">
            <Button
              variant="outline"
              onClick={() => setLocation('/')}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="w-4 h-4" />
              Annulla
            </Button>
            <div className="flex gap-2">
              <Button
                onClick={handleAddCleaners}
                disabled={selectedCleaners.size === 0}
                variant="secondary"
                className="flex items-center gap-2"
              >
                <UserPlus className="w-4 h-4" />
                Aggiungi ({selectedCleaners.size})
              </Button>
              <Button
                onClick={handleSaveSelection}
                disabled={selectedCleaners.size === 0}
                className="flex items-center gap-2"
              >
                <Save className="w-4 h-4" />
                Sostituisci ({selectedCleaners.size})
              </Button>
            </div>
          </div>
      </div>
    </div>
  );
}