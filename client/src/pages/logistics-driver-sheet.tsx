import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "wouter";
import { format } from "date-fns";
import { ArrowLeft, Loader2 } from "lucide-react";
import LogisticsDriverSequenceSheet from "@/components/logistics-driver-sequence-sheet";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { Button } from "@/components/ui/button";
import {
  buildSequenceSummaryGroupsFromDriverAssignments,
  type SequenceSummaryGroup,
} from "@/lib/sequence-summary";

function resolveWorkDate(): string {
  if (typeof window === "undefined") return format(new Date(), "yyyy-MM-dd");

  const urlParams = new URLSearchParams(window.location.search);
  const dateParam = urlParams.get("date");
  if (dateParam) return dateParam;

  const saved = localStorage.getItem("selected_work_date");
  if (saved) return saved;

  return format(new Date(), "yyyy-MM-dd");
}

async function fetchDriverSummaryGroup(
  driverId: number,
  workDate: string
): Promise<SequenceSummaryGroup | null> {
  const [selRes, tlRes] = await Promise.all([
    fetch(`/api/selected-logistics-drivers?date=${encodeURIComponent(workDate)}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    }),
    fetch(`/api/logistics-timeline?date=${encodeURIComponent(workDate)}`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
    }),
  ]);

  const sel = selRes.ok ? await selRes.json() : { drivers: [] };
  const tl = tlRes.ok ? await tlRes.json() : { drivers_assignments: [] };

  const selDrivers = sel.drivers || [];
  const fromTl = tl.drivers_assignments || [];
  const selectedIds = new Set(selDrivers.map((d: { id: number }) => d.id));

  const mergedSelected = selDrivers.map((d: { id: number; name?: string; lastname?: string }) => {
    const hit = fromTl.find((x: { driver?: { id: number } }) => x.driver?.id === d.id);
    return hit ? { ...hit, driver: { ...hit.driver, ...d } } : { driver: d, tasks: [] };
  });

  const orphanRows = fromTl.filter(
    (x: { driver?: { id: number }; tasks?: unknown[] }) =>
      x.driver?.id != null &&
      !selectedIds.has(x.driver.id) &&
      (x.tasks?.length || 0) > 0
  );

  const assignments = [
    ...mergedSelected,
    ...orphanRows.map((row: { driver: { id: number }; tasks: unknown[] }) => ({
      ...row,
      driver: { ...row.driver, isRemoved: true as const },
    })),
  ];

  const groups = buildSequenceSummaryGroupsFromDriverAssignments(assignments, workDate);
  return groups.find((group) => group.id === driverId) ?? null;
}

export default function LogisticsDriverSheet() {
  const params = useParams<{ driverId: string }>();
  const driverId = Number(params.driverId);
  const workDate = resolveWorkDate();
  const backHref = `/generate-logistics-assignments?date=${encodeURIComponent(workDate)}`;

  const [group, setGroup] = useState<SequenceSummaryGroup | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadGroup = useCallback(async () => {
    if (!Number.isFinite(driverId)) {
      setLoadError("Driver non valido");
      setGroup(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await fetchDriverSummaryGroup(driverId, workDate);
      setGroup(result);
      if (!result) {
        setLoadError("Nessun task assegnato a questo driver per la data selezionata.");
      }
    } catch {
      setLoadError("Impossibile caricare la scheda driver.");
      setGroup(null);
    } finally {
      setIsLoading(false);
    }
  }, [driverId, workDate]);

  useEffect(() => {
    void loadGroup();
  }, [loadGroup]);

  if (!Number.isFinite(driverId)) {
    return (
      <PageViewportCentered layout="viewport" className="gap-4">
        <p className="text-muted-foreground">Driver non valido.</p>
        <Link href={backHref}>
          <Button variant="outline" className="border-custom-blue">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Torna al resoconto
          </Button>
        </Link>
      </PageViewportCentered>
    );
  }

  if (isLoading && !group) {
    return (
      <PageViewportCentered layout="viewport" className="gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-custom-blue" />
        <p className="text-muted-foreground">Caricamento scheda driver…</p>
      </PageViewportCentered>
    );
  }

  if (!group) {
    return (
      <PageViewportCentered layout="viewport" className="gap-4">
        <p className="text-center text-muted-foreground">{loadError ?? "Scheda non disponibile."}</p>
        <Link href={backHref}>
          <Button variant="outline" className="border-custom-blue">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Torna al resoconto
          </Button>
        </Link>
      </PageViewportCentered>
    );
  }

  return (
    <LogisticsDriverSequenceSheet
      group={group}
      workDate={workDate}
      backHref={backHref}
      isLoading={isLoading}
    />
  );
}
