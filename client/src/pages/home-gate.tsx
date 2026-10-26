import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { getStoredUserRole, isLogisticaRole, LOGISTICS_HOME_PATH } from "@/lib/auth-role";

export default function HomeGate() {
  const [, setLocation] = useLocation();
  const [hasRedirected, setHasRedirected] = useState(false);

  useEffect(() => {
    if (hasRedirected) return;
    setHasRedirected(true);
    const role = getStoredUserRole();
    if (isLogisticaRole(role)) {
      setLocation(LOGISTICS_HOME_PATH);
      return;
    }
    setLocation("/generate-assignments");
  }, [hasRedirected, setLocation]);

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
