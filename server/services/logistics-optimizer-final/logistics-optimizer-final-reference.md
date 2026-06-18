# Logistics Optimizer Final — reference

> **Nome file:** `logistics-optimizer-final-reference.md`  
> **Modulo:** `server/services/logistics-optimizer-final`  
> **Ultimo aggiornamento:** 2026-06-17  
> **Stato:** in produzione (`POST /api/logistics-optimizer-final/run`)

Documento di riferimento per l'optimizer logistics attuale: architettura, contratti dati, regole di dominio e confronto con il modulo legacy.

Le sezioni **2–20** descrivono il comportamento del vecchio `logistics-optimizer` (archivio utile per capire le migrazioni). Le sezioni **1, 21–25** descrivono l'implementazione corrente.

## 1. Obiettivo di questo file

Documentare il modulo `logistics-optimizer-final` e il suo rapporto col legacy, separando tre responsabilità — tutte oggi nel modulo final:

1. **Data preparation / pre-solver** — loader, finestre, vincoli, `RoutingProblemInput`
2. **Decision engine** — `greedy-v1` (debug) \| `ortools-v1` (produzione)
3. **Apply / persistenza** — `apply-routing-solution.ts` (timeline + containers)

Il modulo **non** chiama `runLogisticsPhase0`, `runLogisticsPhase1` né `runLogisticsPhase2`. Usa loader puri, risolve il VRP e applica `RoutingSolution`.

---

## 1.1 Moduli implementati

### Pre-solver e contratti

| Modulo | Ruolo |
|---|---|
| `loaders.ts` | `loadUnlockedLogisticsTasks`, `loadSelectedDrivers`, `loadWindowConfig`, `loadLogisticsRoutingSourceData` |
| `timeline-assignment-hints.ts` | `parsePreAssignedTimelineEntries`, `loadTimelineAssignmentHints`, `buildRequiredDriverConstraints` |
| `auto-convoke-logistics-drivers.ts` | `autoConvokeLogisticsDriversWithPreAssignedTasks` (M5c) |
| `input-contract.ts` | `RawLogisticsTaskInput`, `RoutingProblemInput`, `HardConstraintSpec`, `SoftConstraintSpec` |
| `bag-handling.ts` | `BagHandling`, `computeBagHandling`, `requiresDriverBeforeCleaner` |
| `business-rules.ts` | Regole tracciate EO/HP/LP, checkout, cleaner 2/3 |
| `windows.ts` | `buildTaskWindow` — finestre hard/soft per task |
| `normalizers.ts` | Normalizzazione driver e priority |
| `travel-matrix.ts` | Depot, nodi, `buildTravelMatrixMin` |
| `build-routing-input.ts` | `buildLogisticsRoutingInput`, `buildRoutingProblemInputFromSource` |
| `validation.ts` | `validateRoutingProblemInput` (modalità `debug` \| `solver` \| `apply`) |
| `groups/*` | Business groups M5b (same-building, nearby, cleaner, sequence, priority) |

### Solver

| Modulo | Ruolo |
|---|---|
| `solver/solve-routing.ts` | Dispatcher `greedy-v1` \| `ortools-v1` |
| `solver/greedy-routing-solver.ts` | Solver greedy per debug/regressione |
| `solver/ortools/ortools-adapter.ts` | `buildOrToolsPayload`, `decodeOrToolsSolution`, cost shaping GEO/M5b |
| `solver/ortools/ortools-routing-solver.ts` | Invocazione subprocess Python |
| `solver/ortools/logistics_routing_ortools.py` | VRP OR-Tools (time windows, required, disjunctions) |
| `solver/ortools/required-infeasible.ts` | Diagnostica `INVALID` su required infeasible |

### Solution, apply, orchestrazione

| Modulo | Ruolo |
|---|---|
| `solution-contract.ts` | `RoutingSolution`, status, solver IDs |
| `solution-validation.ts` | `validateRoutingSolution` post-solver |
| `solution-apply-gate.ts` | Gate apply (`INVALID` / `INFEASIBLE` / `PARTIAL`) |
| `apply-routing-solution.ts` | Apply timeline + containers (M6) |
| `unassigned-diagnostics.ts` | Diagnostica task droppati |
| `run-routing-dry.ts` | Dry-run senza apply |
| `run-routing.ts` | Pipeline completa con apply opzionale |
| `run-routing-input-debug.ts` | Solo `RoutingProblemInput` + debug JSON |
| `debug-writer.ts` | Artefatti in `server/debug/logistics-optimizer-final/` |
| `index.ts` | Re-export pubblico del modulo |

### Pipeline produzione

```txt
autoConvokeLogisticsDriversWithPreAssignedTasks   # side effect su lg_selected_drivers
  → loadLogisticsRoutingSourceData(workDate)
  → buildRoutingProblemInputFromSource(source)
  → validateRoutingProblemInput (mode: solver)
  → solveRouting(input, { solverId })             # default: ortools-v1
  → validateRoutingSolution
  → evaluateSolutionApplyGate
  → applyLogisticsRoutingSolution (se apply=true)
```

**Non fa (rispetto al legacy):** bande latitudinali, competitive grouping greedy, repair insertion, scoring progressivo in Phase 2.

**Tipi autonomi:** `RawLogisticsTaskInput` in `input-contract.ts` (nessun import da `phase0.ts`).

**Classi task (§22):**

- **Container-locked** — esclusi in `loadUnlockedLogisticsTasks`, mai in `tasks[]`
- **Pre-assigned** — in `tasks[]` + `REQUIRED_DRIVER_TASK`; driver fisso, tempo/ordine flessibili
- **Free** — in `tasks[]`, nessun vincolo driver

### API HTTP

| Endpoint | Apply | Note |
|---|---|---|
| `GET /api/logistics-optimizer-final/precheck` | No | Controlli pre-run |
| `POST /api/logistics-optimizer-final/routing-input-debug` | No | Solo input JSON |
| `POST /api/logistics-optimizer-final/run-dry` | No | Solver + debug artifacts |
| `POST /api/logistics-optimizer-final/run` | Opzionale (`apply: true`) | Produzione |
| `POST /api/logistics-optimizer/run` | — | **410** — redirect al modulo final |

UI: `client/src/pages/generate-logistics-assignments.tsx` chiama `/run` con `apply: true`, `solver: "ortools-v1"`.

### Test

Suite in `shared/logisticsOptimizerFinal*.test.ts` — **123 test** su pre-solver, validation, timeline hints, auto-convoke, OR-Tools adapter, greedy, solution validation, business groups, diagnostics.

**Gap noto:** nessun test unitario su `applyLogisticsRoutingSolution` (save timeline, rimozione containers, preserve).

---

## 2. Mappa file legacy (`logistics-optimizer`) — archivio

> **Nota:** il modulo legacy è disabilitato (HTTP 410). Questa sezione resta come riferimento storico per le migrazioni.

| File | Ruolo attuale |
|---|---|
| `server/services/logistics-optimizer/index.ts` | Orchestrazione completa: Phase 0 → Phase 1 → Phase 2 → Apply. |
| `server/services/logistics-optimizer/phase0.ts` | Carica i task logistici da `lg_containers`, aggiunge lock e contesto cleaner da `daily_assignments_current`. |
| `server/services/logistics-optimizer/phase1.ts` | Carica driver selezionati e crea candidati task con coordinate; costruisce bande geografiche per latitudine. |
| `server/services/logistics-optimizer/phase2.ts` | Algoritmo decisionale attuale: grouping, simulazioni, hard constraints, soft scoring, repair, debug. È la parte da abbandonare/rifare. |
| `server/services/logistics-optimizer/bag-rule.ts` | Calcola la policy borsone: `NORMAL_TASK`, `DRIVER_BRINGS_BAG`, `CLEANER_HAS_BAG`. |
| `server/services/logistics-optimizer/logistics-driver-schedule.ts` | Simula una route driver: travel, checkout wait, start/end, check-in violations. |
| `server/services/logistics-optimizer/apply-validation.ts` | Valida la timeline finale dopo il ricalcolo. |
| `shared/logistics-scheduling-constraints.ts` | Costanti e funzioni comuni: durata task logistica, check-in/checkout applicability. |
| `server/routes.ts` | Endpoint `POST /api/logistics-optimizer/run`. |

---

## 3. Flusso legacy end-to-end (`logistics-optimizer`)

### 3.1 Trigger

Il frontend chiama:

```http
POST /api/logistics-optimizer/run
```

Payload tipico:

```json
{
  "date": "YYYY-MM-DD",
  "debug": true,
  "competitiveGrouping": true
}
```

Nel backend la route importa dinamicamente `runLogisticsOptimizer(workDate, { debug, competitiveGrouping })`.

### 3.2 Orchestrazione legacy

Il vecchio `runLogisticsOptimizer` fa:

```ts
phase0 = runLogisticsPhase0(workDate)
phase1 = runLogisticsPhase1(workDate, phase0.unlockedTaskData)
phase2 = runLogisticsPhase2(workDate, phase0.unlockedTaskData, phase1, debugCollector, competitiveGrouping)
apply = applyLogisticsOptimizerResult(workDate, phase0, phase1, phase2)
```

Se una fase non può partire, l'apply non viene eseguito.

---

## 4. Come preleva i dati (legacy)

Le sezioni 4.x descrivono il modulo **legacy**. Il modulo **final** replica la query task/driver senza Phase 1 né bande latitudinali.

## 4.1 Phase 0 legacy — task logistici + lock + contesto housekeeping

File: `phase0.ts`

Query base:

- Tabella primaria: `lg_containers lc`
- Lock giornalieri: `daily_task_locks dtl`
- Contesto cleaner via lateral join su `daily_assignments_current dac`

Campi principali estratti:

```ts
taskId
logisticCode
priority
cleaningTime
lat, lng
checkinDate, checkoutDate
checkinTime, checkoutTime
premium
paxIn
cleanerId
cleanerStartTime
cleanerTaskStartTime
cleanerSequence
locked
lockedReason
```

Regola Phase 0:

- Tutti i task in `lg_containers` per `workDate` vengono caricati.
- Se `daily_task_locks.locked = true` oppure il container risulta locked, il task viene escluso dall'optimizer.
- I task locked non vengono ricalcolati da Phase 2, ma possono essere preservati in apply se già presenti in timeline.

Output rilevante:

```ts
unlockedTaskData: LogisticsTaskInputWithLock[]
lockedTasksExcluded: number
```

## 4.2 Phase 1 legacy — driver selezionati + candidati schedulabili (deprecato nel final)

File: `phase1.ts`

Driver:

- Caricati da `pgDailyAssignmentsService.loadSelectedLogisticsDrivers(workDate)`.
- Dettagli caricati con `loadLgDriversByIds`.
- `startTime` default: `10:00` se assente.

Task candidates:

- Entrano solo i task unlocked con `lat` e `lng` numerici.
- Task senza coordinate sono esclusi da Phase 1 e quindi non arrivano a Phase 2.

Phase 1 costruisce anche bande geografiche per latitudine:

- `latMin`, `latMax` sui task candidati.
- Numero bande = numero driver selezionati.
- Ogni driver ottiene una fascia latitudinale.
- Ogni task riceve `assignedBandIndex` e `assignedDriverId` preferito.

Questa non è una regola hard: è una preferenza geografica usata dallo scoring.

## 4.3 Phase 2 — arricchimento task

File: `phase2.ts`, funzione `buildPhase2Tasks`.

A ogni candidate Phase 1 vengono riattaccati:

- check-in / checkout date/time;
- cleaning time;
- cleaner id;
- cleaner start time;
- cleaner task start time;
- cleaner sequence;
- premium;
- pax-in;
- priority normalizzata;
- bag policy.

---

## 5. Tipologia task logistico attiva

File: `shared/logistics-task-kind.ts`

```ts
type LogisticsTaskKind = "pick-up" | "delivery" | "delivery/pick-up";
// null = non determinato
```

Regole auto:

| Tipologia | Condizione |
|---|---|
| `null` | Nessun cleaner/sequence. |
| `pick-up` | `sequence === 1`, non premium, `pax_in <= 4`. |
| `delivery/pick-up` | Cleaner presente e (`sequence !== 1` oppure premium oppure `pax_in > 4`). |
| `delivery` | Solo manuale; dotazione/materiale, non regola borsone. |

Funzione chiave:

```ts
requiresDriverBeforeCleaner(kind)
```

Ritorna `true` solo per `delivery/pick-up`.

Nota importante: la tipologia non esclude task dall'optimizer. Influenza finestre, deadline e scoring. I nomi legacy `NORMAL_TASK`, `DRIVER_BRINGS_BAG`, `CLEANER_HAS_BAG` restano ammessi solo in trace/debug o nel legacy optimizer disabilitato.

---

## 6. Regole hard attuali

## 6.1 Coordinate obbligatorie

Hard pre-filter:

- senza coordinate valide, il task viene escluso dai candidati Phase 1;
- non appare nella soluzione optimizer.

## 6.2 Driver obbligatori

Hard precondition:

- se non ci sono driver logistica selezionati per la data, l'optimizer non parte;
- reason code: `NO_SELECTED_DRIVERS` in Phase 1.

## 6.3 Task locked esclusi

Hard pre-filter:

- task locked esclusi in Phase 0;
- possono rimanere preservati in timeline se già assegnati manualmente o presenti prima dell'optimizer.

## 6.4 Durata servizio logistica

Costante condivisa:

```ts
LOGISTICS_SERVICE_DURATION_MIN = 15
```

Ogni task logistico occupa 15 minuti nella route driver.

## 6.5 Travel time

Oggi viene stimato con `estimateCarTravelMinutes`, basato su distanza geografica stimata.

Nel vecchio optimizer housekeeping esiste anche un `TravelTimeProvider` con:

- haversine;
- fattore non lineare 1.5;
- velocità media 18 km/h;
- cache DB.

Nel `logistics-optimizer` attuale la travel matrix viene precomputata in Phase 2 fra task schedulabili, ma resta una stima interna, non un input pulito.

## 6.6 Checkout

File: `shared/logistics-scheduling-constraints.ts` e `logistics-driver-schedule.ts`.

Regola per `logistics-optimizer-final`:

- se `checkout_time` esiste e `checkout_date` è assente oppure coincide con `workDate`, il checkout è applicabile;
- il servizio logistico può iniziare solo dal checkout in poi;
- il vecchio `CHECKOUT_MAX_WAIT` non è più solver-facing.

Formalmente:

```ts
earliestStartMin = checkoutMin
```

## 6.7 Check-in

Regola attuale:

- il check-in vincola solo se `checkin_date === workDate`;
- il task logistico deve finire entro il check-in;
- inoltre non può iniziare al check-in o dopo.

Formalmente:

```ts
endMin > checkinMin => violation
startMin >= checkinMin => violation
```

Reason code usato:

```ts
CHECKIN_CHECKOUT_CONSTRAINT
```

## 6.8 Priority lower bound e configurazione finestre EO/HP/LP

`logistics-driver-schedule.ts` usa le priority windows caricate da configurazione applicativa persistita in banca dati, oggi tramite JSON salvato in `app_settings` / configurazione equivalente.

Regola architetturale da mantenere nel nuovo algoritmo:

- `EO_Start_Time`, `HP_Start_Time`, `LP_Start_Time` sono **parametri configurabili**;
- il nuovo pre-OR-Tools deve riceverli da un oggetto esplicito, ad esempio `LogisticsWindowConfig`;
- il pre-OR-Tools non deve conoscere valori hardcoded, se non come fallback esplicito e tracciato;
- eventuali modifiche future alle finestre devono avvenire da configurazione/database, non dal codice dell'algoritmo.

Regola attuale nel motore schedule:

- HP/LP non possono iniziare prima della rispettiva `startMin` configurata.
- EO non ha lower bound equivalente nel motore schedule attuale: può iniziare appena il driver è disponibile, compatibilmente con travel, checkout, check-in e vincoli cleaner.
- EO **non deve obbligatoriamente** iniziare prima di `hp_start_time`: l'anticipo EO è una preferenza soft, non un vincolo hard.
- Se anticipare EO consuma capacità utile per task più vincolati o prioritari, il solver deve poter scegliere di schedulare EO dopo `hp_start_time` senza considerarlo una violazione.

Effetto attuale:

```ts
startMin = Math.max(startMin, priorityWindow.startMin)
```

## 6.9 Vincolo cleaner / consegna borsone

File: `phase2.ts`, funzioni `getCleanerViolation`, `getCleanerDeadlineForBagDelivery`.

Per `NORMAL_TASK` e `DRIVER_BRINGS_BAG`:

- riferimento temporale: `cleanerTaskStartTime`, fallback `cleanerStartTime`;
- il driver può iniziare il task logistico dopo l'inizio cleaner solo entro una tolleranza;
- tolleranza = `ceil(2/3 * cleaningTime)`;
- fallback tolleranza = 30 minuti se `cleaningTime` assente o non valida.

Formalmente:

```ts
latestAllowedStart = cleanerReferenceTime + ceil(cleaningTime * 2 / 3)
taskStartMin > latestAllowedStart => CLEANER_TIME_CONSTRAINT
```

Per `CLEANER_HAS_BAG`:

- non esiste vincolo “driver prima del cleaner”;
- il driver deve solo ritirare lo sporco;
- rimangono validi checkout/check-in e finestre generali.

## 6.10 Validazione finale post-recalc

Dopo l'apply:

1. viene costruita la timeline;
2. viene chiamato `recalculateLogisticsTimeline`;
3. viene eseguita `buildFinalTimelineValidation`;
4. `assertLogisticsTimelineValidAfterRecalc` fallisce se ci sono violazioni check-in.

Nota: il checkout wait exceeded è tracciato, ma il throw finale riguarda le violazioni check-in.

---

## 7. Regole soft attuali

Le soft rules sono distribuite dentro `phase2.ts` e mischiate con la fattibilità.

## 7.1 Preferenza banda geografica

Da Phase 1:

- ogni task ha una banda latitudinale;
- ogni driver ha un indice;
- lo scoring penalizza distanza fra `group.seedBandIndex` e `state.driverIndex`.

```ts
bandPenalty = abs(seedBandIndex - driverIndex) * 3
```

## 7.2 Travel minimization locale

Lo score premia route con minore `travelMinutesDelta`.

```ts
score -= travelMinutesDelta
```

## 7.3 Fairness / bilanciamento carico

Penalità attuale:

```ts
fairnessPenalty = projectedLoadMin * 0.3 + projectedTaskCount * 2.5
```

Effetto: limita accumulo su un driver, ma non ottimizza globalmente il bilanciamento.

## 7.4 Continuità stesso indirizzo

Bonus se task consecutivi condividono `addressId`.

```ts
SAME_LOCATION_CONTINUITY_BONUS_PER_PAIR = 8
```

`addressId` viene costruito fondendo:

- stesso `logisticCode`;
- oppure travel stimato <= 1 minuto.

## 7.5 Continuità nearby

Bonus se due task consecutivi sono vicini.

```ts
NEARBY_TASKS_TRAVEL_MAX_MIN = 5
NEARBY_CONTINUITY_BONUS_PER_PAIR = 2
```

## 7.6 Continuità cleaner sequence

Bonus se un task continua la sequenza del cleaner già servita dal driver.

Penalità se due task consecutivi dello stesso cleaner saltano sequenza.

```ts
CLEANER_SEQUENCE_BREAK_PENALTY = 5
```

## 7.7 Group origin bonus

Bonus piccoli per:

- cleaner cluster;
- strong location cluster;
- urgenza borsone.

## 7.8 Slack penalty

Penalizza route troppo vicine ai limiti hard:

- check-in;
- cleaner tolerance;
- checkout come lower bound hard dello start.

Soglia:

```ts
SLACK_THRESHOLD_MIN = 15
```

## 7.9 Priority penalty

Le priority windows aggiungono penalty/bonus qualitativi, oltre al lower bound hard su HP/LP.

Esempi:

- EO può ricevere bonus se anticipato;
- HP può ricevere bonus se dentro finestra preferita;
- LP penalizzato se troppo presto.

## 7.10 Fragmentation penalty

Penalizza candidati che separano task molto vicini, stesso indirizzo o stesso logistic code.

Costanti principali:

```ts
SAME_LOCATION_FRAGMENTATION_PENALTY = 150
SAME_LOGISTIC_CODE_FRAGMENTATION_PENALTY = 150
VERY_NEAR_FRAGMENTATION_PENALTY = 35
```

Serve a evitare split locali, ma aumenta complessità e non risolve il globale.

## 7.11 Route linearity penalty

Penalizza pattern come:

- ritorno allo stesso indirizzo dopo stop intermedi;
- scelta del prossimo task non vicino rispetto ad alternative future;
- gap fra task uguali/vicini.

È applicata come delta fra route prima e route dopo l'inserimento.

---

## 8. Come raggruppa oggi Phase 2

## 8.1 Pre-cluster per cleaner

I task con cleaner e sequence vengono ordinati per:

1. `cleanerSequence`
2. `cleanerTaskStartTime`
3. `taskId`

Poi vengono clusterizzati se compatibili geograficamente:

```ts
CLEANER_CLUSTER_MAX_STEP_TRAVEL_MIN = 10
CLEANER_CLUSTER_MAX_RADIUS_TRAVEL_MIN = 12
GROUP_MAX_TASKS = 4
```

## 8.2 Strong location clusters

Prima del fallback geografico, raggruppa task dello stesso indirizzo forte:

- stesso `logisticCode`; oppure
- travel stimato <= 1 minuto.

Dimensione max:

```ts
MAX_STRONG_CLUSTER_SIZE = 4
```

## 8.3 Geographic fallback

Per task non clusterizzati:

- seed ordinati per deadline/urgenza;
- aggiunge il candidato pending migliore se:
  - nearest travel al gruppo <= 8 minuti;
  - travel dal centroide <= 10 minuti;
  - max task gruppo = 4.

```ts
GEO_FALLBACK_MAX_STEP_TRAVEL_MIN = 8
GEO_FALLBACK_MAX_RADIUS_TRAVEL_MIN = 10
GROUP_MAX_TASKS = 4
```

## 8.4 Singleton fallback

Task urgenti che non entrano in cluster diventano singleton.

## 8.5 Ordinamento gruppi legacy

I gruppi vengono ordinati per:

1. deadline più stretta;
2. presenza urgenza borsone;
3. tipo gruppo: cleaner cluster → strong location → geo fallback → singleton;
4. dimensione gruppo maggiore;
5. id gruppo.

---

## 9. Competitive grouping attuale

Nel codice caricato dalla route, `competitiveGrouping` di default è ON.

Invece di processare una coda fissa di gruppi, Phase 2 rigenera a ogni iterazione candidati dal pool residuo:

Tipi candidati:

```ts
SAME_LOCATION
CLEANER_SEQUENCE
NEARBY_MICRO
SINGLETON
```

Per ogni iterazione:

1. costruisce tutti i candidati dai task rimasti;
2. fa cheap ranking;
3. prende top-N + urgenti;
4. per ogni candidato prova tutti i driver;
5. simula ordini e possibili inserimenti;
6. applica score finale con travel, fairness, fragmentation, linearity, risk lookahead;
7. consuma i task del candidato vincitore;
8. se nessun full assignment è possibile, tenta partial assignment;
9. alla fine tenta repair insertion sui task non assegnati.

Questo spiega perché oggi è buono localmente ma debole globalmente:

- l'algoritmo prende decisioni greedy incrementali;
- ogni scelta consuma task e invalida candidati futuri;
- le penalty cercano di correggere effetti globali ma sono patch locali;
- il repair finale inserisce task mancanti ma non ricalcola una soluzione globale ottima.

---

## 10. Simulazione driver attuale

Per ogni driver lo stato contiene:

```ts
driverId
driverIndex
driverStartMin
clockMin
lastLat, lastLng
assignedTasks
totalTravelMinutes
cleanerLastSequence
```

La simulazione costruisce la route completa:

- route già assegnata;
- nuovo gruppo in append oppure in inserimento se abilitato;
- ricalcolo completo schedule driver;
- verifica hard constraints su tutta la route, non solo sui task nuovi.

Se fattibile, produce:

```ts
assignments
fullRouteAssignments
insertIndex
fullRouteTravelMinutes
projectedClockMin
projectedLastLat, projectedLastLng
travelMinutesDelta
score
```

---

## 11. Reason code attuali

```ts
CHECKIN_CHECKOUT_CONSTRAINT
CLEANER_TIME_CONSTRAINT
NO_DRIVER_FEASIBLE
NO_TASK_CANDIDATES
TRULY_IMPOSSIBLE
ROUTE_CAPACITY_OR_ORDERING_CONFLICT
```

Interpretazione:

| Reason | Significato |
|---|---|
| `CHECKIN_CHECKOUT_CONSTRAINT` | Violazione check-in o finestra checkout/check-in impossibile. |
| `CLEANER_TIME_CONSTRAINT` | Il driver arriva oltre la tolleranza rispetto all'inizio cleaner. |
| `NO_DRIVER_FEASIBLE` | Nessun driver riesce a inserire task/gruppo. |
| `NO_TASK_CANDIDATES` | Nessun task schedulabile in input. |
| `TRULY_IMPOSSIBLE` | Anche da solo, il task non è fattibile per alcun driver. |
| `ROUTE_CAPACITY_OR_ORDERING_CONFLICT` | Il task sarebbe fattibile da solo, ma non entra nella route costruita. |

---

## 12. Come applica il risultato finale

> **Implementazione attuale:** `apply-routing-solution.ts` (`applyLogisticsRoutingSolution`).  
> Il flusso sotto descrive il legacy `index.ts`; il modulo final replica la stessa semantica partendo da `RoutingSolution`.

File: `index.ts`, funzione `applyLogisticsOptimizerResult`.

Passi:

1. Carica driver selezionati.
2. Carica containers logistici correnti.
3. Carica timeline logistica corrente.
4. Crea mappe `cleanerIdByTaskId` e `cleanerSequenceByTaskId`.
5. Ricostruisce i task ottimizzati da `phase2.driverPlans` usando i dati originali dei containers.
6. Preserva task già in timeline non rischedulati dall'optimizer.
7. Combina preserved + optimized per driver.
8. Riassegna `sequence` progressiva e `followup`.
9. Ricalcola `bag_policy` per ogni task.
10. Costruisce `drivers_assignments`.
11. Esegue `recalculateLogisticsTimeline(timeline, workDate)`.
12. Valida check-in post-ricalcolo.
13. Salva timeline con `saveLogisticsTimeline`.
14. Salva snapshot history dei containers.
15. Rimuove dai containers i task assegnati dall'optimizer.
16. Salva containers aggiornati.

Output apply:

```ts
applied: true
insertedTasks
removedFromContainers
totalTasksOnTimeline
finalValidation
```

---

## 13. Problemi strutturali individuati

## 13.1 Phase 2 fa troppe cose

Dentro `phase2.ts` ci sono insieme:

- normalizzazione dati;
- clustering;
- candidatura;
- travel matrix;
- hard constraints;
- soft scoring;
- greedy decision loop;
- partial assignment;
- repair;
- debug;
- classificazione unassigned.

Questo rende difficile modificare una regola senza impattare scoring e flusso decisionale.

## 13.2 Ottimizzazione locale, non globale

Il sistema migliora gruppi vicini/locali perché costruisce candidati locali forti, ma non decide globalmente l'intera assegnazione. Le scelte greedy consumano task e driver state progressivamente.

## 13.3 Le soft rules compensano limiti dell'algoritmo

Fragmentation, route linearity, same-location penalties e repair sono diventati meccanismi correttivi. In un modello OR-Tools, molte di queste cose dovrebbero diventare:

- dimensioni;
- vincoli;
- disjunction penalties;
- cost matrix;
- soft time windows;
- vehicle/task compatibility.

## 13.4 Time window non esplicite come input

Oggi le finestre sono calcolate dentro funzioni sparse:

- checkout nel motore schedule;
- check-in nel motore schedule;
- cleaner deadline in Phase 2;
- priority lower bound in schedule;
- slack penalty nello scoring.

Nel nuovo design ogni task dovrebbe avere già:

```ts
serviceWindowStartMin
serviceWindowEndMin
hardEarliestStartMin
hardLatestStartMin
hardLatestEndMin
softWindows[]
```

---

## 14. Nuovo obiettivo pre-OR-Tools

Il nuovo pre-optimizer deve produrre un `RoutingProblemInput` pulito e deterministico.

Responsabilità del pre-OR-Tools:

1. Caricare dati grezzi.
2. Normalizzare date/orari/coordinate.
3. Calcolare bag policy.
4. Calcolare finestre temporali driver.
5. Calcolare finestre temporali task.
6. Calcolare compatibilità task-driver, se necessario.
7. Costruire matrice travel/service.
8. Separare hard constraints da soft preferences.
9. Restituire un input serializzabile e debuggabile.

Non deve:

- scegliere il driver vincitore;
- ordinare definitivamente le route;
- fare greedy grouping decisionale;
- fare repair decisionale.

---

## 15. Regole finestra autista da incorporare nel nuovo pre-OR-Tools

Dal foglio allegato `regole(1).txt`, la finestra utile del driver ha:

### Inizio

1. Check-out migrato da cliente, se presente.
2. Se check-out non migrato, usare la policy configurata per la priority del task:
   - HP/LP: hanno un hard lower bound pari alla rispettiva finestra configurata, oggi derivata da `hp_start_time`;
   - EO: non ha hard lower bound legato a `hp_start_time`; può iniziare prima se il driver è disponibile, ma non è obbligatorio anticiparlo.

Questi valori non sono costanti dell'algoritmo: vengono letti da un JSON configurabile e salvato in banca dati. I valori operativi attuali, ad esempio `hp_start_time = 11:00`, sono configurazione operativa, non logica applicativa.

Regola EO fondamentale:

- EO è una possibilità di anticipo, non un obbligo.
- EO può iniziare prima di `hp_start_time` se questo migliora la soluzione globale.
- EO resta schedulabile anche dopo `hp_start_time`; in quel caso perde il beneficio/bonus di anticipo, ma non viola alcun vincolo hard.
- L'obiettivo del solver deve poter preferire HP/LP, cleaner deadline, check-in stretti, minore travel o migliore bilanciamento se anticipare EO renderebbe la soluzione complessiva peggiore.

### Fine

1. `DRIVER_BRINGS_BAG`: l'autista deve provare ad arrivare prima dello start cleaner; è ammesso uno start logistico fino a `cleanerTaskStartTime + ceil(cleaningTime * 2 / 3)`.
2. Eccezione `CLEANER_HAS_BAG`:
   - task cleaner con sequence = 1 e (`!premium` oppure `pax_in < 4`);
   - il driver può passare in qualunque momento rispettando checkout/check-in, perché deve solo ritirare sporco.
3. Check-in migrato da cliente, se presente.

Nota implementativa: per `DRIVER_BRINGS_BAG` non usare `cleanerTaskEndTime`; la deadline deriva dallo start cleaner.

---

## 16. Contratto dati proposto per nuovo pre-OR-Tools

## 16.1 Tipi base

```ts
type Minutes = number; // minuti da 00:00
type TaskId = number;
type DriverId = number;

type BagHandling =
  | "NO_CLEANER_CONTEXT"
  | "DRIVER_BRINGS_BAG"
  | "CLEANER_HAS_BAG";

type Priority = "EO" | "HP" | "LP" | null;
```

## 16.1.1 Configurazione finestre logistiche

```ts
interface LogisticsWindowConfig {
  source: "app_settings" | "unavailable";
  workDate: string;
  priorityWindows: PriorityWindows | null;
  fallbackUsed: boolean;
  error?: string;
}
```

Questa configurazione deve essere caricata prima del calcolo delle finestre task e passata esplicitamente al pre-OR-Tools. Nessuna funzione del nuovo algoritmo deve contenere valori tipo `10:00` o `11:00` come costanti interne. Se il JSON non è disponibile o è invalido, il fallback deve essere dichiarato nell'output/debug con `fallbackUsed = true`.

## 16.2 Input finale verso solver

```ts
interface RoutingProblemInput {
  schemaVersion: "logistics-routing-input/v1";
  workDate: string;
  windowConfig: LogisticsWindowConfig;
  depot: LocationNode;
  drivers: DriverNode[];
  tasks: TaskNode[];
  travelMatrixMin: number[][];
  serviceDurationMin: number;
  hardConstraints: HardConstraintSpec[];
  softConstraints: SoftConstraintSpec[];
  businessGroups: RoutingBusinessGroup[];  // M5b
  metadata: RoutingProblemMetadata;
}
```

## 16.3 DriverNode

```ts
interface DriverNode {
  id: DriverId;
  startLocationNodeId: string; // sempre "depot"
  endLocationNodeId?: string;
  workWindow: {
    startMin: Minutes;
    endMin: Minutes;
    startSource: "driver_row" | "default";
    endSource: "driver_row" | "default";
  };
  selected: true;
}
```

## 16.4 TaskNode

```ts
interface TaskNode {
  taskId: TaskId;
  logisticCode: number;
  nodeIndex: number; // indice nella matrice travel, depot incluso
  location: {
    lat: number;
    lng: number;
    address?: string | null;
    addressGroupId?: number | null;
  };

  priority: Priority;
  bagHandling: BagHandling;

  serviceDurationMin: Minutes; // oggi 15

  rawTimes: {
    checkoutDate: string | null;
    checkoutTime: string | null;
    checkinDate: string | null;
    checkinTime: string | null;
    cleanerStartTime: string | null;
    cleanerTaskStartTime: string | null;
    cleanerTaskEndTime?: string | null;
  };

  hardWindow: {
    earliestStartMin: Minutes;
    latestStartMin: Minutes;
    latestEndMin: Minutes;
    reasons: string[];
  };

  softWindows: Array<{
    type: "preferred_start" | "preferred_end" | "slack_buffer";
    startMin?: Minutes;
    endMin?: Minutes;
    penaltyPerMin?: number;
    maxPenalty?: number;
    reason: string;
  }>;

  groupingHints: {
    cleanerId: number | null;
    cleanerSequence: number | null;
    addressGroupId: number | null;
    sameLogisticCodeGroup: number | null;
    nearbyGroupCandidates?: TaskId[];
  };

  eligibility: {
    schedulable: boolean;
    exclusionReasons: string[];
  };
}
```

## 16.5 Hard constraints esplicite

```ts
type HardConstraintSpec =
  | {
      type: "TASK_TIME_WINDOW";
      taskId: TaskId;
      earliestStartMin: Minutes;
      latestStartMin: Minutes;
      latestEndMin: Minutes;
      sourceRules?: string[];
    }
  | {
      type: "DRIVER_WORK_WINDOW";
      driverId: DriverId;
      startMin: Minutes;
      endMin: Minutes;
    }
  | {
      type: "TASK_REQUIRED";
      taskId: TaskId;
      penaltyIfDropped?: number;
    }
  | {
      type: "REQUIRED_DRIVER_TASK";       // M4b — pre-assigned timeline
      taskId: TaskId;
      driverId: DriverId;
      source: "timeline_pre_assigned";
      manuallyMoved?: boolean;
    };
```

`LOCKED_TASK_PRESERVE` del piano originale non è usato: i container-locked sono esclusi dal loader, non entrano in `tasks[]`.

## 16.6 Soft constraints esplicite

```ts
type SoftConstraintSpec =
  | { type: "MINIMIZE_TOTAL_TRAVEL"; weight: number }
  | { type: "BALANCE_DRIVER_LOAD"; weight: number }
  | {
      type: "PREFERRED_PRIORITY_WINDOW";
      taskId: TaskId;
      startMin: Minutes;
      endMin?: Minutes;
      penaltyPerMinOutside: number;
    }
  // M5b — business groups (cost shaping in ortools-adapter)
  | { type: "KEEP_SAME_COORDINATES_BUILDING_TOGETHER"; groupId: string; weight: number; toleranceMeters: number }
  | { type: "KEEP_NEARBY_CLUSTER_TOGETHER"; groupId: string; weight: number; maxTravelMin: number }
  | { type: "KEEP_CLEANER_SEQUENCE"; groupId: string; weight: number; cleanerId: number; orderedTaskIds: TaskId[] }
  | { type: "KEEP_SAME_CLEANER_TASKS_TOGETHER"; groupId: string; weight: number; cleanerId: number }
  | { type: "KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER"; groupId: string; weight: number; windowOverlap: { startMin: Minutes; endMin: Minutes } };
```

I nomi `KEEP_SAME_ADDRESS_TOGETHER` del piano originale sono stati sostituiti dai tipi `KEEP_*` sopra, generati da `groups/build-business-groups.ts`.

---

## 17. Calcolo proposto finestre task

Funzione target:

```ts
function buildTaskWindow(task, windowConfig: LogisticsWindowConfig, workDate): TaskWindow
```

Output:

```ts
interface TaskWindow {
  earliestStartMin: number;
  latestStartMin: number;
  latestEndMin: number;
  reasons: string[];
}
```

### 17.1 Earliest start

Candidati:

1. Checkout migrato se checkout applicabile.
2. Priority start se checkout non applicabile/non migrato:
   - HP → `windowConfig.priorityWindows.HP.startMin` come hard lower bound;
   - LP → `windowConfig.priorityWindows.LP.startMin` come hard lower bound;
   - EO → nessun hard lower bound legato a `hp_start_time`; usa la disponibilità del driver, più eventuali checkout/travel/vincoli specifici.
3. Driver work start.

Nota: i valori arrivano sempre dal JSON configurabile salvato in DB. Il codice può usare un fallback solo se esplicito, centralizzato e visibile nel debug.

Per EO va inoltre costruita una soft window/preferenza prima di `hp_start_time`: anticiparlo è desiderabile solo se non peggiora vincoli più importanti o il costo globale della route.

Formula:

```ts
// HP/LP
earliestStartMin = max(driverStartMin, checkoutStartMin, priorityWindow.startMin)

// EO
earliestStartMin = max(driverStartMin, checkoutStartMin)
// preferredBeforeMin = hpStartMin come soft preference, non hard constraint
```

### 17.2 Latest start / latest end

Candidati hard deadline:

1. Check-in applicabile:
   - `latestEndMin <= checkinMin`
   - `latestStartMin < checkinMin`
2. Cleaner constraint per `DRIVER_BRINGS_BAG`:
   - usare `cleanerTaskStartTime`, fallback `cleanerStartTime`;
   - non usare `cleanerTaskEndTime`;
   - latest start = cleaner task start + 2/3 cleaning time.
3. Per `CLEANER_HAS_BAG`:
   - nessun latest legato al cleaner;
   - solo check-in/checkout/driver window.

Formula iniziale compatibile con codice attuale:

```ts
latestStartFromCleaner = cleanerReferenceStart + ceil(cleaningTime * 2 / 3)
latestEndFromCheckin = checkinMin
latestStartMin = min(latestStartFromCleaner, latestEndFromCheckin - serviceDurationMin)
latestEndMin = min(checkinMin, latestStartMin + serviceDurationMin)
```

Reason/debug da usare:

```ts
DRIVER_BRINGS_BAG_BEFORE_CLEANER_WITH_2_3_TOLERANCE
```

---

## 18. Pipeline proposta nuovo pre-OR-Tools

```ts
async function buildLogisticsRoutingInput(workDate: string): Promise<RoutingProblemInput> {
  const rawTasks = await loadUnlockedLogisticsTasks(workDate);
  const rawDrivers = await loadSelectedDrivers(workDate);
  const prioritySettings = await loadWindowConfig(workDate);
  const lockedAssignments = await loadExistingLockedAssignments(workDate);

  const normalizedTasks = normalizeTasks(rawTasks, workDate);
  const drivers = normalizeDrivers(rawDrivers);

  const taskPolicies = normalizedTasks.map(computeTaskBagPolicy);
  const addressGroups = buildAddressGroups(normalizedTasks);
  const taskWindows = normalizedTasks.map(task =>
    buildTaskWindow(task, taskPolicies[task.taskId], prioritySettings, workDate)
  );

  const eligibleTasks = applyPreSolverEligibility(normalizedTasks, taskWindows);
  const nodes = buildLocationNodes(depot, eligibleTasks);
  const travelMatrixMin = await buildTravelMatrix(nodes);

  return {
    schemaVersion: "logistics-routing-input/v1",
    workDate,
    depot,
    drivers,
    tasks: buildTaskNodes(eligibleTasks, taskPolicies, taskWindows, addressGroups),
    travelMatrixMin,
    serviceDurationMin: 15,
    hardConstraints: buildHardConstraints(...),
    softConstraints: buildSoftConstraints(...),
    metadata: buildMetadata(...),
  };
}
```

---

## 19. Cosa riusare dal codice attuale

Da riusare quasi direttamente:

- query Phase 0 come loader puro `loadUnlockedLogisticsTasks`, senza chiamare `runLogisticsPhase0`;
- loader driver puro `loadSelectedDrivers`, senza chiamare `runLogisticsPhase1`;
- loader `loadExistingLockedAssignments` per preservare assegnazioni locked/manuali fuori dal problema libero;
- `computeBagPolicy`, dopo chiarimento `AND/OR` con regole operative;
- funzioni parsing orari;
- check-in/checkout applicability;
- `LOGISTICS_SERVICE_DURATION_MIN`;
- final apply, ma staccato dal solver;
- debug JSON, ma adattato a `RoutingProblemInput` e `RoutingSolution`.

Da NON riusare come architettura:

- `runLogisticsPhase1`, `driverBands`, `bandAssignments`;
- `phase2.ts` come decision engine;
- competitive grouping loop;
- fragmentation/linearity come patch interne;
- repair insertion come correzione decisionale;
- bande latitudinali come meccanismo primario.

Da trasformare:

- grouping hints → soft constraints o metadata;
- same address → dimensione/penalty esplicita;
- cleaner sequence → precedence/soft sequence constraint;
- priority windows → time windows/soft windows;
- unassigned classification → post-solver diagnostics.

---

## 20. Output solver (`RoutingSolution`)

Implementato in `solution-contract.ts`. L'apply dipende solo da questa struttura.

```ts
interface RoutingSolution {
  schemaVersion: "logistics-routing-solution/v1";
  solverId: "greedy-v1" | "ortools-v1";
  workDate: string;
  status: "FEASIBLE" | "PARTIAL" | "INFEASIBLE" | "INVALID";
  generatedAt: string;
  routes: Array<{
    driverId: DriverId;
    startMin: Minutes;
    endMin: Minutes;
    totalServiceMin: Minutes;
    totalTravelMin: Minutes;
    totalWaitMin: Minutes;
    stops: Array<{
      sequence: number;
      taskId: TaskId;
      arrivalMin: Minutes;
      startMin: Minutes;
      endMin: Minutes;
      serviceDurationMin: Minutes;
      travelFromPreviousMin: Minutes;
      waitMin: Minutes;
      previousTaskId?: TaskId | null;
    }>;
  }>;
  droppedTasks: Array<{
    taskId: TaskId;
    reason: RoutingDroppedTaskReason;
    details?: string;
  }>;
  objectiveBreakdown?: {
    assignedTasks: number;
    droppedTasks: number;
    totalTravelMin: Minutes;
    totalWaitMin: Minutes;
    softConstraintScore?: number;
    penalties?: Record<string, number>;
  };
  diagnostics?: { warnings: string[]; notes?: string[]; solveDurationMs?: number };
}
```

---

## 21. Checklist implementativa

### Completato

```txt
server/services/logistics-optimizer-final/
  loaders.ts
  normalizers.ts
  bag-handling.ts          # era bag-policy.ts nel piano originale
  windows.ts
  business-rules.ts
  travel-matrix.ts
  groups/*                 # era address-groups.ts nel piano originale
  input-contract.ts
  build-routing-input.ts
  timeline-assignment-hints.ts
  auto-convoke-logistics-drivers.ts
  validation.ts
  solution-contract.ts
  solution-validation.ts
  solution-apply-gate.ts
  apply-routing-solution.ts
  solver/solve-routing.ts
  solver/greedy-routing-solver.ts
  solver/ortools/*
  run-routing-dry.ts
  run-routing.ts
  run-routing-input-debug.ts
  debug-writer.ts
  unassigned-diagnostics.ts
  index.ts
```

| Milestone | Stato |
|---|---|
| M4 — `RoutingProblemInput` JSON + validator | ✅ |
| M4b — pre-assigned + `REQUIRED_DRIVER_TASK` | ✅ |
| M5 — OR-Tools VRP + greedy debug | ✅ |
| M5b — business groups + soft cost shaping | ✅ |
| M5c — auto-convoke pre-assigned | ✅ |
| M6 — apply timeline + containers | ✅ |

### Aperto / follow-up

- Test unitari su `applyLogisticsRoutingSolution`
- Mutation hooks UI in `logistics-timeline-mutation-routes.ts` (auto-convoke su D&D timeline — PR separata)
- Allineare `bag_policy` in apply (`bag-rule.ts` legacy) con `BagHandling` del pre-solver, o documentare il confine
- `task.location.addressGroupId` non popolato; grouping in `businessGroups`

---

## 22. Decisioni di dominio (chiuse 2026-06-11, aggiornate Milestone 4b)

### Logistics task classes (nomenclatura allineata a housekeeping)

Glossario (termini di dominio):

| Termine | Definizione |
|---|---|
| **Container-locked** | Task bloccato in container (`daily_task_locks` / `lg_containers`). Non entra in timeline, escluso da `RoutingProblemInput.tasks`. |
| **Pre-assigned** | Task su logistics timeline driver, già assegnato a un driver. Genera `REQUIRED_DRIVER_TASK`; driver fisso, tempo/ordine flessibili in `hardWindow`. |
| **Free** | Task in pool senza vincolo driver. |

**Non esiste “locked on timeline”.** In logistics non ci sono task bloccati in timeline. Il check `task.locked === true` in `loadTimelineAssignmentHints` è solo un guard difensivo: un container-locked non dovrebbe mai comparire in timeline; se succede, l'hint viene ignorato.

1. **Container-locked** (`daily_task_locks` / `lg_containers`): stay in containers, never enter timeline, excluded from `RoutingProblemInput.tasks`, never moved by solver.

2. **Pre-assigned** (assignment on driver timeline): enter `RoutingProblemInput.tasks`, generate hard `REQUIRED_DRIVER_TASK`, must stay on the same driver, may shift in time and route order within `hardWindow`.

3. **Free tasks**: enter `tasks[]`, no `REQUIRED_DRIVER_TASK`, any feasible driver.

- `manually_moved` is metadata only; it does not lock the task.
- Logistics differs from housekeeping pre-assigned: housekeeping excludes timeline tasks from Phase1 and keeps them time-fixed; logistics keeps them in the solver pool with flexible timing on the required driver.
- Apply preserva task fuori dal pool solver e merge solver output per free/pre-assigned (`apply-routing-solution.ts`).

| # | Domanda | Decisione |
|---|---|---|
| 1 | Task pre-assegnati in timeline | **Integrati in 4b.** `REQUIRED_DRIVER_TASK` hard in `hardConstraints`; greedy rispetta driver mandato; drop `REQUIRED_DRIVER_INFEASIBLE` → `status: INVALID`. |
| 2 | Driver end window | **Sì.** Ogni driver ha un orario massimo giornaliero (`endTime` / `DRIVER_WORK_WINDOW`). Già implementato in `buildDriverNodes`. |
| 3 | Start location | **Sempre depot** (`45.434029, 9.180008`). `startLocationNodeId: "depot"` per tutti i driver. |
| 4 | Task senza coordinate | **Sempre esclusi.** Nessun geocoding/fallback. Già implementato in `loaders.ts` → `schedulableTasks`. |

Implicazioni immediate:

- `loadTimelineAssignmentHints` + `buildRequiredDriverConstraints` sono il path ufficiale per i pre-assegnati.
- `loadExistingLockedAssignments` resta esportato per retrocompatibilità ma non è usato dal builder 4b.
- Required droppato o violato → solution `status: INVALID`, non `PARTIAL` accettabile.

### Auto-convocazione pre-assigned (M5c)

Regola operativa (allineata a housekeeping, senza readonly/rehydrate ADAM):

```txt
driver con task pre-assigned in logistics timeline
→ implicitamente convocato
→ prima di buildLogisticsRoutingInput / loadLogisticsRoutingSourceData
→ REQUIRED_DRIVER_TASK non skippato per driver-not-selected
```

Implementazione:

- [`auto-convoke-logistics-drivers.ts`](auto-convoke-logistics-drivers.ts): `autoConvokeLogisticsDriversWithPreAssignedTasks`
- Parser condiviso: `parsePreAssignedTimelineEntries` in [`timeline-assignment-hints.ts`](timeline-assignment-hints.ts)
- Hook esplicito in `buildLogisticsRoutingInput` (side effect su `lg_selected_drivers`, **non** nel loader)
- Merge selected: ordine esistente + append nuovi driver
- Revision action type: `AUTO_CONVOKED_PREASSIGNED`
- Opzione `saveSelectedDrivers: false` per test (non confondere con `run-dry` optimizer)

Metadata in `RoutingProblemInput.metadata`:

- `autoConvokedDriverIds` / `autoConvokedDriversCount`
- `autoConvokeMissingInDbDriverIds` / `autoConvokeMissingInDbDriversCount` (timeline cita driver assente da `lg_drivers`)

`REQUIRED_DRIVER_NOT_SELECTED` (OR-Tools safety net) resta per dati corrotti / race — non flusso normale dopo auto-convoke.

Fase 2 (PR separata): mutation hooks UI in `logistics-timeline-mutation-routes.ts` per parity D&D housekeeping.

---

## 24. Milestone 5 — OR-Tools routing solver

### Pipeline

```txt
RoutingProblemInput
  → buildOrToolsPayload (travelMatrixMin + costMatrixMin shaped)
  → logistics_routing_ortools.py
  → decodeOrToolsSolution
  → validateRoutingSolution
  → evaluateSolutionApplyGate
  → (opz.) applyLogisticsRoutingSolution
```

Debug artifacts (`server/debug/logistics-optimizer-final/`):

- `01-routing-input.json`
- `02-routing-solution.json`
- `03-ortools-payload.json` (solo con `ortools-v1`)

### Solver IDs

| ID | Ruolo | Default |
|---|---|---|
| `ortools-v1` | Produzione + dry-run | **Sì** (`run-routing`, `run-routing-dry`, `solveRouting`) |
| `greedy-v1` | Debug/regressione | Opt-in (`"solver": "greedy-v1"`) |

`greedy-v1` con `apply: true` è bloccato (`GreedySolverNotAllowedForApplyError`); la UI produzione usa esplicitamente `ortools-v1`.

### Hard constraints

- Task time windows (`transit = service(from) + travel`)
- `startMin ∈ [earliestStartMin, latestStartMin]` e `startMin + serviceDurationMin ≤ latestEndMin` (esplicito in Python)
- Driver work windows
- `REQUIRED_DRIVER_TASK` → vincolo veicolo hard (no disjunction)
- Driver required non tra i selected: hint skippato in pre-solver; safety net adapter → `INVALID` (`REQUIRED_DRIVER_NOT_SELECTED`) senza chiamare Python
- Task liberi → `AddDisjunction` con penalty **EO 100k > HP 50k > LP 25k**

### Soft constraints (cost shaping)

**M5 GEO** — `KEEP_SAME_COORDINATES_BUILDING_TOGETHER`, `KEEP_NEARBY_CLUSTER_TOGETHER`: riduzione costo arco intra-gruppo in `costMatrixMin`.

**M5b** — `KEEP_CLEANER_SEQUENCE`, `KEEP_SAME_CLEANER_TASKS_TOGETHER`, `KEEP_PRIORITY_COMPATIBLE_TASKS_TOGETHER`: bonus/penalty su archi in `ortools-adapter.ts`; `softTimeWindows` e load balance in Python.

Decode e validation usano sempre `travelMatrixMin` originale. Il cost shaping non garantisce grouping globale sullo stesso veicolo.

### Required infeasible

Se OR-Tools ritorna `infeasible` con task required coinvolti, `buildRequiredInfeasibleSolution` produce `RoutingSolution` con `status: INVALID` — non errore HTTP 500.

### Status solution

`FEASIBLE` \| `PARTIAL` \| `INFEASIBLE` \| `INVALID` (no `OPTIMAL`).

### Dipendenze

`ortools` in `pyproject.toml` (`pip install ortools` o `uv sync`). Se non disponibile: HTTP 503 `ORTOOLS_UNAVAILABLE`.

---

## 25. Milestone 6 — Apply timeline

File: `apply-routing-solution.ts` — `applyLogisticsRoutingSolution`.

### Gate apply

`evaluateSolutionApplyGate` / `assertSolutionCanBeApplied`:

| Status | Apply default | Con `allowPartial: true` |
|---|---|---|
| `FEASIBLE` | ✅ | ✅ |
| `PARTIAL` | ❌ | ✅ |
| `INFEASIBLE` | ❌ | ❌ |
| `INVALID` | ❌ | ❌ |

### Passi apply

1. Validazione input (`mode: "apply"`) + assert solution gate
2. Carica driver selezionati, containers, timeline corrente
3. Costruisce route da `RoutingSolution` per driver
4. Preserva task timeline fuori dal pool solver / non rischedulati
5. Re-sequence progressiva, `followup`, `logistics_task_kind` / `logistics_task_kind_source`
6. `recalculateLogisticsTimeline` → `buildFinalTimelineValidation` → assert check-in
7. Salva timeline + history containers + rimuove task assegnati dai containers

### Output

```ts
{
  applied: boolean;
  insertedTasks: number;
  removedFromContainers: number;
  totalTasksOnTimeline: number;
  preservedOutsideSolverInputTasks: number;
  preservedUnassignedRoutingTasks: number;
  finalValidation: LogisticsFinalTimelineValidation;
}
```

### Confine tipologia logistica

Il pre-solver e l'apply usano `LogisticsTaskKind` (`pick-up`, `delivery`, `delivery/pick-up`, `null`) da `shared/logistics-task-kind.ts`. `delivery/pick-up` è l'unico tipo che attiva il vincolo “driver prima del cleaner”; `delivery` è solo manuale e non applica regole borsone.

### Known limitations

- Apply non coperto da test unitari dedicati
- Mutation hooks UI per auto-convoke su D&D timeline non ancora implementati (optimizer corretto al run; UI può restare incoerente fino al prossimo run)

---

## 23. Sintesi

### Legacy (`logistics-optimizer`)

Robusto su cluster locali (cleaner sequence, stesso indirizzo, vicinanza, checkout/check-in, borsone), ma debole globalmente: loop greedy con scoring progressivo, repair e penalty come patch.

### Attuale (`logistics-optimizer-final`)

La conoscenza di dominio è nel pre-solver; il solver decide globalmente:

- task con finestre temporali esplicite (`hardWindow` + `softWindows`);
- driver con work window esplicita;
- matrice travel completa;
- hard constraints separati (`TASK_TIME_WINDOW`, `DRIVER_WORK_WINDOW`, `REQUIRED_DRIVER_TASK`);
- soft constraints dichiarative + `businessGroups` con cost shaping OR-Tools;
- debug input/output serializzabile;
- apply su `RoutingSolution` indipendente dal solver interno.

**Migrazione completata** per il flusso produzione: legacy disabilitato, UI su `/api/logistics-optimizer-final/run`.


---

## 26. Changelog documentazione

### 2026-06-17

- Rinominato da `logistics_optimizer_pre_ortools_base.md` → `logistics-optimizer-final-reference.md`
- Aggiornate §1, §1.1, §21, §24; aggiunta §25 (M6 apply)
- Allineato default solver (`ortools-v1`), pipeline produzione, API, test
- Sezioni 2–20 marcate come archivio legacy

### 2026-06-04

### Finestre EO/HP/LP configurabili

È stato chiarito che le finestre temporali EO/HP/LP vengono lette da un file JSON configurabile e salvato in banca dati. Il nuovo algoritmo deve mantenere questa architettura:

- `EO_Start_Time`, `HP_Start_Time`, `LP_Start_Time` sono parametri configurabili;
- il pre-OR-Tools deve riceverli tramite `LogisticsWindowConfig`;
- nessun valore operativo deve essere hardcoded nell'algoritmo;
- i fallback sono ammessi solo se espliciti, centralizzati e tracciati nel debug/output;
- le modifiche future alle finestre devono avvenire cambiando configurazione/database, non codice.

