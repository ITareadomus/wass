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

interface Account {
  id: number;
  username: string;
  password: string;
  role: "admin" | "user" | "viewer";
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

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p>Caricamento...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      <div className="container mx-auto px-4 py-8">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Impostazioni Account</h1>
          <div className="flex gap-2">
            <Button onClick={() => setLocation("/")} variant="outline" className="flex items-center gap-2">
              <Home className="w-4 h-4" />
              <span>Torna alla Home</span>
            </Button>
            <ThemeToggle />
          </div>
        </div>

        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Gestione Account</CardTitle>
            <CardDescription>
              Aggiungi, modifica o elimina gli account utente
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Pulsante Aggiungi Nuovo */}
              {!isAddingNew && (
                <Button onClick={() => setIsAddingNew(true)} className="w-full">
                  <Plus className="w-4 h-4 mr-2" />
                  Aggiungi Nuovo Account
                </Button>
              )}

              {/* Form Nuovo Account */}
              {isAddingNew && (
                <Card className="border-2 border-primary">
                  <CardContent className="pt-6">
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
                        <Button onClick={handleAddAccount} className="flex-1">
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

              {/* Lista Account */}
              {accounts.map((account) => (
                <Card key={account.id}>
                  <CardContent className="pt-6">
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
                            className="flex-1"
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
                                ? account.password
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