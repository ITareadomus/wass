import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { ThemeToggle } from "@/components/theme-toggle";
import { Trash2, Plus, Eye, EyeOff, Save, X, Home } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";

interface Account {
  id: number;
  username: string;
  password: string;
  plain_password?: string;
  role: "admin" | "user" | "viewer";
}

interface TaskTypeRules {
  standard_cleaner: boolean;
  premium_cleaner: boolean;
  straordinaria_cleaner: boolean;
  formatore_cleaner: boolean;
}

interface SystemSettings {
  "early-out": {
    eo_start_time: string;
    eo_end_time: string;
    eo_clients: number[];
  };
  "high-priority": {
    hp_start_time: string;
    hp_end_time: string;
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

export default function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showPassword, setShowPassword] = useState<{ [key: number]: boolean }>({});
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<number | null>(null);
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [newAccount, setNewAccount] = useState<Omit<Account, "id">>({
    username: "",
    password: "",
    role: "user",
  });

  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

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

    loadAccounts();
    // loadSystemSettings(); // No longer needed
  }, [setLocation, toast]);

  const loadAccounts = async () => {
    setIsLoading(true);
    try {
      const response = await fetch("/api/accounts");
      if (response.ok) {
        const data = await response.json();
        setAccounts(data.users);
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile caricare gli account",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  // const loadSystemSettings = async () => {
  //   try {
  //     const response = await fetch(`/data/input/settings.json?t=${Date.now()}`, {
  //       cache: 'no-store',
  //       headers: { 'Cache-Control': 'no-cache' }
  //     });
  //     if (response.ok) {
  //       const data = await response.json();
  //       console.log('✅ Settings loaded:', data);
  //       console.log('✅ Task types loaded:', data?.task_types);
  //       setSystemSettings(data);
  //     }
  //   } catch (error) {
  //     console.error('❌ Error loading settings:', error);
  //     toast({
  //       title: "Errore",
  //       description: "Impossibile caricare le impostazioni di sistema",
  //       variant: "destructive",
  //     });
  //   }
  // };

  // const saveSystemSettings = async () => {
  //   if (!systemSettings) return;

  //   setIsSavingSettings(true);
  //   try {
  //     const response = await fetch("/api/save-settings", {
  //       method: "POST",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify(systemSettings),
  //     });

  //     if (response.ok) {
  //       toast({
  //         title: "Impostazioni salvate",
  //         description: "Le modifiche sono state salvate con successo",
  //       });
  //       setHasUnsavedChanges(false);
  //       // Ricarica le impostazioni per assicurarsi che siano aggiornate
  //       await loadSystemSettings();
  //     } else {
  //       throw new Error();
  //     }
  //   } catch (error) {
  //     toast({
  //       title: "Errore",
  //       description: "Impossibile salvare le impostazioni",
  //       variant: "destructive",
  //     });
  //   } finally {
  //     setIsSavingSettings(false);
  //   }
  // };

  // const updateTaskTypeRule = (
  //   taskType: keyof SystemSettings['task_types'],
  //   cleanerType: keyof TaskTypeRules,
  //   value: boolean
  // ) => {
  //   if (!systemSettings) return;

  //   setSystemSettings({
  //     ...systemSettings,
  //     task_types: {
  //       ...systemSettings.task_types,
  //       [taskType]: {
  //         ...systemSettings.task_types[taskType],
  //         [cleanerType]: value
  //       }
  //     }
  //   });
  //   setHasUnsavedChanges(true);
  // };



  const handleSaveAccount = async (account: Account) => {
    try {
      const response = await fetch("/api/accounts/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(account),
      });

      if (response.ok) {
        toast({
          title: "Account aggiornato",
          description: "Le modifiche sono state salvate con successo",
        });
        setEditingAccount(null);
        loadAccounts();
      } else {
        throw new Error();
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile salvare le modifiche",
        variant: "destructive",
      });
    }
  };

  const handleAddAccount = async () => {
    if (!newAccount.username || !newAccount.password) {
      toast({
        title: "Campi mancanti",
        description: "Username e password sono obbligatori",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await fetch("/api/accounts/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAccount),
      });

      if (response.ok) {
        toast({
          title: "Account creato",
          description: "Il nuovo account è stato aggiunto con successo",
        });
        setIsAddingNew(false);
        setNewAccount({ username: "", password: "", role: "user" });
        loadAccounts();
      } else {
        throw new Error();
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile creare l'account",
        variant: "destructive",
      });
    }
  };

  const handleDeleteAccount = async () => {
    if (!accountToDelete) return;

    try {
      const response = await fetch("/api/accounts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: accountToDelete }),
      });

      if (response.ok) {
        toast({
          title: "Account eliminato",
          description: "L'account è stato rimosso con successo",
        });
        setDeleteDialogOpen(false);
        setAccountToDelete(null);
        loadAccounts();
      } else {
        throw new Error();
      }
    } catch (error) {
      toast({
        title: "Errore",
        description: "Impossibile eliminare l'account",
        variant: "destructive",
      });
    }
  };

  if (isLoading) { // systemSettings check is removed as it's not loaded anymore
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
          <div className="flex gap-2 items-center">
            <ThemeToggle />
          </div>
        </div>

        {/* Task Types Settings - Removed */}

        {/* Account Management */}
        <Card className="mb-6 bg-custom-blue-light border-2 border-custom-blue">
          <CardHeader className="bg-custom-blue-light">
            <CardTitle>Gestione Account</CardTitle>
            <CardDescription>
              Aggiungi, modifica o elimina gli account
            </CardDescription>
          </CardHeader>
          <CardContent className="bg-custom-blue-light">
            <div className="space-y-4">
              {!isAddingNew && (
                <Button
                  onClick={() => setIsAddingNew(true)}
                  className="w-full bg-background border-2 border-custom-blue text-black dark:text-white hover:opacity-80"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Aggiungi Nuovo Account
                </Button>
              )}

              {isAddingNew && (
                <Card className="border-2 border-custom-blue bg-custom-blue-light">
                  <CardContent className="pt-6 bg-custom-blue-light">
                    <div className="space-y-4">
                      <div>
                        <Label htmlFor="new-username">Username</Label>
                        <Input
                          id="new-username"
                          value={newAccount.username}
                          onChange={(e) =>
                            setNewAccount({ ...newAccount, username: e.target.value })
                          }
                          placeholder="Inserisci username"
                        />
                      </div>
                      <div>
                        <Label htmlFor="new-password">Password</Label>
                        <Input
                          id="new-password"
                          type="text"
                          value={newAccount.password}
                          onChange={(e) =>
                            setNewAccount({ ...newAccount, password: e.target.value })
                          }
                          placeholder="Inserisci password"
                        />
                      </div>
                      <div>
                        <Label htmlFor="new-role">Ruolo</Label>
                        <Select
                          value={newAccount.role}
                          onValueChange={(value: "admin" | "user" | "viewer") =>
                            setNewAccount({ ...newAccount, role: value })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">Admin</SelectItem>
                            <SelectItem value="user">User</SelectItem>
                            <SelectItem value="viewer">Viewer</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={handleAddAccount}
                          className="flex-1 border-2 border-custom-blue hover:opacity-80"
                        >
                          <Save className="w-4 h-4 mr-2" />
                          Salva
                        </Button>
                        <Button
                          onClick={() => {
                            setIsAddingNew(false);
                            setNewAccount({ username: "", password: "", role: "user" });
                          }}
                          variant="outline"
                          className="flex-1"
                        >
                          <X className="w-4 h-4 mr-2" />
                          Annulla
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {accounts.map((account) => (
                <Card key={account.id} className="bg-custom-blue-light border-2 border-custom-blue">
                  <CardContent className="pt-6 bg-custom-blue-light">
                    {editingAccount?.id === account.id ? (
                      <div className="space-y-4">
                        <div>
                          <Label>Username</Label>
                          <Input
                            value={editingAccount.username}
                            onChange={(e) =>
                              setEditingAccount({
                                ...editingAccount,
                                username: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div>
                          <Label>Password</Label>
                          <Input
                            type="text"
                            value={editingAccount.password}
                            onChange={(e) =>
                              setEditingAccount({
                                ...editingAccount,
                                password: e.target.value,
                              })
                            }
                          />
                        </div>
                        <div>
                          <Label>Ruolo</Label>
                          <Select
                            value={editingAccount.role}
                            onValueChange={(value: "admin" | "user" | "viewer") =>
                              setEditingAccount({ ...editingAccount, role: value })
                            }
                            disabled={editingAccount.id === 1 && editingAccount.role === 'admin'}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="user">User</SelectItem>
                              <SelectItem value="viewer">Viewer</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            onClick={() => handleSaveAccount(editingAccount)}
                            className="flex-1 border-2 border-custom-blue hover:opacity-80"
                          >
                            <Save className="w-4 h-4 mr-2" />
                            Salva
                          </Button>
                          <Button
                            onClick={() => setEditingAccount(null)}
                            variant="outline"
                            className="flex-1"
                          >
                            <X className="w-4 h-4 mr-2" />
                            Annulla
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div className="space-y-1 flex-1">
                          <p className="font-semibold">{account.username}</p>
                          <div className="flex items-center gap-2">
                            <p className="text-sm text-muted-foreground">
                              {showPassword[account.id]
                                ? (account.plain_password || "••••••••")
                                : "••••••••"}
                            </p>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() =>
                                setShowPassword({
                                  ...showPassword,
                                  [account.id]: !showPassword[account.id],
                                })
                              }
                              className="h-6 w-6"
                            >
                              {showPassword[account.id] ? (
                                <EyeOff className="h-3 w-3" />
                              ) : (
                                <Eye className="h-3 w-3" />
                              )}
                            </Button>
                          </div>
                          <p className="text-sm">
                            <span className="font-medium">Ruolo:</span>{" "}
                            <span className="capitalize">{account.role}</span>
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            onClick={() => setEditingAccount(account)}
                            variant="outline"
                            size="sm"
                            className="border-2 border-custom-blue"
                            disabled={account.id === 1 && account.role === 'admin'}
                          >
                            Modifica
                          </Button>
                          <Button
                            onClick={() => {
                              setAccountToDelete(account.id);
                              setDeleteDialogOpen(true);
                            }}
                            variant="destructive"
                            size="sm"
                            className="border-2 border-custom-blue"
                            disabled={account.id === 1}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sei sicuro?</AlertDialogTitle>
            <AlertDialogDescription>
              Questa azione non può essere annullata. L'account verrà eliminato
              permanentemente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAccount}>
              Elimina
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}