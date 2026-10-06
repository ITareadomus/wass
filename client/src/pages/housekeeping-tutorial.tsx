import { cloneElement, useEffect, useState, type MouseEvent, type ReactElement, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  BarChart3,
  Building2,
  Calendar,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  HelpCircle,
  History,
  Home,
  Lock,
  Map as MapIcon,
  Moon,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Truck,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { HousekeepingPractice } from "@/components/tutorial/housekeeping-practice";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type Spot = { id: string; title: string; body: string };

const CHAPTERS = [
  { id: "giornata", label: "Giornata" },
  { id: "barra", label: "Barra" },
  { id: "comandi", label: "Comandi" },
  { id: "containers", label: "Containers" },
  { id: "timeline", label: "Timeline" },
  { id: "task", label: "Task" },
  { id: "prova", label: "Prova" },
];

const SELECTED = "ring-2 ring-offset-2 ring-[hsl(199,89%,48%)]";

const OUTLINE = "border-2 border-custom-blue";

function Hit({
  id,
  active,
  onSelect,
  className,
  children,
}: {
  id: string;
  active: string;
  onSelect: (id: string) => void;
  className?: string;
  children: ReactElement<{ className?: string; onClick?: (event: MouseEvent) => void }>;
}) {
  return cloneElement(children, {
    onClick: (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect(id);
    },
    className: cn("cursor-pointer", children.props.className, className, active === id && SELECTED),
  });
}

function Stage({
  id,
  title,
  icon,
  spots,
  active,
  onSelect,
  filled = false,
  children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  spots: Spot[];
  active: string;
  onSelect: (id: string) => void;
  filled?: boolean;
  children: ReactNode;
}) {
  const index = Math.max(0, spots.findIndex((spot) => spot.id === active));
  const spot = spots[index] ?? spots[0];

  return (
    <section id={id} className="scroll-mt-16">
      <h2 className="mb-3 flex items-center text-xl font-bold">
        <span className="mr-2 text-custom-blue">{icon}</span>
        {title}
      </h2>
      <div className={cn("rounded-lg border-2 border-custom-blue shadow-sm", filled ? "bg-custom-blue-light" : "bg-background")}>
        <div className="p-4">{children}</div>
        <div
          key={spot.id}
          className={cn(
            "flex items-center gap-3 border-t-2 border-custom-blue px-4 py-3 animate-in fade-in slide-in-from-bottom-1 duration-300",
            filled ? "bg-background" : "bg-custom-blue-light"
          )}
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-custom-blue">{spot.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-foreground">{spot.body}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={index === 0}
              onClick={() => onSelect(spots[index - 1].id)}
              aria-label="Comando precedente"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <span className="w-10 text-center text-xs tabular-nums text-muted-foreground">
              {index + 1}/{spots.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              disabled={index >= spots.length - 1}
              onClick={() => onSelect(spots[index + 1].id)}
              aria-label="Comando successivo"
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

function useSpots(spots: Spot[]) {
  const [active, setActive] = useState(spots[0]?.id ?? "");
  return { spots, active, setActive };
}

export default function HousekeepingTutorial() {
  const [chapter, setChapter] = useState(CHAPTERS[0].id);

  useEffect(() => {
    const nodes = CHAPTERS.map((item) => document.getElementById(item.id)).filter(
      (node): node is HTMLElement => node != null
    );
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (visible?.target.id) setChapter(visible.target.id);
      },
      { rootMargin: "-15% 0px -55% 0px", threshold: [0.15, 0.4, 0.7] }
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground" data-testid="housekeeping-tutorial">
      <div className="mx-auto w-full max-w-[1920px] px-4 pb-16 pt-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[25px] font-bold leading-[44px]">Tutorial Housekeeping</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            Clicca i comandi: sono quelli della pagina Assegnazioni. Le frecce scorrono la spiegazione.
          </p>
        </div>

        <div className="sticky top-0 z-30 -mx-4 mb-6 border-b border-border/50 bg-background/95 px-4 py-2 backdrop-blur">
          <div
            className="inline-flex max-w-full flex-wrap gap-0.5 rounded-md border-2 border-custom-blue bg-background p-0.5"
            role="tablist"
            aria-label="Sezioni del tutorial"
          >
            {CHAPTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={chapter === item.id}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  chapter === item.id ? "bg-custom-blue-light text-custom-blue" : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => {
                  setChapter(item.id);
                  document.getElementById(item.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-8">
          <DayStage />
          <HeaderStage />
          <CommandsStage />
          <ContainersStage />
          <TimelineStage />
          <TaskStage />
          <section id="prova" className="scroll-mt-16">
            <h2 className="mb-3 flex items-center text-xl font-bold">
              <span className="mr-2 text-custom-blue">
                <RefreshCw className="h-5 w-5" />
              </span>
              Prova sulla giornata finta
            </h2>
            <HousekeepingPractice />
          </section>
        </div>
      </div>
    </div>
  );
}

function DayStage() {
  const { spots, active, setActive } = useSpots([
    {
      id: "data",
      title: "Data",
      body: "Il calendario accanto al titolo carica containers, timeline e cleaner convocati di quel giorno.",
    },
    {
      id: "sync",
      title: "Sync from ADAM",
      body: "Prima di assegnare si allineano appartamenti e orari. Il pallino rosso compare quando ADAM ha novità.",
    },
    {
      id: "onde",
      title: "Tre ondate",
      body: "Le task libere stanno in Early out, poi High priority, poi Low priority. Si assegnano in quest'ordine: High si sblocca con una Early out già in timeline, Low quando ci sono entrambe.",
    },
    {
      id: "timeline",
      title: "Timeline",
      body: "Ogni riga è un cleaner. Le card si mettono in sequenza a mano, oppure con Assegna. A destra restano le ore di pulizia.",
    },
    {
      id: "transfer",
      title: "Trasferisci su ADAM",
      body: "Quando la giornata è pronta, questo pulsante scrive su ADAM cleaner, sequenza e orari. Accanto resta «Salvato il…».",
    },
    {
      id: "strisce",
      title: "Striscia colorata",
      body: "Verde standard, giallo premium, rosso straordinaria, grigio altro (per esempio la pulizia uffici). Il colore è il tipo di lavoro, non la priorità.",
    },
  ]);

  return (
    <Stage
      id="giornata"
      title="Come si prepara la giornata"
      icon={<Calendar className="h-5 w-5" />}
      spots={spots}
      active={active}
      onSelect={setActive}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Hit id="data" active={active} onSelect={setActive}>
          <Button type="button" variant="outline" className={cn(OUTLINE, "text-[13px] font-normal")}>
            <Calendar className="mr-2 h-4 w-4" />
            05/10/2026
          </Button>
        </Hit>
        <ChevronRight className="h-4 w-4 text-custom-blue" />
        <Hit id="sync" active={active} onSelect={setActive}>
          <span className="inline-flex items-center overflow-hidden rounded-md border-2 border-custom-blue bg-custom-blue">
            <span className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium text-black dark:text-white">
              <span className="relative inline-flex">
                <RefreshCw className="h-4 w-4" />
                <span className="absolute -right-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-red-500" />
              </span>
              Sync from ADAM
            </span>
          </span>
        </Hit>
        <ChevronRight className="h-4 w-4 text-custom-blue" />
        <Hit id="onde" active={active} onSelect={setActive}>
          <span className="inline-flex items-center gap-1">
            <Badge className="border-blue-700 bg-blue-500 text-white hover:bg-blue-500">EO</Badge>
            <Badge className="border-orange-700 bg-orange-500 text-white hover:bg-orange-500">HP</Badge>
            <Badge className="border-gray-700 bg-gray-500 text-white hover:bg-gray-500">LP</Badge>
          </span>
        </Hit>
        <ChevronRight className="h-4 w-4 text-custom-blue" />
        <Hit id="timeline" active={active} onSelect={setActive}>
          <span className="inline-flex h-10 min-w-[220px] items-center gap-2 rounded-md border bg-background px-2">
            <span className="h-3 w-3 rounded-full bg-[#E6194B]" />
            <span className="text-sm font-semibold">Giulia Rossi</span>
            <span className="ml-auto rounded-md border bg-card px-2 py-1 text-[13px] font-extrabold">18420</span>
          </span>
        </Hit>
        <ChevronRight className="h-4 w-4 text-custom-blue" />
        <Hit id="transfer" active={active} onSelect={setActive}>
          <Button type="button" variant="outline" size="sm" className={cn(OUTLINE, "bg-background")}>
            Trasferisci su ADAM
          </Button>
        </Hit>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Hit id="strisce" active={active} onSelect={setActive}>
          <span className="inline-flex gap-2">
            <StripeChip stripe="bg-green-500" label="Standard" />
            <StripeChip stripe="bg-yellow-500" label="Premium" />
            <StripeChip stripe="bg-red-500" label="Straordinaria" />
            <StripeChip stripe="bg-gray-400" label="Altro" />
          </span>
        </Hit>
      </div>
    </Stage>
  );
}

function StripeChip({ stripe, label }: { stripe: string; label: string }) {
  return (
    <span className="relative flex h-10 items-center rounded-md border bg-card pl-4 pr-3 text-[13px] font-extrabold">
      <span className={cn("absolute bottom-[2px] left-[2px] top-[2px] w-1.5 rounded-sm", stripe)} />
      {label}
    </span>
  );
}

function HeaderStage() {
  const { spots, active, setActive } = useSpots([
    {
      id: "help",
      title: "Task non confermate",
      body: "Il punto di domanda tondo apre l'elenco delle operazioni ancora da confermare, per la data scelta. Sulla card, lo stesso simbolo in piccolo indica quella task.",
    },
    {
      id: "theme",
      title: "Tema",
      body: "Luna o sole cambia chiaro e scuro e lo ricorda su questo browser.",
    },
    {
      id: "account",
      title: "Account",
      body: "L'iniziale apre cambio account e logout. Gli admin trovano anche Account Settings e Settings. History nel menu c'è, ed è disattivo.",
    },
    {
      id: "home",
      title: "Torna alla Home",
      body: "Su Convocazioni e sulle impostazioni questo tasto sostituisce il punto di domanda e riporta alle assegnazioni.",
    },
    {
      id: "date",
      title: "Assegnazioni del giorno",
      body: "Sotto la barra, il titolo e la data dicono su quale giornata stai lavorando. Cambiare data ricarica tutto.",
    },
    {
      id: "switch",
      title: "Housekeeping / Logistica",
      body: "Housekeeping assegna i cleaner agli appartamenti. Logistica assegna gli autisti ai giri. Il segmento acceso è la pagina in cui ti trovi.",
    },
  ]);

  return (
    <Stage
      id="barra"
      title="Barra e titolo"
      icon={<HelpCircle className="h-5 w-5" />}
      spots={spots}
      active={active}
      onSelect={setActive}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/40 px-3 py-2">
        <span className="text-[32px] font-bold leading-none tracking-tight">WASS</span>
        <div className="flex items-center gap-3">
          <Hit id="help" active={active} onSelect={setActive}>
            <Button type="button" variant="outline" size="icon" className="rounded-full" title="Task Non Confermate">
              <HelpCircle className="h-5 w-5" />
            </Button>
          </Hit>
          <Hit id="theme" active={active} onSelect={setActive}>
            <Button type="button" variant="outline" size="icon" className="rounded-full">
              <Moon className="h-5 w-5" />
            </Button>
          </Hit>
          <Hit id="account" active={active} onSelect={setActive}>
            <span className="inline-flex">
              <Avatar className="h-9 w-9">
                <AvatarFallback className="bg-blue-500 text-sm font-semibold text-white">M</AvatarFallback>
              </Avatar>
            </span>
          </Hit>
          <Hit id="home" active={active} onSelect={setActive}>
            <Button type="button" variant="outline" size="icon" className="rounded-full" title="Torna alla Home">
              <Home className="h-5 w-5" />
            </Button>
          </Hit>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[25px] font-bold leading-[44px]">Assegnazioni Housekeeping del</span>
          <Hit id="date" active={active} onSelect={setActive}>
            <Button type="button" variant="outline" className={cn(OUTLINE, "text-[13px] font-normal")}>
              <Calendar className="mr-2 h-4 w-4" />
              05/10/2026
            </Button>
          </Hit>
        </div>
        <Hit id="switch" active={active} onSelect={setActive}>
          <span className="inline-flex items-center gap-0.5 rounded-md border-2 border-custom-blue bg-background p-0.5">
            <span className="inline-flex items-center gap-2 rounded-md bg-custom-blue-light px-3 py-2 text-sm font-medium text-custom-blue">
              <Building2 className="h-4 w-4" />
              Housekeeping
            </span>
            <span className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground">
              <Truck className="h-4 w-4" />
              Logistica
            </span>
          </span>
        </Hit>
      </div>
    </Stage>
  );
}

function CommandsStage() {
  const { spots, active, setActive } = useSpots([
    {
      id: "search",
      title: "Cerca task",
      body: "Cerca per codice ADAM, alias, indirizzo, cliente, riferimento o codice appartamento. Le card trovate si accendono di giallo, nei container, in timeline e sulla mappa.",
    },
    {
      id: "sync",
      title: "Sync from ADAM",
      body: "Chiede se aggiornare solo containers e dati appartamento, oppure anche cleaner, sequenza e orari. Riscrive i container. Le modifiche WASS non ancora trasferite vengono sovrascritte.",
    },
    {
      id: "assign",
      title: "Assegna",
      body: "Lancia le tre ondate in ordine: Early out, High priority, Low priority. In pagina vera compare la finestra di attesa. Le task bloccate restano ferme.",
    },
    {
      id: "hide",
      title: "Nascondi / Apri i containers",
      body: "La linguetta sul bordo chiude i tre riquadri per lasciare spazio alla timeline, e li riapre quando servono.",
    },
  ]);
  const [query, setQuery] = useState("ROSSI");
  const highlighted = query.trim().length > 0;

  return (
    <Stage
      id="comandi"
      title="Ricerca, sync e assegna"
      icon={<Search className="h-5 w-5" />}
      spots={spots}
      active={active}
      onSelect={setActive}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className={cn("relative min-w-[220px] flex-1", active === "search" && SELECTED)} onClick={() => setActive("search")}>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-custom-blue" />
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive("search");
            }}
            onFocus={() => setActive("search")}
            placeholder="Cerca task..."
            className="border-2 border-custom-blue bg-background pl-10"
          />
        </div>
        <div className="flex items-center overflow-hidden rounded-md border-2 border-custom-blue bg-custom-blue">
          <Hit id="sync" active={active} onSelect={setActive}>
            <Button type="button" variant="ghost" size="sm" className="rounded-none px-3 text-black hover:bg-custom-blue/80 dark:text-white">
              <span className="relative inline-flex">
                <RefreshCw className="h-4 w-4" />
                <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500" />
              </span>
              Sync from ADAM
            </Button>
          </Hit>
          <div className="h-6 w-px bg-black/20 dark:bg-white/20" />
          <Hit id="assign" active={active} onSelect={setActive}>
            <Button type="button" variant="ghost" size="sm" className="rounded-none px-3 text-black hover:bg-custom-blue/80 dark:text-white">
              <Calendar className="h-4 w-4" />
              Assegna
            </Button>
          </Hit>
        </div>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3">
        <DemoCard highlighted={highlighted} reference={highlighted ? "ROSSI" : ""} />
        <Hit id="hide" active={active} onSelect={setActive}>
          <span className="inline-flex items-center gap-1.5 rounded-t-lg border-2 border-b-0 border-custom-blue bg-custom-blue-light px-2.5 py-1 text-[12px] font-medium text-custom-blue">
            Nascondi containers
          </span>
        </Hit>
      </div>
    </Stage>
  );
}

function ContainersStage() {
  const { spots, active, setActive } = useSpots([
    {
      id: "eo",
      title: "Early out",
      body: "Prima ondata, chi esce presto. Il suo Assegna è subito disponibile.",
    },
    {
      id: "hp",
      title: "High priority",
      body: "Seconda ondata. Assegna resta spento finché in timeline non c'è almeno una Early out.",
    },
    {
      id: "lp",
      title: "Low priority",
      body: "Il resto della giornata. Assegna si accende solo dopo Early out e High priority.",
    },
    {
      id: "multi",
      title: "Selezione multipla",
      body: "Il quadratino numera le card nell'ordine dei click. Trascinandone una, si spostano tutte insieme. Il pallino in alto a sinistra mostra il numero.",
    },
    {
      id: "assign-eo",
      title: "Assegna Early out",
      body: "Distribuisce le task libere di questa colonna sui cleaner, bilanciando i minuti. In produzione il pulsante si spegne dopo l'uso, finché la timeline non cambia.",
    },
    {
      id: "assign-hp",
      title: "Assegna High priority",
      body: "È lo stesso pulsante, spento finché in timeline non c'è almeno una Early out. Poi assegna solo questa colonna.",
    },
    {
      id: "assign-lp",
      title: "Assegna Low priority",
      body: "Si accende solo quando in timeline ci sono già Early out e High priority. Assegna il resto della giornata.",
    },
    {
      id: "duplicate",
      title: "Duplicati",
      body: "Il riquadro tratteggiato raccoglie due card dello stesso appartamento. Di solito ne resta attiva una.",
    },
    {
      id: "lock",
      title: "Lucchetto",
      body: "La task bloccata non si trascina e l'assegnazione automatica la salta. Si sblocca dal dettaglio.",
    },
    {
      id: "question",
      title: "Operazione non confermata",
      body: "Il punto interrogativo sulla card segnala un'operazione da controllare. L'elenco completo è il ? tondo in alto a destra.",
    },
  ]);

  return (
    <Stage
      id="containers"
      title="Containers"
      icon={<Clock className="h-5 w-5" />}
      spots={spots}
      active={active}
      onSelect={setActive}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <ColumnFrame
          id="eo"
          assignId="assign-eo"
          active={active}
          onSelect={setActive}
          icon={<Clock className="mr-2 h-5 w-5" />}
          title="EARLY OUT"
          count="4 task"
        >
          <div className="rounded-md border-2 border-dashed border-amber-500/80 bg-amber-500/10 p-2">
            <Hit id="duplicate" active={active} onSelect={setActive}>
              <p className="mb-2 text-[11px] font-semibold text-amber-800 dark:text-amber-200">
                Duplicati dello stesso appartamento
              </p>
            </Hit>
            <div className="flex flex-wrap gap-2">
              <DemoCard />
              <DemoCard name="18581" />
            </div>
          </div>
        </ColumnFrame>
        <ColumnFrame
          id="hp"
          assignId="assign-hp"
          active={active}
          onSelect={setActive}
          icon={<AlertCircle className="mr-2 h-5 w-5" />}
          title="HIGH PRIORITY"
          count="2 task"
          assignDisabled
        >
          <Hit id="question" active={active} onSelect={setActive}>
            <span className="relative inline-flex">
              <DemoCard name="18501" stripe="bg-red-500" alias="ISOLA" />
              <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-gray-700/80 bg-gray-900/75 text-white">
                <HelpCircle className="h-3 w-3" />
              </span>
            </span>
          </Hit>
        </ColumnFrame>
        <ColumnFrame
          id="lp"
          assignId="assign-lp"
          active={active}
          onSelect={setActive}
          icon={<ArrowDown className="mr-2 h-5 w-5" />}
          title="LOW PRIORITY"
          count="3 task"
          assignDisabled
        >
          <Hit id="lock" active={active} onSelect={setActive}>
            <span className="relative inline-flex">
              <DemoCard name="18801" alias="CITYLIFE" />
              <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-gray-700 bg-gray-600 text-white">
                <Lock className="h-2.5 w-2.5" />
              </span>
            </span>
          </Hit>
        </ColumnFrame>
      </div>
    </Stage>
  );
}

function ColumnFrame({
  id,
  assignId,
  active,
  onSelect,
  icon,
  title,
  count,
  assignDisabled,
  children,
}: {
  id: string;
  assignId: string;
  active: string;
  onSelect: (id: string) => void;
  icon: ReactNode;
  title: string;
  count: string;
  assignDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg border-2 border-custom-blue bg-custom-blue-light p-3">
      <div className="mb-3 flex items-start justify-between gap-2">
        <Hit id={id} active={active} onSelect={onSelect}>
          <span className="block text-left">
            <span className="flex items-center font-semibold text-custom-blue">
              {icon}
              {title}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{count}</span>
          </span>
        </Hit>
        <div className="flex gap-2">
          <Hit id="multi" active={active} onSelect={onSelect}>
            <Button type="button" variant="outline" size="sm" className="h-7 border-2 border-custom-blue bg-background px-2 text-xs">
              <CheckSquare className="h-3 w-3" />
            </Button>
          </Hit>
          <Hit id={assignId} active={active} onSelect={onSelect}>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn("h-7 border-2 border-custom-blue bg-background px-2 text-xs", assignDisabled && "opacity-50")}
            >
              <Calendar className="h-3 w-3" />
              Assegna
            </Button>
          </Hit>
        </div>
      </div>
      {children}
    </div>
  );
}

function TimelineStage() {
  const { spots, active, setActive } = useSpots([
    {
      id: "short",
      title: "Task brevi",
      body: "Sotto una certa durata, check-out, check-in e riferimento cliente si nascondono. Il passaggio del mouse li mostra. Il punto esclamativo giallo lo ricorda.",
    },
    {
      id: "colors",
      title: "Colori stato",
      body: "Acceso, la card in corso diventa azzurra e quella conclusa verde. Spento, tornano al colore della card.",
    },
    {
      id: "history",
      title: "Storico",
      body: "Chi ha spostato una task, cambiato un orario, sincronizzato, aggiunto un cleaner o azzerato le assegnazioni.",
    },
    {
      id: "stats",
      title: "Statistiche",
      body: "Totale, non assegnate, standard, premium, straordinarie e altro. Lo stesso pulsante chiude il pannello.",
    },
    {
      id: "map",
      title: "Mappa",
      body: "Apre gli appartamenti. Si può lasciarla flottante, fissarla a destra con la puntina e allargarla dal bordo. Il doppio click sul cleaner filtra i suoi punti.",
    },
    {
      id: "roster",
      title: "Convocazioni",
      body: "Apre l'elenco dei cleaner del giorno. In timeline compaiono solo i convocati.",
    },
    {
      id: "reset",
      title: "Reset",
      body: "Chiede conferma e rimette le task nei container. I convocati restano. Lo storico segna l'azzeramento.",
    },
    {
      id: "remove",
      title: "Rimuovi cleaners",
      body: "L'icona rossa sopra i nomi toglie uno o più convocati. Le loro task tornano nei container.",
    },
    {
      id: "bands",
      title: "Fasce orarie",
      body: "Le graffe EO, HP e LP sopra gli orari dividono la giornata. Early out è la prima parte, High priority la centrale, Low priority il resto.",
    },
    {
      id: "worked",
      title: "Ore lavorate",
      body: "Somma dei minuti di pulizia della riga, già divisi se i cleaner sono più di uno. Il travel non entra nel conteggio.",
    },
    {
      id: "cleaner",
      title: "Nome del cleaner",
      body: "Un click apre la persona. Il doppio click filtra la mappa. Il pallino è il colore dei suoi punti. Premium o Standard è il ruolo.",
    },
    {
      id: "shift",
      title: "Primo appartamento",
      body: "In pagina una maniglia sulla prima card sposta l'inizio di tutta la riga, a scatti di 30 minuti. Nella prova i tasti −30 e +30 fanno la stessa cosa.",
    },
    {
      id: "card",
      title: "Trascinare la card",
      body: "Si lascia in coda a un cleaner, oppure sopra un'altra card per inserirla prima. In basso compare la zona rossa: rilasciarla lì rimette la task nel suo container.",
    },
    {
      id: "add",
      title: "Aggiungi cleaner",
      body: "Inserisce in timeline una persona già convocata.",
    },
    {
      id: "day",
      title: "Inizio giornata operativa",
      body: "Quando parte, la timeline è di sola lettura: niente spostamenti, reset o sync. Restano colori, mappa e storico.",
    },
    {
      id: "transfer",
      title: "Trasferisci su ADAM",
      body: "Invia cleaner, sequenza e orari. «Salvato il…» è l'ultimo invio riuscito.",
    },
  ]);
  const [colors, setColors] = useState(true);

  return (
    <Stage
      id="timeline"
      title="Timeline"
      icon={<Users className="h-5 w-5" />}
      spots={spots}
      active={active}
      onSelect={setActive}
      filled
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="flex items-center text-xl font-bold">
            <Calendar className="mr-2 h-5 w-5 text-custom-blue" />
            Timeline Housekeeping - 2 Cleaners
          </h3>
          <Hit id="short" active={active} onSelect={setActive}>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 text-yellow-500 hover:bg-yellow-500/10 hover:text-yellow-600">
              <AlertCircle className="h-4 w-4" />
            </Button>
          </Hit>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className={cn("flex items-center gap-2 rounded-md px-1", active === "colors" && SELECTED)}
            onClick={() => setActive("colors")}
          >
            <Label className="cursor-pointer text-sm font-medium text-custom-blue">Colori stato</Label>
            <Switch
              checked={colors}
              onCheckedChange={(checked) => {
                setColors(checked);
                setActive("colors");
              }}
              className="border-2 border-custom-blue data-[state=checked]:bg-[hsl(199,89%,48%)] data-[state=unchecked]:bg-sky-200"
            />
          </div>
          <ToolButton id="history" active={active} onSelect={setActive} icon={<History className="h-4 w-4" />} label="Storico" />
          <ToolButton id="stats" active={active} onSelect={setActive} icon={<BarChart3 className="h-4 w-4" />} label="Statistiche" />
          <ToolButton id="map" active={active} onSelect={setActive} icon={<MapIcon className="h-4 w-4" />} label="Mappa" />
          <ToolButton id="roster" active={active} onSelect={setActive} icon={<Users className="h-4 w-4" />} label="Convocazioni" />
          <ToolButton id="reset" active={active} onSelect={setActive} icon={<RotateCcw className="h-4 w-4" />} label="Reset" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Hit id="bands" active={active} onSelect={setActive}>
          <span className="inline-flex items-center gap-2">
            <Badge className="border-blue-700 bg-blue-500 text-white hover:bg-blue-500">EO</Badge>
            <Badge className="border-orange-700 bg-orange-500 text-white hover:bg-orange-500">HP</Badge>
            <Badge className="border-gray-700 bg-gray-500 text-white hover:bg-gray-500">LP</Badge>
            <span className="text-[13px] font-medium tabular-nums">08:00 · 10:00 · 12:00 · 14:00</span>
          </span>
        </Hit>
        <Hit id="remove" active={active} onSelect={setActive}>
          <Button type="button" variant="ghost" size="sm" className="text-red-700 dark:text-red-400">
            <UserMinus className="h-4 w-4" />
          </Button>
        </Hit>
        <Hit id="worked" active={active} onSelect={setActive}>
          <span className="text-[13px] font-medium">Ore lavorate</span>
        </Hit>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-background/70 px-2 py-2">
        <Hit id="cleaner" active={active} onSelect={setActive}>
          <span className="inline-flex items-center gap-2">
            <span className="h-3 w-3 rounded-full bg-[#E6194B]" />
            <span className="text-sm font-semibold">Giulia Rossi</span>
            <span className="rounded border border-yellow-600 bg-yellow-100 px-1.5 text-[10px] font-medium text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200">
              Premium
            </span>
          </span>
        </Hit>
        <Hit id="shift" active={active} onSelect={setActive}>
          <span className="inline-flex items-center gap-1 text-[10px]">
            <span className="rounded border border-custom-blue bg-background px-1">−30</span>
            <span className="text-muted-foreground">primo 08:30</span>
            <span className="rounded border border-custom-blue bg-background px-1">+30</span>
          </span>
        </Hit>
        <Hit id="card" active={active} onSelect={setActive}>
          <span className="inline-flex">
            <DemoCard
              name="18488"
              alias="SANT'AMBROGIO"
              stripe="bg-yellow-500"
              surface={colors ? "bg-sky-100 dark:bg-sky-950" : "bg-card"}
            />
          </span>
        </Hit>
        <span className="ml-auto text-sm font-semibold tabular-nums">1:20</span>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Hit id="add" active={active} onSelect={setActive}>
          <Button type="button" variant="outline" size="sm" className={cn(OUTLINE, "bg-background")}>
            <UserPlus className="h-4 w-4" />
            Aggiungi cleaner
          </Button>
        </Hit>
        <div className="flex flex-wrap items-center gap-3">
          <div
            className={cn("flex items-center gap-2 rounded-md px-1", active === "day" && SELECTED)}
            onClick={() => setActive("day")}
          >
            <Label className="cursor-pointer text-sm font-medium text-custom-blue">Inizio giornata operativa</Label>
            <Switch
              onCheckedChange={() => setActive("day")}
              className="border-2 border-custom-blue data-[state=checked]:bg-[hsl(199,89%,48%)] data-[state=unchecked]:bg-sky-200"
            />
          </div>
          <Hit id="transfer" active={active} onSelect={setActive}>
            <span className="inline-flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" className={cn(OUTLINE, "bg-background")}>
                Trasferisci su ADAM
              </Button>
              <span className="text-xs text-muted-foreground">Salvato il 05/10/2026 09:40</span>
            </span>
          </Hit>
        </div>
      </div>
    </Stage>
  );
}

function ToolButton({
  id,
  active,
  onSelect,
  icon,
  label,
}: {
  id: string;
  active: string;
  onSelect: (id: string) => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <Hit id={id} active={active} onSelect={onSelect}>
      <Button type="button" variant="outline" size="sm" className={cn(OUTLINE, "bg-background")}>
        {icon}
        {label}
      </Button>
    </Hit>
  );
}

function TaskStage() {
  const { spots, active, setActive } = useSpots([
    { id: "stripe", title: "Striscia", body: "Il colore a sinistra è il tipo di intervento: standard, premium, straordinaria o altro." },
    { id: "code", title: "Codice ADAM", body: "Il numero in grassetto, per esempio 18420. È quello che si cerca più spesso." },
    { id: "ref", title: "Riferimento cliente", body: "Tra parentesi, in rosso, accanto al codice. È il riferimento ospite o società, quando ADAM lo manda." },
    { id: "alias", title: "Alias e tipologia", body: "Seconda riga: il nome breve dell'appartamento e, tra parentesi, monolocale, bilocale, ufficio." },
    { id: "out", title: "Check-out", body: "Freccia verde verso l'alto: quando gli ospiti escono. Se il cleaner arriva prima, la timeline aspetta questo orario." },
    { id: "in", title: "Check-in", body: "Freccia rossa verso il basso: quando entrano i prossimi. Se il giorno è un altro, data e orario diventano grigi." },
    { id: "collab", title: "Più cleaner", body: "Il badge viola divide la durata. Due persone su 60 minuti occupano 30 minuti in timeline ciascuna." },
    { id: "question", title: "Non confermata", body: "Il ? sulla card è un'operazione da confermare. Il ? tondo in alto apre l'elenco del giorno." },
    { id: "lock", title: "Bloccata", body: "Il lucchetto ferma drag e assegnazione automatica. Dal dettaglio si può togliere." },
    { id: "duration", title: "Durata pulizia", body: "Minuti dell'appartamento. La matita indica che in dettaglio si può correggere." },
    { id: "address", title: "Indirizzo e cliente", body: "Nel dettaglio, in sola lettura: cliente, indirizzo, codice appartamento. L'indirizzo è anche il punto sulla mappa." },
    { id: "keys", title: "Accesso", body: "Chiave classica, serratura smart o keybox, con il codice o il posto. In pagina il campo apre il dettaglio chiavi." },
    { id: "type", title: "Tipologia intervento", body: "Fermata, partenza, ripasso, straordinaria, uffici. Si può cambiare: la striscia della card segue il tipo." },
    { id: "pax", title: "Pax-in e pax-out", body: "Ospiti in arrivo e in uscita. Il pax-in si corregge quando ADAM non è allineato. Il pax-out è solo lettura." },
    { id: "times", title: "Inizio, fine, travel, sequenza", body: "WASS li calcola da ordine, spostamento, check-out e durata. Il numero in alto a destra sulla card in timeline è la sequenza." },
    { id: "note", title: "Nota e divani letto", body: "Istruzioni del cliente e letti extra. Restano nel dettaglio, non sulla card." },
  ]);

  return (
    <Stage
      id="task"
      title="La task"
      icon={<Lock className="h-5 w-5" />}
      spots={spots}
      active={active}
      onSelect={setActive}
    >
      <div className="flex flex-wrap items-start gap-4">
        <div className="relative">
          <TaskFace active={active} onSelect={setActive} />
          <Hit id="question" active={active} onSelect={setActive} className="absolute -right-1.5 -top-1.5">
            <span className="flex h-4 w-4 items-center justify-center rounded-full border-2 border-gray-700/80 bg-gray-900/75 text-white">
              <HelpCircle className="h-3 w-3" />
            </span>
          </Hit>
        </div>
        <Hit id="lock" active={active} onSelect={setActive}>
          <span className="relative inline-flex">
            <DemoCard name="18801" alias="CITYLIFE" reference="" />
            <span className="absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border-2 border-gray-700 bg-gray-600 text-white">
              <Lock className="h-2.5 w-2.5" />
            </span>
          </span>
        </Hit>
        <Hit id="collab" active={active} onSelect={setActive}>
          <span className="relative inline-flex">
            <DemoCard name="18455" alias="NAVIGLI" reference="" stripe="bg-yellow-500" />
            <Badge className="absolute -right-1 top-1/2 h-3.5 -translate-y-1/2 bg-purple-500 px-0.5 py-0 text-[10px] hover:bg-purple-500">
              👥
            </Badge>
          </span>
        </Hit>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <FieldHit id="duration" active={active} onSelect={setActive} label="Durata pulizia" value="1:30 ore" editable />
        <FieldHit id="address" active={active} onSelect={setActive} label="Indirizzo" value="VIA TORINO 12, MILANO" />
        <FieldHit id="keys" active={active} onSelect={setActive} label="Accesso" value="Chiave classica — Portineria, gancio 12" />
        <FieldHit id="type" active={active} onSelect={setActive} label="Tipologia intervento" value="Partenza" editable />
        <FieldHit id="pax" active={active} onSelect={setActive} label="Pax-in / Pax-out" value="2 / 2" editable />
        <FieldHit id="times" active={active} onSelect={setActive} label="Inizio – fine · travel · sequenza" value="10:00 – 11:30 · 15 min · 1" />
        <FieldHit id="note" active={active} onSelect={setActive} label="Nota cliente · divani letto" value="Lasciare le chiavi sul tavolo · nessuno" />
        <FieldHit id="out" active={active} onSelect={setActive} label="Check-out" value="05/10/2026 - 10:00" editable />
      </div>
    </Stage>
  );
}

function FieldHit({
  id,
  active,
  onSelect,
  label,
  value,
  editable,
}: {
  id: string;
  active: string;
  onSelect: (id: string) => void;
  label: string;
  value: string;
  editable?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={cn("rounded-md px-2 py-1 text-left transition", active === id && SELECTED)}
    >
      <p className="flex items-center gap-1 text-sm font-semibold text-muted-foreground">
        {label}
        {editable && <Pencil className="h-3 w-3 text-muted-foreground/60" />}
      </p>
      <span className="mt-1 block text-sm text-foreground">{value}</span>
    </button>
  );
}

function TaskFace({
  active,
  onSelect,
}: {
  active: string;
  onSelect: (id: string) => void;
}) {
  return (
    <span className="relative flex h-10 w-max items-center rounded-md border bg-card px-2 shadow-sm">
      <Hit id="stripe" active={active} onSelect={onSelect}>
        <span className="absolute bottom-[2px] left-[2px] top-[2px] w-1.5 rounded-sm bg-green-500" />
      </Hit>
      <span className="min-w-0 pl-2">
        <span className="flex items-center gap-1">
          <Hit id="code" active={active} onSelect={onSelect}>
            <span className="text-[13px] font-extrabold leading-none">18420</span>
          </Hit>
          <Hit id="ref" active={active} onSelect={onSelect}>
            <span className="text-[11px] font-bold text-red-600 dark:text-red-400">(ROSSI)</span>
          </Hit>
        </span>
        <Hit id="alias" active={active} onSelect={onSelect}>
          <span className="block text-[9px] font-semibold leading-none opacity-80">DUOMO (Bilocale)</span>
        </Hit>
      </span>
      <span className="ml-3 flex flex-col items-end gap-0.5">
        <Hit id="out" active={active} onSelect={onSelect}>
          <span className="text-[11px] font-bold leading-none text-[#137537]">↑ 10:00</span>
        </Hit>
        <Hit id="in" active={active} onSelect={onSelect}>
          <span className="text-[11px] font-bold leading-none text-red-600">↓ 15:00</span>
        </Hit>
      </span>
    </span>
  );
}

function DemoCard({
  name = "18420",
  alias = "DUOMO",
  reference = "ROSSI",
  stripe = "bg-green-500",
  highlighted = false,
  surface = "bg-card",
}: {
  name?: string;
  alias?: string;
  reference?: string;
  stripe?: string;
  highlighted?: boolean;
  surface?: string;
}) {
  return (
    <span
      className={cn(
        "relative flex h-10 w-max items-center rounded-md border px-2 shadow-sm",
        surface,
        highlighted && "task-border-search-highlighted"
      )}
    >
      <span className={cn("absolute bottom-[2px] left-[2px] top-[2px] w-1.5 rounded-sm", stripe)} />
      <span className="pl-2">
        <span className="flex items-center gap-1">
          <span className="text-[13px] font-extrabold leading-none">{name}</span>
          {reference && <span className="text-[11px] font-bold text-red-600 dark:text-red-400">({reference})</span>}
        </span>
        <span className="block text-[9px] font-semibold leading-none opacity-80">{alias} (Bilocale)</span>
      </span>
      <span className="ml-3 flex flex-col items-end">
        <span className="text-[11px] font-bold leading-none text-[#137537]">↑ 10:00</span>
        <span className="text-[11px] font-bold leading-none text-red-600">↓ 15:00</span>
      </span>
    </span>
  );
}
