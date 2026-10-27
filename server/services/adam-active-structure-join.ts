/**
 * Se più righe di app_structures condividono lo stesso logistic_code,
 * i campi appartamento (indirizzo, coordinate, premium, …) escono dalla
 * struttura con active = 1. Se quella agganciata al task è già attiva, resta lei.
 * Se nessuna è attiva, si tiene la struttura del task.
 */
export const ADAM_ACTIVE_STRUCTURE_JOIN_FROM_HOUSEKEEPING = `
JOIN app_structures linked ON linked.id = h.structure_id
JOIN app_structures s ON s.id = COALESCE(
  (
    SELECT preferred.id
    FROM app_structures preferred
    WHERE preferred.logistic_code = linked.logistic_code
      AND preferred.active = 1
    ORDER BY (preferred.id = linked.id) DESC, preferred.id DESC
    LIMIT 1
  ),
  linked.id
)`.trim();
