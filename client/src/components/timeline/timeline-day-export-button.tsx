import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { getStoredUser, getStoredUserRole } from "@/lib/auth-role";

export function TimelineDayExportButton({ workDate }: { workDate: string }) {
  const { toast } = useToast();
  const [downloading, setDownloading] = useState(false);
  if (getStoredUserRole() !== "admin") return null;

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const username = getStoredUser()?.username ?? "";
      const response = await fetch(`/api/day-export.sql?date=${encodeURIComponent(workDate)}`, {
        headers: { "x-wass-username": username },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Download non riuscito");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `wass-giornata-${workDate}.sql`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Download giornata",
        description: error instanceof Error ? error.message : "Download non riuscito",
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="border-2 border-custom-blue px-2"
      title="Scarica la query SQL di questa giornata, da importare nel database di sviluppo"
      aria-label="Scarica la giornata"
      disabled={downloading}
      onClick={() => void download()}
    >
      {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
    </Button>
  );
}
