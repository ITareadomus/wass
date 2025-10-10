
import { useState, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Users, CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { cn } from "@/lib/utils";

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
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());

  useEffect(() => {
    const extractCleaners = async () => {
      try {
        setIsLoading(true);
        setLoadingMessage("Estrazione cleaners dal database...");

        // Formatta la data nel formato YYYY-MM-DD
        const formattedDate = format(selectedDate, "yyyy-MM-dd");

        // Esegui lo script extract_cleaners.py con la data selezionata
        const response = await fetch('/api/extract-cleaners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: formattedDate })
        });

        if (!response.ok) {
          throw new Error('Errore durante l\'estrazione dei cleaners');
        }

        const result = await response.json();
        console.log("Estrazione cleaners completata:", result);

        setLoadingMessage("Caricamento cleaners...");

        // Carica il file cleaners.json generato
        const cleanersResponse = await fetch('/data/cleaners/cleaners.json');
        if (!cleanersResponse.ok) {
          throw new Error('Errore nel caricamento di cleaners.json');
        }

        const cleanersData = await cleanersResponse.json();
        
        // Estrai i cleaners dalla struttura nested
        let cleanersList: Cleaner[] = [];
        if (cleanersData.dates) {
          const latestDate = Object.keys(cleanersData.dates).sort().reverse()[0];
          cleanersList = cleanersData.dates[latestDate]?.cleaners || [];
        } else if (cleanersData.cleaners) {
          cleanersList = cleanersData.cleaners;
        }

        // Ordina per ore crescenti
        cleanersList.sort((a, b) => a.counter_hours - b.counter_hours);

        setCleaners(cleanersList);
        setSelectedCleaners(new Set()); // Reset selezioni quando cambia la data
        setIsLoading(false);
        setLoadingMessage("Cleaners caricati con successo!");
      } catch (error) {
        console.error("Errore nell'estrazione dei cleaners:", error);
        setLoadingMessage("Errore durante l'estrazione dei cleaners");
        setIsLoading(false);
      }
    };

    extractCleaners();
  }, [selectedDate]);

  const toggleCleanerSelection = (cleanerId: number) => {
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

  const handleConfirm = () => {
    console.log("Cleaners selezionati:", Array.from(selectedCleaners));
    // Logica da implementare
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
      <div className="container mx-auto p-2 max-w-screen-xl">
        <div className="mb-3 flex justify-between items-center flex-wrap gap-2">
          <h1 className="text-lg font-bold text-foreground flex items-center gap-1">
            <Users className="w-4 h-4 text-primary" />
            CONVOCAZIONI
          </h1>
          
          <div className="flex items-center gap-2">
            {/* Selettore Data */}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-[120px] justify-start text-left font-normal text-xs h-7",
                    !selectedDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-1 h-3 w-3" />
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

            {/* Contatore Cleaners */}
            <div className="bg-card rounded-lg border shadow-sm px-2 py-1 text-center">
              <div className="text-xs text-muted-foreground">Selezionati / Disponibili</div>
              <div className="text-base font-bold">
                <span className="text-primary">{selectedCleaners.size}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-foreground">{cleaners.length}</span>
              </div>
            </div>
          </div>
        </div>

        <Card className="p-3 mb-3">
          <div className="space-y-1.5">
            {cleaners.map((cleaner) => {
              const isPremium = cleaner.role === "Premium";
              const borderColor = isPremium ? "border-yellow-500" : "border-green-500";
              const bgColor = isPremium ? "bg-yellow-500/10" : "bg-green-500/10";
              const badgeColor = isPremium ? "bg-yellow-500/20 text-yellow-700 border-yellow-500" : "bg-green-500/20 text-green-700 border-green-500";
              
              return (
                <div
                  key={cleaner.id}
                  className={`flex items-center justify-between p-2 border rounded-lg hover:opacity-80 transition-all ${borderColor} ${bgColor}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex flex-col gap-1">
                      <span className="font-semibold text-foreground text-sm">
                        {cleaner.name} {cleaner.lastname}
                      </span>
                      <div className="flex gap-1 text-xs text-muted-foreground">
                        <span className={`px-1 py-0.5 rounded border font-medium text-xs ${badgeColor}`}>
                          {cleaner.role}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs text-foreground/80">
                        <div>
                          <span className="font-semibold">Ore settimana:</span> {cleaner.counter_hours}h
                        </div>
                        <div>
                          <span className="font-semibold">Giorni consecutivi:</span> {cleaner.counter_days}
                        </div>
                        <div>
                          <span className="font-semibold">Contratto:</span> {cleaner.contract_type}
                        </div>
                        <div>
                          <span className="font-semibold">Start Time:</span> {cleaner.start_time || "10:00"}
                        </div>
                      </div>
                    </div>
                  </div>
                  <Switch
                    checked={selectedCleaners.has(cleaner.id)}
                    onCheckedChange={() => toggleCleanerSelection(cleaner.id)}
                  />
                </div>
              );
            })}
          </div>
        </Card>

        <div className="flex justify-end">
          <Button
            onClick={handleConfirm}
            size="sm"
            disabled={selectedCleaners.size === 0}
          >
            Conferma ({selectedCleaners.size})
          </Button>
        </div>
      </div>
    </div>
  );
}
