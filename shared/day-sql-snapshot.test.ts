import { describe, expect, it } from "vitest";
import { parseSqlInserts, snapshotFromDaySql } from "./day-sql-snapshot";

const SAMPLE = `-- Giornata WASS 2026-11-12
BEGIN;
INSERT INTO public."cleaners" ("cleaner_id", "work_date", "name", "lastname", "role", "start_time", "end_time")
VALUES
  ('24'::integer, '2026-11-12'::date, 'Ada', 'Bianchi', 'standard', '10:00', '18:00'),
  ('132'::integer, '2026-11-12'::date, 'Lia', 'Neri', 'premium', '09:30', '17:30');
INSERT INTO public."aliases" ("cleaner_id", "alias", "name", "lastname")
VALUES
  ('24'::integer, 'ADA', 'Ada', 'Bianchi')
ON CONFLICT ("cleaner_id") DO UPDATE SET "alias" = EXCLUDED."alias";
INSERT INTO public."daily_selected_cleaners" ("work_date", "scope", "cleaners")
VALUES
  ('2026-11-12'::date, 'housekeeping', '{24,132,845}'::integer[]);
INSERT INTO public."daily_assignments_current" ("scope", "work_date", "cleaner_id", "task_id", "logistic_code", "address", "lat", "lng", "cleaning_time", "alias", "start_time", "end_time", "sequence", "customer_note")
VALUES
  ('housekeeping', '2026-11-12'::date, '24'::integer, '242632'::bigint, '1001'::bigint, 'Via Roma 1, Milano', '45.460000'::numeric, '9.190000'::numeric, '90'::integer, 'APT A', '10:15:00'::time, '11:45:00'::time, '1'::integer, 'note con ''apice'' e, virgola'),
  ('office', '2026-11-12'::date, '9'::integer, '1'::bigint, '1'::bigint, 'Ufficio', '45.1'::numeric, '9.1'::numeric, '30'::integer, NULL, '08:00:00'::time, '08:30:00'::time, '1'::integer, NULL);
INSERT INTO public."daily_containers" ("work_date", "scope", "task_id", "logistic_code", "lat", "lng", "address", "locked")
VALUES
  ('2026-11-12'::date, 'housekeeping', '242632'::integer, '1001'::integer, '45.460000'::numeric, '9.190000'::numeric, 'Via Roma 1', 'false'::boolean),
  ('2026-11-12'::date, 'housekeeping', '242999'::integer, '1009'::integer, '45.480000'::numeric, '9.200000'::numeric, 'Via Spare', 'false'::boolean);
COMMIT;
`;

describe("parseSqlInserts", () => {
  it("tiene le stringhe con virgole e apici e scarta ON CONFLICT", () => {
    const tables = parseSqlInserts(SAMPLE);
    const assignments = tables.find((table) => table.table === "daily_assignments_current");
    expect(assignments?.rows).toHaveLength(2);
    expect(assignments?.rows[0][13]).toBe("note con 'apice' e, virgola");
    const selected = tables.find((table) => table.table === "daily_selected_cleaners");
    expect(selected?.rows[0][2]).toBe("{24,132,845}");
  });
});

describe("snapshotFromDaySql", () => {
  it("ricostruisce la giornata housekeeping e ignora lo scope ufficio", () => {
    const day = snapshotFromDaySql(SAMPLE);
    expect(day.workDate).toBe("2026-11-12");
    expect(day.assignedCount).toBe(1);
    expect(day.cleaners.map((cleaner) => cleaner.name)).toEqual(["ADA", "ID 845", "Lia Neri"]);
    expect(day.tasks.find((task) => task.taskId === "242632")).toMatchObject({
      cleanerId: 24,
      label: "APT A",
      startMin: 10 * 60 + 15,
      endMin: 11 * 60 + 45,
      lat: 45.46,
    });
    expect(day.tasks.some((task) => task.taskId === "242999" && !task.assigned)).toBe(true);
    expect(day.tasks.some((task) => task.taskId === "1")).toBe(false);
  });

  it("isola la prova algoritmo dalla giornata vera", () => {
    const sql = `${SAMPLE}
INSERT INTO public."daily_assignments_current" ("scope", "work_date", "cleaner_id", "task_id", "logistic_code", "address", "lat", "lng", "cleaning_time", "alias", "start_time", "end_time", "sequence")
VALUES
  ('alg-test', '2026-11-12'::date, '132'::integer, '242999'::bigint, '1009'::bigint, 'Via Spare', '45.480000'::numeric, '9.200000'::numeric, '60'::integer, 'APT B', '12:00:00'::time, '13:00:00'::time, '1'::integer);
INSERT INTO public."daily_containers" ("work_date", "scope", "task_id", "logistic_code", "lat", "lng", "address", "locked")
VALUES
  ('2026-11-12'::date, 'alg-test', '242999'::integer, '1009'::integer, '45.480000'::numeric, '9.200000'::numeric, 'Via Spare', 'false'::boolean);
INSERT INTO public."daily_selected_cleaners" ("work_date", "scope", "cleaners")
VALUES
  ('2026-11-12'::date, 'alg-test', '{132}'::integer[]);
`;
    const proof = snapshotFromDaySql(sql, "alg-test");
    expect(proof.assignedCount).toBe(1);
    expect(proof.tasks.map((task) => task.taskId)).toEqual(["242999"]);
    expect(proof.cleaners.map((cleaner) => cleaner.id)).toEqual([132]);
    const real = snapshotFromDaySql(sql, "housekeeping");
    expect(real.tasks.some((task) => task.taskId === "242632" && task.assigned)).toBe(true);
    expect(real.tasks.some((task) => task.assigned && task.cleanerId === 132 && task.taskId === "242999")).toBe(false);
  });

  it("legge la prova dalle tabelle alg_test e lascia stare la giornata vera", () => {
    const sql = `${SAMPLE}
INSERT INTO public."alg_test_assignments" ("scope", "work_date", "cleaner_id", "task_id", "logistic_code", "address", "lat", "lng", "cleaning_time", "alias", "start_time", "end_time", "sequence")
VALUES
  ('alg-test', '2026-11-12'::date, '845'::integer, '300001'::bigint, '2001'::bigint, 'Via Prova 2', '45.470000'::numeric, '9.210000'::numeric, '45'::integer, 'APT P', '14:00:00'::time, '14:45:00'::time, '1'::integer);
INSERT INTO public."alg_test_containers" ("work_date", "scope", "task_id", "logistic_code", "lat", "lng", "address", "locked")
VALUES
  ('2026-11-12'::date, 'alg-test', '300002'::integer, '2002'::integer, '45.471000'::numeric, '9.211000'::numeric, 'Via Prova 3', 'false'::boolean);
INSERT INTO public."alg_test_selected_cleaners" ("work_date", "scope", "cleaners")
VALUES
  ('2026-11-12'::date, 'alg-test', '{845}'::integer[]);
`;
    const proof = snapshotFromDaySql(sql, "alg-test");
    expect(proof.tasks.map((task) => task.taskId).sort()).toEqual(["300001", "300002"]);
    expect(proof.tasks.find((task) => task.taskId === "300001")).toMatchObject({ assigned: true, cleanerId: 845 });
    expect(proof.cleaners.map((cleaner) => cleaner.id)).toEqual([845]);
    const real = snapshotFromDaySql(sql, "housekeeping");
    expect(real.tasks.some((task) => task.taskId === "242632" && task.assigned)).toBe(true);
    expect(real.tasks.some((task) => task.taskId === "300001")).toBe(false);
  });
});
