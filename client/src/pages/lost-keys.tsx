import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { it } from "date-fns/locale";
import { Check, ChevronLeft, Loader2, RefreshCw, Undo2 } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getStoredUserRole, isViewerRole } from "@/lib/auth-role";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

type LostKey = {
  workDate: string;
  taskId: number;
  logisticCode: string;
  cleanerName: string;
  matricola: string | null;
  aptCode: string | null;
  customerName: string | null;
  daysMissing: number;
};

type LostKeysPayload = {
  today: string;
  keys: LostKey[];
};

type ListKind = "lost" | "unreturned";

const LIST_COPY: Record<
  ListKind,
  {
    path: string;
    title: string;
    description: string;
    loading: string;
    empty: string;
    action: string;
    errorTitle: string;
  }
> = {
  lost: {
    path: "/api/key-registry/lost",
    title: "Chiavi smarrite",
    description: "Chiavi segnate smarrite nei giorni già passati.",
    loading: "Caricamento chiavi smarrite",
    empty: "Nessuna chiave smarrita dei giorni passati.",
    action: "Ripristina",
    errorTitle: "Chiave non ripristinata",
  },
  unreturned: {
    path: "/api/key-registry/unreturned",
    title: "Chiavi non restituite",
    description: "Chiavi consegnate e non tornate in magazzino, nei giorni già passati.",
    loading: "Caricamento chiavi non restituite",
    empty: "Nessuna chiave non restituita dei giorni passati.",
    action: "Restituita",
    errorTitle: "Restituzione non salvata",
  },
};

function registryHref(): string {
  const saved = typeof window === "undefined" ? null : localStorage.getItem("selected_work_date");
  return saved && /^\d{4}-\d{2}-\d{2}$/.test(saved) ? `/keys?date=${saved}` : "/keys";
}

function withoutKey(payload: LostKeysPayload, workDate: string, taskId: number): LostKeysPayload {
  return {
    ...payload,
    keys: payload.keys.filter((key) => !(key.workDate === workDate && key.taskId === taskId)),
  };
}

function KeyListPage({ kind }: { kind: ListKind }) {
  const copy = LIST_COPY[kind];
  const queryKey = [copy.path] as const;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const viewer = isViewerRole(getStoredUserRole());
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const listQuery = useQuery<LostKeysPayload>({ queryKey: [...queryKey] });

  const resolveKey = async (key: LostKey) => {
    const pendingKey = `${key.workDate}:${key.taskId}`;
    if (viewer || pendingIds.has(pendingKey)) return;
    const previous = queryClient.getQueryData<LostKeysPayload>(queryKey);
    setPendingIds((current) => new Set(current).add(pendingKey));
    if (previous) queryClient.setQueryData(queryKey, withoutKey(previous, key.workDate, key.taskId));
    try {
      if (kind === "lost") {
        await apiRequest("POST", "/api/key-registry/recovered", { date: key.workDate, taskId: key.taskId });
      } else {
        await apiRequest("POST", "/api/key-registry/delivered", {
          date: key.workDate,
          taskId: key.taskId,
          status: "returned",
        });
      }
      await queryClient.invalidateQueries({
        predicate: (query) => String(query.queryKey[0] ?? "").startsWith("/api/key-registry"),
      });
    } catch (error) {
      if (previous) queryClient.setQueryData(queryKey, previous);
      toast({
        title: copy.errorTitle,
        description: error instanceof Error ? error.message : "Riprova",
        variant: "destructive",
      });
    } finally {
      setPendingIds((current) => {
        const nextIds = new Set(current);
        nextIds.delete(pendingKey);
        return nextIds;
      });
    }
  };

  const groups = useMemo(() => {
    const byDate = new Map<string, LostKey[]>();
    for (const key of listQuery.data?.keys ?? []) {
      const rows = byDate.get(key.workDate) ?? [];
      rows.push(key);
      byDate.set(key.workDate, rows);
    }
    return [...byDate.entries()];
  }, [listQuery.data]);

  return (
    <div className="min-h-[calc(100dvh-3.5rem)] bg-background text-foreground md:min-h-[calc(100dvh-3.75rem)]">
      <div className="sticky top-0 z-20 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-12 w-12 shrink-0"
              data-viewer-allow=""
              title="Aggiorna"
              onClick={() => listQuery.refetch()}
              disabled={listQuery.isFetching}
            >
              <RefreshCw className={cn("h-5 w-5", listQuery.isFetching && "animate-spin")} />
            </Button>
          </div>
          <Link
            href={registryHref()}
            data-viewer-allow=""
            className="inline-flex h-12 w-fit items-center gap-2 rounded-md border-2 border-custom-blue px-3 text-sm font-medium text-custom-blue"
          >
            <ChevronLeft className="h-5 w-5" />
            Registro chiavi
          </Link>
        </div>
      </div>

      <div className="mx-auto w-full max-w-5xl px-4 py-4">
        {listQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            {copy.loading}
          </div>
        ) : listQuery.isError ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-6 text-center">
            <p className="font-medium">Elenco non disponibile</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {listQuery.error instanceof Error ? listQuery.error.message : "Errore di caricamento"}
            </p>
          </div>
        ) : groups.length === 0 ? (
          <p className="py-16 text-center text-muted-foreground">{copy.empty}</p>
        ) : (
          <div className="space-y-4 pb-8">
            {groups.map(([workDate, keys]) => (
              <section key={workDate} className="overflow-hidden rounded-2xl border bg-card shadow-sm">
                <header className="border-b px-4 py-3">
                  <h2 className="text-lg font-semibold capitalize">
                    {format(parseISO(workDate), "EEEE d MMMM yyyy", { locale: it })}
                  </h2>
                </header>
                <ul className="space-y-2 p-3">
                  {keys.map((key) => {
                    const pending = pendingIds.has(`${key.workDate}:${key.taskId}`);
                    return (
                      <li
                        key={`${key.workDate}-${key.taskId}`}
                        className="flex items-center gap-3 rounded-xl border-2 border-border bg-background px-4 py-3"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-2xl font-semibold tabular-nums">{key.logisticCode}</p>
                          <p className="mt-1 text-sm font-medium">{key.aptCode || "—"}</p>
                          <p className="truncate text-sm text-muted-foreground">{key.customerName || "—"}</p>
                          <p className="mt-1 text-sm">
                            {key.cleanerName || "Cleaner"}
                            {key.matricola ? ` · Matricola ${key.matricola}` : ""}
                          </p>
                        </div>
                        {viewer ? null : kind === "unreturned" ? (
                          <button
                            type="button"
                            disabled={pending}
                            aria-label={`Segna restituita la chiave ${key.logisticCode}`}
                            title="Segna restituita"
                            onClick={() => resolveKey(key)}
                            className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border-2 border-emerald-600 bg-emerald-600 text-white disabled:opacity-60"
                          >
                            {pending ? (
                              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                            ) : (
                              <Check className="h-6 w-6" aria-hidden />
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => resolveKey(key)}
                            className="inline-flex h-12 shrink-0 items-center gap-2 rounded-xl border-2 border-emerald-600 bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-60"
                          >
                            {pending ? (
                              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            ) : (
                              <Undo2 className="h-4 w-4" aria-hidden />
                            )}
                            {copy.action}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function UnreturnedKeys() {
  return <KeyListPage kind="unreturned" />;
}

export default function LostKeys() {
  return <KeyListPage kind="lost" />;
}
