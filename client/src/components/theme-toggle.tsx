
import { Moon, Sun, LogOut, History, User, Check, Settings, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";

interface Account {
  id: number;
  username: string;
  password: string;
  role: string;
}

export function ThemeToggle() {
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const [isDark, setIsDark] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);

  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const shouldBeDark = savedTheme === "dark" || (!savedTheme && prefersDark);
    
    setIsDark(shouldBeDark);
    if (shouldBeDark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    // Load accounts
    fetch("/data/accounts.json")
      .then(res => res.json())
      .then(data => setAccounts(data.users || []))
      .catch(err => console.error("Error loading accounts:", err));
  }, []);

  const toggleTheme = () => {
    const newIsDark = !isDark;
    setIsDark(newIsDark);
    
    if (newIsDark) {
      document.documentElement.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      document.documentElement.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("user");
    toast({
      title: "Logout effettuato",
      description: "Sei stato disconnesso con successo",
    });
    setLocation("/login");
  };

  const switchAccount = (account: Account) => {
    localStorage.removeItem("user");
    toast({
      title: "Cambio account",
      description: "Effettua il login con le credenziali desiderate",
    });
    setLocation("/login");
  };

  const getCurrentUser = () => {
    if (!user) return null;
    try {
      return JSON.parse(user);
    } catch {
      return null;
    }
  };

  const user = localStorage.getItem("user");

  const getUserInitial = () => {
    if (!user) return "";
    try {
      const userData = JSON.parse(user);
      const username = userData.username || "";
      return username.charAt(0).toUpperCase();
    } catch {
      return "";
    }
  };

  const getAvatarColor = (userId: number) => {
    const colors = [
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
    return colors[(userId - 1) % colors.length];
  };

  const currentUser = getCurrentUser();

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        onClick={toggleTheme}
        className="rounded-full"
      >
        {isDark ? (
          <Sun className="h-5 w-5" />
        ) : (
          <Moon className="h-5 w-5" />
        )}
      </Button>
      {location !== "/" && location !== "/generate-assignments" && (
        <Button 
          onClick={() => setLocation("/")} 
          variant="outline" 
          size="icon"
          className="rounded-full"
          title="Torna alla Home"
        >
          <Home className="h-5 w-5" />
        </Button>
      )}
      {user && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-full h-9 w-9 p-0">
              <Avatar className="h-9 w-9 cursor-pointer">
                <AvatarFallback className={`${currentUser ? getAvatarColor(currentUser.id) : 'bg-primary'} text-white font-semibold`}>
                  {getUserInitial()}
                </AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <User className="mr-2 h-4 w-4" />
                <span>{currentUser?.username || "Utente"}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuLabel>Cambia Account</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {accounts.map((account) => (
                  <DropdownMenuItem
                    key={account.id}
                    onClick={() => switchAccount(account)}
                    className="cursor-pointer"
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          <AvatarFallback className={`${getAvatarColor(account.id)} text-white text-xs font-semibold`}>
                            {account.username.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span>{account.username}</span>
                      </div>
                      {currentUser?.id === account.id && (
                        <Check className="h-4 w-4" />
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
                {currentUser?.role === "admin" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setLocation("/account-settings")} className="cursor-pointer">
                      <Settings className="mr-2 h-4 w-4" />
                      <span>Account Settings</span>
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuItem disabled>
              <History className="mr-2 h-4 w-4" />
              <span>History</span>
            </DropdownMenuItem>

            {currentUser?.role === "admin" && (
              <DropdownMenuItem onClick={() => setLocation("/settings")} className="cursor-pointer">
                <Settings className="mr-2 h-4 w-4" />
                <span>Settings</span>
              </DropdownMenuItem>
            )}
            
            <DropdownMenuSeparator />
            
            <DropdownMenuItem onClick={handleLogout} className="text-red-600 cursor-pointer">
              <LogOut className="mr-2 h-4 w-4" />
              <span>Logout</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
