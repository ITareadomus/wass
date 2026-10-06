import { useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlertCircle,
  ArrowDown,
  BarChart3,
  Calendar,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  Clock,
  HelpCircle,
  History,
  Lock,
  Map as MapIcon,
  RefreshCw,
  RotateCcw,
  Search,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Priority = "early_out" | "high_priority" | "low_priority";
type Tier = "standard" | "premium" | "straordinaria" | "altro";
type Execution = "idle" | "in_progress" | "done";
type KeyType = "classico" | "smart" | "kbox";
type AdamMode = "apt" | "assignments";

type TutorialTask = {
  id: string;
  name: string;
  alias: string;
  customerName: string;
  customerReference: string;
  address: string;
  aptCode: string;
  typeApt: string;
  keyType: KeyType;
  keyDetail: string;
  cleaningMinutes: number;
  checkoutDate: string;
  checkoutTime: string;
  checkinDate: string;
  checkinTime: string;
  intervention: string;
  interventionKey: string;
  tier: Tier;
  paxIn: number;
  paxOut: number;
  priority: Priority;
  confirmed: boolean;
  locked: boolean;
  collaborators: number;
  customerNote: string;
  sofabeds: string;
  execution: Execution;
  cleanerId: string | null;
  sequence: number;
  travelMinutes: number;
  duplicateGroup?: string;
  mapX: number;
  mapY: number;
};

type TutorialCleaner = {
  id: string;
  name: string;
  role: string;
  color: string;
  shiftMinutes: number;
};

type HistoryEntry = { id: string; at: string; label: string };

type GoalId =
  | "drag"
  | "reorder"
  | "between"
  | "back"
  | "details"
  | "search"
  | "wave"
  | "multi"
  | "shift";

const DEMO_DATE = "2026-10-05";
const DAY_START = 8 * 60 + 30;
const GOALS: { id: GoalId; label: string }[] = [
  { id: "drag", label: "Trascina una task da un container su un cleaner" },
  { id: "reorder", label: "Cambia l'ordine di due task sullo stesso cleaner" },
  { id: "between", label: "Sposta una task da un cleaner a un altro" },
  { id: "back", label: "Rimetti una task nel container" },
  { id: "details", label: "Apri una task e modifica durata, orario o pax" },
  { id: "search", label: "Cerca un codice, un indirizzo o un cliente" },
  { id: "wave", label: "Lancia Assegna su Early out, poi High, poi Low" },
  { id: "multi", label: "Seleziona più task e trascinale insieme" },
  { id: "shift", label: "Sposta di 30 minuti l'inizio del primo appartamento" },
];

const PRIORITIES: {
  key: Priority;
  title: string;
  short: string;
  icon: "clock" | "alert" | "down";
}[] = [
  { key: "early_out", title: "EARLY OUT", short: "EO", icon: "clock" },
  { key: "high_priority", title: "HIGH PRIORITY", short: "HP", icon: "alert" },
  { key: "low_priority", title: "LOW PRIORITY", short: "LP", icon: "down" },
];

const INTERVENTIONS: { key: string; label: string; tier: Tier }[] = [
  { key: "fermata", label: "Fermata", tier: "standard" },
  { key: "partenza", label: "Partenza", tier: "standard" },
  { key: "ripasso", label: "Ripasso", tier: "standard" },
  { key: "fermata-premium", label: "Fermata (premium)", tier: "premium" },
  { key: "straordinaria", label: "Pulizia straordinaria", tier: "straordinaria" },
  { key: "uffici", label: "Pulizia uffici/altro", tier: "altro" },
];

const STRIPE: Record<Tier, string> = {
  standard: "bg-green-500",
  premium: "bg-yellow-500",
  straordinaria: "bg-red-500",
  altro: "bg-gray-400",
};

const TIER_BADGE: Record<Tier, string> = {
  standard: "border-green-600 bg-green-500/20 text-green-800 dark:text-green-200",
  premium: "border-yellow-600 bg-yellow-500/30 text-yellow-800 dark:text-yellow-200",
  straordinaria: "border-red-500 bg-red-500/20 text-red-700 dark:text-red-300",
  altro: "border-gray-500 bg-gray-500/20 text-gray-700 dark:text-gray-300",
};

const KEY_LABEL: Record<KeyType, string> = {
  classico: "Chiave classica",
  smart: "Serratura smart",
  kbox: "Keybox",
};

function seedCleaners(): TutorialCleaner[] {
  return [
    { id: "giulia", name: "Giulia Rossi", role: "Premium", color: "#E6194B", shiftMinutes: 0 },
    { id: "marco", name: "Marco Bianchi", role: "Standard", color: "#3CB44B", shiftMinutes: 0 },
  ];
}

function extraCleaners(): TutorialCleaner[] {
  return [
    { id: "sara", name: "Sara Verdi", role: "Standard", color: "#4363D8", shiftMinutes: 0 },
    { id: "luca", name: "Luca Neri", role: "Premium", color: "#F58231", shiftMinutes: 0 },
  ];
}

function seedTasks(): TutorialTask[] {
  return [
    task({
      id: "eo-duomo",
      name: "18420",
      alias: "DUOMO",
      customerName: "Mario Rossi",
      customerReference: "ROSSI",
      address: "Via Torino 12, Milano",
      aptCode: "A-12",
      typeApt: "Bilocale",
      keyType: "classico",
      keyDetail: "Portineria, gancio 12",
      cleaningMinutes: 90,
      checkoutTime: "10:00",
      checkinTime: "15:00",
      intervention: "Partenza",
      interventionKey: "partenza",
      tier: "standard",
      paxIn: 2,
      paxOut: 2,
      priority: "early_out",
      customerNote: "Lasciare le chiavi sul tavolo in ingresso.",
      mapX: 46,
      mapY: 42,
    }),
    task({
      id: "eo-navigli",
      name: "18455",
      alias: "NAVIGLI",
      customerName: "Laura Bianchi",
      address: "Ripa di Porta Ticinese 8, Milano",
      aptCode: "B-3",
      typeApt: "Monolocale",
      keyType: "smart",
      keyDetail: "Codice 4821, scala B",
      cleaningMinutes: 60,
      checkoutTime: "09:30",
      checkinTime: "14:00",
      intervention: "Fermata (premium)",
      interventionKey: "fermata-premium",
      tier: "premium",
      paxIn: 1,
      paxOut: 2,
      priority: "early_out",
      collaborators: 2,
      customerNote: "Coppia in arrivo nel pomeriggio. Due cleaner: il tempo in timeline si dimezza.",
      sofabeds: "1 singolo",
      mapX: 28,
      mapY: 62,
    }),
    task({
      id: "eo-isola",
      name: "18501",
      alias: "ISOLA",
      customerName: "Famiglia Verdi",
      address: "Via Pastrengo 15, Milano",
      aptCode: "C-1",
      typeApt: "Trilocale",
      keyType: "kbox",
      keyDetail: "Cassetta sul cancello, codice 9077",
      cleaningMinutes: 120,
      checkoutTime: "11:00",
      checkinTime: "16:30",
      intervention: "Pulizia straordinaria",
      interventionKey: "straordinaria",
      tier: "straordinaria",
      paxIn: 4,
      paxOut: 3,
      priority: "early_out",
      confirmed: false,
      customerNote: "C'è un cane in casa. Non usare prodotti profumati.",
      sofabeds: "1 doppio",
      mapX: 58,
      mapY: 24,
    }),
    task({
      id: "eo-ba-1",
      name: "18580",
      alias: "BUENOS AIRES",
      customerName: "Hotel Demo",
      customerReference: "BA",
      address: "Corso Buenos Aires 40, Milano",
      aptCode: "D-9",
      typeApt: "Bilocale",
      keyType: "classico",
      keyDetail: "Reception",
      cleaningMinutes: 75,
      checkoutTime: "10:30",
      checkinTime: "15:30",
      intervention: "Partenza",
      interventionKey: "partenza",
      paxIn: 2,
      paxOut: 2,
      priority: "early_out",
      duplicateGroup: "ba",
      mapX: 70,
      mapY: 36,
    }),
    task({
      id: "eo-ba-2",
      name: "18581",
      alias: "BUENOS AIRES",
      customerName: "Hotel Demo",
      customerReference: "BA",
      address: "Corso Buenos Aires 40, Milano",
      aptCode: "D-9",
      typeApt: "Bilocale",
      keyType: "classico",
      keyDetail: "Reception",
      cleaningMinutes: 75,
      checkoutTime: "10:30",
      checkinTime: "15:30",
      intervention: "Ripasso",
      interventionKey: "ripasso",
      paxIn: 2,
      paxOut: 2,
      priority: "early_out",
      duplicateGroup: "ba",
      mapX: 74,
      mapY: 44,
    }),
    task({
      id: "hp-brera",
      name: "18610",
      alias: "BRERA",
      customerName: "Anna Colombo",
      address: "Via Fiori Chiari 6, Milano",
      aptCode: "E-2",
      typeApt: "Bilocale",
      keyType: "smart",
      keyDetail: "Codice 1104",
      cleaningMinutes: 75,
      checkoutTime: "12:00",
      checkinTime: "18:00",
      intervention: "Ripasso",
      interventionKey: "ripasso",
      paxIn: 3,
      paxOut: 2,
      priority: "high_priority",
      mapX: 40,
      mapY: 28,
    }),
    task({
      id: "hp-romana",
      name: "18640",
      alias: "PORTA ROMANA",
      customerName: "BNL Stay",
      customerReference: "BNL",
      address: "Corso Lodi 18, Milano",
      aptCode: "F-7",
      typeApt: "Monolocale",
      keyType: "kbox",
      keyDetail: "Codice 2208, interno cortile",
      cleaningMinutes: 45,
      checkoutTime: "13:30",
      checkinTime: "",
      intervention: "Fermata",
      interventionKey: "fermata",
      paxIn: 1,
      paxOut: 1,
      priority: "high_priority",
      customerNote: "Task corta: in timeline check-out e riferimento cliente compaiono passando il mouse.",
      mapX: 62,
      mapY: 70,
    }),
    task({
      id: "hp-ambrogio",
      name: "18488",
      alias: "SANT'AMBROGIO",
      customerName: "Giulia Fontana",
      address: "Via San Vittore 4, Milano",
      aptCode: "G-1",
      typeApt: "Trilocale",
      keyType: "classico",
      keyDetail: "In bacheca",
      cleaningMinutes: 80,
      checkoutTime: "11:00",
      checkinTime: "16:00",
      intervention: "Fermata (premium)",
      interventionKey: "fermata-premium",
      tier: "premium",
      paxIn: 2,
      paxOut: 3,
      priority: "high_priority",
      execution: "in_progress",
      cleanerId: "giulia",
      sequence: 1,
      mapX: 34,
      mapY: 48,
    }),
    task({
      id: "lp-loreto",
      name: "18702",
      alias: "LORETO",
      customerName: "Paolo Greco",
      address: "Piazza Buenos Aires 3, Milano",
      aptCode: "H-4",
      typeApt: "Bilocale",
      keyType: "smart",
      keyDetail: "Codice 6630",
      cleaningMinutes: 90,
      checkoutTime: "16:00",
      checkinDate: "2026-10-06",
      checkinTime: "10:00",
      intervention: "Fermata",
      interventionKey: "fermata",
      paxIn: 2,
      paxOut: 2,
      priority: "low_priority",
      customerNote: "Il check-in è il giorno dopo: in card l'orario diventa grigio con la data.",
      mapX: 78,
      mapY: 30,
    }),
    task({
      id: "lp-citylife",
      name: "18801",
      alias: "CITYLIFE",
      customerName: "Sara Conti",
      address: "Piazza Tre Torri 1, Milano",
      aptCode: "I-8",
      typeApt: "Attico",
      keyType: "kbox",
      keyDetail: "Codice 4410",
      cleaningMinutes: 70,
      checkoutTime: "15:00",
      checkinTime: "19:00",
      intervention: "Partenza",
      interventionKey: "partenza",
      paxIn: 2,
      paxOut: 2,
      priority: "low_priority",
      locked: true,
      execution: "done",
      cleanerId: "marco",
      sequence: 1,
      customerNote: "Task bloccata: il lucchetto impedisce di spostarla finché non la sblocchi dal dettaglio.",
      mapX: 18,
      mapY: 40,
    }),
    task({
      id: "lp-ufficio",
      name: "18910",
      alias: "UFFICIO CENTRO",
      customerName: "Studio Demo",
      address: "Via Dante 9, Milano",
      aptCode: "U-1",
      typeApt: "Ufficio",
      keyType: "classico",
      keyDetail: "Reception piano terra",
      cleaningMinutes: 60,
      checkoutTime: "17:00",
      checkinTime: "19:30",
      intervention: "Pulizia uffici/altro",
      interventionKey: "uffici",
      tier: "altro",
      paxIn: 0,
      paxOut: 0,
      priority: "low_priority",
      mapX: 48,
      mapY: 18,
    }),
  ];
}

function task(partial: Omit<TutorialTask, "checkoutDate" | "checkinDate" | "confirmed" | "locked" | "collaborators" | "customerNote" | "sofabeds" | "execution" | "cleanerId" | "sequence" | "travelMinutes" | "customerReference" | "tier"> & Partial<TutorialTask>): TutorialTask {
  return {
    customerReference: "",
    checkoutDate: DEMO_DATE,
    checkinDate: DEMO_DATE,
    tier: "standard",
    confirmed: true,
    locked: false,
    collaborators: 1,
    customerNote: "",
    sofabeds: "Nessuno",
    execution: "idle",
    cleanerId: null,
    sequence: 0,
    travelMinutes: 15,
    ...partial,
  };
}

function adamTask(): TutorialTask {
  return task({
    id: "adam-new",
    name: "19012",
    alias: "NUOVO ADAM",
    customerName: "Chiara Russo",
    address: "Via Padova 22, Milano",
    aptCode: "L-5",
    typeApt: "Bilocale",
    keyType: "smart",
    keyDetail: "Codice 1590",
    cleaningMinutes: 60,
    checkoutTime: "12:30",
    checkinTime: "17:00",
    intervention: "Partenza",
    interventionKey: "partenza",
    paxIn: 2,
    paxOut: 1,
    priority: "low_priority",
    customerNote: "Comparsa dopo la sync di prova.",
    mapX: 66,
    mapY: 52,
  });
}

function clock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function clockToMinutes(value: string): number | null {
  if (!value || !value.includes(":")) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}

function offDayLabel(date: string): string {
  if (!date || date === DEMO_DATE) return "";
  const [, month, day] = date.split("-");
  return `${day}/${month}`;
}

function workMinutes(item: TutorialTask): number {
  return Math.max(15, Math.round(item.cleaningMinutes / Math.max(1, item.collaborators)));
}

function formatDateTime(date: string, time: string): string {
  if (!date) return "non indicato";
  const [, month, day] = date.split("-");
  return `${day}/${month}/2026${time ? ` - ${time}` : ""}`;
}

function normalize(tasks: TutorialTask[]): TutorialTask[] {
  const byCleaner = new Map<string, TutorialTask[]>();
  for (const item of tasks) {
    if (!item.cleanerId) continue;
    const list = byCleaner.get(item.cleanerId) ?? [];
    list.push(item);
    byCleaner.set(item.cleanerId, list);
  }
  const sequence = new Map<string, number>();
  for (const list of byCleaner.values()) {
    list.sort((a, b) => a.sequence - b.sequence || a.name.localeCompare(b.name));
    list.forEach((item, index) => sequence.set(item.id, index + 1));
  }
  return tasks.map((item) =>
    item.cleanerId ? { ...item, sequence: sequence.get(item.id) ?? item.sequence } : item
  );
}

function moveTasks(
  tasks: TutorialTask[],
  ids: string[],
  target:
    | { type: "column"; priority: Priority }
    | { type: "cleaner"; cleanerId: string; beforeId: string | null }
): TutorialTask[] {
  const movable = new Set(tasks.filter((item) => ids.includes(item.id) && !item.locked).map((item) => item.id));
  const orderedIds = ids.filter((id) => movable.has(id));
  if (!orderedIds.length) return tasks;

  if (target.type === "column") {
    return normalize(
      tasks.map((item) =>
        orderedIds.includes(item.id)
          ? { ...item, cleanerId: null, sequence: 0, priority: target.priority }
          : item
      )
    );
  }

  const cleared = tasks.map((item) =>
    orderedIds.includes(item.id) ? { ...item, cleanerId: null, sequence: 0 } : item
  );
  const current = cleared
    .filter((item) => item.cleanerId === target.cleanerId)
    .sort((a, b) => a.sequence - b.sequence);
  const beforeIndex = target.beforeId ? current.findIndex((item) => item.id === target.beforeId) : current.length;
  const insertAt = beforeIndex < 0 ? current.length : beforeIndex;
  const merged = [
    ...current.slice(0, insertAt).map((item) => item.id),
    ...orderedIds,
    ...current.slice(insertAt).map((item) => item.id),
  ];
  const sequence = new Map(merged.map((id, index) => [id, index + 1]));
  return normalize(
    cleared.map((item) =>
      sequence.has(item.id)
        ? { ...item, cleanerId: target.cleanerId, sequence: sequence.get(item.id) ?? item.sequence }
        : item
    )
  );
}

function assignWave(
  tasks: TutorialTask[],
  cleanerIds: string[],
  priority: Priority
): { tasks: TutorialTask[]; moved: number } {
  if (!cleanerIds.length) return { tasks, moved: 0 };
  const pool = tasks.filter((item) => !item.cleanerId && item.priority === priority && !item.locked);
  let next = tasks;
  let moved = 0;
  for (const item of pool) {
    const loads = cleanerIds.map((id) => ({
      id,
      minutes: next
        .filter((candidate) => candidate.cleanerId === id)
        .reduce((sum, candidate) => sum + workMinutes(candidate), 0),
    }));
    loads.sort((a, b) => a.minutes - b.minutes);
    const cleanerId = loads[0]?.id;
    if (!cleanerId) break;
    const sequence = next.filter((candidate) => candidate.cleanerId === cleanerId).length + 1;
    next = next.map((candidate) =>
      candidate.id === item.id ? { ...candidate, cleanerId, sequence } : candidate
    );
    moved += 1;
  }
  return { tasks: normalize(next), moved };
}

type Scheduled = {
  task: TutorialTask;
  start: number;
  end: number;
  travel: number;
  wait: number;
};

function scheduleCleaner(items: TutorialTask[], shiftMinutes: number): Scheduled[] {
  const ordered = [...items].sort((a, b) => a.sequence - b.sequence);
  let cursor = DAY_START + shiftMinutes;
  return ordered.map((item, index) => {
    const travel = index === 0 ? 0 : item.travelMinutes;
    const arrival = cursor + travel;
    const checkout = clockToMinutes(item.checkoutTime);
    const sameDayCheckout = item.checkoutDate === DEMO_DATE || !item.checkoutDate;
    const wait = sameDayCheckout && checkout != null && checkout > arrival ? checkout - arrival : 0;
    const start = arrival + wait;
    const end = start + workMinutes(item);
    cursor = end;
    return { task: item, start, end, travel, wait };
  });
}

function matchesQuery(item: TutorialTask, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return [
    item.name,
    item.alias,
    item.address,
    item.customerName,
    item.customerReference,
    item.aptCode,
  ].some((value) => value.toLowerCase().includes(needle));
}

const tutorialCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return closestCenter(args);
  const removeHits = hits.filter((hit) => hit.id === "remove");
  const slots = hits.filter((hit) => String(hit.id).startsWith("slot:"));
  const pool = removeHits.length ? removeHits : slots.length ? slots : hits;
  const containers = args.droppableContainers.filter((container) =>
    pool.some((hit) => hit.id === container.id)
  );
  const ranked = closestCenter({ ...args, droppableContainers: containers });
  return ranked.length ? ranked : pool;
};

function CardFace({
  item,
  timeline,
  highlighted,
  muted,
  selectedOrder,
  multi,
  overlay,
  insertHint,
}: {
  item: TutorialTask;
  timeline?: boolean;
  highlighted?: boolean;
  muted?: boolean;
  selectedOrder?: number;
  multi?: boolean;
  overlay?: boolean;
  insertHint?: boolean;
}) {
  const checkoutOff = offDayLabel(item.checkoutDate);
  const checkinOff = offDayLabel(item.checkinDate);
  const surface =
    item.execution === "in_progress"
      ? "bg-sky-100 dark:bg-sky-950"
      : item.execution === "done"
        ? "bg-emerald-100 dark:bg-emerald-950"
        : "bg-card";

  return (
    <div
      data-testid={`tutorial-task-${item.name}`}
      className={cn(
        "relative flex h-10 min-w-[148px] items-center rounded-md border bg-card px-2 text-left shadow-sm",
        timeline ? "w-full" : "w-max max-w-full",
        surface,
        highlighted && "task-border-search-highlighted",
        muted && "opacity-40",
        insertHint && "ring-2 ring-custom-blue",
        overlay && "shadow-lg",
        item.locked && "cursor-default"
      )}
    >
      <span className={cn("absolute bottom-[2px] left-[2px] top-[2px] w-1.5 rounded-sm", STRIPE[item.tier])} />
      {multi && !timeline && (
        <span
          className={cn(
            "absolute -left-1 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border-2 text-[10px] font-bold",
            selectedOrder
              ? "border-sky-700 bg-sky-600 text-white"
              : "border-sky-600 bg-background text-sky-600"
          )}
        >
          {selectedOrder || ""}
        </span>
      )}
      {!item.confirmed && !item.locked && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-gray-700/80 bg-gray-900/75 text-white">
          <HelpCircle className="h-3 w-3" />
        </span>
      )}
      {item.locked && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-gray-700 bg-gray-600 text-white">
          <Lock className="h-2.5 w-2.5" />
        </span>
      )}
      {timeline && item.sequence > 0 && (
        <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-bold text-white">
          {item.sequence}
        </span>
      )}
      <div className="min-w-0 flex-1 pl-2">
        <div className="flex items-center gap-1">
          <span className="text-[13px] font-extrabold leading-none">{item.name}</span>
          {item.customerReference && (
            <span className="whitespace-nowrap text-[11px] font-bold text-red-600 dark:text-red-400">
              ({item.customerReference})
            </span>
          )}
          {item.collaborators > 1 && (
            <Badge className="h-3.5 bg-purple-500 px-0.5 py-0 text-[10px] hover:bg-purple-500">👥</Badge>
          )}
        </div>
        <span className="block text-[9px] font-semibold leading-none opacity-80">
          {item.alias} ({item.typeApt})
        </span>
      </div>
      <div className="ml-2 flex shrink-0 flex-col items-end gap-0.5">
        {item.checkoutTime && (
          <span className={cn("text-[11px] font-bold leading-none", checkoutOff ? "text-gray-500" : "text-[#137537]")}>
            <span className="mr-0.5">{checkoutOff ? "↑" : "↑"}</span>
            {item.checkoutTime}
            {checkoutOff ? ` ${checkoutOff}` : ""}
          </span>
        )}
        {item.checkinTime && (
          <span className={cn("text-[11px] font-bold leading-none", checkinOff ? "text-gray-500" : "text-red-600")}>
            ↓ {item.checkinTime}
            {checkinOff ? ` ${checkinOff}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function PracticeCard({
  item,
  timeline,
  highlighted,
  muted,
  selectedOrder,
  multi,
  dayLocked,
  didDrag,
  onOpen,
  onToggle,
  tourId,
}: {
  item: TutorialTask;
  timeline?: boolean;
  highlighted: boolean;
  muted: boolean;
  selectedOrder?: number;
  multi: boolean;
  dayLocked: boolean;
  didDrag: MutableRefObject<boolean>;
  onOpen: () => void;
  onToggle: () => void;
  tourId?: string;
}) {
  const disabled = item.locked || dayLocked;
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: `task:${item.id}`,
    disabled,
    data: { taskId: item.id },
  });
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `slot:${item.id}`,
    disabled: dayLocked,
  });

  return (
    <div
      ref={(node) => {
        setDragRef(node);
        setDropRef(node);
      }}
      {...listeners}
      {...attributes}
      data-tour={tourId}
      className={cn(timeline ? "relative w-full" : "relative", isDragging && "opacity-40", !disabled && "cursor-grab active:cursor-grabbing")}
      onClick={() => {
        if (didDrag.current) return;
        onOpen();
      }}
    >
      {multi && !timeline && (
        <button
          type="button"
          className="absolute -left-1 -top-1.5 z-20 h-4 w-4"
          aria-label={`Seleziona task ${item.name}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        />
      )}
      <CardFace
        item={item}
        timeline={timeline}
        highlighted={highlighted}
        muted={muted}
        selectedOrder={selectedOrder}
        multi={multi}
        insertHint={isOver}
      />
    </div>
  );
}

export function HousekeepingPractice({
  tour = false,
  spotlight = "",
}: {
  tour?: boolean;
  spotlight?: string;
}) {
  const [tasks, setTasks] = useState<TutorialTask[]>(() => seedTasks());
  const [cleaners, setCleaners] = useState<TutorialCleaner[]>(() => seedCleaners());
  const [search, setSearch] = useState("");
  const [containersOpen, setContainersOpen] = useState(true);
  const [multiPriority, setMultiPriority] = useState<Priority | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showColors, setShowColors] = useState(true);
  const [operational, setOperational] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([
    { id: "seed", at: "09:00", label: "Prova caricata con task di esempio" },
  ]);
  const [adamDot, setAdamDot] = useState(true);
  const [adamOpen, setAdamOpen] = useState(false);
  const [adamMode, setAdamMode] = useState<AdamMode>("apt");
  const [transferOpen, setTransferOpen] = useState(false);
  const [lastTransfer, setLastTransfer] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removeSelection, setRemoveSelection] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [convocazioniOpen, setConvocazioniOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [coach, setCoach] = useState("Trascina una card colorata su un cleaner, oppure premi Assegna dentro Early out.");
  const [goals, setGoals] = useState<Set<GoalId>>(() => new Set());
  const [wavesUsed, setWavesUsed] = useState<Set<Priority>>(() => new Set());
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const didDrag = useRef(false);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const dayLocked = operational;
  const detail = tasks.find((item) => item.id === detailId) ?? null;
  const activeTask = tasks.find((item) => item.id === activeTaskId) ?? null;
  const searching = search.trim().length > 0;

  useEffect(() => {
    if (!tour) return;
    const needsContainers = ["eo", "duplicate", "multi", "task", "hp", "lp"].includes(spotlight);
    if (needsContainers) setContainersOpen(true);
  }, [tour, spotlight]);

  const hasEo = tasks.some((item) => item.priority === "early_out" && item.cleanerId);
  const hasHp = tasks.some((item) => item.priority === "high_priority" && item.cleanerId);

  const complete = (id: GoalId) => {
    setGoals((current) => {
      if (current.has(id)) return current;
      const next = new Set(current);
      next.add(id);
      return next;
    });
  };

  const pushHistory = (label: string) => {
    setHistory((current) => [{ id: `${Date.now()}`, at: nowLabel(), label }, ...current].slice(0, 40));
    setCoach(label);
  };

  const noteMove = (prev: TutorialTask[], next: TutorialTask[], ids: string[]) => {
    if (ids.length > 1) complete("multi");
    for (const id of ids) {
      const before = prev.find((item) => item.id === id);
      const after = next.find((item) => item.id === id);
      if (!before || !after) continue;
      if (!before.cleanerId && after.cleanerId) complete("drag");
      if (before.cleanerId && after.cleanerId && before.cleanerId !== after.cleanerId) complete("between");
      if (before.cleanerId && !after.cleanerId) complete("back");
      if (before.cleanerId && before.cleanerId === after.cleanerId && before.sequence !== after.sequence) {
        complete("reorder");
      }
    }
  };

  const commitMove = (next: TutorialTask[], ids: string[], label: string) => {
    noteMove(tasks, next, ids);
    setTasks(next);
    setSelectedIds([]);
    pushHistory(label);
  };

  const handleDragStart = (event: DragStartEvent) => {
    didDrag.current = true;
    const taskId = String(event.active.id).replace(/^task:/, "");
    setActiveTaskId(taskId);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const taskId = String(event.active.id).replace(/^task:/, "");
    const overId = event.over ? String(event.over.id) : "";
    const current = tasks.find((item) => item.id === taskId);
    setActiveTaskId(null);
    requestAnimationFrame(() => {
      didDrag.current = false;
    });
    if (!current || current.locked || dayLocked) return;

    const grouped =
      multiPriority === current.priority && selectedIds.includes(taskId)
        ? selectedIds.filter((id) => tasks.some((item) => item.id === id && !item.locked))
        : [taskId];
    const ids = grouped.includes(taskId) ? grouped : [taskId, ...grouped];

    if (!overId || overId === `task:${taskId}` || overId === `slot:${taskId}` || ids.includes(overId.replace(/^slot:/, ""))) {
      return;
    }

    if (overId === "remove") {
      if (!current.cleanerId) return;
      commitMove(
        moveTasks(tasks, ids, { type: "column", priority: current.priority }),
        ids,
        ids.length > 1
          ? `${ids.length} task rimesse nel container, nell'ordine in cui le hai numerate`
          : `${current.name} è tornata nel container ${labelFor(current.priority)}`
      );
      return;
    }

    if (overId.startsWith("col:")) {
      const priority = overId.slice(4) as Priority;
      commitMove(
        moveTasks(tasks, ids, { type: "column", priority }),
        ids,
        `${ids.length > 1 ? `${ids.length} task` : current.name} spostata in ${labelFor(priority)}`
      );
      return;
    }

    if (overId.startsWith("slot:")) {
      const target = tasks.find((item) => item.id === overId.slice(5));
      if (!target || ids.includes(target.id)) return;
      if (target.cleanerId) {
        commitMove(
          moveTasks(tasks, ids, { type: "cleaner", cleanerId: target.cleanerId, beforeId: target.id }),
          ids,
          `Inserita prima di ${target.name}`
        );
      } else {
        commitMove(
          moveTasks(tasks, ids, { type: "column", priority: target.priority }),
          ids,
          `Spostata nel container ${labelFor(target.priority)}`
        );
      }
      return;
    }

    if (overId.startsWith("cleaner:")) {
      const cleanerId = overId.slice(8);
      const cleaner = cleaners.find((item) => item.id === cleanerId);
      commitMove(
        moveTasks(tasks, ids, { type: "cleaner", cleanerId, beforeId: null }),
        ids,
        `Aggiunta in coda a ${cleaner?.name ?? "cleaner"}`
      );
    }
  };

  const runWave = (priority: Priority) => {
    const result = assignWave(tasks, cleaners.map((item) => item.id), priority);
    if (!result.moved) {
      setCoach(`${labelFor(priority)} non ha task libere da assegnare. Quelle bloccate restano ferme.`);
      return;
    }
    noteMove(tasks, result.tasks, result.tasks.filter((item) => item.priority === priority).map((item) => item.id));
    setTasks(result.tasks);
    const used = new Set(wavesUsed);
    used.add(priority);
    setWavesUsed(used);
    if (used.has("early_out") && used.has("high_priority") && used.has("low_priority")) complete("wave");
    pushHistory(
      `Assegnate ${result.moved} task ${labelFor(priority)}. In produzione lo fa l'ottimizzatore, rispettando lo stesso ordine EO, HP, LP.`
    );
  };

  const runAll = () => {
    let next = tasks;
    let moved = 0;
    const used = new Set(wavesUsed);
    const first = assignWave(next, cleaners.map((item) => item.id), "early_out");
    next = first.tasks;
    moved += first.moved;
    if (first.moved) used.add("early_out");
    if (next.some((item) => item.priority === "early_out" && item.cleanerId)) {
      const second = assignWave(next, cleaners.map((item) => item.id), "high_priority");
      next = second.tasks;
      moved += second.moved;
      if (second.moved) used.add("high_priority");
    }
    if (
      next.some((item) => item.priority === "early_out" && item.cleanerId) &&
      next.some((item) => item.priority === "high_priority" && item.cleanerId)
    ) {
      const third = assignWave(next, cleaners.map((item) => item.id), "low_priority");
      next = third.tasks;
      moved += third.moved;
      if (third.moved) used.add("low_priority");
    }
    noteMove(tasks, next, next.map((item) => item.id));
    setTasks(next);
    setWavesUsed(used);
    if (used.has("early_out") && used.has("high_priority") && used.has("low_priority")) complete("wave");
    pushHistory(
      moved
        ? `Assegna ha distribuito ${moved} task sui cleaner, partendo dalle Early out.`
        : "Non c'erano task libere da assegnare."
    );
  };

  const applyAdam = () => {
    setAdamOpen(false);
    setAdamDot(false);
    setTasks((current) => {
      let next = current.map((item) =>
        item.id === "eo-duomo"
          ? { ...item, checkoutTime: item.checkoutTime === "10:00" ? "10:30" : "10:15" }
          : item
      );
      if (!next.some((item) => item.id === "adam-new")) next = [...next, adamTask()];
      if (adamMode === "assignments") {
        const cleanerId = cleaners[0]?.id;
        if (cleanerId) {
          next = normalize(
            next.map((item) =>
              item.id === "adam-new" ? { ...item, cleanerId, sequence: 50 } : item
            )
          );
        }
      }
      return next;
    });
    pushHistory(
      adamMode === "apt"
        ? "Sync appartamenti: aggiornato il check-out di 18420 ed aggiunta la task 19012. In produzione i container vengono rigenerati da ADAM."
        : "Sync completa: aggiornati i dati e riallineata anche un'assegnazione. In produzione sovrascrive le modifiche WASS non ancora trasferite."
    );
  };

  const stats = useMemo(() => {
    const count = (tier: Tier) => tasks.filter((item) => item.tier === tier).length;
    return {
      total: tasks.length,
      locked: tasks.filter((item) => item.locked).length,
      unassigned: tasks.filter((item) => !item.cleanerId).length,
      standard: count("standard"),
      premium: count("premium"),
      straordinarie: count("straordinaria"),
      altro: count("altro"),
    };
  }, [tasks]);

  const scale = useMemo(() => {
    let end = 18 * 60;
    for (const cleaner of cleaners) {
      const scheduled = scheduleCleaner(
        tasks.filter((item) => item.cleanerId === cleaner.id),
        cleaner.shiftMinutes
      );
      const last = scheduled[scheduled.length - 1];
      if (last) end = Math.max(end, last.end + 30);
    }
    return { start: 8 * 60, end };
  }, [tasks, cleaners]);

  const hours = Array.from({ length: Math.ceil((scale.end - scale.start) / 60) + 1 }, (_, index) => scale.start + index * 60);

  const detailSchedule = useMemo(() => {
    if (!detail?.cleanerId) return null;
    const cleaner = cleaners.find((item) => item.id === detail.cleanerId);
    if (!cleaner) return null;
    return (
      scheduleCleaner(
        tasks.filter((item) => item.cleanerId === cleaner.id),
        cleaner.shiftMinutes
      ).find((item) => item.task.id === detail.id) ?? null
    );
  }, [detail, cleaners, tasks]);

  const updateDetail = (patch: Partial<TutorialTask>, label: string) => {
    if (!detail) return;
    setTasks((current) => current.map((item) => (item.id === detail.id ? { ...item, ...patch } : item)));
    complete("details");
    pushHistory(label);
  };

  const availableCleaners = extraCleaners().filter((item) => !cleaners.some((current) => current.id === item.id));

  return (
    <div data-testid="tutorial-practice" className="space-y-4">
      {!tour && (
        <div className="flex items-center gap-2">
          {GOALS.map((goal) => (
            <span
              key={goal.id}
              title={goal.label}
              className={cn(
                "h-2.5 w-2.5 rounded-full border",
                goals.has(goal.id)
                  ? "border-green-700 bg-green-500"
                  : "border-custom-blue bg-background"
              )}
            />
          ))}
          <span className="text-sm font-semibold tabular-nums text-custom-blue">
            {goals.size}/{GOALS.length}
          </span>
        </div>
        <p className="min-w-0 flex-1 text-sm text-foreground">
          {GOALS.find((goal) => !goals.has(goal.id))?.label ?? "Hai provato tutti i gesti di questa giornata finta."}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-2 border-custom-blue bg-background"
          onClick={() => {
            setTasks(seedTasks());
            setCleaners(seedCleaners());
            setSearch("");
            setSelectedIds([]);
            setMultiPriority(null);
            setOperational(false);
            setAdamDot(true);
            setLastTransfer(null);
            setWavesUsed(new Set());
            pushHistory("Prova riportata all'esempio iniziale.");
          }}
        >
          <RotateCcw className="h-4 w-4" />
          Ricomincia la prova
        </Button>
      </div>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={tutorialCollision}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={() => {
          setActiveTaskId(null);
          requestAnimationFrame(() => {
            didDrag.current = false;
          });
        }}
      >
        <div className="flex items-center gap-3" data-tour="search-row">
          <div className="relative flex-1" data-tour="search">
            <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-custom-blue" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                if (event.target.value.trim().length >= 2) complete("search");
              }}
              placeholder="Cerca task..."
              className="border-2 border-custom-blue pl-10"
              data-testid="tutorial-search"
            />
          </div>
          <div className="flex shrink-0 items-center overflow-hidden rounded-md border-2 border-custom-blue bg-custom-blue">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-none px-3 text-black hover:bg-custom-blue/80 dark:text-white"
              onClick={() => setAdamOpen(true)}
              disabled={dayLocked}
              data-tour="sync"
            >
              <span className="relative mr-2 inline-flex">
                <RefreshCw className="h-4 w-4" />
                {adamDot && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500" />}
              </span>
              Sync from ADAM
            </Button>
            <div className="h-6 w-px bg-black/20 dark:bg-white/20" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-none px-3 text-black hover:bg-custom-blue/80 dark:text-white"
              disabled={dayLocked}
              onClick={runAll}
              data-tour="assign"
            >
              <Calendar className="mr-2 h-4 w-4" />
              Assegna
            </Button>
          </div>
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-t-lg border-2 border-b-0 border-custom-blue bg-custom-blue-light px-2.5 py-1 text-[12px] font-medium text-custom-blue"
            onClick={() => setContainersOpen((open) => !open)}
            data-tour="hide"
          >
            {containersOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {containersOpen ? "Nascondi containers" : "Apri i containers"}
          </button>
        </div>

        {containersOpen && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {PRIORITIES.map((column) => (
              <PriorityPracticeColumn
                key={column.key}
                column={column}
                tasks={tasks.filter((item) => item.priority === column.key && !item.cleanerId)}
                dayLocked={dayLocked}
                hasEo={hasEo}
                hasHp={hasHp}
                searching={searching}
                query={search}
                multi={multiPriority === column.key}
                selectedIds={selectedIds}
                didDrag={didDrag}
                showColors={showColors}
                onToggleMulti={() => {
                  setMultiPriority((current) => (current === column.key ? null : column.key));
                  setSelectedIds([]);
                }}
                onToggleTask={(taskId) => {
                  setSelectedIds((current) =>
                    current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId]
                  );
                }}
                onOpen={setDetailId}
                onAssign={() => runWave(column.key)}
              />
            ))}
          </div>
        )}

        <div className="relative mt-4 overflow-hidden rounded-lg border-2 border-custom-blue bg-custom-blue-light shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4">
            <div className="flex items-center gap-2" data-tour="timeline-title">
              <h3 className="flex items-center text-xl font-bold">
                <Calendar className="mr-2 h-5 w-5 text-custom-blue" />
                Timeline Housekeeping - {cleaners.length} Cleaners
              </h3>
              <Popover>
                <PopoverTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-600" aria-label="Info visualizzazione task brevi">
                    <AlertCircle className="h-4 w-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 text-sm leading-relaxed">
                  Sulle task corte check-out, check-in e codice cliente restano nascosti nella timeline vera. Passa il cursore sulla card per leggerli. Qui restano visibili così puoi impararli subito.
                </PopoverContent>
              </Popover>
            </div>
            <div className="flex flex-wrap items-center gap-2" data-tour="toolbar">
              <div className="flex items-center gap-2" data-tour="colors">
                <Label htmlFor="tutorial-colors" className="text-sm font-medium text-custom-blue">Colori stato</Label>
                <Switch id="tutorial-colors" checked={showColors} onCheckedChange={setShowColors} className="border-2 border-custom-blue data-[state=checked]:bg-[hsl(199,89%,48%)] data-[state=unchecked]:bg-sky-200" />
              </div>
              <Button type="button" variant="outline" size="sm" className="border-2 border-custom-blue" onClick={() => setHistoryOpen(true)}>
                <History className="h-4 w-4" />
                Storico
              </Button>
              <Button type="button" variant="outline" size="sm" className={cn("border-2 border-custom-blue", statsOpen && "bg-custom-blue-light")} onClick={() => setStatsOpen((open) => !open)}>
                <BarChart3 className="h-4 w-4" />
                Statistiche
              </Button>
              <Button type="button" variant="outline" size="sm" className={cn("border-2 border-custom-blue", mapOpen && "bg-custom-blue-light")} onClick={() => setMapOpen((open) => !open)}>
                <MapIcon className="h-4 w-4" />
                Mappa
              </Button>
              <Button type="button" variant="outline" size="sm" className="border-2 border-custom-blue" onClick={() => setConvocazioniOpen(true)}>
                <Users className="h-4 w-4" />
                Convocazioni
              </Button>
              <Button type="button" variant="outline" size="sm" className="border-2 border-custom-blue" disabled={dayLocked} onClick={() => setResetOpen(true)}>
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto px-2 py-3">
            <div className="min-w-[860px]">
              <div className="mb-1 flex h-8 items-end" data-tour="bands">
                <div className="w-48 shrink-0" />
                <div className="relative h-8 flex-1">
                  {(["EO", "HP", "LP"] as const).map((band, index) => (
                    <div key={band} className="absolute top-1 h-5 border-x border-t border-slate-500/50" style={{ left: `${index * 28}%`, width: index === 2 ? "44%" : "28%" }}>
                      <Badge className={cn("absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 border text-[10px] text-white", index === 0 ? "border-blue-700 bg-blue-500" : index === 1 ? "border-orange-700 bg-orange-500" : "border-gray-700 bg-gray-500")}>
                        {band}
                      </Badge>
                    </div>
                  ))}
                </div>
                <div className="w-24 shrink-0" />
              </div>
              <div className="flex h-8 items-center text-[13px] font-medium">
                <div className="flex w-48 shrink-0 justify-center">
                  <Button type="button" variant="ghost" size="sm" className="text-red-700 dark:text-red-400" disabled={dayLocked || cleaners.length === 0} onClick={() => { setRemoveSelection([]); setRemoveOpen(true); }} aria-label="Rimuovi cleaners convocati">
                    <UserMinus className="h-4 w-4" />
                  </Button>
                </div>
                <div className="relative h-8 flex-1">
                  {hours.map((minute) => (
                    <span key={minute} className="absolute -translate-x-1/2 tabular-nums" style={{ left: `${((minute - scale.start) / (scale.end - scale.start)) * 100}%` }}>
                      {clock(minute)}
                    </span>
                  ))}
                </div>
                <div className="w-24 shrink-0 text-center text-[13px]">Ore lavorate</div>
              </div>

              {cleaners.map((cleaner) => {
                const scheduled = scheduleCleaner(
                  tasks.filter((item) => item.cleanerId === cleaner.id),
                  cleaner.shiftMinutes
                );
                const worked = scheduled.reduce((sum, item) => sum + workMinutes(item.task), 0);
                return (
                  <CleanerPracticeRow
                    key={cleaner.id}
                    cleaner={cleaner}
                    scheduled={scheduled}
                    worked={worked}
                    scaleStart={scale.start}
                    scaleEnd={scale.end}
                    dayLocked={dayLocked}
                    searching={searching}
                    query={search}
                    showColors={showColors}
                    didDrag={didDrag}
                    onOpen={setDetailId}
                    tourRow={cleaner.id === "giulia"}
                    onShift={(delta) => {
                      setCleaners((current) =>
                        current.map((item) =>
                          item.id === cleaner.id
                            ? { ...item, shiftMinutes: Math.max(-60, Math.min(120, item.shiftMinutes + delta)) }
                            : item
                        )
                      );
                      complete("shift");
                      pushHistory(`Primo appartamento di ${cleaner.name} spostato di ${delta > 0 ? "+" : ""}${delta} minuti.`);
                    }}
                  />
                );
              })}

              <div className="mt-2 flex items-center justify-between gap-3" data-tour="footer">
                <Button type="button" variant="outline" size="sm" className="border-2 border-custom-blue" disabled={dayLocked || availableCleaners.length === 0} onClick={() => setAddOpen(true)}>
                  <UserPlus className="h-4 w-4" />
                  Aggiungi cleaner
                </Button>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="tutorial-operational" className="text-sm font-medium text-custom-blue">Inizio giornata operativa</Label>
                    <Switch
                      id="tutorial-operational"
                      checked={operational}
                      onCheckedChange={(checked) => {
                        setOperational(checked);
                        setCoach(
                          checked
                            ? "Giornata operativa iniziata: spostamenti, reset e sync sono bloccati. Si guarda l'avanzamento."
                            : "Giornata operativa chiusa: puoi di nuovo modificare la timeline."
                        );
                      }}
                    />
                  </div>
                  <Button type="button" variant="outline" size="sm" className="border-2 border-custom-blue" onClick={() => setTransferOpen(true)}>
                    Trasferisci su ADAM
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {lastTransfer ? `Salvato il ${lastTransfer}` : "Nessun trasferimento di prova"}
                  </span>
                </div>
              </div>
            </div>
          </div>
          {dayLocked && (
            <p className="border-t border-border px-4 py-2 text-sm text-muted-foreground">
              Modalità sola visualizzazione, come quando la giornata operativa è partita.
            </p>
          )}
        </div>

        {(statsOpen || mapOpen) && (
          <div className="grid gap-4 lg:grid-cols-2">
            {statsOpen && (
              <div className="rounded-lg border-2 border-custom-blue bg-card p-4">
                <p className="mb-3 font-semibold">Statistiche della prova</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label="Totale" value={`${stats.total}`} note={`/ ${stats.locked} bloccati`} />
                  <Stat label="Non assegnate" value={`${stats.unassigned}`} />
                  <Stat label="Standard" value={`${stats.standard}`} />
                  <Stat label="Premium" value={`${stats.premium}`} />
                  <Stat label="Straordinarie" value={`${stats.straordinarie}`} />
                  <Stat label="Altro" value={`${stats.altro}`} />
                </div>
              </div>
            )}
            {mapOpen && (
              <div className="rounded-lg border-2 border-custom-blue bg-card p-4">
                <p className="font-semibold">Mappa di prova</p>
                <p className="mb-3 text-sm text-muted-foreground">
                  Nella pagina vera è la mappa di Milano. Il click apre la task. Il doppio click sul cleaner, lì, filtra solo i suoi punti.
                </p>
                <div className="relative h-56 overflow-hidden rounded-md bg-[radial-gradient(circle_at_30%_40%,#dbeafe,transparent_40%),linear-gradient(#e2e8f0,#f8fafc)] dark:bg-[radial-gradient(circle_at_30%_40%,#1e3a8a,#0f172a)]">
                  {tasks.map((item) => {
                    const cleaner = cleaners.find((candidate) => candidate.id === item.cleanerId);
                    const highlighted = matchesQuery(item, search);
                    return (
                      <button
                        key={item.id}
                        type="button"
                        title={`${item.name} ${item.alias}`}
                        className={cn("absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow", highlighted && "h-5 w-5 ring-2 ring-amber-400")}
                        style={{ left: `${item.mapX}%`, top: `${item.mapY}%`, background: cleaner?.color ?? "#94a3b8" }}
                        onClick={() => setDetailId(item.id)}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {!tour && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-foreground" data-testid="tutorial-coach">
          {coach}
        </p>
        )}

        {activeTask?.cleanerId && !dayLocked && <RemovePracticeZone />}
        <DragOverlay>
          {activeTask ? <CardFace item={activeTask} overlay /> : null}
        </DragOverlay>
      </DndContext>

      {!tour && (
      <button
        type="button"
        className="text-sm font-medium text-custom-blue underline-offset-2 hover:underline"
        onClick={() => {
          setAdamDot(true);
          setCoach("Pallino rosso riacceso: in produzione compare quando ADAM ha novità rispetto all'ultima sync.");
        }}
      >
        Simula un nuovo aggiornamento ADAM
      </button>
      )}

      <Dialog open={detail != null} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2">
                  Dettagli Task #{detail.name}
                  <Badge className={cn("border", detail.priority === "early_out" ? "border-blue-700 bg-blue-500 text-white" : detail.priority === "high_priority" ? "border-orange-700 bg-orange-500 text-white" : "border-gray-700 bg-gray-500 text-white")}>
                    {detail.priority === "early_out" ? "EO" : detail.priority === "high_priority" ? "HP" : "LP"}
                  </Badge>
                  <Badge variant="outline" className={TIER_BADGE[detail.tier]}>{detail.tier}</Badge>
                </DialogTitle>
                <DialogDescription>
                  Esempio completo. I campi con la matita si possono modificare solo in questa prova.
                </DialogDescription>
              </DialogHeader>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Codice ADAM" value={detail.name} hint="È il numero grande sulla card. È la chiave con cui riconosci la task." />
                <Field label="Cliente" value={detail.customerName} hint="Nome ospite o società, arriva da ADAM." />
                <Field label="Riferimento cliente" value={detail.customerReference || "—"} hint="Se c'è, esce in rosso accanto al codice. Si cerca anche da qui." />
                <Field label="Indirizzo" value={detail.address} hint="Compare nel tooltip della card e come punto sulla mappa." />
                <Field label="Codice appartamento" value={detail.aptCode} hint="Codice interno della struttura." />
                <Field label="Alias e tipologia" value={`${detail.alias} (${detail.typeApt})`} hint="Seconda riga della card: il nome breve dell'appartamento." />
                <Field label="Accesso" value={`${KEY_LABEL[detail.keyType]} — ${detail.keyDetail}`} hint="Classica, smart o keybox. In pagina il campo apre il dettaglio chiavi." />
                <Field label="Divani letto" value={detail.sofabeds} hint="Lettura da ADAM, serve a stimare il lavoro extra." />
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Durata pulizia ✎</p>
                  <Input
                    type="number"
                    min={15}
                    max={480}
                    value={detail.cleaningMinutes}
                    className="mt-1"
                    onChange={(event) => {
                      const cleaningMinutes = Math.max(15, Math.min(480, Number(event.target.value) || 15));
                      updateDetail({ cleaningMinutes }, `Durata di ${detail.name} impostata a ${cleaningMinutes} minuti.`);
                    }}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Minuti dell'appartamento. Con {detail.collaborators} cleaner in timeline contano {workMinutes(detail)} minuti a persona.
                  </p>
                </div>
                <Field
                  label="Stato esecuzione"
                  value={detail.execution === "in_progress" ? "In corso" : detail.execution === "done" ? "Completata" : "Da iniziare"}
                  hint="Con Colori stato acceso, in corso è azzurro e completata è verde."
                />
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Check-out ✎</p>
                  <Input type="time" value={detail.checkoutTime} className="mt-1" onChange={(event) => updateDetail({ checkoutTime: event.target.value }, `Check-out di ${detail.name} alle ${event.target.value}.`)} />
                  <p className="mt-1 text-xs text-muted-foreground">Freccia verde verso l'alto sulla card. Se l'arrivo è prima, la timeline aspetta questo orario.</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Check-in ✎</p>
                  <Input type="time" value={detail.checkinTime} className="mt-1" onChange={(event) => updateDetail({ checkinTime: event.target.value }, `Check-in di ${detail.name} alle ${event.target.value}.`)} />
                  <p className="mt-1 text-xs text-muted-foreground">
                    Freccia rossa verso il basso. Data: {formatDateTime(detail.checkinDate, "")}. Se il giorno è diverso, l'orario in card è grigio.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <p className="text-sm font-semibold text-muted-foreground">Tipologia intervento ✎</p>
                  <Select
                    value={detail.interventionKey}
                    onValueChange={(value) => {
                      const chosen = INTERVENTIONS.find((item) => item.key === value);
                      if (!chosen) return;
                      updateDetail(
                        { interventionKey: chosen.key, intervention: chosen.label, tier: chosen.tier },
                        `${detail.name} ora è ${chosen.label}.`
                      );
                    }}
                  >
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {INTERVENTIONS.map((item) => (
                        <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-xs text-muted-foreground">La striscia colorata segue il tipo: verde standard, giallo premium, rosso straordinaria, grigio altro.</p>
                </div>
                <div>
                  <p className="text-sm font-semibold text-muted-foreground">Pax-in ✎</p>
                  <Input type="number" min={0} value={detail.paxIn} className="mt-1" onChange={(event) => updateDetail({ paxIn: Math.max(0, Number(event.target.value) || 0) }, `Pax-in di ${detail.name} aggiornato.`)} />
                  <p className="mt-1 text-xs text-muted-foreground">Ospiti in arrivo. Si può correggere quando ADAM non è allineato.</p>
                </div>
                <Field label="Pax-out" value={String(detail.paxOut)} hint="Ospiti in uscita. In pagina è solo lettura." />
                <Field label="Travel time" value={detail.sequence > 1 ? `${detail.travelMinutes} min` : "0 min sulla prima della sequenza"} hint="Minuti di spostamento prima della task, dal secondo appartamento in poi." />
                <Field
                  label="Inizio e fine pulizia"
                  value={detailSchedule ? `${clock(detailSchedule.start)} – ${clock(detailSchedule.end)}${detailSchedule.wait ? ` (attesa check-out ${detailSchedule.wait} min)` : ""}` : "Non assegnata"}
                  hint="WASS li calcola da ordine, travel, check-out e durata. Il primo appartamento parte dalle 08:30 più lo scarto che imposti sul cleaner."
                />
                <Field label="Assegnata a" value={cleaners.find((item) => item.id === detail.cleanerId)?.name ?? "Nessuno, è ancora nel container"} hint="Click sul nome in timeline apre il cleaner. Qui vedi a chi è finita la task." />
                <Field label="Sequenza" value={detail.cleanerId ? String(detail.sequence) : "—"} hint="Il numero in alto a destra sulla card in timeline. Trascinare sopra un'altra task cambia questo ordine." />
                <Field label="Nota cliente" value={detail.customerNote || "—"} hint="Istruzioni operative. Restano nel dettaglio, non sulla card." />
                <Field label="Operazione confermata" value={detail.confirmed ? "Sì" : "No: in card c'è il punto interrogativo"} hint="Il ? segnala un'operazione ancora da confermare. Il pulsante ? in alto a destra elenca queste task sulla data scelta." />
                <div className="sm:col-span-2 flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <div>
                    <p className="text-sm font-semibold">Task bloccata</p>
                    <p className="text-xs text-muted-foreground">Il lucchetto impedisce drag, cambio container e assegnazione automatica.</p>
                  </div>
                  <Switch
                    checked={detail.locked}
                    onCheckedChange={(checked) => updateDetail({ locked: checked }, checked ? `${detail.name} bloccata.` : `${detail.name} sbloccata.`)}
                    aria-label="Blocca task di prova"
                  />
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={adamOpen} onOpenChange={setAdamOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sync from ADAM</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>I container vengono rigenerati da ADAM. Le modifiche WASS non ancora trasferite vengono sovrascritte. Qui la sync è simulata.</p>
                <Label className="text-foreground">Cosa sincronizzare</Label>
                <RadioGroup value={adamMode} onValueChange={(value) => setAdamMode(value as AdamMode)} className="gap-3">
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="apt" id="tutorial-adam-apt" className="mt-1" />
                    <Label htmlFor="tutorial-adam-apt" className="font-normal">Solo containers e dati appartamento</Label>
                  </div>
                  <div className="flex items-start gap-2">
                    <RadioGroupItem value="assignments" id="tutorial-adam-assignments" className="mt-1" />
                    <Label htmlFor="tutorial-adam-assignments" className="font-normal">Anche assegnazioni, sequenza e ricalcolo orari</Label>
                  </div>
                </RadioGroup>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-2 border-custom-blue">Annulla</AlertDialogCancel>
            <AlertDialogAction className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent" onClick={(event) => { event.preventDefault(); applyAdam(); }}>
              Conferma refresh
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={transferOpen} onOpenChange={setTransferOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Trasferisci su ADAM</AlertDialogTitle>
            <AlertDialogDescription>
              In produzione scrive su ADAM cleaner, sequenza e orari della giornata. In questa prova non viene inviato nulla: serve a riconoscere il pulsante e la scritta «Salvato il…».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-2 border-custom-blue">Annulla</AlertDialogCancel>
            <AlertDialogAction
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent"
              onClick={(event) => {
                event.preventDefault();
                const stamp = `${DEMO_DATE.split("-").reverse().join("/")} ${nowLabel()}`;
                setLastTransfer(stamp);
                setTransferOpen(false);
                pushHistory("Trasferimento di prova registrato. ADAM vero non è stato contattato.");
              }}
            >
              Conferma
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset delle assegnazioni</AlertDialogTitle>
            <AlertDialogDescription>
              Tutte le task tornano nei container. Cleaner e modifiche ai dettagli restano. In produzione compare la stessa conferma e lo storico segna l'azzeramento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-2 border-custom-blue">Annulla</AlertDialogCancel>
            <AlertDialogAction
              className="border-2 border-custom-blue bg-background text-foreground hover:bg-accent"
              onClick={(event) => {
                event.preventDefault();
                setTasks((current) => current.map((item) => ({ ...item, cleanerId: null, sequence: 0 })));
                setResetOpen(false);
                pushHistory("Assegnazioni azzerate.");
              }}
            >
              Azzera
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Storico azioni</DialogTitle>
            <DialogDescription>Nella pagina vera elenca chi ha spostato, assegnato, sincronizzato o trasferito. Qui registra solo la prova.</DialogDescription>
          </DialogHeader>
          <ul className="max-h-80 space-y-2 overflow-y-auto text-sm">
            {history.map((entry) => (
              <li key={entry.id} className="rounded-md border border-border px-3 py-2">
                <span className="mr-2 font-semibold tabular-nums">{entry.at}</span>
                {entry.label}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>

      <Dialog open={convocazioniOpen} onOpenChange={setConvocazioniOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Convocazioni</DialogTitle>
            <DialogDescription>
              Apre l'elenco dei cleaner da convocare per la data. Da lì si scelgono le persone che poi compaiono in timeline. Il pulsante persona con il meno toglie i convocati; Aggiungi cleaner ne inserisce uno già convocato.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Aggiungi cleaner</DialogTitle>
            <DialogDescription>Scegline uno. In produzione la lista arriva dalle convocazioni della data.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {availableCleaners.map((cleaner) => (
              <Button
                key={cleaner.id}
                type="button"
                variant="outline"
                className="w-full justify-start border-2 border-custom-blue"
                onClick={() => {
                  setCleaners((current) => [...current, cleaner]);
                  setAddOpen(false);
                  pushHistory(`${cleaner.name} aggiunto in timeline.`);
                }}
              >
                <span className="mr-2 h-3 w-3 rounded-full" style={{ background: cleaner.color }} />
                {cleaner.name} · {cleaner.role}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rimuovi cleaners convocati</DialogTitle>
            <DialogDescription>Le loro task tornano nei container. In produzione il pulsante rosso sopra gli orari apre questa scelta.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {cleaners.map((cleaner) => (
              <label key={cleaner.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={removeSelection.includes(cleaner.id)}
                  onChange={(event) => {
                    setRemoveSelection((current) =>
                      event.target.checked ? [...current, cleaner.id] : current.filter((id) => id !== cleaner.id)
                    );
                  }}
                />
                {cleaner.name}
              </label>
            ))}
          </div>
          <Button
            type="button"
            className="border-2 border-custom-blue"
            variant="outline"
            disabled={removeSelection.length === 0}
            onClick={() => {
              const removed = new Set(removeSelection);
              setTasks((current) =>
                normalize(current.map((item) => (item.cleanerId && removed.has(item.cleanerId) ? { ...item, cleanerId: null, sequence: 0 } : item)))
              );
              setCleaners((current) => current.filter((item) => !removed.has(item.id)));
              setRemoveOpen(false);
              pushHistory("Cleaner rimossi. Le task sono tornate nei container.");
            }}
          >
            Rimuovi selezionati
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function labelFor(priority: Priority): string {
  if (priority === "early_out") return "Early out";
  if (priority === "high_priority") return "High priority";
  return "Low priority";
}

function Field({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-sm font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm text-foreground">{value}</p>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold">
        {value} {note && <span className="text-xs font-medium text-muted-foreground">{note}</span>}
      </p>
    </div>
  );
}

function PriorityPracticeColumn({
  column,
  tasks,
  dayLocked,
  hasEo,
  hasHp,
  searching,
  query,
  multi,
  selectedIds,
  didDrag,
  showColors,
  onToggleMulti,
  onToggleTask,
  onOpen,
  onAssign,
}: {
  column: (typeof PRIORITIES)[number];
  tasks: TutorialTask[];
  dayLocked: boolean;
  hasEo: boolean;
  hasHp: boolean;
  searching: boolean;
  query: string;
  multi: boolean;
  selectedIds: string[];
  didDrag: MutableRefObject<boolean>;
  showColors: boolean;
  onToggleMulti: () => void;
  onToggleTask: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onAssign: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column.key}`, disabled: dayLocked });
  const waveBlocked =
    column.key === "high_priority" ? !hasEo : column.key === "low_priority" ? !hasEo || !hasHp : false;
  const seen = new Set<string>();

  const renderCard = (item: TutorialTask) => {
    const highlighted = matchesQuery(item, query);
    const order = selectedIds.indexOf(item.id);
    return (
      <PracticeCard
        key={item.id}
        item={{ ...item, execution: showColors ? item.execution : "idle" }}
        highlighted={highlighted}
        muted={searching && !highlighted}
        selectedOrder={order >= 0 ? order + 1 : undefined}
        multi={multi}
        dayLocked={dayLocked}
        didDrag={didDrag}
        onOpen={() => onOpen(item.id)}
        onToggle={() => onToggleTask(item.id)}
        tourId={column.key === "early_out" && item.id === "eo-duomo" ? "task" : undefined}
      />
    );
  };

  return (
    <section
      data-tour={column.key === "early_out" ? "eo" : column.key === "high_priority" ? "hp" : "lp"}
      className={cn("rounded-lg border-2 border-custom-blue bg-custom-blue-light p-3", isOver && "ring-2 ring-custom-blue")}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center font-semibold text-custom-blue">
            {column.icon === "clock" && <Clock className="mr-2 h-5 w-5" />}
            {column.icon === "alert" && <AlertCircle className="mr-2 h-5 w-5" />}
            {column.icon === "down" && <ArrowDown className="mr-2 h-5 w-5" />}
            {column.title}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {tasks.length} task
            {multi && selectedIds.length > 0 ? ` · ${selectedIds.length} selezionate` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant={multi ? "default" : "outline"} size="sm" className="h-7 border-2 border-custom-blue px-2 text-xs" disabled={dayLocked || tasks.length === 0} onClick={onToggleMulti} title={multi ? "Disattiva selezione multipla" : "Attiva selezione multipla"} data-tour={column.key === "early_out" ? "multi" : undefined}>
            <CheckSquare className="h-3 w-3" />
            {multi ? <span className="ml-1">On</span> : null}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 border-2 border-custom-blue px-2 text-xs"
            disabled={dayLocked || tasks.length === 0 || waveBlocked}
            title={
              waveBlocked
                ? column.key === "high_priority"
                  ? "Prima serve almeno una Early out in timeline"
                  : "Prima servono Early out e High priority in timeline"
                : "Assegna"
            }
            onClick={onAssign}
            data-tour={column.key === "early_out" ? "assign-eo" : undefined}
          >
            <Calendar className="mr-1 h-3 w-3" />
            Assegna
          </Button>
        </div>
      </div>
      <div ref={setNodeRef} className="flex min-h-[120px] flex-wrap content-start gap-2">
        {tasks.map((item) => {
          if (!item.duplicateGroup) return renderCard(item);
          if (seen.has(item.duplicateGroup)) return null;
          seen.add(item.duplicateGroup);
          const group = tasks.filter((candidate) => candidate.duplicateGroup === item.duplicateGroup);
          return (
            <div
              key={item.duplicateGroup}
              data-tour={column.key === "early_out" ? "duplicate" : undefined}
              className="w-full rounded-md border-2 border-dashed border-amber-500/80 bg-amber-500/10 p-2"
            >
              <p className="mb-2 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                Duplicati dello stesso appartamento: in produzione ne resta attivo uno.
              </p>
              <div className="flex flex-wrap gap-2">{group.map(renderCard)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CleanerPracticeRow({
  cleaner,
  scheduled,
  worked,
  scaleStart,
  scaleEnd,
  dayLocked,
  searching,
  query,
  showColors,
  didDrag,
  onOpen,
  onShift,
  tourRow = false,
}: {
  cleaner: TutorialCleaner;
  scheduled: Scheduled[];
  worked: number;
  scaleStart: number;
  scaleEnd: number;
  dayLocked: boolean;
  searching: boolean;
  query: string;
  showColors: boolean;
  didDrag: MutableRefObject<boolean>;
  onOpen: (taskId: string) => void;
  onShift: (delta: number) => void;
  tourRow?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `cleaner:${cleaner.id}`, disabled: dayLocked });
  const span = Math.max(1, scaleEnd - scaleStart);
  return (
    <div className="flex items-stretch border-t border-border/70 py-1" data-tour={tourRow ? "cleaner" : undefined}>
      <div className="flex w-48 shrink-0 flex-col justify-center pr-2">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: cleaner.color }} />
          <span className="truncate text-sm font-semibold">{cleaner.name}</span>
        </div>
        <span className={cn("mt-0.5 w-fit rounded border px-1.5 text-[10px] font-medium", cleaner.role === "Premium" ? "border-yellow-600 bg-yellow-100 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200" : "border-green-600 bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200")}>
          {cleaner.role}
        </span>
        <div className="mt-1 flex items-center gap-1" data-tour={tourRow ? "shift" : undefined}>
          <button type="button" className="rounded border border-custom-blue px-1 text-[10px]" disabled={dayLocked || cleaner.shiftMinutes <= -60} onClick={() => onShift(-30)}>-30</button>
          <span className="text-[10px] text-muted-foreground">primo {clock(DAY_START + cleaner.shiftMinutes)}</span>
          <button type="button" className="rounded border border-custom-blue px-1 text-[10px]" disabled={dayLocked || cleaner.shiftMinutes >= 120} onClick={() => onShift(30)}>+30</button>
        </div>
      </div>
      <div ref={setNodeRef} className={cn("relative min-h-[4.75rem] flex-1 self-stretch rounded-md", isOver && "bg-custom-blue/10 ring-2 ring-custom-blue")}>
        {scheduled.map((item) => {
          const left = ((item.start - scaleStart) / span) * 100;
          const width = (workMinutes(item.task) / span) * 100;
          const highlighted = matchesQuery(item.task, query);
          return (
            <div
              key={item.task.id}
              className="absolute top-1/2 z-10 -translate-y-1/2"
              style={{ left: `${left}%`, width: `${Math.max(width, 12)}%`, minWidth: 148 }}
            >
              <PracticeCard
                item={{ ...item.task, execution: showColors ? item.task.execution : "idle" }}
                timeline
                highlighted={highlighted}
                muted={searching && !highlighted}
                multi={false}
                dayLocked={dayLocked}
                didDrag={didDrag}
                onOpen={() => onOpen(item.task.id)}
                onToggle={() => undefined}
              />
            </div>
          );
        })}
      </div>
      <div className="flex w-24 shrink-0 items-center justify-center text-sm font-semibold tabular-nums">
        {Math.floor(worked / 60)}:{String(worked % 60).padStart(2, "0")}
      </div>
    </div>
  );
}

function RemovePracticeZone() {
  const { setNodeRef, isOver } = useDroppable({ id: "remove" });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border-2 border-red-600 bg-background px-4 py-2 text-sm font-medium text-red-700 shadow-lg dark:text-red-300",
        isOver && "bg-red-100 dark:bg-red-950"
      )}
    >
      Trascina qui per rimettere la task nel container
    </div>
  );
}
