import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Users, Clock } from "lucide-react";
import { cn } from "@/lib/utils";

interface Cleaner {
  id: number;
  cleaner_id?: number;
  name: string;
  lastname?: string;
  available?: boolean;
  start_time?: string;
  total_hours?: number;
}

interface CleanerSelectorDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (selectedCleanerIds: number[]) => void;
  excludeCleanerId?: number | null;
  workDate: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  baseCleaningTime?: number;
  existingCollaboratorCount?: number;
  isLoading?: boolean;
}

export function CleanerSelectorDialog({
  isOpen,
  onClose,
  onConfirm,
  excludeCleanerId = null,
  workDate,
  title = "Seleziona Collaboratori",
  description = "Seleziona uno o più cleaners da aggiungere come collaboratori",
  confirmLabel = "Conferma",
  baseCleaningTime = 0,
  existingCollaboratorCount = 0,
  isLoading = false,
}: CleanerSelectorDialogProps) {
  const [cleaners, setCleaners] = useState<Cleaner[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [isLoadingCleaners, setIsLoadingCleaners] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadCleaners();
      setSelectedIds([]);
    }
  }, [isOpen, workDate]);

  const loadCleaners = async () => {
    setIsLoadingCleaners(true);
    try {
      const response = await fetch(`/api/selected-cleaners?date=${workDate}`, {
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.error("Impossibile caricare cleaners da API");
        setCleaners([]);
        return;
      }

      const data = await response.json();
      let cleanersList = data.cleaners || [];

      cleanersList = cleanersList.map((c: any) => ({
        id: c.cleaner_id || c.id,
        cleaner_id: c.cleaner_id || c.id,
        name: c.name,
        lastname: c.lastname || "",
        available: c.available !== false,
        start_time: c.start_time,
        total_hours: c.total_hours,
      }));

      if (excludeCleanerId) {
        cleanersList = cleanersList.filter(
          (c: Cleaner) => c.id !== excludeCleanerId && c.cleaner_id !== excludeCleanerId
        );
      }

      cleanersList.sort((a: Cleaner, b: Cleaner) => {
        const nameA = `${a.name} ${a.lastname || ""}`.toLowerCase();
        const nameB = `${b.name} ${b.lastname || ""}`.toLowerCase();
        return nameA.localeCompare(nameB);
      });

      setCleaners(cleanersList);
    } catch (error) {
      console.error("Errore nel caricamento dei cleaners:", error);
      setCleaners([]);
    } finally {
      setIsLoadingCleaners(false);
    }
  };

  const toggleCleaner = (cleanerId: number) => {
    setSelectedIds((prev) =>
      prev.includes(cleanerId)
        ? prev.filter((id) => id !== cleanerId)
        : [...prev, cleanerId]
    );
  };

  const handleConfirm = () => {
    if (selectedIds.length > 0) {
      onConfirm(selectedIds);
    }
  };

  const calculatePreviewDuration = () => {
    if (selectedIds.length === 0 || baseCleaningTime === 0) return null;
    const totalCollaborators = existingCollaboratorCount + selectedIds.length;
    const perCleaner = Math.ceil(baseCleaningTime / totalCollaborators);
    const hours = Math.floor(perCleaner / 60);
    const mins = perCleaner % 60;
    return { duration: `${hours}:${String(mins).padStart(2, "0")}`, totalCollaborators };
  };

  const previewDuration = calculatePreviewDuration();

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-600" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 mt-4">
          {isLoadingCleaners ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-purple-600 mr-2" />
              <p className="text-muted-foreground">Caricamento cleaners...</p>
            </div>
          ) : cleaners.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nessun cleaner disponibile per questa data
            </div>
          ) : (
            cleaners.map((cleaner) => {
              const isSelected = selectedIds.includes(cleaner.id);
              const displayName = cleaner.lastname
                ? `${cleaner.name} ${cleaner.lastname}`
                : cleaner.name;

              return (
                <label
                  key={cleaner.id}
                  className={cn(
                    "flex items-center justify-between p-3 border rounded-lg cursor-pointer transition-colors",
                    isSelected
                      ? "bg-purple-100 dark:bg-purple-900/30 border-purple-300 dark:border-purple-700"
                      : "hover:bg-accent",
                    !cleaner.available && "opacity-70"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => toggleCleaner(cleaner.id)}
                    />
                    <div>
                      <span className="font-medium">{displayName}</span>
                      {cleaner.start_time && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                          <Clock className="w-3 h-3" />
                          <span>Inizio: {cleaner.start_time}</span>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {cleaner.total_hours !== undefined && (
                      <Badge variant="outline" className="text-xs">
                        {cleaner.total_hours.toFixed(1)}h
                      </Badge>
                    )}
                    {!cleaner.available && (
                      <Badge variant="secondary" className="text-xs">
                        Non disponibile
                      </Badge>
                    )}
                  </div>
                </label>
              );
            })
          )}
        </div>

        {selectedIds.length > 0 && baseCleaningTime > 0 && previewDuration && (
          <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 rounded-lg border border-green-200 dark:border-green-800">
            <p className="text-sm font-medium text-green-700 dark:text-green-300">
              Preview durata:
            </p>
            <p className="text-sm text-green-600 dark:text-green-400">
              {previewDuration.duration} ore per cleaner ({previewDuration.totalCollaborators} collaborator
              {previewDuration.totalCollaborators > 1 ? "i" : "e"} totali)
            </p>
            {existingCollaboratorCount > 0 && (
              <p className="text-xs text-green-500 dark:text-green-500 mt-1">
                ({existingCollaboratorCount} esistenti + {selectedIds.length} nuov{selectedIds.length > 1 ? "i" : "o"})
              </p>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>
            Annulla
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={selectedIds.length === 0 || isLoading}
            className="bg-purple-600 hover:bg-purple-700"
          >
            {isLoading ? (
              <>
                <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                Assegnazione...
              </>
            ) : (
              <>
                {confirmLabel}
                {selectedIds.length > 0 && ` (${selectedIds.length})`}
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
