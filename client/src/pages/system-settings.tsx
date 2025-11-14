
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
          <h1 className="text-3xl font-bold">Settings</h1>
          <div className="flex items-center gap-2">
            <ThemeToggle />
          </div>
        </div>

        <div className="space-y-4">
          {/* Early-Out, High-Priority e Low-Priority in un'unica card full-width */}
          <Card className="bg-background border-2 border-custom-blue">
            <CardHeader className="bg-background py-3">
              <CardTitle className="text-lg">Priority Settings</CardTitle>
              <CardDescription className="text-xs">
                Configurazione per le task Early-Out, High-Priority e Low-Priority
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-background">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Early-Out */}
                <div className="space-y-3">
                  <div className="border-b pb-2">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500 text-white border-blue-700">
                      EO
                    </span>
                  </div>
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
                </div>

                {/* High-Priority */}
                <div className="space-y-3">
                  <div className="border-b pb-2">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-500 text-white border-orange-700">
                      HP
                    </span>
                  </div>
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
                </div>

                {/* Low-Priority */}
                <div className="space-y-3">
                  <div className="border-b pb-2">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-500 text-white border-gray-700">
                      LP
                    </span>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lp_start_time" className="text-sm text-muted-foreground">Start Time</Label>
                    <Input
                      id="lp_start_time"
                      type="time"
                      disabled
                      placeholder="Non valorizzato"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lp_time" className="text-sm text-muted-foreground">LP Time</Label>
                    <Input
                      id="lp_time"
                      type="time"
                      disabled
                      placeholder="Non valorizzato"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lp_clients" className="text-sm text-muted-foreground">LP Clients</Label>
                    <Input
                      id="lp_clients"
                      disabled
                      placeholder="Non valorizzato"
                    />
                  </div>
                </div>
              </div>

              {/* Dedupe Strategy - sotto EO e HP, max width per occupare solo 2 colonne */}
              <div className="md:col-span-3 mt-4 pt-4 border-t">
                <div className="space-y-2 max-w-[66%]">
                  <Label htmlFor="dedupe_strategy" className="text-sm font-semibold">Dedupe Strategy</Label>
                  <Select
                    value={settings.dedupe_strategy}
                    onValueChange={(value) =>
                      setSettings({
                        ...settings,
                        dedupe_strategy: value,
                      })
                    }
                  >
                    <SelectTrigger id="dedupe_strategy">
                      <SelectValue placeholder="Seleziona strategia" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="eo_wins">eo_wins</SelectItem>
                      <SelectItem value="hp_wins">hp_wins</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    Strategia per le task duplex, cioè che rispecchiano entrambi i criteri EO e HP (eo_wins → le task duplex saranno EO - hp_wins → viceversa)
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Apartment Types */}
          <Card className="bg-background border-2 border-custom-blue">
              <CardHeader className="bg-background py-3">
                <CardTitle className="text-lg">Apartment Types</CardTitle>
                <CardDescription className="text-xs">
                  Seleziona i tipi di appartamenti che i cleaner possono pulire
                </CardDescription>
              </CardHeader>
              <CardContent className="bg-background">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Cleaner STANDARD */}
                  <div className="space-y-3">
                    <div className="border-b pb-2">
                      <span className="px-2 py-0.5 rounded border font-medium text-sm bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400">
                        Standard
                      </span>
                    </div>
                    <div className="space-y-2">
                      {["A", "B", "C", "D", "E", "F", "X"].map((type) => (
                        <div key={`standard-${type}`} className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id={`standard-${type}`}
                            checked={settings.apartment_types.standard_apt.includes(type)}
                            onChange={(e) => {
                              const newTypes = e.target.checked
                                ? [...settings.apartment_types.standard_apt, type]
                                : settings.apartment_types.standard_apt.filter((t) => t !== type);
                              setSettings({
                                ...settings,
                                apartment_types: {
                                  ...settings.apartment_types,
                                  standard_apt: newTypes,
                                },
                              });
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <Label htmlFor={`standard-${type}`} className="text-sm cursor-pointer">
                            Tipo {type}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Cleaner PREMIUM */}
                  <div className="space-y-3">
                    <div className="border-b pb-2">
                      <span className="px-2 py-0.5 rounded border font-medium text-sm bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400">
                        Premium
                      </span>
                    </div>
                    <div className="space-y-2">
                      {["A", "B", "C", "D", "E", "F", "X"].map((type) => (
                        <div key={`premium-${type}`} className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id={`premium-${type}`}
                            checked={settings.apartment_types.premium_apt.includes(type)}
                            onChange={(e) => {
                              const newTypes = e.target.checked
                                ? [...settings.apartment_types.premium_apt, type]
                                : settings.apartment_types.premium_apt.filter((t) => t !== type);
                              setSettings({
                                ...settings,
                                apartment_types: {
                                  ...settings.apartment_types,
                                  premium_apt: newTypes,
                                },
                              });
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <Label htmlFor={`premium-${type}`} className="text-sm cursor-pointer">
                            Tipo {type}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Cleaner FORMATORE */}
                  <div className="space-y-3">
                    <div className="border-b pb-2">
                      <span className="px-2 py-0.5 rounded border font-medium text-sm bg-orange-500/30 text-orange-800 dark:bg-orange-500/40 dark:text-orange-200 border-orange-600 dark:border-orange-400">
                        Formatore
                      </span>
                    </div>
                    <div className="space-y-2">
                      {["A", "B", "C", "D", "E", "F", "X"].map((type) => (
                        <div key={`formatore-${type}`} className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id={`formatore-${type}`}
                            checked={settings.apartment_types.formatore_apt.includes(type)}
                            onChange={(e) => {
                              const newTypes = e.target.checked
                                ? [...settings.apartment_types.formatore_apt, type]
                                : settings.apartment_types.formatore_apt.filter((t) => t !== type);
                              setSettings({
                                ...settings,
                                apartment_types: {
                                  ...settings.apartment_types,
                                  formatore_apt: newTypes,
                                },
                              });
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <Label htmlFor={`formatore-${type}`} className="text-sm cursor-pointer">
                            Tipo {type}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

          {/* Client Settings a tutta larghezza */}
          <div className="grid grid-cols-1 gap-4">
            {/* Client Settings Shortcut */}
            <Card className="bg-background border-2 border-custom-blue hover:bg-custom-blue hover:text-white transition-colors cursor-pointer" onClick={() => setLocation("/client-settings")}>
              <CardHeader className="bg-background py-2">
                <CardTitle className="text-lg">Client Settings</CardTitle>
                <CardDescription className="text-xs">
                  Impostazioni per modificare Check-in e Check-out pre-impostati per cliente
                </CardDescription>
              </CardHeader>
              <CardContent className="bg-background flex items-center justify-center p-4">
                <div className="text-center">
                  <Settings className="w-8 h-8 mx-auto mb-2" />
                  <p className="text-sm font-semibold">Vai a Client Settings</p>
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
