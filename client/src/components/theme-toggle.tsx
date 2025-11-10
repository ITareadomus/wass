
import { Moon, Sun, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";

export function ThemeToggle() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [isDark, setIsDark] = useState(false);

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

  const user = localStorage.getItem("user");

  return (
    <div className="flex items-center gap-2">
      {user && (
        <Button
          variant="outline"
          size="icon"
          onClick={handleLogout}
          className="rounded-full bg-red-500 hover:bg-red-600 text-white border-red-600"
        >
          <LogOut className="h-5 w-5" />
        </Button>
      )}
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
    </div>
  );
}
