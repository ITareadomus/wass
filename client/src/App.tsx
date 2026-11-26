import { Switch, Route, useLocation, Link, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import GenerateAssignments from "@/pages/generate-assignments";
import GenerateLogisticsAssignments from "@/pages/generate-logistics-assignments";
import LogisticsDriverSheet from "@/pages/logistics-driver-sheet";
import Convocazioni from "@/pages/convocazioni";
import UnconfirmedTasks from "@/pages/unconfirmed-tasks";
import HomeGate from "@/pages/home-gate";
import Login from "@/pages/login";
import Settings from "@/pages/settings";
import SystemSettings from "@/pages/system-settings";
import PreassignedApartments from "@/pages/preassigned-apartments";
import KeyRegistry from "@/pages/key-registry";
import CleanerAnagrafica from "@/pages/cleaner-anagrafica";
import LostKeys, { UnreturnedKeys } from "@/pages/lost-keys";
import NotFound from "@/pages/not-found";
import DayComparison from "@/pages/day-comparison";
import { useEffect, useState } from "react";
import { WassSiteHeader } from "@/components/wass-site-header";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { Columns2, Home, Settings as SettingsIcon } from "lucide-react";
import { ViewerLock } from "@/components/viewer-lock";
import {
  getStoredUser,
  getStoredUserRole,
  homePathForRole,
  isBetaTesterAccess,
  isLogisticaPathAllowed,
  isLogisticaRole,
  isReadOnlySession,
  refreshStoredSession,
  LOGISTICS_HOME_PATH,
  type StoredUser,
} from "@/lib/auth-role";

const OFFICE_SCOPE_ENABLED = false;

function GlobalHeader() {
  const [location] = useLocation();
  const [sessionUser, setSessionUser] = useState<StoredUser | null>(getStoredUser());
  useEffect(() => {
    void refreshStoredSession().then(setSessionUser);
  }, [location]);
  const role = sessionUser?.role ?? getStoredUserRole();
  const betaAccess = isBetaTesterAccess(sessionUser);
  const logisticsOnly = isLogisticaRole(role);
  const assignmentsHomeHref = homePathForRole(role);
  const isConvocazioniPage =
    location === "/convocazioni" || location.startsWith("/convocazioni?");
  const showHomeButton =
    isConvocazioniPage ||
    location === "/settings" ||
    location === "/account-settings" ||
    location === "/appartamenti-preassegnati" ||
    location === "/keys" ||
    location.startsWith("/keys?") ||
    location === "/registro-chiavi" ||
    location.startsWith("/registro-chiavi?") ||
    location === "/chiavi-smarrite" ||
    location === "/chiavi-non-restituite" ||
    location === "/comparison" ||
    location === "/alg-test";

  useEffect(() => {
    if (typeof window === "undefined" || OFFICE_SCOPE_ENABLED) return;

    if (localStorage.getItem("assignments_scope") === "office") {
      localStorage.setItem("assignments_scope", "housekeeping");
    }

    const url = new URL(window.location.href);
    const scope = url.searchParams.get("scope");
    const kind = url.searchParams.get("kind");
    if (scope !== "office" && kind !== "office") return;

    if (scope === "office") {
      url.searchParams.delete("scope");
    }
    if (kind === "office") {
      url.searchParams.delete("kind");
    }

    const query = url.searchParams.toString();
    const nextUrl = `${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextUrl);
  }, [location]);

  const homeHref =
    logisticsOnly ||
      (isConvocazioniPage &&
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("kind") === "drivers")
      ? LOGISTICS_HOME_PATH
      : isConvocazioniPage &&
          typeof window !== "undefined" &&
          new URLSearchParams(window.location.search).get("scope") === "alg-test"
        ? "/alg-test"
        : assignmentsHomeHref;

  return (
    <WassSiteHeader
      right={
        <>
          {showHomeButton ? (
            <Link href={homeHref} data-viewer-allow="">
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                title="Torna alla Home"
                data-testid="link-home-global"
                data-viewer-allow=""
              >
                <Home className="h-5 w-5" />
              </Button>
            </Link>
          ) : null}
          {betaAccess && location !== "/alg-test" && (
            <Link href="/alg-test">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                title="Prova l'algoritmo senza modificare la giornata vera"
                data-testid="link-alg-test-global"
              >
                Prova algoritmo
              </Button>
            </Link>
          )}
          {betaAccess && (
            <Link href="/comparison">
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                title="Confronta giornate"
                data-testid="link-comparison-global"
              >
                <Columns2 className="h-5 w-5" />
              </Button>
            </Link>
          )}
          {role === "admin" && (
            <Link href="/settings">
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                title="Impostazioni"
                data-testid="link-settings-global"
              >
                <SettingsIcon className="h-5 w-5" />
              </Button>
            </Link>
          )}
          <ThemeToggle showHomeButton={false} gapClassName="gap-3" />
        </>
      }
    />
  );
}

function ViewerBanner() {
  const [location] = useLocation();
  const search = typeof window !== "undefined" ? window.location.search : "";
  if (!isReadOnlySession(getStoredUserRole(), location, search)) return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      Sola lettura: puoi consultare i task della giornata e aprire i dettagli. Le modifiche sono disattivate.
    </div>
  );
}

function LoginHeader() {
  return (
    <WassSiteHeader
      right={<ThemeToggle showHomeButton={false} showAccountMenu={false} gapClassName="gap-3" />}
    />
  );
}

function ProtectedRoute({ component: Component }: { component: () => JSX.Element }) {
  const [location, setLocation] = useLocation();
  const searchNow = typeof window !== "undefined" ? window.location.search : "";
  const betaPath =
    location === "/alg-test" ||
    location === "/comparison" ||
    (location === "/convocazioni" && new URLSearchParams(searchNow).get("scope") === "alg-test");
  const [allowed, setAllowed] = useState(!betaPath);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const raw = localStorage.getItem("user");
      if (!raw) {
        setLocation("/login");
        return;
      }
      const session = await refreshStoredSession();
      if (cancelled) return;
      const role = session?.role ?? getStoredUserRole();
      const search = typeof window !== "undefined" ? window.location.search : "";
      const betaPage =
        location === "/alg-test" ||
        location === "/comparison" ||
        (location === "/convocazioni" && new URLSearchParams(search).get("scope") === "alg-test");
      if (betaPage && !isBetaTesterAccess(session)) {
        setAllowed(false);
        setLocation(homePathForRole(role));
        return;
      }
      if (isLogisticaRole(role) && !isLogisticaPathAllowed(location, search)) {
        setAllowed(false);
        setLocation(LOGISTICS_HOME_PATH);
        return;
      }
      setAllowed(true);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [location, setLocation]);

  const user = localStorage.getItem("user");
  if (!user || !allowed) {
    return null;
  }

  return (
    <>
      <GlobalHeader />
      <ViewerBanner />
      <Component />
    </>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/login">
        {() => (
          <>
            <LoginHeader />
            <Login />
          </>
        )}
      </Route>
      <Route path="/">
        {() => <ProtectedRoute component={HomeGate} />}
      </Route>
      <Route path="/unconfirmed-tasks">
        {() => <ProtectedRoute component={UnconfirmedTasks} />}
      </Route>
      <Route path="/generate-assignments" key="housekeeping-assignments">
        {() => <ProtectedRoute key="housekeeping-assignments" component={GenerateAssignments} />}
      </Route>
      <Route path="/generate-logistics-assignments/driver/:driverId">
        {() => <ProtectedRoute component={LogisticsDriverSheet} />}
      </Route>
      <Route path="/generate-logistics-assignments">
        {() => <ProtectedRoute component={GenerateLogisticsAssignments} />}
      </Route>
      <Route path="/convocazioni">
        {() => <ProtectedRoute component={Convocazioni} />}
      </Route>
      <Route path="/account-settings">
        {() => <ProtectedRoute component={Settings} />}
      </Route>
      <Route path="/settings">
        {() => <ProtectedRoute component={SystemSettings} />}
      </Route>
      <Route path="/comparison">
        {() => <ProtectedRoute component={DayComparison} />}
      </Route>
      <Route path="/alg-test" key="alg-test-assignments">
        {() => <ProtectedRoute key="alg-test-assignments" component={GenerateAssignments} />}
      </Route>
      <Route path="/appartamenti-preassegnati">
        {() => <ProtectedRoute component={PreassignedApartments} />}
      </Route>
      <Route path="/keys">
        {() => <ProtectedRoute component={KeyRegistry} />}
      </Route>
      <Route path="/registro-chiavi">
        {() => <Redirect to={`/keys${window.location.search}`} />}
      </Route>
      <Route path="/anagrafica-dipendenti">
        {() => <ProtectedRoute component={CleanerAnagrafica} />}
      </Route>
      <Route path="/chiavi-non-restituite">
        {() => <ProtectedRoute component={UnreturnedKeys} />}
      </Route>
      <Route path="/chiavi-smarrite">
        {() => <ProtectedRoute component={LostKeys} />}
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <ViewerLock />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
