---
name: Fix sequence calcolo secondo trasferimento ADAM
overview: "Correggere il calcolo della sequenza nell'endpoint POST /api/transfer-to-adam: usare direttamente task.sequence dalla timeline (già \"assoluta\" in WASS) invece di sommare baseSeq da ADAM, così al secondo trasferimento le sequence non raddoppiano (es. 1,2 che diventano 3,4)."
todos: []
isProject: false
---

# Piano: correzione calcolo sequenza al secondo trasferimento su ADAM

## Problema

Nell'endpoint [server/routes.ts](server/routes.ts) (POST `/api/transfer-to-adam`), la sequenza scritta su `app_housekeeping` è calcolata così:

```javascript
const baseSeq = baseSeqByCleaner.get(primaryCleanerId) ?? 0;
const sequence = baseSeq + (task.sequence ?? 1);
```

`baseSeqByCleaner` viene riempito con `MAX(sequence)` letto da `app_housekeeping` per quella data e per ogni cleaner. Al **secondo** trasferimento quel MAX include già le task scritte al primo invio, quindi si somma di nuovo un offset e le sequence "scattano" (es. 1,2 diventano 3,4).

La timeline WASS (PostgreSQL / `daily_assignments_current`) contiene già una `task.sequence` considerata "assoluta" (anche in presenza di task pre-WASS per quel cleaner). L'endpoint non deve quindi applicare un ulteriore offset da ADAM.

## Soluzione

Usare **solo** il valore di `task.sequence` proveniente dalla timeline, senza sommare `baseSeq` da ADAM.

## Modifiche

**File:** [server/routes.ts](server/routes.ts)

1. **Rimuovere** il blocco che costruisce `baseSeqByCleaner` (righe ~4768-4786): la query su `app_housekeeping` con `SELECT cleaned_by_us, COALESCE(MAX(sequence), 0) AS max_seq ... GROUP BY cleaned_by_us` e il ciclo che popola la `Map`.
2. **Sostituire** il calcolo della sequenza nel loop delle task in timeline (righe ~4832-4834):
  - Da: `const baseSeq = baseSeqByCleaner.get(primaryCleanerId) ?? 0;` e `const sequence = baseSeq + (task.sequence ?? 1);`
  - A: `const sequence = task.sequence ?? 1;` (rimuovere la riga che usa `baseSeqByCleaner`).

Dopo la modifica, l'UPDATE su `app_housekeeping` continuerà a ricevere il parametro `sequence` come oggi, ma con il valore già corretto dalla timeline (stesso comportamento al primo e al secondo trasferimento, senza drift).

## Verifica

- Primo trasferimento: le task in timeline hanno sequence 1, 2, ... e su ADAM verranno scritte 1, 2, ...
- Secondo trasferimento: stesse task con le stesse sequence in timeline; su ADAM restano 1, 2, ... invece di diventare 3, 4, ...

Nessuna modifica alla fase di cleanup (task non in timeline) né ad altri endpoint.