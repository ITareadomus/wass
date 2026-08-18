import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { getStoredUserRole, isLogisticaRole, LOGISTICS_HOME_PATH } from "@/lib/auth-role";

interface UnconfirmedSummary {
  unconfirmedCount: number;
  date: string;
  total?: number;
  error?: string;
}

export default function HomeGate() {
  const [, setLocation] = useLocation();
  const [hasRedirected, setHasRedirected] = useState(false);

  const selectedDate = (() => {
    const urlParams = new URLSearchParams(window.location.search);
    const dateParam = urlParams.get("date");
    if (dateParam) return dateParam;

    const savedDate = localStorage.getItem("selected_work_date");
    if (savedDate) return savedDate;

    return format(new Date(), "yyyy-MM-dd");
  })();

  const { data, isLoading, isError } = useQuery<UnconfirmedSummary>({
    queryKey: ["/api/unconfirmed-tasks-summary", selectedDate],
    queryFn: async () => {
      const response = await fetch(`/api/unconfirmed-tasks-summary?date=${selectedDate}`);
      if (!response.ok) throw new Error("Failed to fetch summary");
      return response.json();
    },
    staleTime: 30000,
    retry: 1,
  });

  useEffect(() => {
    if (hasRedirected) return;
    setHasRedirected(true);
    if (isLogisticaRole(getStoredUserRole())) {
      setLocation(LOGISTICS_HOME_PATH);
      return;
    }
    setLocation(`/unconfirmed-tasks?date=${selectedDate}`);
  }, [hasRedirected, setLocation, selectedDate]);

  return (
    <PageViewportCentered
      layout="viewport"
      className="bg-background py-8"
      data-testid="home-gate-loading"
    >
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-muted-foreground">Caricamento task...</p>
      </div>
    </PageViewportCentered>
  );
}
