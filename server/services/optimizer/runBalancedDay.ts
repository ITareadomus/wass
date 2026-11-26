import { randomUUID } from "crypto";
import pool from "../../../shared/pg-db";
import { assignmentScopeSql, assignmentsTableFor, containersTableFor, normalizeAssignmentScope, selectedCleanersTableFor, type AssignmentScope } from "../../../shared/assignment-scope";
import { assignBalancedDay, type BalancedPriority, type BalancedTask } from "../../../shared/balanced-assignment";
import type { HkConstraintSettings } from "../../../shared/hk-constraint-settings";
import { DEFAULT_APARTMENT_TYPES } from "./phase2";
import { createRun, loadLockedCleanerIds, updateRunStatus } from "./db";
import { loadPriorityStartWindows, priorityToDbFormat } from "./priorityWindows";
import { loadTriadeAssignmentWeights, triadeWeightOrBase } from "../triade-assignment";
import type { WorkloadBalanceChoice } from "../../../shared/workload-balance-choice";

function toMinutes(value: unknown): number | null {
  if (value == null) return null;
  const match = String(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function fromMinutes(workDate: string, value: number): Date {
  const [year, month, day] = workDate.split("-").map(Number);
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, 0, 0));
}

function isStickyAssignment(reasons: unknown, taskId: number, lockedTaskIds: Set<number>): boolean {
  if (lockedTaskIds.has(taskId)) return true;
  const list = Array.isArray(reasons) ? reasons : [];
  return list.includes("preassigned_enable_wass_readonly");
}

function mapPriority(value: unknown): BalancedPriority | null {
  const normalized = String(value ?? "").toLowerCase().replace(/[_-]/g, "");
  if (normalized === "earlyout" || normalized === "eo") return "EO";
  if (normalized === "highpriority" || normalized === "hp") return "HP";
  if (normalized === "lowpriority" || normalized === "lp") return "LP";
  return null;
}

async function loadApartmentTypes() {
  try {
    const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'app_settings'`);
    const apt = result.rows[0]?.value?.apartment_types;
    if (apt && typeof apt === "object") {
      return {
        standard_apt: apt.standard_apt || DEFAULT_APARTMENT_TYPES.standard_apt,
        premium_apt: apt.premium_apt || DEFAULT_APARTMENT_TYPES.premium_apt,
        straordinario_apt: apt.straordinario_apt || DEFAULT_APARTMENT_TYPES.straordinario_apt,
        formatore_apt: apt.formatore_apt || DEFAULT_APARTMENT_TYPES.formatore_apt,
        ufficio_apt: apt.ufficio_apt || DEFAULT_APARTMENT_TYPES.ufficio_apt,
      };
    }
  } catch (error) {
    console.warn("[balanced] Tipi appartamento non letti, uso i default:", error);
  }
  return DEFAULT_APARTMENT_TYPES;
}

async function loadFormatoreRules() {
  try {
    const result = await pool.query(`SELECT value FROM app_settings WHERE key = 'app_settings'`);
    const value = result.rows[0]?.value;
    const priority = value?.priority_types?.formatore_cleaner;
    const taskTypes = value?.task_types?.formatore_cleaner;
    const allowedPriorities: string[] = [];
    if (priority && typeof priority === "object") {
      if (priority.early_out) allowedPriorities.push("early_out");
      if (priority.high_priority) allowedPriorities.push("high_priority");
      if (priority.low_priority) allowedPriorities.push("low_priority");
    }
    return {
      allowedPriorities: allowedPriorities.length > 0 ? allowedPriorities : ["early_out", "high_priority", "low_priority"],
      standardApt: taskTypes && typeof taskTypes === "object" ? Boolean(taskTypes.standard_apt) : true,
    };
  } catch (error) {
    console.warn("[balanced] Regole formatore non lette:", error);
    return null;
  }
}

export async function runBalancedDay(
  workDate: string,
  settings: HkConstraintSettings,
  scope: AssignmentScope = "housekeeping",
  workloadChoice?: WorkloadBalanceChoice,
) {
  const resolvedScope = normalizeAssignmentScope(scope);
  const runId = randomUUID();
  const started = Date.now();
  await createRun({
    runId,
    workDate,
    algorithmVersion: "v3-balanced",
    params: settings as never,
    status: "success",
  });

  try {
    const [containerRows, assignedRows, lockedTaskRows, selectedRows, apartmentTypes, formatore, lockedCleanerIds] = await Promise.all([
      pool.query(
        `
          SELECT task_id, logistic_code, client_id, operation_id, lat, lng, cleaning_time,
                 checkin_time, checkout_time, premium, straordinaria, type_apt, priority
          FROM ${containersTableFor(resolvedScope)}
          WHERE work_date = $1
            AND ${assignmentScopeSql(resolvedScope)}
            AND lat IS NOT NULL
            AND lng IS NOT NULL
            AND NOT COALESCE(locked, false)
            AND task_id NOT IN (
              SELECT task_id FROM daily_task_locks
              WHERE work_date = $1 AND locked = true
            )
        `,
        [workDate]
      ),
      pool.query(
        `
          SELECT cleaner_id, task_id, logistic_code, client_id, operation_id,
                 lat, lng, cleaning_time, checkin_time, checkout_time,
                 premium, straordinaria, type_apt, priority, reasons
          FROM ${assignmentsTableFor(resolvedScope)}
          WHERE work_date = $1 AND ${assignmentScopeSql(resolvedScope)}
        `,
        [workDate]
      ),
      pool.query(
        `
          SELECT task_id
          FROM daily_task_locks
          WHERE work_date = $1 AND locked = true
        `,
        [workDate]
      ),
      pool.query(
        `
          SELECT cleaners
          FROM ${selectedCleanersTableFor(resolvedScope)}
          WHERE work_date = $1 AND ${assignmentScopeSql(resolvedScope)}
        `,
        [workDate]
      ),
      loadApartmentTypes(),
      loadFormatoreRules(),
      loadLockedCleanerIds(workDate),
    ]);

    const selectedIds = (selectedRows.rows[0]?.cleaners || [])
      .map((id: unknown) => Number(id))
      .filter((id: number) => Number.isFinite(id) && id > 0);
    const locked = new Set(lockedCleanerIds);
    const cleanerIds = selectedIds.filter((id: number) => !locked.has(id));
    const cleanerRows = cleanerIds.length
      ? await pool.query(
          `
            SELECT cleaner_id, role, start_time, end_time
            FROM cleaners
            WHERE work_date = $1 AND cleaner_id = ANY($2::int[])
          `,
          [workDate, cleanerIds]
        )
      : { rows: [] };

    const lockedTaskIds = new Set(
      lockedTaskRows.rows.map((row) => Number(row.task_id)).filter((id: number) => Number.isFinite(id) && id > 0),
    );
    const assignmentByTask = new Map<number, (typeof assignedRows.rows)[number]>();
    for (const row of assignedRows.rows) {
      const taskId = Number(row.task_id);
      if (!Number.isFinite(taskId) || taskId <= 0 || assignmentByTask.has(taskId)) continue;
      assignmentByTask.set(taskId, row);
    }
    const selectedSet = new Set(cleanerIds);
    const containerIds = new Set(containerRows.rows.map((row) => Number(row.task_id)));
    const fixedByCleaner = new Map<number, { count: number; minutes: number }>();
    const movableRows: Array<(typeof assignedRows.rows)[number]> = [];
    for (const [taskId, row] of assignmentByTask) {
      const cleanerId = Number(row.cleaner_id);
      const onSelected = selectedSet.has(cleanerId);
      const sticky = isStickyAssignment(row.reasons, taskId, lockedTaskIds) || !onSelected || row.lat == null || row.lng == null;
      if (sticky) {
        if (!onSelected) continue;
        const bucket = fixedByCleaner.get(cleanerId) ?? { count: 0, minutes: 0 };
        bucket.count += 1;
        bucket.minutes += Number(row.cleaning_time) || 0;
        fixedByCleaner.set(cleanerId, bucket);
        continue;
      }
      if (!containerIds.has(taskId)) movableRows.push(row);
    }

    const freshRows = [
      ...containerRows.rows.filter((row) => {
        const taskId = Number(row.task_id);
        if (lockedTaskIds.has(taskId)) return false;
        const existing = assignmentByTask.get(taskId);
        return !existing || !isStickyAssignment(existing.reasons, taskId, lockedTaskIds);
      }),
      ...movableRows,
    ];
    const taskSeeds = freshRows.map((row) => ({
      taskId: Number(row.task_id),
      clientId: row.client_id == null ? null : Number(row.client_id),
      operationId: row.operation_id == null ? null : Number(row.operation_id),
    }));
    const weights = await loadTriadeAssignmentWeights(workDate, taskSeeds, cleanerIds);
    let priorityWindows = null;
    try {
      priorityWindows = await loadPriorityStartWindows();
    } catch (error) {
      console.warn("[balanced] Finestre priorità non disponibili:", error);
    }

    const tasks: BalancedTask[] = freshRows.map((row) => ({
      taskId: Number(row.task_id),
      logisticCode: Number(row.logistic_code) || 0,
      lat: Number(row.lat),
      lng: Number(row.lng),
      cleaningMin: Number(row.cleaning_time) || 0,
      checkoutMin: toMinutes(row.checkout_time),
      checkinMin: toMinutes(row.checkin_time),
      priority: mapPriority(row.priority),
      triadeWeight: weights.taskWeight.get(Number(row.task_id)) ?? triadeWeightOrBase(null),
      premium: row.premium === true,
      straordinaria: row.straordinaria === true,
      typeApt: String(row.type_apt ?? ""),
      isOffice: false,
    }));
    const preferredMinutes = new Map(
      (workloadChoice?.mode === "custom" ? workloadChoice.targets : []).map((row) => [row.cleanerId, row.minutes]),
    );
    const cleaners = cleanerRows.rows.map((row) => ({
      cleanerId: Number(row.cleaner_id),
      role: String(row.role ?? "Standard"),
      triadeWeight: weights.cleanerWeight.get(Number(row.cleaner_id)) ?? triadeWeightOrBase(null),
      startMin: toMinutes(row.start_time) ?? 10 * 60,
      endMin: toMinutes(row.end_time) ?? 20 * 60,
      fixedCount: fixedByCleaner.get(Number(row.cleaner_id))?.count ?? 0,
      fixedWorkMin: fixedByCleaner.get(Number(row.cleaner_id))?.minutes ?? 0,
      fixedHasLongOt: false,
      fixedHasAnyOt: false,
      anchor: null,
      targetMin: preferredMinutes.get(Number(row.cleaner_id)) ?? null,
    }));
    const effectiveSettings = workloadChoice
      ? { ...settings, workloadBalance: "hard" as const }
      : settings;

    const solved = assignBalancedDay({
      tasks,
      cleaners,
      settings: effectiveSettings,
      apartmentTypes,
      formatore,
      priorityWindows,
    });
    const logisticByTask = new Map(tasks.map((task) => [task.taskId, task.logisticCode]));

    for (const row of solved.assignments) {
      await pool.query(
        `
          INSERT INTO optimizer.optimizer_assignment (
            run_id, cleaner_id, task_id, logistic_code, sequence, start_time, end_time,
            travel_minutes_from_prev, reasons, priority_type, priority_penalty, priority_reasons
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        `,
        [
          runId,
          row.cleanerId,
          row.taskId,
          logisticByTask.get(row.taskId) ?? 0,
          row.sequence,
          fromMinutes(workDate, row.startMin),
          fromMinutes(workDate, row.endMin),
          row.travelMin,
          [],
          priorityToDbFormat(row.priority),
          0,
          [],
        ]
      );
    }
    for (const row of solved.unassigned) {
      await pool.query(
        `
          INSERT INTO optimizer.optimizer_unassigned (run_id, task_id, logistic_code, reason_code, details)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [runId, row.taskId, logisticByTask.get(row.taskId) ?? null, row.reason, JSON.stringify({ reason: row.reason })]
      );
    }

    const summary = {
      tasksAssigned: solved.assignments.length,
      tasksUnassigned: solved.unassigned.length,
      fifthTaskCleaners: solved.fifthTaskCleaners,
      durationMs: Date.now() - started,
    };
    await updateRunStatus(runId, solved.unassigned.length > 0 ? "partial" : "success", summary);
    return { status: "success" as const, runId, summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateRunStatus(runId, "failed", { error: message });
    return { status: "failed" as const, runId, error: message, summary: { tasksAssigned: 0, tasksUnassigned: 0 } };
  }
}
