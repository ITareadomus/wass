import { useEffect, useState } from "react";
import { Building2, Calendar, ChevronLeft, ChevronRight, Truck } from "lucide-react";
import { HousekeepingPractice } from "@/components/tutorial/housekeeping-practice";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    target: "date",
    title: "Scegli la giornata",
    body: "Il calendario accanto al titolo carica containers, timeline e cleaner convocati di quel giorno. In questa prova la data è il 5 ottobre 2026.",
  },
  {
    target: "switch",
    title: "Housekeeping o Logistica",
    body: "Il selettore cambia pianificazione. Housekeeping assegna i cleaner agli appartamenti. Logistica assegna gli autisti. Questo percorso resta su Housekeeping.",
  },
  {
    target: "search",
    title: "Cerca una task",
    body: "Scrivi un codice ADAM, un alias, un indirizzo o un cliente. Prova con ROSSI: la card si accende di giallo.",
  },
  {
    target: "sync",
    title: "Sync from ADAM",
    body: "Il pallino rosso segnala novità da ADAM. Aprilo e scegli se aggiornare solo gli appartamenti oppure anche le assegnazioni. Qui non parte nessuna sync vera.",
  },
  {
    target: "assign",
    title: "Assegna tutta la giornata",
    body: "Questo Assegna lancia le tre ondate in ordine: Early out, poi High priority, poi Low priority. Le task bloccate non si muovono.",
  },
  {
    target: "eo",
    title: "Container Early out",
    body: "Le task ancora senza cleaner stanno in tre colonne. Early out è la prima: chi deve uscire presto si assegna prima del resto.",
  },
  {
    target: "duplicate",
    title: "Duplicati",
    body: "Il riquadro tratteggiato raccoglie due card dello stesso appartamento. In produzione di solito ne resta attiva una.",
  },
  {
    target: "multi",
    title: "Selezione multipla",
    body: "Il quadratino numera le card nell'ordine dei click. Se ne trascini una, si spostano tutte insieme.",
  },
  {
    target: "assign-eo",
    title: "Assegna solo questa colonna",
    body: "L'Assegna dentro Early out sistema soltanto quelle task. High priority resta spento finché in timeline non c'è una Early out. Low priority aspetta entrambe.",
  },
  {
    target: "task",
    title: "Apri o trascina la card",
    body: "Un click apre tutti i dati: orari, pax, chiave, nota. Il trascinamento la mette su un cleaner, oppure in un altro container. Provalo su 18420.",
  },
  {
    target: "hp",
    title: "High priority e Low priority",
    body: "High priority è la seconda ondata, Low priority l'ultima. Si sbloccano solo quando le ondate precedenti sono già in timeline.",
  },
  {
    target: "hide",
    title: "Nascondi i containers",
    body: "La linguetta chiude le tre colonne per lasciare spazio alla timeline. Si riapre dallo stesso punto.",
  },
  {
    target: "timeline-title",
    title: "La timeline",
    body: "Ogni riga è un cleaner convocato. Il punto esclamativo giallo ricorda che, sulle task corte, alcuni orari si vedono solo passando il mouse.",
  },
  {
    target: "bands",
    title: "Fasce della giornata",
    body: "Le graffe EO, HP e LP sopra gli orari dividono la giornata. Le card si appoggiano all'orario calcolato: inizio, travel, attesa del check-out, durata.",
  },
  {
    target: "cleaner",
    title: "Il cleaner",
    body: "Il pallino è il colore dei suoi punti in mappa. Premium o Standard è il ruolo. Un click sul nome, nella pagina vera, apre la persona; il doppio click filtra la mappa.",
  },
  {
    target: "shift",
    title: "Primo appartamento",
    body: "−30 e +30 spostano l'inizio di tutta la riga, a scatti di mezz'ora. Nella pagina vera lo stesso gesto è la maniglia sulla prima card.",
  },
  {
    target: "colors",
    title: "Colori stato",
    body: "Acceso, la pulizia in corso è azzurra e quella conclusa è verde. Spento, le card tornano al colore normale.",
  },
  {
    target: "toolbar",
    title: "Storico, statistiche, mappa",
    body: "Storico elenca le modifiche. Statistiche conta le task. Mappa mostra gli appartamenti. Convocazioni sceglie i cleaner. Reset rimette le task nei container.",
  },
  {
    target: "footer",
    title: "Chiudi la giornata",
    body: "Aggiungi cleaner inserisce un convocato. Inizio giornata operativa blocca le modifiche. Trasferisci su ADAM invia cleaner, sequenza e orari. Qui non viene inviato nulla.",
  },
] as const;

export default function HousekeepingStepTutorial() {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  useEffect(() => {
    const measure = () => {
      const node = document.querySelector(`[data-tour="${step.target}"]`);
      setRect(node instanceof HTMLElement ? node.getBoundingClientRect() : null);
    };
    const node = document.querySelector(`[data-tour="${step.target}"]`);
    node?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    measure();
    const timers = [80, 240, 480].map((delay) => window.setTimeout(measure, delay));
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [step.target]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "ArrowRight") {
        setIndex((current) => Math.min(STEPS.length - 1, current + 1));
      }
      if (event.key === "ArrowLeft") {
        setIndex((current) => Math.max(0, current - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-screen bg-background pb-28 text-foreground" data-testid="housekeeping-step-tutorial">
      <style>{`[data-tour]{scroll-margin-top:72px;scroll-margin-bottom:140px;}`}</style>
      <div className="mx-auto w-full max-w-[1920px] px-4 pb-6 pt-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <h1 className="text-[25px] font-bold leading-[44px]">Assegnazioni Housekeeping del</h1>
            <Button
              type="button"
              variant="outline"
              data-tour="date"
              className="border-2 border-custom-blue text-[13px] font-normal"
            >
              <Calendar className="mr-2 h-4 w-4" />
              05/10/2026
            </Button>
          </div>
          <div
            data-tour="switch"
            className="inline-flex items-center gap-0.5 rounded-md border-2 border-custom-blue bg-background p-0.5"
            role="tablist"
            aria-label="Passa tra Housekeeping e Logistica"
          >
            <span className="inline-flex items-center gap-2 rounded-md bg-custom-blue-light px-3 py-2 text-sm font-medium text-custom-blue">
              <Building2 className="h-4 w-4" />
              Housekeeping
            </span>
            <span className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground">
              <Truck className="h-4 w-4" />
              Logistica
            </span>
          </div>
        </div>

        <HousekeepingPractice tour spotlight={step.target} />
      </div>

      {rect && (
        <div
          className="pointer-events-none fixed z-40 rounded-lg border-2 border-[hsl(199,89%,48%)]"
          style={{
            top: Math.max(8, rect.top - 6),
            left: Math.max(8, rect.left - 6),
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(15, 23, 42, 0.55)",
          }}
        />
      )}

      <div className="fixed inset-x-0 bottom-0 z-50 border-t-2 border-custom-blue bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1920px] flex-wrap items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-custom-blue">
              Passo {index + 1} di {STEPS.length}
            </p>
            <p className="text-base font-semibold text-foreground">{step.title}</p>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="mr-2 hidden items-center gap-1 sm:flex" aria-hidden>
              {STEPS.map((item, itemIndex) => (
                <span
                  key={item.target}
                  className={cn(
                    "h-1.5 rounded-full transition-all",
                    itemIndex === index ? "w-4 bg-[hsl(199,89%,48%)]" : "w-1.5 bg-sky-200 dark:bg-sky-900"
                  )}
                />
              ))}
            </div>
            <Button
              type="button"
              variant="outline"
              className="border-2 border-custom-blue"
              disabled={index === 0}
              onClick={() => setIndex((current) => Math.max(0, current - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              Indietro
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-2 border-custom-blue bg-custom-blue-light text-custom-blue hover:bg-custom-blue-light"
              onClick={() => setIndex((current) => (current >= STEPS.length - 1 ? 0 : current + 1))}
            >
              {last ? "Ricomincia" : "Avanti"}
              {!last && <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
