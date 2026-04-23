import { Switch, Route, useLocation, Link } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import GenerateAssignments from "@/pages/generate-assignments";
import GenerateLogisticsAssignments from "@/pages/generate-logistics-assignments";
import Convocazioni from "@/pages/convocazioni";
import UnconfirmedTasks from "@/pages/unconfirmed-tasks";
import HomeGate from "@/pages/home-gate";
import Login from "@/pages/login";
import Settings from "@/pages/settings";
import SystemSettings from "@/pages/system-settings";
import ClientSettings from "@/pages/client-settings";
import NotFound from "@/pages/not-found";
import { useEffect } from "react";
import { WassSiteHeader } from "@/components/wass-site-header";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { HelpCircle, Home } from "lucide-react";

const OFFICE_SCOPE_ENABLED = false;

function GlobalHeader() {
  const [location] = useLocation();
  const assignmentsHomeHref = "/generate-assignments";
  const selectedDate =
    typeof window !== "undefined" ? localStorage.getItem("selected_work_date") : null;
  const unconfirmedHref = selectedDate
    ? `/unconfirmed-tasks?date=${selectedDate}`
    : "/unconfirmed-tasks";
  const isConvocazioniPage =
    location === "/convocazioni" || location.startsWith("/convocazioni?");
  const isUnconfirmedTasksPage =
    location === "/unconfirmed-tasks" || location.startsWith("/unconfirmed-tasks?");
  const showHomeButton =
    isConvocazioniPage || location === "/settings" || location === "/account-settings";
  const showUnconfirmedButton = !showHomeButton && !isUnconfirmedTasksPage;

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
    isConvocazioniPage &&
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("kind") === "drivers"
      ? "/generate-logistics-assignments"
      : assignmentsHomeHref;

  return (
    <WassSiteHeader
      right={
        <>
          {showHomeButton ? (
            <Link href={homeHref}>
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                title="Torna alla Home"
                data-testid="link-home-global"
              >
                <Home className="h-5 w-5" />
              </Button>
            </Link>
          ) : showUnconfirmedButton ? (
            <Link href={unconfirmedHref}>
              <Button
                variant="outline"
                size="icon"
                className="rounded-full"
                title="Task Non Confermate"
                data-testid="link-unconfirmed-tasks-global"
              >
                <HelpCircle className="h-5 w-5" />
              </Button>
            </Link>
          ) : null}
          <ThemeToggle showHomeButton={false} gapClassName="gap-3" />
        </>
      }
    />
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
  const [, setLocation] = useLocation();

  useEffect(() => {
    const user = localStorage.getItem("user");
    if (!user) {
      setLocation("/login");
    }
  }, [setLocation]);

  const user = localStorage.getItem("user");
  if (!user) {
    return null;
  }

  return (
    <>
      <GlobalHeader />
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
      <Route path="/generate-assignments">
        {() => <ProtectedRoute component={GenerateAssignments} />}
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
      <Route path="/client-settings">
        {() => <ProtectedRoute component={ClientSettings} />}
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
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
