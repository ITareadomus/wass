import { useEffect, useState } from "react";
import { HkAlgorithmSettings } from "@/components/settings/hk-algorithm-settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { getStoredUser } from "@/lib/auth-role";
import { parseHkConstraintSettings, parseHkProfileLibrary, type HkConstraintSettings, type HkProfileLibrary } from "@shared/hk-constraint-settings";
import { Loader2, SlidersHorizontal } from "lucide-react";

export function AlgTestAlgorithmSettingsButton() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [constraints, setConstraints] = useState<HkConstraintSettings | null>(null);
  const [profiles, setProfiles] = useState<HkProfileLibrary | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const username = getStoredUser()?.username ?? "";
        const response = await fetch("/api/hk-algorithm-settings", {
          headers: { "x-wass-username": username },
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || "Impostazioni non lette");
        if (cancelled) return;
        const library = parseHkProfileLibrary(data.hk_profiles, data.hk_constraints);
        const active = library.profiles.find((profile) => profile.id === library.activeId) ?? library.profiles[0];
        setProfiles(library);
        setConstraints(active ? { ...active.settings } : parseHkConstraintSettings(data.hk_constraints));
      } catch (error) {
        if (!cancelled) {
          toast({
            variant: "destructive",
            title: "Impostazioni algoritmo",
            description: error instanceof Error ? error.message : "Impostazioni non lette",
          });
          setOpen(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, toast]);

  const save = async () => {
    if (!constraints || !profiles) return;
    setSaving(true);
    try {
      const username = getStoredUser()?.username ?? "";
      const response = await fetch("/api/hk-algorithm-settings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wass-username": username,
        },
        body: JSON.stringify({ hk_constraints: constraints, hk_profiles: profiles }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) {
        throw new Error(data?.error || "Salvataggio non riuscito");
      }
      toast({ title: "Impostazioni algoritmo salvate" });
      setOpen(false);
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Impostazioni algoritmo",
        description: error instanceof Error ? error.message : "Salvataggio non riuscito",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="border-amber-400 bg-background"
        data-viewer-allow=""
        onClick={() => setOpen(true)}
      >
        <SlidersHorizontal className="mr-2 h-4 w-4" />
        Impostazioni algoritmo
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-4xl flex-col overflow-hidden" data-viewer-allow="">
          <DialogHeader>
            <DialogTitle>Impostazioni algoritmo</DialogTitle>
            <DialogDescription>
              Valgono per la prova e anche per Assegna sulla giornata vera. Il resto delle impostazioni di WASS resta com&apos;è.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto pr-1">
            {loading || !constraints || !profiles ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Carico le impostazioni
              </div>
            ) : (
              <HkAlgorithmSettings
                value={constraints}
                profiles={profiles}
                onChange={({ constraints: nextConstraints, profiles: nextProfiles }) => {
                  setConstraints(nextConstraints);
                  setProfiles(nextProfiles);
                }}
              />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Chiudi
            </Button>
            <Button type="button" onClick={() => void save()} disabled={saving || loading || !constraints} data-viewer-allow="">
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Salva
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
