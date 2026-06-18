---
name: timeline dynamic scale
overview: Implementare una timeline oraria dinamica dove scala, card, griglia, travel time, waiting gap e range visibile usano un unico calcolo coerente basato sulla durata minima leggibile della giornata.
todos:
  - id: timeline-helpers
    content: Aggiungere helper robusti per leggere durata, start/end e travel time in minuti.
    status: completed
  - id: shortest-task-scale
    content: Calcolare la durata minima valida e derivare `timelinePxPerMinute` dalla larghezza minima leggibile.
    status: completed
  - id: dynamic-visible-range
    content: Calcolare start/end dinamici della timeline con arrotondamento e buffer finale.
    status: completed
  - id: grid-width-update
    content: Sostituire la scala fissa con `timelineContentWidthPx` e aggiornare header/griglia/fasce.
    status: completed
  - id: task-card-scale
    content: Aggiornare `TaskCard` per usare la scala comune e rispettare la larghezza minima.
    status: completed
  - id: travel-gap-offset-scale
    content: Ricalcolare travel time, waiting gap e offset iniziale con `timelinePxPerMinute`.
    status: completed
  - id: validation
    content: Verificare UI e linter/diagnostics sui file modificati.
    status: completed
isProject: false
---

# Piano Timeline Dinamica

## Scopo
Aggiornare la timeline housekeeping in [client/src/components/timeline/timeline-view.tsx](client/src/components/timeline/timeline-view.tsx) e [client/src/components/drag-drop/task-card.tsx](client/src/components/drag-drop/task-card.tsx) per calcolare dinamicamente la dimensione della griglia oraria e delle card.

## Comportamento Atteso
- La task più corta della giornata determina la scala minima leggibile.
- La larghezza minima tiene conto di contenuto, padding, bordi e margine di sicurezza.
- Task, travel time, waiting gap e offset iniziale usano la stessa scala `pxPerMinute`.
- La timeline termina poco dopo l’ultimo elemento utile della giornata, invece di arrivare sempre alle `19:00`.
- Se l’ultimo task finisce alle `15:10`, la timeline può essere visibile fino a circa `17:00`, aumentando lo spazio disponibile per le card.

## Implementazione

1. In `TimelineView`, aggiungere helper per convertire in minuti:
   - `duration` formato `H.MM`;
   - `cleaning_time` / `cleaningTime`;
   - `start_time`, `end_time`, `fw_start_time`, `startTime`.

2. Calcolare il task più corto della giornata:
   - considerare solo task assegnati/visibili nella timeline;
   - ignorare durate `0`, `null`, `undefined` o non numeriche;
   - usare fallback conservativo se nessuna durata valida esiste.

3. Definire una costante centrale, per esempio:

```ts
const MIN_TIMELINE_TASK_WIDTH_PX = 150;
```

Questa rappresenta la larghezza minima leggibile comprensiva di testo, padding, bordo e margine visivo. Potrà essere regolata dopo verifica UI.

4. Calcolare la scala comune:

```ts
const timelinePxPerMinute = MIN_TIMELINE_TASK_WIDTH_PX / shortestTaskMinutes;
```

5. Calcolare il range temporale visibile:
   - start: ora intera iniziale già usata dalla griglia;
   - end: massimo tra `end_time` e fallback `start_time + taskDuration`;
   - includere travel time/waiting gap quando estendono la riga;
   - arrotondare all’ora successiva;
   - aggiungere buffer finale, ad esempio 60-120 minuti;
   - usare fallback alle `19:00` solo se i dati non sono affidabili.

6. Sostituire la scala fissa attuale:

```ts
const timelineWidthScale = 1.06;
const timelineScaledWidth = `${timelineWidthScale * 100}%`;
const timelineTaskWidthPx = timelineWidthPx * timelineWidthScale;
```

con una larghezza pixel-based:

```ts
const timelineVisibleMinutes = timelineEndMinutes - timelineStartMinutes;
const timelineContentWidthPx = Math.max(
  timelineWidthPx,
  timelineVisibleMinutes * timelinePxPerMinute
);
const timelineScaledWidth = `${timelineContentWidthPx}px`;
```

7. Aggiornare la griglia oraria:
   - `generateGlobalTimeSlots` deve generare slot fino alla fine dinamica;
   - `getGlobalTimelineMinutes` deve usare `timelineEndMinutes` dinamico;
   - `minutesToPct` deve usare start/end reali della timeline visibile;
   - EO/HP/LP devono essere clampate nel range visibile.

8. Aggiornare `TaskCard`:
   - aggiungere props opzionali tipo `timelinePxPerMinute` e `minTimelineTaskWidthPx`;
   - in timeline calcolare la width con la scala comune:

```ts
const widthPx = effectiveMinutes * timelinePxPerMinute;
return `${Math.max(widthPx, minTimelineTaskWidthPx)}px`;
```

9. Aggiornare travel time, waiting gap e initial offset in `TimelineView`:

```ts
const travelWidthPx = travelTime * timelinePxPerMinute;
const waitingGapWidthPx = waitingGap * timelinePxPerMinute;
const initialOffsetWidthPx = timeOffset * timelinePxPerMinute;
```

Questo elimina la dipendenza da `globalTimeSlots.length * 60` per le misure in pixel.

## Criteri di Accettazione
- Una task da 15 minuti non ha testo/orari che escono dalla card.
- Una task da 30 minuti è larga circa il doppio di una task da 15 minuti.
- Travel time da 15 minuti occupa la stessa larghezza temporale di una task da 15 minuti.
- Waiting gap e offset iniziale sono allineati alla griglia.
- Se la giornata termina presto, la timeline non mostra ore inutili fino alle `19:00`.
- Se la giornata termina tardi, la timeline rimane scrollabile senza comprimere le card.
- Non vengono introdotti errori linter nei file modificati.

## Verifica
- Controllare manualmente una giornata corta, una giornata lunga e una giornata con travel time significativo.
- Controllare che header orario e righe task restino sincronizzati nello scroll orizzontale.
- Eseguire diagnostics/linter sui file toccati dopo l’implementazione.