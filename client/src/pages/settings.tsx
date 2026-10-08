import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Eye, EyeOff, Loader2, Lock, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { PageViewportCentered } from "@/components/page-viewport-centered";
import { cn } from "@/lib/utils";

type AccountRole = "admin" | "user" | "viewer" | "logistica";

interface Account {
  id: number;
  username: string;
  password?: string;
  plain_password?: string;
  role: AccountRole;
  source?: "wass" | "adam";
  displayName?: string;
}

function isAdamAccount(account: Pick<Account, "source"> | null | undefined) {
  return account?.source === "adam";
}

function accountKey(account: Pick<Account, "id" | "source">) {
  return `${account.source ?? "wass"}-${account.id}`;
}

function accountLabel(account: Pick<Account, "username" | "source" | "displayName">) {
  if (isAdamAccount(account) && account.displayName?.trim()) return account.displayName.trim();
  return account.username;
}

const ROLES: { value: AccountRole; label: string; badgeClass: string }[] = [
  {
    value: "admin",
    label: "Admin",
    badgeClass: "border-transparent bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-200",
  },
  {
    value: "user",
    label: "User",
    badgeClass: "border-transparent bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-200",
  },
  {
    value: "viewer",
    label: "Viewer",
    badgeClass: "border-transparent bg-gray-100 text-gray-600 dark:bg-gray-500/20 dark:text-gray-300",
  },
  {
    value: "logistica",
    label: "Logistica",
    badgeClass: "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-200",
  },
];

const AVATAR_COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-purple-500",
  "bg-orange-500",
  "bg-pink-500",
  "bg-teal-500",
  "bg-red-500",
  "bg-indigo-500",
  "bg-yellow-500",
  "bg-cyan-500",
];

function avatarColor(userId: number) {
  return AVATAR_COLORS[(userId - 1) % AVATAR_COLORS.length];
}

function roleMeta(role: string) {
  return ROLES.find((item) => item.value === role) ?? ROLES[1];
}

/** Password da mostrare e modificare: in chiaro, mai l'eventuale hash bcrypt residuo. */
function accountPassword(account: Pick<Account, "password" | "plain_password">): string {
  const plain = account.plain_password?.trim();
  if (plain && !plain.startsWith("$2")) return plain;
  return account.password;
}

function isPrimaryAdmin(account: Pick<Account, "id" | "role" | "source">) {
  return !isAdamAccount(account) && account.id === 1 && account.role === "admin";
}

async function readError(response: Response, fallback: string) {
  try {
    const data = await response.json();
    if (typeof data?.message === "string" && data.message.trim()) return data.message;
  } catch {
    /* risposta non JSON */
  }
  return fallback;
}

export default function Settings() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<AccountRole | "all">("all");
  const [visiblePasswords, setVisiblePasswords] = useState<Record<number, boolean>>({});
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [draftUsername, setDraftUsername] = useState("");
  const [draftPassword, setDraftPassword] = useState("");
  const [draftRole, setDraftRole] = useState<AccountRole>("user");
  const [showDraftPassword, setShowDraftPassword] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);

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

  const loadAccounts = async (silent = false) => {
    if (!silent) setIsLoading(true);
    try {
      const response = await fetch("/api/accounts");
      if (response.ok) {
        const data = await response.json();
        setAccounts(Array.isArray(data.users) ? data.users : []);
      }
    } catch {
      toast({
        title: "Errore",
        description: "Impossibile caricare gli account",
        variant: "destructive",
      });
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  const roleCounts = useMemo(() => {
    const counts: Record<AccountRole, number> = { admin: 0, user: 0, viewer: 0, logistica: 0 };
    for (const account of accounts) {
      if (counts[account.role] !== undefined) counts[account.role] += 1;
    }
    return counts;
  }, [accounts]);

  const visibleAccounts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return accounts.filter((account) => {
      if (roleFilter !== "all" && account.role !== roleFilter) return false;
      if (!needle) return true;
      return (
        account.username.toLowerCase().includes(needle) ||
        (account.displayName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [accounts, query, roleFilter]);

  const openCreate = () => {
    setEditingAccount(null);
    setDraftUsername("");
    setDraftPassword("");
    setDraftRole("user");
    setShowDraftPassword(false);
    setEditorOpen(true);
  };

  const openEdit = (account: Account) => {
    if (isPrimaryAdmin(account)) return;
    setEditingAccount(account);
    setDraftUsername(accountLabel(account));
    setDraftPassword(accountPassword(account));
    setDraftRole(account.role);
    setShowDraftPassword(false);
    setEditorOpen(true);
  };

  const handleSave = async () => {
    const isAdam = isAdamAccount(editingAccount);
    if (!draftUsername.trim() || (!isAdam && !draftPassword)) {
      toast({
        title: "Campi mancanti",
        description: "Username e password sono obbligatori",
        variant: "destructive",
      });
      return;
    }

    setIsSaving(true);
    try {
      const isEdit = editingAccount !== null;
      const response = await fetch(isEdit ? "/api/accounts/update" : "/api/accounts/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isEdit && isAdam
            ? { source: "adam", id: editingAccount.id, role: draftRole }
            : isEdit
              ? { id: editingAccount.id, username: draftUsername.trim(), password: draftPassword, role: draftRole }
              : { username: draftUsername.trim(), password: draftPassword, role: draftRole }
        ),
      });

      if (!response.ok) {
        throw new Error(await readError(response, isEdit ? "Impossibile salvare le modifiche" : "Impossibile creare l'account"));
      }

      toast({
        title: isEdit ? "Account aggiornato" : "Account creato",
        description: isEdit
          ? "Le modifiche sono state salvate con successo"
          : "Il nuovo account è stato aggiunto con successo",
      });
      setEditorOpen(false);
      await loadAccounts(true);
    } catch (error) {
      toast({
        title: "Errore",
        description: error instanceof Error ? error.message : "Operazione non riuscita",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!accountToDelete) return;

    try {
      const response = await fetch("/api/accounts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: accountToDelete.id }),
      });

      if (!response.ok) {
        throw new Error(await readError(response, "Impossibile eliminare l'account"));
      }

      toast({
        title: "Account eliminato",
        description: "L'account è stato rimosso con successo",
      });
      setDeleteDialogOpen(false);
      setAccountToDelete(null);
      await loadAccounts(true);
    } catch (error) {
      toast({
        title: "Errore",
        description: error instanceof Error ? error.message : "Impossibile eliminare l'account",
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return (
      <PageViewportCentered layout="viewport" className="bg-background py-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Caricamento...</p>
        </div>
      </PageViewportCentered>
    );
  }

  return (
    <div className="min-h-[calc(100vh-3.75rem)] overflow-x-hidden bg-muted/30 text-foreground">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:py-10">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">Account</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {accounts.length === 1 ? "1 accesso a WASS" : `${accounts.length} accessi a WASS`}
            </p>
          </div>
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="h-4 w-4" />
            Nuovo account
          </Button>
        </div>

        <div className="mb-4 flex flex-wrap gap-2">
          <FilterChip active={roleFilter === "all"} onClick={() => setRoleFilter("all")} count={accounts.length}>
            Tutti
          </FilterChip>
          {ROLES.map((role) => (
            <FilterChip
              key={role.value}
              active={roleFilter === role.value}
              onClick={() => setRoleFilter(role.value)}
              count={roleCounts[role.value]}
              toneClass={role.badgeClass}
            >
              {role.label}
            </FilterChip>
          ))}
        </div>

        <div className="relative mb-4">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Cerca per username"
            className="bg-background pl-9"
            aria-label="Cerca account"
          />
        </div>

        <div className="overflow-hidden rounded-xl border border-border/70 bg-background shadow-sm">
          {visibleAccounts.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-muted-foreground">
              Nessun account corrisponde alla ricerca.
            </p>
          ) : (
            <ul className="divide-y divide-border/70">
              {visibleAccounts.map((account) => {
                const role = roleMeta(account.role);
                const locked = isPrimaryAdmin(account);
                const passwordVisible = Boolean(visiblePasswords[accountKey(account)]);
                const password = accountPassword(account);
                const adam = isAdamAccount(account);
                return (
                  <li key={accountKey(account)} className="flex items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
                    <Avatar className="h-10 w-10">
                      <AvatarFallback className={cn(avatarColor(account.id), "text-sm font-semibold text-white")}>
                        {accountLabel(account).charAt(0).toUpperCase() || "?"}
                      </AvatarFallback>
                    </Avatar>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium">{accountLabel(account)}</p>
                        {adam ? (
                          <span
                            title="Account preso da ADAM"
                            className="inline-flex h-5 items-center rounded-md border border-violet-300 bg-violet-50 px-1.5 text-[10px] font-semibold tracking-wide text-violet-700 dark:border-violet-400/80 dark:bg-violet-950 dark:text-violet-300"
                          >
                            AD
                          </span>
                        ) : null}
                        <Badge className={role.badgeClass}>{role.label}</Badge>
                        {locked ? (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                            <Lock className="h-3 w-3" />
                            Principale
                          </span>
                        ) : null}
                      </div>
                      {adam ? (
                        <p className="mt-1 truncate text-xs text-muted-foreground">{account.username}</p>
                      ) : (
                        <div className="mt-1 flex items-center gap-1">
                          <p className="truncate font-mono text-xs tracking-wide text-muted-foreground">
                            {passwordVisible ? password || "—" : "••••••••"}
                          </p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground"
                            aria-label={passwordVisible ? "Nascondi password" : "Mostra password"}
                            onClick={() =>
                              setVisiblePasswords((current) => ({
                                ...current,
                                [accountKey(account)]: !current[accountKey(account)],
                              }))
                            }
                          >
                            {passwordVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Modifica ${accountLabel(account)}`}
                        title={locked ? "L'account admin principale non si può modificare" : "Modifica"}
                        disabled={locked}
                        onClick={() => openEdit(account)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      {adam ? null : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        aria-label={`Elimina ${account.username}`}
                        title={account.id === 1 ? "L'account admin principale non si può eliminare" : "Elimina"}
                        disabled={account.id === 1}
                        onClick={() => {
                          setAccountToDelete(account);
                          setDeleteDialogOpen(true);
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editingAccount ? "Modifica account" : "Nuovo account"}</DialogTitle>
            <DialogDescription>
              {isAdamAccount(editingAccount)
                ? "Nome e password arrivano da ADAM. Qui puoi cambiare solo il ruolo WASS."
                : editingAccount
                  ? `Aggiorna username, password o ruolo di ${editingAccount.username}.`
                  : "Username e password servono per entrare in WASS."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="account-username">{isAdamAccount(editingAccount) ? "Nome" : "Username"}</Label>
              <Input
                id="account-username"
                value={draftUsername}
                onChange={(event) => setDraftUsername(event.target.value)}
                placeholder="Nome utente"
                autoComplete="off"
                readOnly={isAdamAccount(editingAccount)}
                disabled={isAdamAccount(editingAccount)}
              />
              {isAdamAccount(editingAccount) ? (
                <p className="text-xs text-muted-foreground">Accesso con {editingAccount?.username}</p>
              ) : null}
            </div>
            {isAdamAccount(editingAccount) ? null : (
            <div className="space-y-2">
              <Label htmlFor="account-password">Password</Label>
              <div className="relative">
                <Input
                  id="account-password"
                  type={showDraftPassword ? "text" : "password"}
                  value={draftPassword}
                  onChange={(event) => setDraftPassword(event.target.value)}
                  placeholder="Password"
                  autoComplete="new-password"
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 text-muted-foreground"
                  aria-label={showDraftPassword ? "Nascondi password" : "Mostra password"}
                  onClick={() => setShowDraftPassword((current) => !current)}
                >
                  {showDraftPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="account-role">Ruolo</Label>
              <Select
                value={draftRole}
                onValueChange={(value: AccountRole) => setDraftRole(value)}
                disabled={editingAccount ? isPrimaryAdmin(editingAccount) : false}
              >
                <SelectTrigger id="account-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((role) => (
                    <SelectItem key={role.value} value={role.value}>
                      <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", role.badgeClass)}>
                        {role.label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditorOpen(false)} disabled={isSaving}>
              Annulla
            </Button>
            <Button type="button" onClick={handleSave} disabled={isSaving}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Salva
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Eliminare {accountToDelete?.username}?</AlertDialogTitle>
            <AlertDialogDescription>
              L'account non potrà più accedere a WASS. L'operazione non si può annullare.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteAccount}>Elimina</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function FilterChip({
  active,
  count,
  onClick,
  children,
  toneClass,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: string;
  toneClass?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors",
        toneClass
          ? cn(toneClass, active ? "ring-2 ring-offset-2 ring-current" : "hover:opacity-80")
          : active
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background text-foreground hover:bg-muted"
      )}
    >
      {children}
      <span
        className={cn(
          "text-xs tabular-nums",
          toneClass ? "opacity-80" : active ? "text-primary-foreground/80" : "text-muted-foreground"
        )}
      >
        {count}
      </span>
    </button>
  );
}
