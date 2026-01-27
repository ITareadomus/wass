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
import { RefreshCw, Users } from "lucide-react";
import { cn } from "@/lib/utils";

interface Cleaner {
  id: number;
  cleaner_id?: number;
  name: string;
  lastname?: string;
  available?: boolean;
  start_time?: string;
  total_hours?: number;
  counter_hours?: number;
  weekly_hours?: number;
  role?: string;
  can_do_straordinaria?: boolean;
  contract_type?: string;
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
  const [convocatiCleaners, setConvocatiCleaners] = useState<Cleaner[]>([]);
  const [nonConvocatiCleaners, setNonConvocatiCleaners] = useState<Cleaner[]>([]);
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
      // Prima sincronizza i cleaners da MySQL a PostgreSQL
      try {
        await fetch('/api/extract-cleaners-optimized', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: workDate }),
          signal: AbortSignal.timeout(30000),
        });
        // Attendi un momento per permettere al database di propagare i dati
        await new Promise(resolve => setTimeout(resolve, 300));
      } catch (extractError) {
        console.warn('Estrazione cleaners fallita, uso dati esistenti:', extractError);
      }

      const [cleanersResponse, selectedResponse] = await Promise.all([
        fetch(`/api/cleaners?date=${workDate}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' },
          signal: AbortSignal.timeout(15000),
        }),
        fetch(`/api/selected-cleaners?date=${workDate}`, {
          signal: AbortSignal.timeout(15000),
        })
      ]);

      if (!cleanersResponse.ok) {
        console.error("Impossibile caricare cleaners da API");
        setConvocatiCleaners([]);
        setNonConvocatiCleaners([]);
        return;
      }

      const cleanersData = await cleanersResponse.json();
      const selectedData = selectedResponse.ok ? await selectedResponse.json() : { cleaners: [] };
      
      const convocatiIds = new Set(
        (selectedData.cleaners || []).map((c: any) => c.cleaner_id || c.id)
      );

      let allCleaners = (cleanersData.cleaners || []).map((c: any) => ({
        id: c.id,
        cleaner_id: c.id,
        name: c.name,
        lastname: c.lastname || "",
        available: c.available !== false,
        start_time: c.start_time,
        total_hours: c.total_hours,
        counter_hours: c.counter_hours,
        weekly_hours: c.weekly_hours,
        role: c.role,
        can_do_straordinaria: c.can_do_straordinaria,
        contract_type: c.contract_type,
      }));

      if (excludeCleanerId) {
        allCleaners = allCleaners.filter(
          (c: Cleaner) => c.id !== excludeCleanerId && c.cleaner_id !== excludeCleanerId
        );
      }

      const sortCleaners = (list: Cleaner[]) => {
        return list.sort((a: Cleaner, b: Cleaner) => {
          const getPriority = (cleaner: Cleaner) => {
            if (cleaner.role === "Formatore") return 1;
            if (cleaner.can_do_straordinaria === true) return 2;
            if (cleaner.role === "Premium") return 3;
            return 4;
          };

          const priorityA = getPriority(a);
          const priorityB = getPriority(b);

          if (priorityA !== priorityB) {
            return priorityA - priorityB;
          }

          const hoursA = Number(
            a.weekly_hours !== undefined && a.weekly_hours !== null
              ? a.weekly_hours
              : a.counter_hours ?? 0
          );
          const hoursB = Number(
            b.weekly_hours !== undefined && b.weekly_hours !== null
              ? b.weekly_hours
              : b.counter_hours ?? 0
          );
          return hoursB - hoursA;
        });
      };

      const convocati = allCleaners.filter((c: Cleaner) => convocatiIds.has(c.id));
      const nonConvocati = allCleaners.filter((c: Cleaner) => !convocatiIds.has(c.id));

      setConvocatiCleaners(sortCleaners(convocati));
      setNonConvocatiCleaners(sortCleaners(nonConvocati));
    } catch (error) {
      console.error("Errore nel caricamento dei cleaners:", error);
      setConvocatiCleaners([]);
      setNonConvocatiCleaners([]);
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
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header fisso */}
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-600" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Info sul Cleaner Primario - fisso */}
        <div className="flex-shrink-0 mt-2 p-3 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
          <p className="text-sm text-blue-700 dark:text-blue-300">
            <strong>Nota:</strong> Il cleaner a cui apparteneva in origine il task sarà considerato come{" "}
            <span className="font-bold">"Cleaner Primario"</span>, cioè il cleaner a cui verrà assegnato il task su ADAM.
          </p>
        </div>

        {/* Lista cleaners scrollabile */}
        <div className="flex-1 overflow-y-auto min-h-0 space-y-4 mt-4">
          {isLoadingCleaners ? (
            <div className="flex items-center justify-center py-8">
              <RefreshCw className="h-6 w-6 animate-spin text-purple-600 mr-2" />
              <p className="text-muted-foreground">Caricamento cleaners...</p>
            </div>
          ) : convocatiCleaners.length === 0 && nonConvocatiCleaners.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              Nessun cleaner disponibile per questa data
            </div>
          ) : (
            <>
              {convocatiCleaners.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500"></span>
                    Cleaners Convocati ({convocatiCleaners.length})
                  </h4>
                  <div className="space-y-2">
                    {convocatiCleaners.map((cleaner) => {
                      const isSelected = selectedIds.includes(cleaner.id);
                      const isPrimary = selectedIds.length > 0 && selectedIds[0] === cleaner.id;
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
                              <p className="font-semibold">
                                {displayName}
                                {isPrimary && (
                                  <span className="ml-2 text-xs font-bold text-blue-600 dark:text-blue-400">(P)</span>
                                )}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {cleaner.role || "Standard"} • Contratto: {cleaner.contract_type || "N/A"} • {Number(cleaner.counter_hours || 0).toFixed(2)}h
                                {cleaner.start_time && ` • Inizio: ${cleaner.start_time}`}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {!cleaner.available && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                                Non disponibile
                              </span>
                            )}
                            {cleaner.role === "Formatore" && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                                Formatore
                              </span>
                            )}
                            {cleaner.role === "Standard" && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                                Standard
                              </span>
                            )}
                            {cleaner.can_do_straordinaria && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700">
                                Straordinario
                              </span>
                            )}
                            {cleaner.role === "Premium" && !cleaner.can_do_straordinaria && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700">
                                Premium
                              </span>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}

              {nonConvocatiCleaners.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-2 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-gray-400"></span>
                    Cleaners Non Convocati ({nonConvocatiCleaners.length})
                  </h4>
                  <div className="space-y-2">
                    {nonConvocatiCleaners.map((cleaner) => {
                      const isSelected = selectedIds.includes(cleaner.id);
                      const isPrimary = selectedIds.length > 0 && selectedIds[0] === cleaner.id;
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
                              <p className="font-semibold">
                                {displayName}
                                {isPrimary && (
                                  <span className="ml-2 text-xs font-bold text-blue-600 dark:text-blue-400">(P)</span>
                                )}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {cleaner.role || "Standard"} • Contratto: {cleaner.contract_type || "N/A"} • {Number(cleaner.counter_hours || 0).toFixed(2)}h
                                {cleaner.start_time && ` • Inizio: ${cleaner.start_time}`}
                              </p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {!cleaner.available && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-gray-500/30 text-gray-800 dark:bg-gray-500/40 dark:text-gray-200 border-gray-600 dark:border-gray-400">
                                Non disponibile
                              </span>
                            )}
                            {cleaner.role === "Formatore" && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700">
                                Formatore
                              </span>
                            )}
                            {cleaner.role === "Standard" && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                                Standard
                              </span>
                            )}
                            {cleaner.can_do_straordinaria && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700">
                                Straordinario
                              </span>
                            )}
                            {cleaner.role === "Premium" && !cleaner.can_do_straordinaria && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700">
                                Premium
                              </span>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer fisso: preview + bottoni */}
        <div className="flex-shrink-0 border-t pt-4 mt-4 space-y-4">
          {selectedIds.length > 0 && baseCleaningTime > 0 && previewDuration && (
            <div className="p-3 bg-purple-50 dark:bg-purple-900/20 rounded-lg border border-purple-200 dark:border-purple-800">
              <p className="text-sm font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-2">
                <Users className="w-4 h-4" />
                Preview durata:
              </p>
              <p className="text-sm text-purple-600 dark:text-purple-400 font-bold mt-1">
                {previewDuration.duration} ore per cleaner
              </p>
              <p className="text-xs text-purple-500 dark:text-purple-500">
                ({previewDuration.totalCollaborators} collaborator{previewDuration.totalCollaborators > 1 ? "i" : "e"} totali)
              </p>
              {existingCollaboratorCount > 0 && (
                <p className="text-xs text-purple-400 dark:text-purple-600 mt-1 italic">
                  ({existingCollaboratorCount} esistenti + {selectedIds.length} nuov{selectedIds.length > 1 ? "i" : "o"})
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose} className="border-2 border-purple-300 dark:border-purple-700">
              Annulla
            </Button>
            <Button
              variant="outline"
              onClick={handleConfirm}
              disabled={selectedIds.length === 0 || isLoading}
              className="border-2 border-purple-300 dark:border-purple-700 hover:bg-purple-50 dark:hover:bg-purple-900/20"
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
