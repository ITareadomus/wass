import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Save, Home, Loader2 } from "lucide-react";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Client {
  client_id: number;
  customer_name: string;
  alias: string | null;
}

interface CleanerAptRules {
  standard_apt: boolean;
  premium_apt: boolean;
  straordinario_apt: boolean;
}

interface CleanerPriorityRules {
  early_out: boolean;
  high_priority: boolean;
  low_priority: boolean;
}

interface SettingsData {
  "early-out": {
    eo_start_time: string;
    eo_end_time: string;
    eo_clients: number[];
  };
  "high-priority": {
    global_start_time: string;
    hp_start_time: string;
    hp_end_time: string;
    hp_clients: number[];
  };
  dedupe_strategy: string;
  apartment_types: {
    standard_apt: string[];
    premium_apt: string[];
    straordinario_apt: string[];
    formatore_apt: string[];
  };
  task_types: {
    standard_cleaner: CleanerAptRules;
    premium_cleaner: CleanerAptRules;
    straordinario_cleaner: CleanerAptRules;
    formatore_cleaner: CleanerAptRules;
  };
  priority_types: {
    standard_cleaner: CleanerPriorityRules;
    premium_cleaner: CleanerPriorityRules;
    straordinario_cleaner: CleanerPriorityRules;
    formatore_cleaner: CleanerPriorityRules;
  };
}

function withSettingsDefaults(data: Partial<SettingsData>): SettingsData {
  const defaultAptRules: CleanerAptRules = {
    standard_apt: false,
    premium_apt: false,
    straordinario_apt: false,
  };
  const defaultPriorityRules: CleanerPriorityRules = {
    early_out: false,
    high_priority: false,
    low_priority: false,
  };

  return {
    "early-out": {
      eo_start_time: data["early-out"]?.eo_start_time ?? "",
      eo_end_time: data["early-out"]?.eo_end_time ?? "",
      eo_clients: data["early-out"]?.eo_clients ?? [],
    },
    "high-priority": {
      global_start_time:
        data["high-priority"]?.global_start_time ?? data["high-priority"]?.hp_start_time ?? "",
      hp_start_time:
        data["high-priority"]?.hp_start_time ?? data["high-priority"]?.global_start_time ?? "",
      hp_end_time: data["high-priority"]?.hp_end_time ?? "",
      hp_clients: data["high-priority"]?.hp_clients ?? [],
    },
    dedupe_strategy: data.dedupe_strategy ?? "",
    apartment_types: {
      standard_apt: data.apartment_types?.standard_apt ?? [],
      premium_apt: data.apartment_types?.premium_apt ?? [],
      straordinario_apt: data.apartment_types?.straordinario_apt ?? [],
      formatore_apt: data.apartment_types?.formatore_apt ?? [],
    },
    task_types: {
      standard_cleaner: { ...defaultAptRules, ...data.task_types?.standard_cleaner },
      premium_cleaner: { ...defaultAptRules, ...data.task_types?.premium_cleaner },
      straordinario_cleaner: { ...defaultAptRules, ...data.task_types?.straordinario_cleaner },
      formatore_cleaner: { ...defaultAptRules, ...data.task_types?.formatore_cleaner },
    },
    priority_types: {
      standard_cleaner: { ...defaultPriorityRules, ...data.priority_types?.standard_cleaner },
      premium_cleaner: { ...defaultPriorityRules, ...data.priority_types?.premium_cleaner },
      straordinario_cleaner: { ...defaultPriorityRules, ...data.priority_types?.straordinario_cleaner },
      formatore_cleaner: { ...defaultPriorityRules, ...data.priority_types?.formatore_cleaner },
    },
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
      const response = await fetch('/api/settings', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' }
      });

      if (response.ok) {
        const data = await response.json();
        if (Object.keys(data).length === 0) {
          setSettings(withSettingsDefaults({}));
        } else {
          setSettings(withSettingsDefaults(data));
        }
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
      <PageViewportCentered layout="viewport" className="bg-background py-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Caricamento...</p>
        </div>
      </PageViewportCentered>
    );
  }

  const handleClientToggle = (clientId: number, priority: "eo" | "hp") => {
    setSettings(prev => {
      if (!prev) return prev;

      const clients =
        priority === "eo"
          ? prev["early-out"].eo_clients
          : prev["high-priority"].hp_clients;
      const newClients = clients.includes(clientId)
        ? clients.filter((id: number) => id !== clientId)
        : [...clients, clientId];

      if (priority === "eo") {
        return {
          ...prev,
          "early-out": {
            ...prev["early-out"],
            eo_clients: newClients,
          },
        };
      }

      return {
        ...prev,
        "high-priority": {
          ...prev["high-priority"],
          hp_clients: newClients,
        },
      };
    });
  };


  const updateTaskTypeRule = (
    cleanerType: keyof SettingsData["task_types"],
    aptType: keyof CleanerAptRules,
    value: boolean
  ) => {
    setSettings(prev => {
      if (!prev) return prev;

      return {
        ...prev,
        task_types: {
          ...prev.task_types,
          [cleanerType]: {
            ...prev.task_types[cleanerType],
            [aptType]: value,
          },
        },
      };
    });
  };

  const updatePriorityTypeRule = (
    cleanerType: keyof SettingsData["priority_types"],
    priorityType: keyof CleanerPriorityRules,
    value: boolean
  ) => {
    setSettings(prev => {
      if (!prev) return prev;

      return {
        ...prev,
        priority_types: {
          ...prev.priority_types,
          [cleanerType]: {
            ...prev.priority_types[cleanerType],
            [priorityType]: value,
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
      <div className="w-full px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Settings</h1>
        </div>

        <div className="space-y-4">
          {/* Algoritmo priorità hp-centrico */}
          <Card className="bg-custom-blue-light border-2 border-custom-blue">
            <CardHeader className="bg-custom-blue-light py-3">
              <CardTitle className="text-lg">Priority Types</CardTitle>
              <CardDescription className="text-s">
              </CardDescription>
              <CardDescription className="text-xs">
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-custom-blue-light">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="global_start_time" className="text-sm">HP Start Time</Label>
                      <Input
                        id="global_start_time"
                        type="time"
                        required
                        value={settings["high-priority"].global_start_time}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            "high-priority": {
                              ...settings["high-priority"],
                              global_start_time: e.target.value,
                              hp_start_time: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="hp_end_time" className="text-sm">HP End Time</Label>
                      <Input
                        id="hp_end_time"
                        type="time"
                        required
                        value={settings["high-priority"].hp_end_time}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            "high-priority": {
                              ...settings["high-priority"],
                              hp_end_time: e.target.value,
                            },
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="dedupe_strategy" className="text-sm font-semibold">Duplex / dedupeStrategy</Label>
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
                      eo_wins assegna a EO i task duplex; hp_wins assegna a HP gli stessi casi.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-3">
                    <div className="border-b pb-2 flex items-center justify-center gap-2">
                      <span className="text-sm font-medium text-blue-800 dark:text-blue-200">Lista clienti </span>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500 text-white border-blue-700">
                        EO
                      </span>
                    </div>
                    <ScrollArea className="h-56 w-full rounded-md border p-4">
                      {clients.map((client) => (
                        <div key={`eo-client-${client.client_id}`} className="flex items-center space-x-2 mb-2">
                          <Checkbox
                            id={`eo-client-${client.client_id}`}
                            checked={settings["early-out"].eo_clients.includes(client.client_id)}
                            onCheckedChange={() => {
                              handleClientToggle(client.client_id, "eo");
                            }}
                          />
                          <Label htmlFor={`eo-client-${client.client_id}`} className="text-sm cursor-pointer">
                            {client.customer_name}
                          </Label>
                        </div>
                      ))}
                    </ScrollArea>
                  </div>

                  <div className="space-y-3">
                    <div className="border-b pb-2 flex items-center justify-center gap-2">
                      <span className="text-sm font-medium text-orange-800 dark:text-orange-200">Lista clienti </span>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-500 text-white border-orange-700">
                        HP
                      </span>
                    </div>
                    <ScrollArea className="h-56 w-full rounded-md border p-4">
                      {clients.map((client) => (
                        <div key={`hp-client-${client.client_id}`} className="flex items-center space-x-2 mb-2">
                          <Checkbox
                            id={`hp-client-${client.client_id}`}
                            checked={settings["high-priority"].hp_clients.includes(client.client_id)}
                            onCheckedChange={() => {
                              handleClientToggle(client.client_id, "hp");
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
              </div>

            </CardContent>
          </Card>

          {/* Apartment Types + Task Types - Card unificata */}
          <Card className="bg-custom-blue-light border-2 border-custom-blue">
            <CardHeader className="bg-custom-blue-light py-3">
              <CardTitle className="text-lg">Apartment Types & Task Types</CardTitle>
              <CardDescription className="text-s">
                Tipi di task, appartamento e priorità che ogni categoria di cleaner può gestire
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-custom-blue-light">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8 w-full">
                {/* Cleaner STANDARD */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center justify-center gap-2">
                    <span className="text-sm font-medium text-green-800 dark:text-green-200">Cleaner</span>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-500/30 text-green-800 dark:bg-green-500/40 dark:text-green-200 border-green-600 dark:border-green-400">
                      Standard
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {/* Colonna sinistra: Tipo A-X */}
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
                    {/* Colonna destra: Apt Types + Priorità */}
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="standard-std"
                          checked={settings.task_types.standard_cleaner.standard_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("standard_cleaner", "standard_apt", !!checked)
                          }
                        />
                        <Label htmlFor="standard-std" className="text-sm cursor-pointer">
                          Apt Standard
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="standard-prem"
                          checked={settings.task_types.standard_cleaner.premium_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("standard_cleaner", "premium_apt", !!checked)
                          }
                        />
                        <Label htmlFor="standard-prem" className="text-sm cursor-pointer">
                          Apt Premium
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="standard-straord"
                          checked={settings.task_types.standard_cleaner.straordinario_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("standard_cleaner", "straordinario_apt", !!checked)
                          }
                        />
                        <Label htmlFor="standard-straord" className="text-sm cursor-pointer">
                          Apt Straordinario
                        </Label>
                      </div>
                      <div className="border-t pt-2 space-y-2">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="standard-eo"
                            checked={settings.priority_types.standard_cleaner.early_out}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("standard_cleaner", "early_out", !!checked)
                            }
                          />
                          <Badge className="bg-blue-500 text-white border-blue-700 text-xs px-2 py-0">
                            EO
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="standard-hp"
                            checked={settings.priority_types.standard_cleaner.high_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("standard_cleaner", "high_priority", !!checked)
                            }
                          />
                          <Badge className="bg-orange-500 text-white border-orange-700 text-xs px-2 py-0">
                            HP
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="standard-lp"
                            checked={settings.priority_types.standard_cleaner.low_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("standard_cleaner", "low_priority", !!checked)
                            }
                          />
                          <Badge className="bg-gray-500 text-white border-gray-700 text-xs px-2 py-0">
                            LP
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cleaner PREMIUM */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center justify-center gap-2">
                    <span className="text-sm font-medium text-yellow-800 dark:text-yellow-200">Cleaner</span>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-500/30 text-yellow-800 dark:bg-yellow-500/40 dark:text-yellow-200 border-yellow-600 dark:border-yellow-400">
                      Premium
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {/* Colonna sinistra: Tipo A-X */}
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
                    {/* Colonna destra: Apt Types + Priorità */}
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="premium-std"
                          checked={settings.task_types.premium_cleaner.standard_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("premium_cleaner", "standard_apt", !!checked)
                          }
                        />
                        <Label htmlFor="premium-std" className="text-sm cursor-pointer">
                          Apt Standard
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="premium-prem"
                          checked={settings.task_types.premium_cleaner.premium_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("premium_cleaner", "premium_apt", !!checked)
                          }
                        />
                        <Label htmlFor="premium-prem" className="text-sm cursor-pointer">
                          Apt Premium
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="premium-straord"
                          checked={settings.task_types.premium_cleaner.straordinario_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("premium_cleaner", "straordinario_apt", !!checked)
                          }
                        />
                        <Label htmlFor="premium-straord" className="text-sm cursor-pointer">
                          Apt Straordinario
                        </Label>
                      </div>
                      <div className="border-t pt-2 space-y-2">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="premium-eo"
                            checked={settings.priority_types.premium_cleaner.early_out}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("premium_cleaner", "early_out", !!checked)
                            }
                          />
                          <Badge className="bg-blue-500 text-white border-blue-700 text-xs px-2 py-0">
                            EO
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="premium-hp"
                            checked={settings.priority_types.premium_cleaner.high_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("premium_cleaner", "high_priority", !!checked)
                            }
                          />
                          <Badge className="bg-orange-500 text-white border-orange-700 text-xs px-2 py-0">
                            HP
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="premium-lp"
                            checked={settings.priority_types.premium_cleaner.low_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("premium_cleaner", "low_priority", !!checked)
                            }
                          />
                          <Badge className="bg-gray-500 text-white border-gray-700 text-xs px-2 py-0">
                            LP
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cleaner STRAORDINARIO */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center justify-center gap-2">
                    <span className="text-sm font-medium text-red-800 dark:text-red-200">Cleaner</span>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-500/30 text-red-800 dark:bg-red-500/40 dark:text-red-200 border-red-600 dark:border-red-400">
                      Straordinario
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {/* Colonna sinistra: Tipo A-X */}
                    <div className="space-y-2">
                      {["A", "B", "C", "D", "E", "F", "X"].map((type) => (
                        <div key={`straordinario-${type}`} className="flex items-center space-x-2">
                          <input
                            type="checkbox"
                            id={`straordinario-${type}`}
                            checked={settings.apartment_types.straordinario_apt.includes(type)}
                            onChange={(e) => {
                              const newTypes = e.target.checked
                                ? [...settings.apartment_types.straordinario_apt, type]
                                : settings.apartment_types.straordinario_apt.filter((t) => t !== type);
                              setSettings({
                                ...settings,
                                apartment_types: {
                                  ...settings.apartment_types,
                                  straordinario_apt: newTypes,
                                },
                              });
                            }}
                            className="h-4 w-4 rounded border-gray-300"
                          />
                          <Label htmlFor={`straordinario-${type}`} className="text-sm cursor-pointer">
                            Tipo {type}
                          </Label>
                        </div>
                      ))}
                    </div>
                    {/* Colonna destra: Apt Types + Priorità */}
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="straord-std"
                          checked={settings.task_types.straordinario_cleaner.standard_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("straordinario_cleaner", "standard_apt", !!checked)
                          }
                        />
                        <Label htmlFor="straord-std" className="text-sm cursor-pointer">
                          Apt Standard
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="straord-prem"
                          checked={settings.task_types.straordinario_cleaner.premium_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("straordinario_cleaner", "premium_apt", !!checked)
                          }
                        />
                        <Label htmlFor="straord-prem" className="text-sm cursor-pointer">
                          Apt Premium
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="straord-straord"
                          checked={settings.task_types.straordinario_cleaner.straordinario_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("straordinario_cleaner", "straordinario_apt", !!checked)
                          }
                        />
                        <Label htmlFor="straord-straord" className="text-sm cursor-pointer">
                          Apt Straordinario
                        </Label>
                      </div>
                      <div className="border-t pt-2 space-y-2">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="straord-eo"
                            checked={settings.priority_types.straordinario_cleaner.early_out}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("straordinario_cleaner", "early_out", !!checked)
                            }
                          />
                          <Badge className="bg-blue-500 text-white border-blue-700 text-xs px-2 py-0">
                            EO
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="straord-hp"
                            checked={settings.priority_types.straordinario_cleaner.high_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("straordinario_cleaner", "high_priority", !!checked)
                            }
                          />
                          <Badge className="bg-orange-500 text-white border-orange-700 text-xs px-2 py-0">
                            HP
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="straord-lp"
                            checked={settings.priority_types.straordinario_cleaner.low_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("straordinario_cleaner", "low_priority", !!checked)
                            }
                          />
                          <Badge className="bg-gray-500 text-white border-gray-700 text-xs px-2 py-0">
                            LP
                          </Badge>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cleaner FORMATORE */}
                <div className="space-y-3">
                  <div className="border-b pb-2 flex items-center justify-center gap-2">
                    <span className="text-sm font-medium text-orange-800 dark:text-orange-200">Cleaner</span>
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-orange-500/30 text-orange-800 dark:bg-orange-500/40 dark:text-orange-200 border-orange-600 dark:border-orange-400">
                      Formatore
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {/* Colonna sinistra: Tipo A-X */}
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
                    {/* Colonna destra: Apt Types + Priorità */}
                    <div className="space-y-2">
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="formatore-std"
                          checked={settings.task_types.formatore_cleaner.standard_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("formatore_cleaner", "standard_apt", !!checked)
                          }
                        />
                        <Label htmlFor="formatore-std" className="text-sm cursor-pointer">
                          Apt Standard
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="formatore-prem"
                          checked={settings.task_types.formatore_cleaner.premium_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("formatore_cleaner", "premium_apt", !!checked)
                          }
                        />
                        <Label htmlFor="formatore-prem" className="text-sm cursor-pointer">
                          Apt Premium
                        </Label>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Checkbox
                          id="formatore-straord"
                          checked={settings.task_types.formatore_cleaner.straordinario_apt}
                          onCheckedChange={(checked) =>
                            updateTaskTypeRule("formatore_cleaner", "straordinario_apt", !!checked)
                          }
                        />
                        <Label htmlFor="formatore-straord" className="text-sm cursor-pointer">
                          Apt Straordinario
                        </Label>
                      </div>
                      <div className="border-t pt-2 space-y-2">
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="formatore-eo"
                            checked={settings.priority_types.formatore_cleaner.early_out}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("formatore_cleaner", "early_out", !!checked)
                            }
                          />
                          <Badge className="bg-blue-500 text-white border-blue-700 text-xs px-2 py-0">
                            EO
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="formatore-hp"
                            checked={settings.priority_types.formatore_cleaner.high_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("formatore_cleaner", "high_priority", !!checked)
                            }
                          />
                          <Badge className="bg-orange-500 text-white border-orange-700 text-xs px-2 py-0">
                            HP
                          </Badge>
                        </div>
                        <div className="flex items-center space-x-2">
                          <Checkbox
                            id="formatore-lp"
                            checked={settings.priority_types.formatore_cleaner.low_priority}
                            onCheckedChange={(checked) =>
                              updatePriorityTypeRule("formatore_cleaner", "low_priority", !!checked)
                            }
                          />
                          <Badge className="bg-gray-500 text-white border-gray-700 text-xs px-2 py-0">
                            LP
                          </Badge>
                        </div>
                      </div>
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