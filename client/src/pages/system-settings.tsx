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
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Client {
  client_id: number;
  customer_name: string;
  alias: string | null;
}

interface TaskTypeRules {
  standard_cleaner: boolean;
  premium_cleaner: boolean;
  straordinaria_cleaner: boolean;
  formatore_cleaner: boolean;
}

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
  task_types: {
    standard_apt: TaskTypeRules;
    premium_apt: TaskTypeRules;
    straordinario_apt: TaskTypeRules;
  };
}

export default function SystemSettings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [clients, setClients] = useState<Client[]>([]);
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
    loadClients();
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

  const loadClients = async () => {
    try {
      const response = await fetch("/api/get-active-clients");
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.clients) {
          setClients(data.clients);
        }
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile caricare l'elenco dei clienti",
        variant: "destructive",
      });
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

  const handleClientToggle = (priority: 'early-out' | 'high-priority', clientId: number) => {
    setSettings(prev => {
      if (!prev) return prev;

      const clients = prev[priority][priority === 'early-out' ? 'eo_clients' : 'hp_clients'];
      const newClients = clients.includes(clientId)
        ? clients.filter(id => id !== clientId)
        : [...clients, clientId];

      return {
        ...prev,
        [priority]: {
          ...prev[priority],
          [priority === 'early-out' ? 'eo_clients' : 'hp_clients']: newClients
        }
      };
    });
  };

  const updateTaskTypeRule = (
    aptType: keyof SettingsData["task_types"],
    cleanerType: keyof TaskTypeRules,
    value: boolean
  ) => {
    setSettings(prev => {
      if (!prev) return prev;

      return {
        ...prev,
        task_types: {
          ...prev.task_types,
          [aptType]: {
            ...prev.task_types[aptType],
            [cleanerType]: value,
          },
        },
      };
    });
  };

  const getClientName = (clientId: number): string => {
    const client = clients.find(c => c.client_id === clientId);
    return client ? client.customer_name : `ID ${clientId}`;
  };


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
          <Card className="bg-custom-blue-light border-2 border-custom-blue">
            <CardHeader className="bg-custom-blue-light py-3">
              <CardTitle className="text-lg">Priority Settings</CardTitle>
              <CardDescription className="text-xs">
                Configurazione per le task Early-Out, High-Priority e Low-Priority
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-custom-blue-light">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Early-Out */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center gap-2">
                    <span className="text-sm font-medium text-blue-800 dark:text-blue-200">Apt</span>
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
                    {/* Input nascosto, useremo i checkboxes */}
                    <Input id="eo_clients" className="hidden" />
                    <ScrollArea className="h-40 w-full rounded-md border p-4">
                      {clients.map((client) => (
                        <div key={`eo-client-${client.client_id}`} className="flex items-center space-x-2 mb-2">
                          <Checkbox
                            id={`eo-client-${client.client_id}`}
                            checked={settings["early-out"].eo_clients.includes(client.client_id)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                handleClientToggle(client.client_id, "eo");
                              } else {
                                handleClientToggle(client.client_id, "eo");
                              }
                            }}
                          />
                          <Label htmlFor={`eo-client-${client.client_id}`} className="text-sm cursor-pointer">
                            {client.customer_name}
                          </Label>
                        </div>
                      ))}
                    </ScrollArea>
                  </div>
                </div>

                {/* High-Priority */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center gap-2">
                    <span className="text-sm font-medium text-orange-800 dark:text-orange-200">Apt</span>
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
                    {/* Input nascosto, useremo i checkboxes */}
                    <Input id="hp_clients" className="hidden" />
                    <ScrollArea className="h-40 w-full rounded-md border p-4">
                      {clients.map((client) => (
                        <div key={`hp-client-${client.client_id}`} className="flex items-center space-x-2 mb-2">
                          <Checkbox
                            id={`hp-client-${client.client_id}`}
                            checked={settings["high-priority"].hp_clients.includes(client.client_id)}
                            onCheckedChange={(checked) => {
                              if (checked) {
                                handleClientToggle(client.client_id, "hp");
                              } else {
                                handleClientToggle(client.client_id, "hp");
                              }
                            }}
                          />
                          <Label htmlFor={`hp-client-${client.client_id}`} className="text-sm cursor-pointer">
                            {client.customer_name}
                          </Label>
                        </div>
                      ))}
                    </ScrollArea>
                  </div>
                </div>

                {/* Low-Priority */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center gap-2">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Apt</span>
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

              {/* Dedupe Strategy e Client Settings - sotto EO e HP */}
              <div className="md:col-span-3 mt-4 pt-4 border-t">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Dedupe Strategy - 2/3 della larghezza */}
                  <div className="space-y-2 md:col-span-2">
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

                  {/* Client Settings - 1/3 della larghezza */}
                  <div className="space-y-2 md:col-span-1">
                    <Label className="text-sm font-semibold">Client Settings</Label>
                    <Button
                      onClick={() => setLocation("/client-settings")}
                      variant="outline"
                      className="w-full justify-start h-auto py-2 bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80 transition-colors"
                    >
                      <Settings className="w-4 h-4 mr-2 flex-shrink-0" />
                      <div className="text-left">
                        <p className="text-xs font-semibold">Vai a Client Settings</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">
                          Modifica Check-in/out per cliente
                        </p>
                      </div>
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Apartment Types */}
          <Card className="bg-custom-blue-light border-2 border-custom-blue">
              <CardHeader className="bg-custom-blue-light py-3">
                <CardTitle className="text-lg">Apartment Types</CardTitle>
                <CardDescription className="text-xs">
                  Tipi di appartamento (dimensioni) che ogni categoria di cleaner può gestire
                </CardDescription>
              </CardHeader>
              <CardContent className="bg-custom-blue-light">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  {/* Cleaner STANDARD */}
                  <div className="space-y-3">
                    <div className="border-b pb-2 flex items-center gap-2">
                      <span className="text-sm font-medium text-green-800 dark:text-green-200">Cleaner</span>
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
                    <div className="border-b pb-2 flex items-center gap-2">
                      <span className="text-sm font-medium text-yellow-800 dark:text-yellow-200">Cleaner</span>
                      <span className="px-2 py-0.5 rounded border font-medium text-sm bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400">
                        Premium
                      </span>
                      <span className="text-sm font-medium text-red-800 dark:text-red-200">e</span>
                      <span className="px-2 py-0.5 rounded border font-medium text-sm bg-red-500/30 text-red-800 dark:bg-red-500/40 dark:text-red-200 border-red-600 dark:border-red-400">
                        Straordinario
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
                    <div className="border-b pb-2 flex items-center gap-2">
                      <span className="text-sm font-medium text-orange-800 dark:text-orange-200">Cleaner</span>
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

          {/* Task Types - Tipi di appartamento che i cleaner possono fare */}
          <Card className="bg-custom-blue-light border-2 border-custom-blue">
            <CardHeader className="bg-custom-blue-light py-3">
              <CardTitle className="text-lg">Task Types</CardTitle>
              <CardDescription className="text-xs">
                Tipi di appartamento che ogni categoria di cleaner può gestire
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-custom-blue-light">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                {/* Appartamento Standard */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center gap-2">
                    <Badge variant="outline" className="bg-white text-custom-blue border-custom-blue">
                      Standard Apt
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Seleziona quali cleaner possono fare gli appartamenti standard
                    </span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="std-standard"
                        checked={settings.task_types.standard_apt.standard_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("standard_apt", "standard_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="std-standard" className="text-sm cursor-pointer">
                        Standard Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="std-premium"
                        checked={settings.task_types.standard_apt.premium_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("standard_apt", "premium_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="std-premium" className="text-sm cursor-pointer">
                        Premium Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="std-straordinaria"
                        checked={settings.task_types.standard_apt.straordinaria_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("standard_apt", "straordinaria_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="std-straordinaria" className="text-sm cursor-pointer">
                        Straordinaria Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="std-formatore"
                        checked={settings.task_types.standard_apt.formatore_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("standard_apt", "formatore_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="std-formatore" className="text-sm cursor-pointer">
                        Cleaner Formatore
                      </Label>
                    </div>
                  </div>
                </div>

                {/* Appartamento Premium */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center gap-2">
                    <Badge variant="outline" className="bg-white text-custom-blue border-custom-blue">
                      Premium Apt
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Seleziona quali cleaner possono fare gli appartamenti premium
                    </span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="prem-standard"
                        checked={settings.task_types.premium_apt.standard_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("premium_apt", "standard_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="prem-standard" className="text-sm cursor-pointer">
                        Standard Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="prem-premium"
                        checked={settings.task_types.premium_apt.premium_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("premium_apt", "premium_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="prem-premium" className="text-sm cursor-pointer">
                        Premium Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="prem-straordinaria"
                        checked={settings.task_types.premium_apt.straordinaria_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("premium_apt", "straordinaria_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="prem-straordinaria" className="text-sm cursor-pointer">
                        Straordinaria Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="prem-formatore"
                        checked={settings.task_types.premium_apt.formatore_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("premium_apt", "formatore_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="prem-formatore" className="text-sm cursor-pointer">
                        Cleaner Formatore
                      </Label>
                    </div>
                  </div>
                </div>

                {/* Appartamento Straordinario */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center gap-2">
                    <Badge variant="outline" className="bg-white text-custom-blue border-custom-blue">
                      Straordinario Apt
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      Seleziona quali cleaner possono fare gli straordinari
                    </span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="straord-standard"
                        checked={settings.task_types.straordinario_apt.standard_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("straordinario_apt", "standard_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="straord-standard" className="text-sm cursor-pointer">
                        Standard Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="straord-premium"
                        checked={settings.task_types.straordinario_apt.premium_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("straordinario_apt", "premium_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="straord-premium" className="text-sm cursor-pointer">
                        Premium Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="straord-straordinaria"
                        checked={settings.task_types.straordinario_apt.straordinaria_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("straordinario_apt", "straordinaria_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="straord-straordinaria" className="text-sm cursor-pointer">
                        Straordinaria Cleaner
                      </Label>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="straord-formatore"
                        checked={settings.task_types.straordinario_apt.formatore_cleaner}
                        onCheckedChange={(checked) =>
                          updateTaskTypeRule("straordinario_apt", "formatore_cleaner", !!checked)
                        }
                      />
                      <Label htmlFor="straord-formatore" className="text-sm cursor-pointer">
                        Cleaner Formatore
                      </Label>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

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