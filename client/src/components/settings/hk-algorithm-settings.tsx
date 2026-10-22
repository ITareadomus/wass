import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import {
  HK_BUILTIN_PROFILES,
  HK_CONSTRAINT_FIELDS,
  HK_CONSTRAINT_PRESETS,
  nextCustomProfileId,
  sameHkConstraintSettings,
  type ConstraintMode,
  type HkConstraintSettings,
  type HkNamedProfile,
  type HkProfileLibrary,
} from "@shared/hk-constraint-settings";

const PRESET_DETAILS = Object.fromEntries(HK_BUILTIN_PROFILES.map((preset) => [preset.id, preset.detail]));

const MODE_LABELS: Array<{ id: ConstraintMode; label: string }> = [
  { id: "off", label: "Spento" },
  { id: "soft", label: "Preferibile" },
  { id: "hard", label: "Obbligatorio" },
];

function ModeSwitch({
  value,
  onChange,
}: {
  value: ConstraintMode;
  onChange: (mode: ConstraintMode) => void;
}) {
  return (
    <div className="inline-flex shrink-0 rounded-lg border bg-muted p-1" role="group">
      {MODE_LABELS.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm transition-colors",
            value === option.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function HkAlgorithmSettings({
  value,
  profiles,
  onChange,
}: {
  value: HkConstraintSettings;
  profiles: HkProfileLibrary;
  onChange: (next: { constraints: HkConstraintSettings; profiles: HkProfileLibrary }) => void;
}) {
  const groups = Array.from(new Set(HK_CONSTRAINT_FIELDS.map((field) => field.group)));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const stateRef = useRef({ value, profiles });
  stateRef.current = { value, profiles };
  const active = profiles.profiles.find((profile) => profile.id === profiles.activeId) ?? profiles.profiles[0];

  const publish = (constraints: HkConstraintSettings, library: HkProfileLibrary) => {
    stateRef.current = { value: constraints, profiles: library };
    onChange({ constraints, profiles: library });
  };

  const writeActive = (constraints: HkConstraintSettings) => {
    const current = stateRef.current.profiles;
    publish(constraints, {
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === current.activeId ? { ...profile, settings: constraints } : profile,
      ),
    });
  };

  const selectProfile = (profile: HkNamedProfile) => {
    setConfirmDeleteId(null);
    const current = stateRef.current.profiles;
    publish({ ...profile.settings }, { ...current, activeId: profile.id });
  };

  const startRename = (profile: HkNamedProfile) => {
    setConfirmDeleteId(null);
    setEditingId(profile.id);
    setDraftName(profile.name);
  };

  const commitRename = (profile: HkNamedProfile) => {
    const name = draftName.trim().slice(0, 40);
    setEditingId(null);
    if (!name || name === profile.name) return;
    const current = stateRef.current;
    publish(current.value, {
      ...current.profiles,
      profiles: current.profiles.profiles.map((item) => (item.id === profile.id ? { ...item, name } : item)),
    });
  };

  const addProfile = () => {
    const current = stateRef.current;
    if (current.profiles.profiles.length >= 12) return;
    const id = nextCustomProfileId(current.profiles.profiles);
    const created: HkNamedProfile = {
      id,
      name: "Nuovo profilo",
      builtin: null,
      settings: { ...current.value },
    };
    publish(current.value, { activeId: id, profiles: [...current.profiles.profiles, created] });
    setEditingId(id);
    setDraftName(created.name);
    setConfirmDeleteId(null);
  };

  const deleteProfile = (profile: HkNamedProfile) => {
    if (profile.builtin) return;
    const current = stateRef.current;
    const remaining = current.profiles.profiles.filter((item) => item.id !== profile.id);
    const nextActive = current.profiles.activeId === profile.id ? remaining[0]?.id ?? "balanced" : current.profiles.activeId;
    const next = remaining.find((item) => item.id === nextActive);
    publish(next ? { ...next.settings } : current.value, { activeId: nextActive, profiles: remaining });
    setConfirmDeleteId(null);
    setEditingId(null);
  };

  const setMode = (id: keyof HkConstraintSettings, mode: ConstraintMode) => {
    writeActive({ ...stateRef.current.value, [id]: mode });
  };

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Profili</h2>
          <p className="text-sm text-muted-foreground">
            Aggiungi un profilo, cambiane il nome e regola gli switch. Dopo Salva, l'assegnazione li confronta tutti in timeline.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {profiles.profiles.map((profile) => {
            const selected = profile.id === active?.id;
            const editing = editingId === profile.id;
            return (
              <div
                key={profile.id}
                className={cn(
                  "rounded-xl border p-4 text-left transition-colors",
                  selected ? "border-primary bg-primary/5" : "hover:bg-muted/60",
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  {editing ? (
                    <input
                      autoFocus
                      aria-label="Nome del profilo"
                      value={draftName}
                      maxLength={40}
                      onChange={(event) => setDraftName(event.target.value)}
                      onBlur={() => commitRename(profile)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitRename(profile);
                        }
                        if (event.key === "Escape") setEditingId(null);
                      }}
                      className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm font-medium"
                    />
                  ) : (
                    <button type="button" onClick={() => selectProfile(profile)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate font-medium">{profile.name}</span>
                    </button>
                  )}
                  <div className="flex shrink-0 items-center">
                    <button
                      type="button"
                      aria-label={editing ? "Conferma nome" : `Rinomina ${profile.name}`}
                      onMouseDown={(event) => {
                        if (editing) event.preventDefault();
                      }}
                      onClick={() => (editing ? commitRename(profile) : startRename(profile))}
                      className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                    </button>
                    {profile.builtin ? null : confirmDeleteId === profile.id ? (
                      <button
                        type="button"
                        onClick={() => deleteProfile(profile)}
                        className="rounded-md px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        Elimina
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Elimina ${profile.name}`}
                        onClick={() => setConfirmDeleteId(profile.id)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
                <button type="button" onClick={() => selectProfile(profile)} className="mt-1 w-full text-left">
                  <p className="text-sm text-muted-foreground">
                    {profile.builtin && sameHkConstraintSettings(profile.settings, HK_CONSTRAINT_PRESETS[profile.builtin])
                      ? PRESET_DETAILS[profile.builtin]
                      : profile.builtin
                        ? "Parte da un profilo di base, con switch modificati."
                        : "Profilo creato da te."}
                  </p>
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addProfile}
            disabled={profiles.profiles.length >= 12}
            className="flex min-h-24 items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-sm font-medium text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Aggiungi profilo
          </button>
        </div>
      </div>

      {groups.map((group) => (
        <section key={group} className="space-y-3">
          <h2 className="text-lg font-semibold">{group}</h2>
          <div className="divide-y rounded-xl border">
            {HK_CONSTRAINT_FIELDS.filter((field) => field.group === group).map((field) => {
              const mode = value[field.id] as ConstraintMode;
              return (
                <div key={field.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="max-w-xl">
                    <div className="font-medium">{field.title}</div>
                    <p className="text-sm text-muted-foreground">{field.detail}</p>
                  </div>
                  <ModeSwitch value={mode} onChange={(next) => setMode(field.id, next)} />
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Pesi, quando il vincolo è preferibile</h2>
        <div className="grid gap-4 rounded-xl border p-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="triade-bonus">Peso dello stesso livello</Label>
            <Input
              id="triade-bonus"
              type="number"
              min={0}
              disabled={value.triadeMatch !== "soft"}
              value={value.triadeMatchBonus}
              onChange={(event) =>
                writeActive({ ...value, triadeMatchBonus: Number(event.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="triade-over">Penalità se il cleaner è sopra il livello</Label>
            <Input
              id="triade-over"
              type="number"
              min={0}
              disabled={value.triadeMatch !== "soft"}
              value={value.triadeOverqualPenalty}
              onChange={(event) =>
                writeActive({ ...value, triadeOverqualPenalty: Number(event.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phase4-bonus">Peso livello nel recupero dei task rimasti</Label>
            <Input
              id="phase4-bonus"
              type="number"
              min={0}
              disabled={value.triadeMatch !== "soft"}
              value={value.phase4LevelBonus}
              onChange={(event) =>
                writeActive({ ...value, phase4LevelBonus: Number(event.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="phase4-over">Penalità di livello nel recupero</Label>
            <Input
              id="phase4-over"
              type="number"
              min={0}
              disabled={value.triadeMatch !== "soft"}
              value={value.phase4OverqualPenalty}
              onChange={(event) =>
                writeActive({ ...value, phase4OverqualPenalty: Number(event.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="travel-weight">Peso del viaggio</Label>
            <Input
              id="travel-weight"
              type="number"
              min={0}
              step={0.5}
              disabled={value.travel !== "soft"}
              value={value.travelWeight}
              onChange={(event) =>
                writeActive({ ...value, travelWeight: Number(event.target.value) || 0 })
              }
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="travel-hard">Minuti massimi di viaggio, se i giri sono obbligatori</Label>
            <Input
              id="travel-hard"
              type="number"
              min={5}
              disabled={value.travel !== "hard"}
              value={value.travelHardMaxMin}
              onChange={(event) =>
                writeActive({ ...value, travelHardMaxMin: Number(event.target.value) || 45 })
              }
            />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Dopo la prima assegnazione</h2>
        <div className="divide-y rounded-xl border">
          <label className="flex items-center justify-between gap-4 p-4">
            <span>
              <span className="block font-medium">Accorcia i giri</span>
              <span className="text-sm text-muted-foreground">
                Sposta task normali tra cleaner se il viaggio totale scende.
              </span>
            </span>
            <Switch
              checked={value.shortenRoutes}
              onCheckedChange={(checked) => writeActive({ ...value, shortenRoutes: checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-4 p-4">
            <span>
              <span className="block font-medium">Ribilancia i carichi</span>
              <span className="text-sm text-muted-foreground">
                Sposta lavoro dai cleaner troppo pieni a quelli troppo vuoti.
              </span>
            </span>
            <Switch
              checked={value.rebalanceLoads}
              onCheckedChange={(checked) => writeActive({ ...value, rebalanceLoads: checked })}
            />
          </label>
          <label className="flex items-center justify-between gap-4 p-4">
            <span>
              <span className="block font-medium">Scambia per far entrare un livello più alto</span>
              <span className="text-sm text-muted-foreground">
                Un task di triade più alta può prendere il posto di uno più basso sullo stesso cleaner.
              </span>
            </span>
            <Switch
              checked={value.triadSwap}
              onCheckedChange={(checked) => writeActive({ ...value, triadSwap: checked })}
            />
          </label>
        </div>
      </section>

      <p className="text-sm text-muted-foreground">
        Obbligatorio blocca l'assegnazione. Preferibile la fa costare, ma il task viene comunque messo se altrimenti resterebbe fuori. Spento ignora la regola.
        {active ? ` Il profilo aperto è ${active.name}.` : ""}
      </p>
    </div>
  );
}
