import { useCallback, useMemo, useState } from "react";
import { format } from "date-fns";
import { it } from "date-fns/locale";
import { CalendarIcon } from "lucide-react";
import { ComparisonMap } from "@/components/comparison/comparison-map";
import { ComparisonSelectionProvider } from "@/components/comparison/comparison-selection";
import { ComparisonTimeline } from "@/components/comparison/comparison-timeline";
import { useSyncedTimelineScroll } from "@/hooks/use-synced-timeline-scroll";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getStoredUser } from "@/lib/auth-role";
import { cn } from "@/lib/utils";
import { comparisonPxPerMinute, comparisonWindow, snapshotFromDaySql, type DaySnapshot } from "@shared/day-sql-snapshot";

interface LoadedDay {
  fileName: string;
  snapshot: DaySnapshot;
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Lettura del file non riuscita"));
    reader.readAsText(file);
  });
}

function OriginChoice({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={
        selected
          ? "rounded-md border border-primary bg-primary/10 px-3 py-1.5 text-sm font-medium text-foreground"
          : "rounded-md border bg-background px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
      }
    >
      {label}
    </button>
  );
}

function DaySlot({
  title,
  loaded,
  error,
  startMin,
  endMin,
  pxPerMinute,
  scroll,
  onFocusMinutes,
  importing,
  onFile,
  onWass,
  onClear,
}: {
  title: string;
  loaded: LoadedDay | null;
  error: string | null;
  startMin: number;
  endMin: number;
  pxPerMinute: number;
  scroll: Pick<
    ReturnType<typeof useSyncedTimelineScroll>,
    "registerScrollRef" | "handleScroll" | "handlePointerDown" | "handlePointerMove" | "stopPan"
  >;
  onFocusMinutes: (minutes: number) => void;
  importing: boolean;
  onFile: (file: File) => void;
  onWass: (workDate: string, source: "housekeeping" | "alg-test") => void;
  onClear: () => void;
}) {
  const [workDate, setWorkDate] = useState("");
  const [origin, setOrigin] = useState<"wass" | "sql">("wass");
  const [source, setSource] = useState<"housekeeping" | "alg-test">("housekeeping");
  const day = loaded?.snapshot ?? null;
  const selectedDate = workDate
    ? new Date(Number(workDate.slice(0, 4)), Number(workDate.slice(5, 7)) - 1, Number(workDate.slice(8, 10)))
    : undefined;
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">
            {day
              ? `${day.workDate ?? "Data non indicata"} · ${loaded?.fileName} · ${day.assignedCount} assegnazioni · ${day.cleaners.length} cleaner`
              : origin === "wass"
                ? "Prima l'origine, poi quale giornata caricare."
                : "Prima l'origine, poi il file SQL."}
          </p>
        </div>
        {loaded ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            Rimuovi
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">1. Da dove</p>
          <div className="flex flex-wrap gap-2" role="group" aria-label={`Origine ${title}`}>
            <OriginChoice label="Da WASS" selected={origin === "wass"} onClick={() => setOrigin("wass")} />
            <OriginChoice label="Da file SQL" selected={origin === "sql"} onClick={() => setOrigin("sql")} />
          </div>
        </div>
        {origin === "wass" ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (workDate) onWass(workDate, source);
            }}
          >
            <p className="text-xs font-medium text-muted-foreground">2. Quale giornata</p>
            <div className="flex flex-wrap gap-2" role="group" aria-label={`Tipo giornata ${title}`}>
              <OriginChoice
                label="Giornata vera"
                selected={source === "housekeeping"}
                onClick={() => setSource("housekeeping")}
              />
              <OriginChoice
                label="Giornata di prova"
                selected={source === "alg-test"}
                onClick={() => setSource("alg-test")}
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`Data ${title}`}
                    className={cn(
                      "justify-start border-2 border-custom-blue text-left text-[13px] font-normal [background-clip:unset] [-webkit-background-clip:unset]",
                      !selectedDate && "text-muted-foreground",
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
                    onSelect={(date) => {
                      if (!date) return;
                      setWorkDate(format(date, "yyyy-MM-dd"));
                    }}
                    initialFocus
                    locale={it}
                  />
                </PopoverContent>
              </Popover>
              <Button type="submit" variant="outline" size="sm" disabled={!workDate || importing}>
                {importing ? "Carico..." : "Carica"}
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">2. File</p>
            <label className="inline-flex cursor-pointer items-center rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted">
              Scegli il file SQL
              <input
                type="file"
                accept=".sql,text/plain"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onFile(file);
                }}
              />
            </label>
          </div>
        )}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {day ? (
        <ComparisonSelectionProvider
          onTaskId={(taskId) => {
            const task = day.tasks.find((item) => item.taskId === taskId || `${item.taskId}:${item.cleanerId}` === taskId);
            if (task?.startMin != null) onFocusMinutes(task.startMin);
          }}
        >
          <ComparisonTimeline
            day={day}
            startMin={startMin}
            endMin={endMin}
            pxPerMinute={pxPerMinute}
            registerScrollRef={scroll.registerScrollRef}
            onScroll={scroll.handleScroll}
            onPointerDown={scroll.handlePointerDown}
            onPointerMove={scroll.handlePointerMove}
            onPointerUp={scroll.stopPan}
            onPointerCancel={scroll.stopPan}
          />
          <ComparisonMap day={day} />
        </ComparisonSelectionProvider>
      ) : origin === "sql" ? (
        <label
          className="flex h-48 cursor-pointer items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files?.[0];
            if (file) onFile(file);
          }}
        >
          Trascina qui il file .sql
          <input
            type="file"
            accept=".sql,text/plain"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) onFile(file);
            }}
          />
        </label>
      ) : (
        <div className="flex h-48 items-center justify-center rounded-lg border border-dashed px-4 text-center text-sm text-muted-foreground">
          Scegli giornata vera o giornata di prova, poi la data.
        </div>
      )}
    </section>
  );
}

export default function DayComparison() {
  const [left, setLeft] = useState<LoadedDay | null>(null);
  const [right, setRight] = useState<LoadedDay | null>(null);
  const [leftError, setLeftError] = useState<string | null>(null);
  const [rightError, setRightError] = useState<string | null>(null);
  const [importing, setImporting] = useState<"left" | "right" | null>(null);
  const timelineScroll = useSyncedTimelineScroll();

  const loadedDays = [left?.snapshot ?? null, right?.snapshot ?? null];
  const windowRange = useMemo(() => comparisonWindow(loadedDays), [left, right]);
  const pxPerMinute = useMemo(() => comparisonPxPerMinute(loadedDays), [left, right]);
  const onFocusMinutes = useCallback((minutes: number) => {
    timelineScroll.applyScrollLeft((minutes - windowRange.startMin) * pxPerMinute - 60);
  }, [pxPerMinute, timelineScroll.applyScrollLeft, windowRange.startMin]);

  const load = async (file: File, side: "left" | "right") => {
    const setLoaded = side === "left" ? setLeft : setRight;
    const setError = side === "left" ? setLeftError : setRightError;
    setError(null);
    try {
      const text = await readFile(file);
      const snapshot = snapshotFromDaySql(text);
      setLoaded({ fileName: file.name, snapshot });
    } catch (error) {
      setLoaded(null);
      setError(error instanceof Error ? error.message : "File non leggibile");
    }
  };

  const loadFromWass = async (
    workDate: string,
    side: "left" | "right",
    source: "housekeeping" | "alg-test" = "housekeeping",
  ) => {
    const setLoaded = side === "left" ? setLeft : setRight;
    const setError = side === "left" ? setLeftError : setRightError;
    setError(null);
    setImporting(side);
    try {
      const username = getStoredUser()?.username ?? "";
      const scopeQuery = source === "alg-test" ? "&scope=alg-test" : "";
      const response = await fetch(`/api/day-export.sql?date=${encodeURIComponent(workDate)}${scopeQuery}`, {
        headers: { "x-wass-username": username },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Import da WASS non riuscito");
      }
      const text = await response.text();
      if (!/insert\s+into/i.test(text)) {
        throw new Error(
          source === "alg-test"
            ? "Nessuna prova algoritmo per questa data. Aprila da Prova algoritmo e premi Assegna."
            : "Nessuna giornata salvata in WASS per questa data",
        );
      }
      const snapshot = snapshotFromDaySql(text, source);
      if (source === "alg-test" && snapshot.assignedCount === 0 && snapshot.containerCount === 0) {
        throw new Error("Nessuna prova algoritmo per questa data. Aprila da Prova algoritmo e premi Assegna.");
      }
      setLoaded({
        fileName: source === "alg-test" ? `Prova ${workDate}` : `WASS ${workDate}`,
        snapshot,
      });
    } catch (error) {
      setLoaded(null);
      setError(error instanceof Error ? error.message : "Import da WASS non riuscito");
    } finally {
      setImporting(null);
    }
  };

  return (
    <main className="mx-auto flex max-w-[1800px] flex-col gap-6 px-4 py-6">
      <div>
        <h1 className="text-2xl font-semibold">Confronto giornate</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Per ogni lato scegli prima se la giornata arriva da WASS o da un file SQL. Se è WASS, poi scegli giornata vera o giornata di prova. Le due timeline scorrono insieme, trascinando o con la barra in alto. Un doppio clic su un task o su un cleaner lo evidenzia sulla mappa di quel lato.
        </p>
      </div>
      <div ref={timelineScroll.setScrollRootRef} className="grid items-start gap-6 md:grid-cols-2">
        <DaySlot
          title="Giornata A"
          loaded={left}
          error={leftError}
          startMin={windowRange.startMin}
          endMin={windowRange.endMin}
          pxPerMinute={pxPerMinute}
          scroll={timelineScroll}
          onFocusMinutes={onFocusMinutes}
          importing={importing === "left"}
          onFile={(file) => void load(file, "left")}
          onWass={(workDate, source) => void loadFromWass(workDate, "left", source)}
          onClear={() => {
            setLeft(null);
            setLeftError(null);
          }}
        />
        <DaySlot
          title="Giornata B"
          loaded={right}
          error={rightError}
          startMin={windowRange.startMin}
          endMin={windowRange.endMin}
          pxPerMinute={pxPerMinute}
          scroll={timelineScroll}
          onFocusMinutes={onFocusMinutes}
          importing={importing === "right"}
          onFile={(file) => void load(file, "right")}
          onWass={(workDate, source) => void loadFromWass(workDate, "right", source)}
          onClear={() => {
            setRight(null);
            setRightError(null);
          }}
        />
      </div>
    </main>
  );
}
