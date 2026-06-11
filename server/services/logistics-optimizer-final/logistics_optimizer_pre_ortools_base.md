# Logistics Optimizer — studio legacy e base `logistics-optimizer-final`

Data analisi: 2026-06-04  
Modulo legacy in produzione: `server/services/logistics-optimizer`  
Modulo nuovo pre-OR-Tools: `server/services/logistics-optimizer-final`

## 1. Obiettivo di questo file

Documentare il comportamento del vecchio optimizer e il contratto del nuovo pre-solver, separando tre responsabilità:

1. **Data preparation / pre-optimizer** (`logistics-optimizer-final`)
2. **Decision engine** (legacy: `phase2.ts`; target: OR-Tools)
3. **Apply / persistenza** (legacy `index.ts`, da riusare invariato nella milestone solver)

Il nuovo modulo **non** chiama `runLogisticsPhase0`, `runLogisticsPhase1` né `runLogisticsPhase2`. Usa loader puri e produce solo `RoutingProblemInput`.

---

## 1.1 Stato implementato in `logistics-optimizer-final`

| Modulo | Ruolo |
|---|---|
| `loaders.ts` | `loadUnlockedLogisticsTasks`, `loadSelectedDrivers`, `loadWindowConfig`, `loadTimelineAssignmentHints` |
| `timeline-assignment-hints.ts` | `loadTimelineAssignmentHints`, `buildRequiredDriverConstraints` |
| `input-contract.ts` | `RawLogisticsTaskInput`, `RoutingProblemInput`, tipi vincoli |
| `bag-handling.ts` | `BagHandling` (`NO_CLEANER_CONTEXT`, `DRIVER_BRINGS_BAG`, `CLEANER_HAS_BAG`) |
| `windows.ts` | Finestre hard/soft task |
| `build-routing-input.ts` | `buildLogisticsRoutingInput(workDate)` |
| `solver/solve-routing.ts` | Dispatcher `greedy-v1` \| `ortools-v1` |
| `solver/ortools/ortools-adapter.ts` | `buildOrToolsPayload`, `decodeOrToolsSolution`, cost shaping GEO |
| `solver/ortools/logistics_routing_ortools.py` | VRP OR-Tools (time windows, required, disjunctions) |
| `run-routing-dry.ts` | Dry-run con `solver` opt-in (`ortools-v1`) |

Flusso attuale del modulo final:

```ts
source = loadLogisticsRoutingSourceData(workDate)
input = buildRoutingProblemInputFromSource(source)
```

**Non fa:** assegnazione driver, bande geografiche, grouping greedy, apply timeline.

**Tipi autonomi:** `RawLogisticsTaskInput` è definito in `input-contract.ts` (nessun import da `phase0.ts`).

**Task pre-assegnati in timeline (Milestone 4b):** `loadTimelineAssignmentHints` carica tutti gli assignment timeline; `buildRequiredDriverConstraints` genera `REQUIRED_DRIVER_TASK` in `hardConstraints`. I pre-assegnati restano in `tasks[]` con driver fisso e orario/sequenza flessibili in `hardWindow`. Distinti dai **task locked nei containers** (esclusi in `loadUnlockedLogisticsTasks`).

---

## 2. Mappa file legacy (`logistics-optimizer`)

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

## 5. Bag policy attuale

File: `bag-rule.ts`

```ts
NORMAL_TASK
DRIVER_BRINGS_BAG
CLEANER_HAS_BAG
```

Regole:

| Policy | Condizione |
|---|---|
| `NORMAL_TASK` | Nessun cleaner/sequence, oppure `sequence !== 1`. |
| `DRIVER_BRINGS_BAG` | `sequence === 1` e (`premium === true` oppure `pax_in > 4`). |
| `CLEANER_HAS_BAG` | `sequence === 1`, non premium, `pax_in <= 4`. |

Funzione chiave:

```ts
requiresDriverBeforeCleaner(policy)
```

Ritorna `true` per:

- `NORMAL_TASK`
- `DRIVER_BRINGS_BAG`

Ritorna `false` per:

- `CLEANER_HAS_BAG`

Nota importante: oggi `filterTasksByBagRule` non esclude nessun task. La bag policy influenza vincoli, deadline e scoring, non l'ingresso nel problema.

Nota per il nuovo pre-OR-Tools: conviene rinominare questa informazione in `BagHandling`, distinguendo il significato operativo dal vincolo effettivo del solver:

```ts
type BagHandling =
  | "NO_CLEANER_CONTEXT"
  | "DRIVER_BRINGS_BAG"
  | "CLEANER_HAS_BAG";
```

- `NO_CLEANER_CONTEXT`: task senza cleaner/sequence utile; nessun vincolo borsone verso cleaner.
- `DRIVER_BRINGS_BAG`: il driver deve provare ad arrivare prima dello start cleaner; e' ammesso uno start logistico fino a `cleanerTaskStartTime + ceil(cleaningTime * 2 / 3)`.
- `CLEANER_HAS_BAG`: il cleaner ha già il borsone; vale con `sequence === 1` e (`!premium` oppure `pax_in < 4`). Il driver può passare per ritiro sporco rispettando gli altri vincoli.

I debug verranno rifatti in seguito, quindi questa migrazione non deve preservare la nomenclatura storica `NORMAL_TASK` se crea ambiguità.

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
  source: "db" | "app_settings" | "fallback";
  workDate: string;
  priorityWindows: {
    EO: PriorityWindowConfig;
    HP: PriorityWindowConfig;
    LP: PriorityWindowConfig;
  };
  fallbackUsed: boolean;
  rawConfig?: unknown;
}

interface PriorityWindowConfig {
  startMin: Minutes;
  endMin?: Minutes;
  label: "EO" | "HP" | "LP";
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
  metadata: RoutingProblemMetadata;
}
```

## 16.3 DriverNode

```ts
interface DriverNode {
  id: DriverId;
  name: string;
  startLocationNodeId: string; // di solito depot, ma estendibile
  endLocationNodeId?: string;
  workWindow: {
    startMin: Minutes;
    endMin: Minutes;
    source: "driver_row" | "default" | "manual_override";
  };
  selected: true;
  lockedRoutePrefix?: TaskId[];
  lockedRouteTasks?: TaskId[];
  capabilities?: string[];
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
      sourceRules: string[];
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
      type: "LOCKED_TASK_PRESERVE";
      taskId: TaskId;
      driverId?: DriverId;
      sequence?: number;
    };
```

## 16.6 Soft constraints esplicite

```ts
type SoftConstraintSpec =
  | {
      type: "MINIMIZE_TOTAL_TRAVEL";
      weight: number;
    }
  | {
      type: "BALANCE_DRIVER_LOAD";
      weight: number;
    }
  | {
      type: "KEEP_SAME_ADDRESS_TOGETHER";
      addressGroupId: number;
      taskIds: TaskId[];
      penaltyIfSplit: number;
    }
  | {
      type: "KEEP_CLEANER_SEQUENCE";
      cleanerId: number;
      orderedTaskIds: TaskId[];
      penaltyIfBroken: number;
    }
  | {
      type: "PREFERRED_PRIORITY_WINDOW";
      taskId: TaskId;
      startMin: Minutes;
      endMin?: Minutes;
      penaltyPerMinOutside: number;
    };
```

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

## 20. Output solver da prevedere per apply

Il nuovo solver, qualunque esso sia, dovrebbe restituire:

```ts
interface RoutingSolution {
  workDate: string;
  status: "FEASIBLE" | "PARTIAL" | "INFEASIBLE" | "INVALID";
  routes: Array<{
    driverId: DriverId;
    stops: Array<{
      taskId: TaskId;
      sequence: number;
      arrivalMin: Minutes;
      startMin: Minutes;
      endMin: Minutes;
      travelFromPreviousMin: Minutes;
      waitMin: Minutes;
      appliedWindowReasons: string[];
    }>;
    totalTravelMin: Minutes;
    totalServiceMin: Minutes;
    totalWaitMin: Minutes;
  }>;
  droppedTasks: Array<{
    taskId: TaskId;
    reason: string;
    diagnostics?: unknown;
  }>;
  objectiveBreakdown: Record<string, number>;
}
```

L'apply dovrebbe dipendere solo da questa struttura, non dai dettagli interni del solver.

---

## 21. Checklist implementativa consigliata

1. Cartella implementata:

```txt
server/services/logistics-optimizer-final/
```

2. Moduli:

```txt
loaders.ts              // DB raw data
normalizers.ts          // parse, default, type safety
bag-policy.ts           // policy unica, testata
windows.ts              // finestre task/driver
address-groups.ts       // same address / same logistic code
travel-matrix.ts        // matrix builder
input-contract.ts       // tipi RoutingProblemInput
build-routing-input.ts  // orchestration pre-OR-Tools
solution-contract.ts    // tipi RoutingSolution
apply-routing-solution.ts
validation.ts
```

3. Prima milestone:

- produrre `RoutingProblemInput` JSON per una data;
- salvarlo in debug;
- nessuna assegnazione ancora.

4. Seconda milestone:

- creare validator che controlla:
  - tutti i task hanno coordinate;
  - finestre coerenti (`earliest <= latest`);
  - driver window presente;
  - matrice travel dimensionata correttamente;
  - reason su ogni esclusione.

5. Terza milestone:

- collegare OR-Tools o altro solver solo dopo aver stabilizzato input/output.
- durante la stabilizzazione sostituire la vecchia nomenclatura `BagPolicy` con `BagHandling`, senza vincolarsi ai debug legacy.

---

## 22. Decisioni di dominio (chiuse 2026-06-11, aggiornate Milestone 4b)

### Logistics task classes (aligned with housekeeping on locks)

1. **Container-locked** (`daily_task_locks` / `lg_containers`): stay in containers, never enter timeline, excluded from `RoutingProblemInput.tasks`, never moved by solver.

2. **Timeline pre-assigned** (assignment on driver timeline, not container-locked): enter `RoutingProblemInput.tasks`, generate hard `REQUIRED_DRIVER_TASK`, must stay on the same driver, may shift in time and route order within `hardWindow`.

3. **Free tasks**: enter `tasks[]`, no `REQUIRED_DRIVER_TASK`, any feasible driver.

- `manually_moved` is metadata only; it does not lock the task.
- Logistics differs from housekeeping pre-assigned: housekeeping excludes timeline tasks from Phase1 and keeps them time-fixed; logistics keeps them in the solver pool with flexible timing on the required driver.
- Future apply must preserve container-locked tasks and merge solver output for free/pre-assigned pool only.

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

---

## 24. Milestone 5 — OR-Tools routing solver

Pipeline:

```txt
RoutingProblemInput
  → buildOrToolsPayload (travelMatrixMin + costMatrixMin shaped)
  → logistics_routing_ortools.py
  → decodeOrToolsSolution
  → validateRoutingSolution
  → 02-routing-solution.json
```

Debug dry-run (`ortools-v1`): `01-routing-input.json`, `02-routing-solution.json`, `03-ortools-payload.json`.

Solver IDs: `greedy-v1` (default `run-dry`), `ortools-v1` (opt-in body `"solver": "ortools-v1"`).

### Hard constraints M5

- Task time windows (`transit = service(from) + travel`)
- `startMin` in `[earliestStartMin, latestStartMin]` and `startMin + serviceDurationMin <= latestEndMin` (explicit in Python)
- Driver work windows
- `REQUIRED_DRIVER_TASK` hard vehicle constraint (no disjunction)
- Required driver not among selected drivers: pre-solver salta l'hint (`REQUIRED_DRIVER_TASK_SKIPPED`); validation segnala `UNKNOWN_DRIVER_IN_CONSTRAINT` se il vincolo arriva comunque nell'input; OR-Tools adapter fa fallback `INVALID` (`REQUIRED_DRIVER_NOT_SELECTED`) senza chiamare Python
- Free tasks: `AddDisjunction` con penalty EO > HP > LP

### Soft GEO M5 (cost shaping locale)

- `KEEP_SAME_COORDINATES_BUILDING` e `KEEP_NEARBY_CLUSTER` riducono costo arco intra-gruppo in `costMatrixMin`
- Decode e validation usano sempre `travelMatrixMin` originale
- Non garantisce grouping globale same-vehicle (M5b per cleaner/sequence/priority)

### Required infeasible

Se OR-Tools ritorna `infeasible`, `buildRequiredInfeasibleSolution` produce `RoutingSolution` diagnostica (`INVALID` se required coinvolti), non errore HTTP 500.

### Known limitations M5

- Soft GEO = cost shaping locale, non garanzia globale stesso veicolo per gruppo
- Cleaner / sequence / priority soft in M5b
- Nessun apply timeline
- Status: `FEASIBLE` \| `PARTIAL` \| `INFEASIBLE` \| `INVALID` (no `OPTIMAL`)
- Python deps: `ortools` in `pyproject.toml` (`pip install ortools` o `uv sync`); `ortools-v1` è opt-in, `greedy-v1` resta default

---

## 23. Sintesi finale

L'attuale algoritmo è robusto nel generare cluster locali perché conosce bene:

- cleaner sequence;
- stesso indirizzo;
- vicinanza geografica;
- checkout/check-in;
- borsone.

Il suo limite principale è che queste informazioni vengono usate dentro un loop greedy con scoring progressivo. Per il nuovo sistema conviene spostare tutta la conoscenza di dominio nel pre-OR-Tools e consegnare al solver un problema già pulito:

- task con finestre temporali esplicite;
- driver con work window esplicita;
- matrice travel completa;
- hard constraints separati;
- soft constraints pesate e dichiarative;
- debug input/output serializzabile.


---

## 23. Aggiornamenti del 2026-06-04

### Finestre EO/HP/LP configurabili

È stato chiarito che le finestre temporali EO/HP/LP vengono lette da un file JSON configurabile e salvato in banca dati. Il nuovo algoritmo deve mantenere questa architettura:

- `EO_Start_Time`, `HP_Start_Time`, `LP_Start_Time` sono parametri configurabili;
- il pre-OR-Tools deve riceverli tramite `LogisticsWindowConfig`;
- nessun valore operativo deve essere hardcoded nell'algoritmo;
- i fallback sono ammessi solo se espliciti, centralizzati e tracciati nel debug/output;
- le modifiche future alle finestre devono avvenire cambiando configurazione/database, non codice.

