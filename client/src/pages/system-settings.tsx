
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { Save, Home, Settings } from "lucide-react";

interface SettingsData {
  "early-out": {
    eo_start_time: string;
    eo_time: string;
    eo_clients: number[];
  };
  "high-priority": {
    hp_start_time: string;
    hp_time: string;
    hp_clients: number[];
  };
  dedupe_strategy: string;
  apartment_types: {
    standard_apt: string[];
    premium_apt: string[];
    formatore_apt: string[];
  };
}

export default function SystemSettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [settings, setSettings] = useState<SettingsData | null>(null);
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

    loadSettings();
  }, [setLocation, toast]);

  const loadSettings = async () => {
    setIsLoading(true);
    try {
      const timestamp = Date.now();
      const response = await fetch(`/data/input/settings.json?t=${timestamp}`, {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });
      
      if (response.ok) {
        const data = await response.json();
        setSettings(data);
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile caricare le impostazioni",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;

    setIsSaving(true);
    try {
      const response = await fetch("/api/save-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });

      if (response.ok) {
        toast({
          title: "Impostazioni salvate",
          description: "Le modifiche sono state salvate con successo",
        });
      } else {
        throw new Error();
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile salvare le impostazioni",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !settings) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Caricamento...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold">Settings</h1>
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

        <div className="space-y-4">
          {/* Early-Out e High-Priority sulla stessa riga */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Early-Out Settings */}
            <Card className="bg-background border-2 border-custom-blue">
              <CardHeader className="bg-background py-3">
                <CardTitle className="text-lg">Early-Out</CardTitle>
                <CardDescription className="text-xs">
                  Configurazione per le task Early-Out
                </CardDescription>
              </CardHeader>
              <CardContent className="bg-background space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="eo_start_time" className="text-sm">Start Time</Label>
                  <Input
                    id="eo_start_time"
                    type="time"
                    value={settings["early-out"].eo_start_time}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        "early-out": {
                          ...settings["early-out"],
                          eo_start_time: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="eo_time" className="text-sm">EO Time</Label>
                  <Input
                    id="eo_time"
                    type="time"
                    value={settings["early-out"].eo_time}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        "early-out": {
                          ...settings["early-out"],
                          eo_time: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="eo_clients" className="text-sm">EO Clients</Label>
                  <Input
                    id="eo_clients"
                    value={settings["early-out"].eo_clients.join(", ")}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        "early-out": {
                          ...settings["early-out"],
                          eo_clients: e.target.value
                            .split(",")
                            .map((id) => parseInt(id.trim()))
                            .filter((id) => !isNaN(id)),
                        },
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            {/* High-Priority Settings */}
            <Card className="bg-background border-2 border-custom-blue">
              <CardHeader className="bg-background py-3">
                <CardTitle className="text-lg">High-Priority</CardTitle>
                <CardDescription className="text-xs">
                  Configurazione per le task High-Priority
                </CardDescription>
              </CardHeader>
              <CardContent className="bg-background space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="hp_start_time" className="text-sm">Start Time</Label>
                  <Input
                    id="hp_start_time"
                    type="time"
                    value={settings["high-priority"].hp_start_time}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        "high-priority": {
                          ...settings["high-priority"],
                          hp_start_time: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hp_time" className="text-sm">HP Time</Label>
                  <Input
                    id="hp_time"
                    type="time"
                    value={settings["high-priority"].hp_time}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        "high-priority": {
                          ...settings["high-priority"],
                          hp_time: e.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="hp_clients" className="text-sm">HP Clients</Label>
                  <Input
                    id="hp_clients"
                    value={settings["high-priority"].hp_clients.join(", ")}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        "high-priority": {
                          ...settings["high-priority"],
                          hp_clients: e.target.value
                            .split(",")
                            .map((id) => parseInt(id.trim()))
                            .filter((id) => !isNaN(id)),
                        },
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Dedupe Strategy */}
          <Card className="bg-background border-2 border-custom-blue">
            <CardHeader className="bg-background py-3">
              <CardTitle className="text-lg">Dedupe Strategy</CardTitle>
              <CardDescription className="text-xs">
                Strategia di deduplicazione
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-background">
              <div className="space-y-2">
                <Label htmlFor="dedupe_strategy" className="text-sm">Strategy</Label>
                <Input
                  id="dedupe_strategy"
                  value={settings.dedupe_strategy}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      dedupe_strategy: e.target.value,
                    })
                  }
                />
              </div>
            </CardContent>
          </Card>

          {/* Apartment Types e Client Settings sulla stessa riga */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Apartment Types */}
            <Card className="bg-background border-2 border-custom-blue">
              <CardHeader className="bg-background py-3">
                <CardTitle className="text-lg">Apartment Types</CardTitle>
                <CardDescription className="text-xs">
                  Tipi di appartamento per categoria
                </CardDescription>
              </CardHeader>
              <CardContent className="bg-background space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="standard_apt" className="text-sm">Standard Apartments</Label>
                  <Input
                    id="standard_apt"
                    value={settings.apartment_types.standard_apt.join(", ")}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        apartment_types: {
                          ...settings.apartment_types,
                          standard_apt: e.target.value
                            .split(",")
                            .map((letter) => letter.trim().toUpperCase())
                            .filter((letter) => letter),
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="premium_apt" className="text-sm">Premium Apartments</Label>
                  <Input
                    id="premium_apt"
                    value={settings.apartment_types.premium_apt.join(", ")}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        apartment_types: {
                          ...settings.apartment_types,
                          premium_apt: e.target.value
                            .split(",")
                            .map((letter) => letter.trim().toUpperCase())
                            .filter((letter) => letter),
                        },
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="formatore_apt" className="text-sm">Formatore Apartments</Label>
                  <Input
                    id="formatore_apt"
                    value={settings.apartment_types.formatore_apt.join(", ")}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        apartment_types: {
                          ...settings.apartment_types,
                          formatore_apt: e.target.value
                            .split(",")
                            .map((letter) => letter.trim().toUpperCase())
                            .filter((letter) => letter),
                        },
                      })
                    }
                  />
                </div>
              </CardContent>
            </Card>

            {/* Client Settings Shortcut */}
            <Card className="bg-background border-2 border-custom-blue hover:bg-custom-blue hover:text-white transition-colors cursor-pointer" onClick={() => setLocation("/client-settings")}>
              <CardHeader className="bg-background py-3">
                <CardTitle className="text-lg">Client Settings</CardTitle>
                <CardDescription className="text-xs">
                  Configurazione impostazioni client
                </CardDescription>
              </CardHeader>
              <CardContent className="bg-background flex items-center justify-center h-full min-h-[180px]">
                <div className="text-center">
                  <Settings className="w-12 h-12 mx-auto mb-3" />
                  <p className="text-lg font-semibold">Vai a Client Settings</p>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Save Button */}
          <Button
            onClick={handleSave}
            disabled={isSaving}
            className="w-full bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
          >
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? "Salvataggio..." : "Salva Impostazioni"}
          </Button>
        </div>
      </div>
    </div>
  );
}
