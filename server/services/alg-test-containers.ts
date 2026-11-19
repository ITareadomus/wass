import { query } from "../../shared/pg-db";

const ASSIGNMENT_REASONS = ["preassigned_enable_wass", "preassigned_enable_wass_readonly"];

/**
 * Contenitori della prova algoritmo: stessi task della giornata housekeeping
 * già salvata nel database, senza cleaner e senza start/end dell'assegnazione.
 */
export async function refillAlgTestContainersFromDb(
  workDate: string,
  options?: { copyCleaners?: boolean },
): Promise<{ taskCount: number }> {
  await query(
    `DELETE FROM alg_test_assignments WHERE work_date = $1::date`,
    [workDate],
  );
  await query(
    `DELETE FROM alg_test_containers WHERE work_date = $1::date`,
    [workDate],
  );

  const inserted = await query(
    `
    INSERT INTO alg_test_containers (
      scope, work_date, priority,
      task_id, logistic_code, client_id, premium, address, lat, lng,
      cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
      pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
      straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history,
      reasons, customer_reference, locked, locked_reason
    )
    SELECT
      'alg-test',
      src.work_date,
      CASE
        WHEN src.priority IN ('early_out', 'early-out', 'eo') THEN 'early_out'
        WHEN src.priority IN ('high_priority', 'high', 'hp') THEN 'high_priority'
        ELSE 'low_priority'
      END,
      src.task_id,
      src.logistic_code,
      src.client_id,
      COALESCE(src.premium, false),
      src.address,
      src.lat,
      src.lng,
      COALESCE(src.cleaning_time, 0),
      src.checkin_date,
      src.checkout_date,
      src.checkin_time,
      src.checkout_time,
      src.pax_in,
      src.pax_out,
      COALESCE(src.small_equipment, false),
      src.operation_id,
      COALESCE(src.confirmed_operation, false),
      COALESCE(src.straordinaria, false),
      src.type_apt,
      src.alias,
      src.customer_name,
      src.customer_note,
      COALESCE(src.customer_note_history, '[]'::jsonb),
      COALESCE(src.reasons, ARRAY[]::text[]),
      src.customer_reference,
      COALESCE(locks.locked, false),
      locks.locked_reason
    FROM (
      SELECT DISTINCT ON (task_id)
        work_date, task_id, logistic_code, client_id, premium, address, lat, lng,
        cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time,
        pax_in, pax_out, small_equipment, operation_id, confirmed_operation,
        straordinaria, type_apt, alias, customer_name, customer_note, customer_note_history,
        COALESCE(
          ARRAY(
            SELECT reason
            FROM unnest(COALESCE(reasons, ARRAY[]::text[])) AS reason
            WHERE reason <> ALL ($2::text[])
          ),
          ARRAY[]::text[]
        ) AS reasons,
        customer_reference,
        priority
      FROM (
        SELECT
          work_date, task_id::bigint, logistic_code::bigint, client_id::bigint, premium::boolean,
          address::text, lat::numeric, lng::numeric,
          cleaning_time::integer, checkin_date::date, checkout_date::date, checkin_time::text, checkout_time::text,
          pax_in::integer, pax_out::integer, small_equipment::boolean, operation_id::integer, confirmed_operation::boolean,
          straordinaria::boolean, type_apt::text, alias::text, customer_name::text, customer_note::text, customer_note_history::jsonb,
          reasons::text[], customer_reference::text, priority::text, 0 AS source_rank
        FROM daily_assignments_current
        WHERE work_date = $1::date AND (scope = 'housekeeping' OR scope IS NULL)
        UNION ALL
        SELECT
          work_date, task_id::bigint, logistic_code::bigint, client_id::bigint, premium::boolean,
          address::text, lat::numeric, lng::numeric,
          cleaning_time::integer, checkin_date::date, checkout_date::date, checkin_time::text, checkout_time::text,
          pax_in::integer, pax_out::integer, small_equipment::boolean, operation_id::integer, confirmed_operation::boolean,
          straordinaria::boolean, type_apt::text, alias::text, customer_name::text, customer_note::text, customer_note_history::jsonb,
          reasons::text[], customer_reference::text, priority::text, 1 AS source_rank
        FROM daily_containers
        WHERE work_date = $1::date AND (scope = 'housekeeping' OR scope IS NULL)
      ) merged
      ORDER BY task_id, source_rank
    ) src
    LEFT JOIN daily_task_locks locks
      ON locks.work_date = src.work_date AND locks.task_id = src.task_id
    `,
    [workDate, ASSIGNMENT_REASONS],
  );

  if (options?.copyCleaners) {
    await query(
      `
      DELETE FROM alg_test_selected_cleaners
      WHERE work_date = $1::date
        AND COALESCE(cardinality(cleaners), 0) = 0
      `,
      [workDate],
    );
    await query(
      `
      INSERT INTO alg_test_selected_cleaners (work_date, cleaners, scope, created_at, updated_at)
      SELECT work_date, cleaners, 'alg-test', NOW(), NOW()
      FROM daily_selected_cleaners
      WHERE work_date = $1::date
        AND (scope = 'housekeeping' OR scope IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM alg_test_selected_cleaners existing
          WHERE existing.work_date = $1::date
        )
      `,
      [workDate],
    );
  }

  return { taskCount: inserted.rowCount ?? 0 };
}
