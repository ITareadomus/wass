# Regole dell’ottimizzatore logistics

Questo documento spiega **cosa decide** l’ottimizzatore quando assegna i task di logistics agli autisti, e **perché**.

---

## In una frase

L’ottimizzatore costruisce, per ogni giornata, i percorsi degli autisti logistics: **quale task va a quale autista, in che ordine e a che ora**, rispettando i vincoli obbligatori e cercando di fare percorsi sensati (poco viaggio, territori coerenti, priorità rispettate).

---

## Come leggere questo documento

- **Obbligatorio** = se non si rispetta, la soluzione non è valida (o quel task non può entrare nel piano).
- **Preferenza** = l’ottimizzatore ci prova, ma può rinunciare se altrimenti non riesce a fare un piano fattibile.
- **Dopo il calcolo** = aggiustamenti “di rifinitura” sul risultato, senza riscrivere le regole di base.

---

## 1. Chi entra nel piano e chi no

### Task bloccati nei container
I task ancora nei container e **bloccati** restano dove sono.  
L’ottimizzatore **non** li sposta in timeline e **non** li assegna.

### Task già in timeline (pre-assegnati)
Se un task è già sulla timeline di un autista:
- resta di **quell’autista** (non può cambiare driver);
- può però essere **spostato in orario e in ordine** di percorso, se le finestre lo permettono.

### Task liberi
I task in pool (nei container, non bloccati) possono andare a **qualsiasi** autista disponibile, se c’è spazio e le regole di orario lo consentono.

### Senza coordinate
Senza latitudine/longitudine valide, il task **non entra** nel piano.  
Non si inventa un indirizzo e non si geocodifica al volo.

### Nessun autista selezionato
Se per quella giornata non ci sono autisti logistics convocati/selezionati, **non si può ottimizzare**.

### Auto-convocazione
Se un task è già in timeline di un autista che non risultava selezionato, quel autista viene **convocato automaticamente** prima di ottimizzare.  
Così i pre-assegnati non vengono “persi” perché il driver non era in lista.

---

## 2. Tipi di task e regola del borsone

L’ottimizzatore distingue tre tipi:

| Tipo | Significato operativo | Effetto |
|------|------------------------|---------|
| **Pick-up** | Il cleaner ha già il borsone: l’autista raccoglie dopo | Nessun obbligo di arrivare prima del cleaner |
| **Delivery / pick-up** | L’autista deve portare il borsone | Deve arrivare **prima** (o entro una tolleranza) rispetto all’inizio del cleaner |
| **Delivery** | Solo se impostato a mano | Non applica le regole automatiche del borsone |

### Quando diventa pick-up in automatico
Se c’è un cleaner, la sequence è 1, l’alloggio **non** è premium e i pax sono ≤ 4 → si assume che il cleaner abbia il borsone → **pick-up**.

Negli altri casi con cleaner → **delivery/pick-up** (autista porta il borsone).

Se il tipo è stato impostato **manualmente**, prevale la scelta manuale.

### Tolleranza “prima del cleaner”
Per i delivery/pick-up, l’autista non deve necessariamente arrivare all’istante esatto in cui inizia il cleaner: ha una **tolleranza**.

- Se c’è la durata di pulizia: tolleranza = circa **due terzi** del tempo di cleaning (arrotondata per eccesso).
- Se manca: tolleranza di default **30 minuti**.

Esempio: cleaner alle 11:00, cleaning 90 min → tolleranza 60 min → l’autista deve **iniziare** il task logistics al più tardi alle 12:00.

---

## 3. Orari: cosa è obbligatorio

### Durata di ogni stop logistics
Ogni task logistics dura **15 minuti** di servizio (fisso).

### Checkout del cliente
Se c’è un checkout valido per la giornata:
- l’autista **non può iniziare prima** del checkout;
- l’ottimizzatore **non** “aspetta” prima del checkout nel modello: semplicemente la finestra parte dal checkout.

### Check-in del cliente
Se c’è un check-in nella stessa giornata di lavoro:
- il task deve **finire in tempo** rispetto al check-in (non si può sforare).

### Fine giornata
Ogni autista ha una propria fascia di lavoro (inizio/fine), impostabile singolarmente; se non impostata, di default è **10:00–20:00**.

Le finestre dei task non hanno un tetto fisso indipendente: quando un task non ha un vincolo reale (check-in, tolleranza cleaner) che lo chiude prima, il limite usato è **il più tardo tra gli orari di fine turno degli autisti convocati quel giorno**. Così, se un autista viene impostato con fine turno oltre le 20:00, i task possono davvero arrivare fino a quell'orario; se invece nessun autista supera le 20:00, il limite di fatto resta 20:00 (per via del default).

### Priorità EO / HP / LP

Le ore di partenza “ufficiali” delle priorità arrivano dalla **configurazione** (non sono scritte a mano nel codice).

| Priorità | Comportamento |
|----------|----------------|
| **EO** | Nessun obbligo di “non iniziare prima di X” (salvo checkout). Si preferisce farli **presto**, ma solo quando ha senso (vedi sotto). |
| **HP** | Non si inizia prima dell’orario HP configurato (se disponibile). |
| **LP** | Non si inizia prima dell’orario LP configurato (se disponibile). |

### Preferenza “EO presto” (non obbligatoria)

Gli EO **non devono** per forza essere fatti all’alba. L’ottimizzatore spinge a farli presto solo in certi casi:

- **Urgente** — c’è un check-in stretto (grosso modo entro le 14:00, o poco margine dalla mattina), oppure è un delivery/pick-up legato al cleaner → conviene anticipare.
- **Compatibile col percorso** — non c’è urgenza forte, ma anticipare non crea danni evidenti → lieve preferenza a farli prima.
- **Flessibile** — tipicamente pick-up o check-in largo → **non** si forza l’anticipo, perché rischierebbe di far zigzagare il percorso senza bisogno.

---

## 4. Partenza e tempi di viaggio

### Dove partono gli autisti
Tutti partono dallo stesso deposito: **Via Barrili 31** (coordinate fisse).  
Non si parte da casa o dall’ultimo stop del giorno precedente.

### Come si stima il viaggio
I tempi tra stop si stimano dalla distanza (linea d’aria) con una velocità media da città, più un piccolo margine, e sono limitati tra pochi minuti e circa tre ore.  
Non è un navigatore in tempo reale: è una stima operativa coerente per confrontare i percorsi.

---

## 5. Cosa l’ottimizzatore cerca di ottenere (preferenze)

Oltre ai vincoli obbligatori, cerca un piano “bello” e praticabile. In ordine di importanza (semplificato):

1. **Non perdere** i task che devono stare su un autista preciso (pre-assegnati / stessi edificio).
2. **Assegnare il più possibile** i task liberi (meglio un piano completo che uno parziale).
3. **Rispettare i territori** (ogni autista sul “suo” pezzo di città, quando possibile).
4. **Meno chilometri / minuti di viaggio**.
5. **Percorsi più lineari** (meno andirivieni, meno salti laterali inutili).
6. Un po’ di **margine** (slack) negli orari, a parità di resto.

### Stesso edificio / stesso indirizzo
Task molto vicini (entro circa **100 metri**, tipicamente stesso civico/edificio) tendono a:
- stare sullo **stesso autista**;
- essere fatti **vicini nel percorso**.

Se ha senso, possono anche diventare un vincolo “stesso driver obbligatorio” per non spezzare l’edificio tra due persone.

### Cluster vicini
Task a pochi minuti di viaggio tra loro tendono a restare raggruppati sullo stesso giro, senza obbligarlo in modo assoluto.

### Finestre di priorità compatibili
Task le cui finestre orarie si sovrappongono abbastanza (almeno ~45 minuti) possono essere raggruppati più volentieri.

### Bilanciare il carico
Si evita che un autista sia pieno e un altro quasi vuoto, a parità di fattibilità.

### Quanto “costa” lasciare fuori un task
Se qualcosa non entra nel piano, l’ottimizzatore non decide in base alla sola etichetta di priorità, ma in base a **quanto è davvero urgente** il task.

Un task **HP** è importante perché, per definizione, ha una finestra di checkout/check-in stretta oppure l’alloggio è premium.

Un task **EO** non è automaticamente più importante di un HP: dipende dalle sue caratteristiche.

| Caso | Importanza (peso nello scartare) |
|------|-----------------------------------|
| **EO con** check-in/checkout stretto, oppure alloggio **premium**, oppure pulizia **straordinaria**, oppure deve precedere il cleaner con vincolo stretto | **Pari a un HP** — è altrettanto urgente. |
| **EO senza** nessuna di queste caratteristiche (“EO ordinario”) | **Non più importante di un HP** — pesa come un **LP**. |
| **LP** | Peso base più basso. |
| Nessuna priorità riconosciuta | Peso minimo di default. |

In pratica: non è l’etichetta “EO” in sé a rendere un task prioritario, ma il fatto che abbia davvero una scadenza stretta, riguardi un alloggio premium, oppure sia una pulizia straordinaria. Un EO “tranquillo” (nessuna scadenza stretta, non premium, non straordinario) non deve scavalcare un HP nella scelta di chi resta fuori dal piano.

---

## 6. Territori

L’ottimizzatore ragiona anche a **zone di città** (territori), per evitare che gli autisti si accavallino.

- Con il modello storico a 3 autisti usa zone consolidate (es. Nord / Centro-Sudovest / Centro-Sudest).
- Altrimenti costruisce zone in base ai task del giorno.

Stare sul proprio territorio è una **preferenza forte**, non un muro invalicabile: se serve per salvare un vincolo duro (orari, pre-assegnati), si può “sforare”, ma costa.

Dopo il calcolo principale ci può essere una **riparazione territori**: qualche task libero finito fuori zona può essere riprovato sul driver “giusto”, se il piano resta migliore.

---

## 7. Come nasce il risultato (senza tecnicismi)

1. **Preparazione** — si caricano task, autisti, orari, territori; si convocano eventuali driver con pre-assegnati; si escludono locked e senza coordinate.
2. **Calcolo globale** — un motore di ottimizzazione cerca il miglior insieme di percorsi rispettando i vincoli e le preferenze.
3. **Rifinitura** — si lucidano i percorsi (ordine più lineare), si riparano alcuni fuori-territorio, si rifinisce la sequenza se migliora la “forma” senza peggiorare troppo copertura e travel.
4. **Controllo** — se il risultato è valido e completo (o si accetta esplicitamente un parziale), si scrive in timeline e si tolgono dai container i task assegnati.
5. **Salvataggio** — i task fuori dal pool (non toccati dal calcolo) restano dove erano.

### Esiti tipici (in linguaggio operativo)

| Esito | Significato |
|-------|-------------|
| **Ok (fattibile)** | Piano completo e coerente: si può applicare. |
| **Parziale** | Qualche task libero è rimasto fuori. Di default **non** si applica, a meno di accettarlo esplicitamente. |
| **Non fattibile / non valido** | Troppi conflitti (soprattutto su pre-assegnati o orari obbligatori): **non** si applica. |

Il motore di debug “greedy” esiste solo per prove: **in produzione non scrive** sulle timeline.

---

## 8. Numeri utili da ricordare

| Cosa | Valore |
|------|--------|
| Durata stop logistics | 15 minuti |
| Tolleranza borsone di default | 30 minuti |
| Formula tolleranza con cleaning | circa 2/3 del tempo di pulizia |
| Fascia tipica autista (default se non impostata) | 10:00–20:00 |
| Fine massima finestre task (senza vincoli propri) | orario di fine turno più tardo tra gli autisti convocati (default 20:00) |
| Stesso edificio | entro ~100 metri |
| Cluster “vicino” | entro ~10 minuti di viaggio |
| Check-in considerato “stretto” per EO | grosso modo entro le 14:00 / poco margine mattutino |
| Deposito | Via Barrili 31 |

---

## Riferimento tecnico

Per i dettagli di implementazione (file, OR-Tools, parametri esatti) vedi  
[`logistics-optimizer-final-reference.md`](./logistics-optimizer-final-reference.md).
