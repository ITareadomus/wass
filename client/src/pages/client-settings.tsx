
import { useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { Home } from "lucide-react";

export default function ClientSettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  useEffect(() => {
    const user = localStorage.getItem("user");
    if (!user) {
      setLocation("/login");
      return;
    }

    const userData = JSON.parse(user);
    if (userData.role !== "admin") {
      toast({
        title: "Accesso negato",
        description: "Solo gli amministratori possono accedere a questa pagina",
        variant: "destructive",
      });
      setLocation("/");
      return;
    }
  }, [setLocation, toast]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Client Settings</h1>
            <Button 
              onClick={() => setLocation("/")} 
              variant="outline" 
              size="icon"
              className="rounded-full"
              title="Torna alla Home"
            >
              <Home className="h-5 w-5" />
            </Button>
          </div>
          <ThemeToggle />
        </div>

        <div className="flex items-center justify-center h-96">
          <p className="text-muted-foreground text-lg">Pagina in costruzione...</p>
        </div>
      </div>
    </div>
  );
}
