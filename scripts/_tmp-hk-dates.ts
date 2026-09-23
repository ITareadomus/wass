import pool from "../shared/pg-db";

const result = await pool.query(`
  SELECT work_date::text AS work_date,
         COUNT(*)::int AS tasks,
         COUNT(DISTINCT cleaner_id)::int AS cleaners
  FROM daily_assignments_current
  WHERE scope = 'housekeeping' OR scope IS NULL
  GROUP BY work_date
  HAVING COUNT(*) > 0
  ORDER BY work_date DESC
  LIMIT 12
`);
console.log(JSON.stringify(result.rows));
await pool.end();
