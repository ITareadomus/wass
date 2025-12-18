import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import GenerateAssignments from "@/pages/generate-assignments";
import Convocazioni from "@/pages/convocazioni";
import UnconfirmedTasks from "@/pages/unconfirmed-tasks";
import Login from "@/pages/login";
import Settings from "@/pages/settings";
import SystemSettings from "@/pages/system-settings";
import ClientSettings from "@/pages/client-settings";
import NotFound from "@/pages/not-found";
import { useEffect } from "react";

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

  return <Component />;
}

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/">
        {() => <ProtectedRoute component={UnconfirmedTasks} />}
      </Route>
      <Route path="/unconfirmed-tasks">
        {() => <ProtectedRoute component={UnconfirmedTasks} />}
      </Route>
      <Route path="/generate-assignments">
        {() => <ProtectedRoute component={GenerateAssignments} />}
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
