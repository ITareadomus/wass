import { useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
                  <div className="flex flex-wrap items-center gap-3">
                    {field.id === "travel" && (
                      <div className="flex items-center gap-2">
                        <Label htmlFor="travel-hard-max" className="whitespace-nowrap text-sm">
                          Massimo
                        </Label>
                        <Input
                          id="travel-hard-max"
                          type="number"
                          min={5}
                          max={180}
                          step={5}
                          disabled={value.travel === "off"}
                          value={value.travelHardMaxMin}
                          className="w-24"
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            if (!Number.isFinite(next)) return;
                            writeActive({
                              ...value,
                              travelHardMaxMin: Math.min(180, Math.max(5, Math.round(next))),
                            });
                          }}
                        />
                        <span className="text-sm text-muted-foreground">min</span>
                      </div>
                    )}
                    <ModeSwitch value={mode} onChange={(next) => setMode(field.id, next)} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}

      <p className="text-sm text-muted-foreground">
        Obbligatorio evita quell'abbinamento finché c'è un'altra scelta. Preferibile lo fa pesare. Spento lo ignora. Ogni cleaner resta entro 4 task; un quinto entra solo se con 4 i task non ci stanno tutti. Se i posti bastano, ogni task viene assegnato.
        {active ? ` Il profilo aperto è ${active.name}.` : ""}
      </p>
    </div>
  );
}
