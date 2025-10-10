
import { useState, useEffect } from "react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Users } from "lucide-react";

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

  useEffect(() => {
    const extractCleaners = async () => {
      try {
        setIsLoading(true);
        setLoadingMessage("Estrazione cleaners dal database...");

        // Esegui lo script extract_cleaners.py
        const response = await fetch('/api/extract-cleaners', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
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

        setCleaners(cleanersList);
        setIsLoading(false);
        setLoadingMessage("Cleaners caricati con successo!");
      } catch (error) {
        console.error("Errore nell'estrazione dei cleaners:", error);
        setLoadingMessage("Errore durante l'estrazione dei cleaners");
        setIsLoading(false);
      }
    };

    extractCleaners();
  }, []);

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
      <div className="container mx-auto p-4 max-w-screen-xl">
        <div className="mb-6 flex justify-between items-center">
          <h1 className="text-3xl font-bold text-foreground flex items-center gap-2">
            <Users className="w-8 h-8 text-primary" />
            CONVOCAZIONI
          </h1>
          <div className="bg-card rounded-lg border shadow-sm px-4 py-2 text-center">
            <div className="text-sm text-muted-foreground">Cleaners Disponibili</div>
            <div className="text-2xl font-bold text-primary">{cleaners.length}</div>
          </div>
        </div>

        <Card className="p-6 mb-6">
          <div className="space-y-3">
            {cleaners.map((cleaner) => {
              const isPremium = cleaner.role === "Premium";
              const borderColor = isPremium ? "border-yellow-500" : "border-green-500";
              const bgColor = isPremium ? "bg-yellow-500/10" : "bg-green-500/10";
              const badgeColor = isPremium ? "bg-yellow-500/20 text-yellow-700 border-yellow-500" : "bg-green-500/20 text-green-700 border-green-500";
              
              return (
                <div
                  key={cleaner.id}
                  className={`flex items-center justify-between p-4 border-2 rounded-lg hover:opacity-80 transition-all ${borderColor} ${bgColor}`}
                >
                  <div className="flex items-center gap-4">
                    <div className="flex flex-col gap-2">
                      <span className="font-semibold text-foreground text-lg">
                        {cleaner.name} {cleaner.lastname}
                      </span>
                      <div className="flex gap-2 text-sm text-muted-foreground">
                        <span className={`px-2 py-0.5 rounded border font-medium ${badgeColor}`}>
                          {cleaner.role}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-foreground/80">
                        <div>
                          <span className="font-semibold">Ore questa settimana:</span> {cleaner.counter_hours}h
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

        <div className="flex justify-end gap-4">
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <span className="font-semibold">Selezionati:</span>
            <span className="bg-primary text-primary-foreground px-3 py-1 rounded">
              {selectedCleaners.size}
            </span>
          </div>
          <Button
            onClick={handleConfirm}
            size="lg"
            disabled={selectedCleaners.size === 0}
          >
            Conferma
          </Button>
        </div>
      </div>
    </div>
  );
}
