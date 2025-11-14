
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { Home, Save } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Client {
  client_id: number;
  customer_name: string;
  alias: string | null;
}

interface ClientWindow {
  client_id: number;
  checkin_time: string;
  checkout_time: string;
}

interface ClientWindowsData {
  windows: ClientWindow[];
  metadata: {
    last_updated: string;
  };
}

export default function ClientSettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [clients, setClients] = useState<Client[]>([]);
  const [windows, setWindows] = useState<Map<number, { checkin: string; checkout: string }>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

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

    loadData();
  }, [setLocation, toast]);

  const loadData = async () => {
    setIsLoading(true);
    try {
      // Carica clienti attivi
      const clientsResponse = await fetch("/api/get-active-clients");
      if (!clientsResponse.ok) throw new Error("Errore nel caricamento dei clienti");
      const clientsData = await clientsResponse.json();
      setClients(clientsData.clients);

      // Carica client_timewindows.json se esiste
      try {
        const windowsResponse = await fetch(`/data/input/client_timewindows.json?t=${Date.now()}`, {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (windowsResponse.ok) {
          const windowsData: ClientWindowsData = await windowsResponse.json();
          const windowsMap = new Map<number, { checkin: string; checkout: string }>();
          
          windowsData.windows.forEach(w => {
            windowsMap.set(w.client_id, {
              checkin: w.checkin_time || "",
              checkout: w.checkout_time || ""
            });
          });
          
          setWindows(windowsMap);
        }
      } catch (err) {
        console.log("client_timewindows.json non trovato, usando valori vuoti");
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile caricare i dati",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleTimeChange = (clientId: number, type: 'checkin' | 'checkout', value: string) => {
    setWindows(prev => {
      const newMap = new Map(prev);
      const current = newMap.get(clientId) || { checkin: "", checkout: "" };
      newMap.set(clientId, {
        ...current,
        [type]: value
      });
      return newMap;
    });
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const windowsArray: ClientWindow[] = [];
      
      windows.forEach((value, clientId) => {
        if (value.checkin || value.checkout) {
          windowsArray.push({
            client_id: clientId,
            checkin_time: value.checkin,
            checkout_time: value.checkout
          });
        }
      });

      const data: ClientWindowsData = {
        windows: windowsArray,
        metadata: {
          last_updated: new Date().toISOString()
        }
      };

      const response = await fetch("/api/save-client-timewindows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (response.ok) {
        toast({
          title: "Salvato",
          description: "Finestre temporali salvate con successo",
        });
      } else {
        throw new Error();
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile salvare le finestre temporali",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p>Caricamento...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Client Settings</h1>
          <ThemeToggle />
        </div>

        <Card className="bg-custom-blue-light border-2 border-custom-blue">
          <CardHeader className="bg-custom-blue-light">
            <CardTitle>Finestre Temporali Clienti</CardTitle>
            <CardDescription>
              Configura gli orari di checkin e checkout per ogni cliente attivo
            </CardDescription>
          </CardHeader>
          <CardContent className="bg-custom-blue-light">
            <Button
              onClick={handleSave}
              disabled={isSaving}
              className="w-full mb-6 bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
            >
              <Save className="w-4 h-4 mr-2" />
              {isSaving ? "Salvataggio..." : "Salva Client Windows"}
            </Button>

            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[100px] text-center text-white">Client ID</TableHead>
                    <TableHead className="w-[120px] text-center text-white">Alias</TableHead>
                    <TableHead className="text-white">Nome Cliente</TableHead>
                    <TableHead className="w-[150px] text-left text-white">Checkin</TableHead>
                    <TableHead className="w-[150px] text-left text-white">Checkout</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {clients.map((client) => {
                    const windowData = windows.get(client.client_id) || { checkin: "", checkout: "" };
                    return (
                      <TableRow key={client.client_id}>
                        <TableCell className="text-center text-[#94a3b8]">{client.client_id}</TableCell>
                        <TableCell className="text-center text-muted-foreground">{client.alias || "-"}</TableCell>
                        <TableCell>{client.customer_name}</TableCell>
                        <TableCell>
                          <Input
                            type="time"
                            value={windowData.checkin}
                            onChange={(e) => handleTimeChange(client.client_id, 'checkin', e.target.value)}
                            className="h-9"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="time"
                            value={windowData.checkout}
                            onChange={(e) => handleTimeChange(client.client_id, 'checkout', e.target.value)}
                            className="h-9"
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
