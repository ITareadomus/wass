/**
 * Se più righe di app_structures condividono lo stesso logistic_code,
 * i campi appartamento (indirizzo, coordinate, premium, …) escono dalla
 * struttura con active = 1, ma solo se ha coordinate utilizzabili.
 * Se quella agganciata al task è già attiva, resta lei.
 * Se la struttura attiva non ha coordinate, si tiene la struttura del task:
 * altrimenti il filtro lat/lng esclude il task e il sync ADAM non lo aggiorna.
 */
export const ADAM_ACTIVE_STRUCTURE_JOIN_FROM_HOUSEKEEPING = `
JOIN app_structures linked ON linked.id = h.structure_id
JOIN app_structures s ON s.id = COALESCE(
  (
    SELECT preferred.id
    FROM app_structures preferred
    WHERE preferred.logistic_code = linked.logistic_code
      AND preferred.active = 1
      AND preferred.lat IS NOT NULL AND preferred.lng IS NOT NULL
      AND preferred.lat != '' AND preferred.lng != ''
      AND preferred.lat != '0' AND preferred.lng != '0'
    ORDER BY (preferred.id = linked.id) DESC, preferred.id DESC
    LIMIT 1
  ),
  linked.id
)`.trim();
