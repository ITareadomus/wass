import * as mysql from "mysql2/promise";
import { formatInTimeZone } from "date-fns-tz";
import { databaseConfig } from "../../config/database";
import * as workspaceFiles from "./workspace-files";
import { pgDailyAssignmentsService } from "./pg-daily-assignments-service";
import {
  hydrateTasksFromContainers,
  recalculateCleanerTimes,
} from "./housekeeping-recalculate-times";

export type RefreshSyncMode = "apt" | "assignments";

export interface LockedConflictTask {
  task_id: number;
  logistic_code: number | null;
  locked_reason: string | null;
  currentCleanerId: number | null;
  adamCleanerId: number | null;
}

export interface AssignmentSyncResult {
  success: boolean;
  needsUnlockConfirm?: boolean;
  lockedTasks?: LockedConflictTask[];
  moved?: number;
  unassigned?: number;
  assigned?: number;
  collaborationUpdated?: number;
  recalculatedCleaners?: number;
  unlockedTaskIds?: number[];
  autoConvokedCleaners?: number;
  error?: string;
}

interface AdamAssignmentRow {
  task_id: number;
  logistic_code: number | null;
  client_id: number | null;
  premium: boolean;
  address: string | null;
  lat: string | null;
  lng: string | null;
  cleaning_time: number;
  checkin_date: string | null;
  checkout_date: string | null;
  checkin_time: string | null;
  checkout_time: string | null;
  pax_in: number;
  pax_out: number;
  small_equipment: boolean;
  operation_id: number | null;
  confirmed_operation: boolean;
  straordinaria: boolean;
  type_apt: string | null;
  alias: string | null;
  customer_name: string | null;
  customer_reference: string | null;
  primaryCleanerId: number | null;
  sequence: number;
  secondaryCleanerIds: number[];
  enableWassReadonly: boolean;
}

const PREASSIGNED_REASON_NORMAL = "preassigned_enable_wass";
const PREASSIGNED_REASON_READONLY = "preassigned_enable_wass_readonly";

function isTrue(value: any): boolean {
  return value === true || value === 1 || value === "1";
}

function applyReadonlyPreassignedMode(task: any): any {
  const reasons = Array.isArray(task?.reasons) ? task.reasons : [];
  const nextReasons: string[] = [];
  const seen = new Set<string>();
  for (const entry of reasons) {
    const reason = String(entry ?? "").trim();
    if (
      !reason ||
      seen.has(reason) ||
      reason === PREASSIGNED_REASON_NORMAL ||
      reason === PREASSIGNED_REASON_READONLY
    ) {
      continue;
    }
    seen.add(reason);
    nextReasons.push(reason);
  }
  nextReasons.push(PREASSIGNED_REASON_READONLY);
  task.reasons = nextReasons;
  task.preAssignedMode = "readonly";
  return task;
}

function mapStructureTypeToLetter(structureTypeId: number): string {
  const map: Record<number, string> = { 1: "A", 2: "B", 3: "C", 4: "D", 5: "E", 6: "F" };
  return map[structureTypeId] || "X";
}

function getRomeTimestamp(): string {
  return formatInTimeZone(new Date(), "Europe/Rome", "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function normalizeIdSet(ids: Iterable<number | null | undefined>): number[] {
  return Array.from(
    new Set(
      Array.from(ids)
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  ).sort((a, b) => a - b);
}

function sameIdSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function fetchAdamAssignmentsForDate(
  workDate: string,
  scope: "housekeeping" | "office"
): Promise<AdamAssignmentRow[]> {
  let connection: mysql.Connection | null = null;
  try {
    connection = await mysql.createConnection({
      host: databaseConfig.mysql.host,
      port: databaseConfig.mysql.port,
      user: databaseConfig.mysql.user,
      password: databaseConfig.mysql.password,
      database: databaseConfig.mysql.database,
    });

    const officeFilter =
      scope === "office"
        ? "AND h.operation_id IN (15, 38)"
        : `AND (COALESCE(o.enable_wass, 0) = 1 OR COALESCE(o.enable_wass_readonly, 0) = 1)`;

    const [rows]: any = await connection.execute(
      `
        SELECT
          h.id AS task_id,
          s.logistic_code AS logistic_code,
          s.customer_id AS client_id,
          s.premium AS premium,
          s.address1 AS address,
          s.lat,
          s.lng,
          (
              SELECT duration_minutes
              FROM app_structure_timings ast
              WHERE ast.structure_type_id = s.structure_type_id
                  AND ast.customer_id = s.customer_id
                  AND ast.structure_operation_id = (
                      CASE WHEN h.operation_id = 0 THEN 2 ELSE h.operation_id END
                  )
                  AND ast.structure_activity_id = h.activity_id
                  AND ast.data_contratto <= h.checkout
                  AND ast.deleted_at IS NULL
              ORDER BY ast.data_contratto DESC
              LIMIT 1
          ) AS cleaning_time,
          h.checkin,
          h.checkout,
          h.checkin_time,
          h.checkout_time,
          h.checkin_pax AS pax_in,
          h.checkout_pax AS pax_out,
          s.structure_type_id,
          h.operation_id,
          c.alias AS alias,
          c.name AS customer_name,
          s.customer_structure_reference AS customer_reference,
          h.cleaned_by_us AS primary_cleaner_id,
          h.sequence AS adam_sequence,
          COALESCE(o.enable_wass_readonly, 0) AS enable_wass_readonly
        FROM app_housekeeping h
        JOIN app_structures s ON h.structure_id = s.id
        LEFT JOIN app_customers c ON s.customer_id = c.id
        LEFT JOIN app_structure_operation o ON o.id = h.operation_id
        WHERE h.checkout = ?
          AND h.deleted_at IS NULL
          AND h.deleted_at_client IS NULL
          AND s.lat IS NOT NULL AND s.lng IS NOT NULL
          AND s.lat != '' AND s.lng != ''
          AND s.lat != '0' AND s.lng != '0'
          ${officeFilter}
        ORDER BY h.cleaned_by_us ASC, h.sequence ASC, h.id ASC
      `,
      [workDate]
    );

    const list = Array.isArray(rows) ? rows : [];
    const taskIds = list
      .map((r: any) => Number(r?.task_id))
      .filter((id: number) => Number.isFinite(id));

    const collabByTask = new Map<number, number[]>();
    if (taskIds.length > 0) {
      const placeholders = taskIds.map(() => "?").join(",");
      const [collabRows]: any = await connection.execute(
        `
          SELECT housekeeping_id, user_id
          FROM app_housekeeping_collaborations
          WHERE housekeeping_id IN (${placeholders})
            AND deleted_at IS NULL
            AND user_id IS NOT NULL
            AND user_id > 0
        `,
        taskIds
      );
      for (const row of Array.isArray(collabRows) ? collabRows : []) {
        const taskId = Number(row?.housekeeping_id);
        const userId = Number(row?.user_id);
        if (!Number.isFinite(taskId) || !Number.isFinite(userId) || userId <= 0) continue;
        if (!collabByTask.has(taskId)) collabByTask.set(taskId, []);
        collabByTask.get(taskId)!.push(userId);
      }
    }

    return list
      .map((r: any) => {
        const taskId = Number(r?.task_id);
        if (!Number.isFinite(taskId)) return null;
        const operationIdRaw = r?.operation_id;
        const operationId = operationIdRaw != null ? Number(operationIdRaw) : null;
        const normalizedOperationId = operationId === 0 ? 2 : operationId;
        const clientId = r?.client_id != null ? Number(r.client_id) : null;
        const primaryRaw = Number(r?.primary_cleaner_id);
        const primaryCleanerId =
          Number.isFinite(primaryRaw) && primaryRaw > 0 ? primaryRaw : null;
        const sequenceRaw = Number(r?.adam_sequence);
        const sequence =
          Number.isFinite(sequenceRaw) && sequenceRaw > 0 ? sequenceRaw : 9999;
        const secondaries = normalizeIdSet(
          (collabByTask.get(taskId) || []).filter((id) => id !== primaryCleanerId)
        );

        return {
          task_id: taskId,
          logistic_code: r?.logistic_code != null ? Number(r.logistic_code) : null,
          client_id: clientId,
          premium: isTrue(r?.premium),
          address: r?.address ? String(r.address) : null,
          lat: r?.lat != null ? String(r.lat).replace(",", ".").trim() : null,
          lng: r?.lng != null ? String(r.lng).replace(",", ".").trim() : null,
          cleaning_time: Number(r?.cleaning_time ?? 0) || 0,
          checkin_date: r?.checkin
            ? formatInTimeZone(new Date(r.checkin), "Europe/Rome", "yyyy-MM-dd")
            : null,
          checkout_date: r?.checkout
            ? formatInTimeZone(new Date(r.checkout), "Europe/Rome", "yyyy-MM-dd")
            : null,
          checkin_time:
            r?.checkin_time != null ? String(r.checkin_time).trim() || null : null,
          checkout_time:
            r?.checkout_time != null ? String(r.checkout_time).trim() || null : null,
          pax_in: r?.pax_in != null ? Number(r.pax_in) : 0,
          pax_out: r?.pax_out != null ? Number(r.pax_out) : 0,
          small_equipment: Number(r?.structure_type_id) === 1,
          operation_id: normalizedOperationId,
          confirmed_operation: operationId !== 0,
          straordinaria: Number(normalizedOperationId) === 3,
          type_apt: mapStructureTypeToLetter(Number(r?.structure_type_id)),
          alias: r?.alias != null ? String(r.alias).trim() || null : null,
          customer_name:
            r?.customer_name != null ? String(r.customer_name).trim() || null : null,
          customer_reference:
            clientId === 3 && r?.customer_reference != null
              ? String(r.customer_reference).trim() || null
              : null,
          primaryCleanerId,
          sequence,
          secondaryCleanerIds: secondaries,
          enableWassReadonly: isTrue(r?.enable_wass_readonly),
        } as AdamAssignmentRow;
      })
      .filter((row: AdamAssignmentRow | null): row is AdamAssignmentRow => row !== null);
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch {
        // ignore
      }
    }
  }
}

function cloneTaskPayload(source: any, overrides: Record<string, any> = {}): any {
  const baseCleaning =
    Number(source?.base_cleaning_time ?? source?.cleaning_time ?? 0) || 0;
  return {
    task_id: Number(source.task_id),
    logistic_code: Number(source.logistic_code ?? source.name ?? 0) || 0,
    client_id: source.client_id ?? null,
    premium: Boolean(source.premium),
    address: source.address ?? null,
    lat: source.lat ?? null,
    lng: source.lng ?? null,
    cleaning_time: Number(source.cleaning_time ?? baseCleaning) || 0,
    base_cleaning_time: baseCleaning || undefined,
    checkin_date: source.checkin_date ?? null,
    checkout_date: source.checkout_date ?? null,
    checkin_time: source.checkin_time ?? null,
    checkout_time: source.checkout_time ?? null,
    pax_in: Number(source.pax_in ?? 0) || 0,
    pax_out: Number(source.pax_out ?? 0) || 0,
    small_equipment: Boolean(source.small_equipment),
    operation_id: source.operation_id ?? 2,
    confirmed_operation: source.confirmed_operation !== undefined
      ? Boolean(source.confirmed_operation)
      : true,
    straordinaria: Boolean(source.straordinaria),
    type_apt: source.type_apt ?? null,
    alias: source.alias ?? null,
    customer_name: source.customer_name ?? null,
    customer_reference: source.customer_reference ?? null,
    customer_note: source.customer_note ?? null,
    customer_note_history: source.customer_note_history ?? null,
    reasons: Array.isArray(source.reasons) ? [...source.reasons] : [],
    preAssignedMode: source.preAssignedMode ?? undefined,
    priority: source.priority || "low_priority",
    start_time: null,
    end_time: null,
    followup: false,
    sequence: 0,
    travel_time: 0,
    manually_moved: false,
    ...overrides,
  };
}

function buildTaskFromAdam(row: AdamAssignmentRow, existing?: any): any {
  const source = existing
    ? {
        ...existing,
        ...row,
        cleaning_time: row.cleaning_time || existing.cleaning_time,
        customer_note: existing.customer_note,
        customer_note_history: existing.customer_note_history,
        reasons: existing.reasons,
        preAssignedMode: existing.preAssignedMode,
        priority: existing.priority || "low_priority",
      }
    : row;
  const payload = cloneTaskPayload(source);
  if (row.enableWassReadonly) {
    applyReadonlyPreassignedMode(payload);
  }
  return payload;
}

function assignmentDiffers(
  currentCleanerIds: number[],
  currentPrimary: number | null,
  currentSequence: number | null,
  desired: AdamAssignmentRow
): boolean {
  const desiredCleaners = normalizeIdSet([
    desired.primaryCleanerId,
    ...desired.secondaryCleanerIds,
  ]);
  if (!desired.primaryCleanerId) {
    return currentCleanerIds.length > 0;
  }
  if (!sameIdSet(currentCleanerIds, desiredCleaners)) return true;
  if (currentPrimary !== desired.primaryCleanerId) return true;
  const desiredSeq = desired.sequence >= 9999 ? null : desired.sequence;
  if (
    desiredSeq != null &&
    currentSequence != null &&
    Number(currentSequence) !== Number(desiredSeq)
  ) {
    return true;
  }
  return false;
}

/**
 * Sync timeline cleaner / sequence / collaborations from ADAM.
 * ADAM wins. Locked WASS tasks that would move need confirmUnlockLocked.
 */
export async function syncTimelineAssignmentsFromAdam(
  workDate: string,
  modifiedBy: string = "system",
  scope: "housekeeping" | "office" = "housekeeping",
  options: { confirmUnlockLocked?: boolean } = {}
): Promise<AssignmentSyncResult> {
  try {
    const adamRows = await fetchAdamAssignmentsForDate(workDate, scope);
    const adamById = new Map(adamRows.map((row) => [row.task_id, row]));

    const timelineData =
      (await workspaceFiles.loadTimeline(workDate, scope)) ||
      {
        metadata: { date: workDate, last_updated: getRomeTimestamp(), created_by: modifiedBy },
        cleaners_assignments: [],
        meta: { total_cleaners: 0, used_cleaners: 0, assigned_tasks: 0, total_tasks: 0 },
      };
    timelineData.cleaners_assignments = Array.isArray(timelineData.cleaners_assignments)
      ? timelineData.cleaners_assignments
      : [];

    const locksMap = await pgDailyAssignmentsService.getLocksMap(workDate);

    type CurrentAssignment = {
      cleanerIds: number[];
      primaryCleanerId: number | null;
      sequence: number | null;
      task: any;
    };
    const currentByTask = new Map<number, CurrentAssignment>();
    for (const entry of timelineData.cleaners_assignments) {
      const cleanerId = Number(entry?.cleaner?.id);
      if (!Number.isFinite(cleanerId) || cleanerId <= 0) continue;
      for (const task of entry.tasks || []) {
        const taskId = Number(task?.task_id);
        if (!Number.isFinite(taskId)) continue;
        const existing = currentByTask.get(taskId);
        if (!existing) {
          currentByTask.set(taskId, {
            cleanerIds: [cleanerId],
            primaryCleanerId:
              task?.is_primary === false ? null : cleanerId,
            sequence: Number(task?.sequence) || null,
            task,
          });
        } else {
          if (!existing.cleanerIds.includes(cleanerId)) {
            existing.cleanerIds.push(cleanerId);
          }
          if (task?.is_primary === true) {
            existing.primaryCleanerId = cleanerId;
            existing.sequence = Number(task?.sequence) || existing.sequence;
          } else if (existing.primaryCleanerId == null && task?.is_primary !== false) {
            existing.primaryCleanerId = cleanerId;
          }
          // Prefer richer payload
          existing.task = { ...existing.task, ...task };
        }
      }
    }
    for (const info of currentByTask.values()) {
      info.cleanerIds = normalizeIdSet(info.cleanerIds);
      if (info.primaryCleanerId == null && info.cleanerIds.length === 1) {
        info.primaryCleanerId = info.cleanerIds[0];
      }
    }

    const lockedConflicts: LockedConflictTask[] = [];
    const relevantTaskIds = new Set<number>([
      ...currentByTask.keys(),
      ...adamRows.filter((r) => r.primaryCleanerId).map((r) => r.task_id),
    ]);

    for (const taskId of relevantTaskIds) {
      const lock = locksMap.get(taskId);
      if (!lock?.locked) continue;
      const current = currentByTask.get(taskId);
      const desired = adamById.get(taskId) || ({
        task_id: taskId,
        logistic_code: current?.task?.logistic_code ?? null,
        primaryCleanerId: null,
        sequence: 9999,
        secondaryCleanerIds: [],
      } as Partial<AdamAssignmentRow> as AdamAssignmentRow);

      const differs = assignmentDiffers(
        current?.cleanerIds || [],
        current?.primaryCleanerId ?? null,
        current?.sequence ?? null,
        desired
      );
      if (!differs) continue;

      lockedConflicts.push({
        task_id: taskId,
        logistic_code:
          desired.logistic_code ??
          (current?.task?.logistic_code != null
            ? Number(current.task.logistic_code)
            : null),
        locked_reason: lock.lockedReason,
        currentCleanerId: current?.primaryCleanerId ?? null,
        adamCleanerId: desired.primaryCleanerId,
      });
    }

    if (lockedConflicts.length > 0 && !options.confirmUnlockLocked) {
      return {
        success: true,
        needsUnlockConfirm: true,
        lockedTasks: lockedConflicts,
      };
    }

    const unlockedTaskIds: number[] = [];
    if (lockedConflicts.length > 0 && options.confirmUnlockLocked) {
      const ids = lockedConflicts.map((t) => t.task_id);
      await pgDailyAssignmentsService.bulkUpdateTaskLockStatus(
        workDate,
        ids,
        false,
        undefined,
        modifiedBy
      );
      for (const taskId of ids) {
        await pgDailyAssignmentsService.syncLockToContainers(
          taskId,
          workDate,
          false,
          undefined
        );
        unlockedTaskIds.push(taskId);
      }
    }

    const selectedCleanersData =
      (await workspaceFiles.loadSelectedCleaners(workDate, scope)) || { cleaners: [] };
    const selectedById = new Map<number, any>(
      (selectedCleanersData.cleaners || [])
        .map((cleaner: any) => [Number(cleaner?.id), cleaner] as const)
        .filter(([id]: readonly [number, any]) => Number.isFinite(id) && id > 0)
    );
    const initiallySelected = new Set(selectedById.keys());

    const neededCleanerIds = normalizeIdSet(
      adamRows.flatMap((row) =>
        row.primaryCleanerId
          ? [row.primaryCleanerId, ...row.secondaryCleanerIds]
          : []
      )
    );
    const missingCleanerIds = neededCleanerIds.filter((id) => !selectedById.has(id));
    if (missingCleanerIds.length > 0) {
      let cleanersFromDb = await pgDailyAssignmentsService.loadCleanersByIds(
        missingCleanerIds,
        workDate,
        scope
      );
      const foundIds = new Set(
        (cleanersFromDb || []).map((c: any) => Number(c?.id)).filter((id: number) => Number.isFinite(id))
      );
      const stillMissing = missingCleanerIds.filter((id) => !foundIds.has(id));
      if (stillMissing.length > 0) {
        const anyScope = await pgDailyAssignmentsService.loadCleanersByIdsAnyScope(
          stillMissing,
          workDate
        );
        cleanersFromDb = [...(cleanersFromDb || []), ...(anyScope || [])];
      }
      for (const cleaner of cleanersFromDb || []) {
        const id = Number(cleaner?.id);
        if (Number.isFinite(id) && !selectedById.has(id)) {
          selectedById.set(id, cleaner);
        }
      }
      // Ultimo fallback: alias anagrafica (nome/cognome) se non in roster del giorno
      const unresolved = missingCleanerIds.filter((id) => !selectedById.has(id));
      if (unresolved.length > 0) {
        try {
          const aliasMap = await pgDailyAssignmentsService.getAllCleanerAliases();
          for (const id of unresolved) {
            const alias = aliasMap.get(id);
            if (!alias) continue;
            selectedById.set(id, {
              id,
              name: alias.name || `ID ${id}`,
              lastname: alias.lastname || "",
              role: "Standard",
              premium: false,
              start_time: "10:00",
              end_time: "20:00",
              alias: alias.alias,
            });
          }
        } catch (error) {
          console.warn("⚠️ Fallback alias cleaner fallito:", error);
        }
      }
    }

    const containersData = await workspaceFiles.loadContainers(workDate, scope);
    const containerTypes = ["early_out", "high_priority", "low_priority"] as const;
    const containerTaskById = new Map<number, any>();
    for (const containerType of containerTypes) {
      for (const task of containersData?.containers?.[containerType]?.tasks || []) {
        const taskId = Number(task?.task_id ?? task?.id);
        if (Number.isFinite(taskId) && !containerTaskById.has(taskId)) {
          containerTaskById.set(taskId, { ...task, priority: containerType });
        }
      }
    }

    // Snapshot existing cleaner entries (keep empty lanes / roster)
    const cleanerEntryById = new Map<number, any>();
    for (const entry of timelineData.cleaners_assignments) {
      const cleanerId = Number(entry?.cleaner?.id);
      if (!Number.isFinite(cleanerId)) continue;
      cleanerEntryById.set(cleanerId, {
        cleaner: { ...entry.cleaner },
        tasks: [],
      });
    }

    const ensureCleanerEntry = (cleanerId: number) => {
      let entry = cleanerEntryById.get(cleanerId);
      if (entry) return entry;
      const info = selectedById.get(cleanerId);
      entry = {
        cleaner: {
          id: cleanerId,
          name: info?.name || `ID ${cleanerId}`,
          lastname: info?.lastname || "",
          role: info?.role || "Standard",
          premium: Boolean(info?.premium),
          start_time: info?.start_time || "10:00",
          end_time: info?.end_time || "20:00",
        },
        tasks: [],
      };
      cleanerEntryById.set(cleanerId, entry);
      if (!selectedById.has(cleanerId)) {
        selectedById.set(cleanerId, { ...entry.cleaner });
      }
      return entry;
    };

    let moved = 0;
    let unassigned = 0;
    let assigned = 0;
    let collaborationUpdated = 0;
    const tasksToReturnToContainers: any[] = [];
    const handledTaskIds = new Set<number>();

    // Unassign: in timeline but ADAM has no primary
    for (const [taskId, current] of currentByTask.entries()) {
      const desired = adamById.get(taskId);
      if (desired?.primaryCleanerId) continue;
      // If ADAM row missing entirely, leave as-is (out of scope)
      if (!desired) continue;
      handledTaskIds.add(taskId);
      tasksToReturnToContainers.push(
        cloneTaskPayload(current.task, {
          start_time: undefined,
          end_time: undefined,
          travel_time: undefined,
          sequence: undefined,
          followup: undefined,
          collaborator_ids: undefined,
          collaborator_count: undefined,
          is_primary: undefined,
          base_cleaning_time: undefined,
        })
      );
      unassigned += 1;
      if (current.cleanerIds.length > 0) moved += 1;
    }

    // Preserve timeline tasks not present in ADAM scope (do not drop them)
    for (const [taskId, current] of currentByTask.entries()) {
      if (adamById.has(taskId)) continue;
      handledTaskIds.add(taskId);
      for (const cleanerId of current.cleanerIds) {
        const entry = ensureCleanerEntry(cleanerId);
        const copy = cloneTaskPayload(current.task, {
          start_time: current.task?.start_time ?? null,
          end_time: current.task?.end_time ?? null,
          travel_time: Number(current.task?.travel_time ?? 0) || 0,
          sequence: Number(current.task?.sequence ?? 0) || 0,
          is_primary:
            current.primaryCleanerId != null
              ? cleanerId === current.primaryCleanerId
              : current.cleanerIds.length === 1,
          collaborator_ids:
            current.cleanerIds.length > 1 ? current.cleanerIds : undefined,
          collaborator_count:
            current.cleanerIds.length > 1 ? current.cleanerIds.length : undefined,
          _adam_sequence: Number(current.task?.sequence ?? 9999) || 9999,
          _adam_task_id: taskId,
          _is_secondary_copy:
            current.primaryCleanerId != null
              ? cleanerId !== current.primaryCleanerId
              : false,
        });
        entry.tasks.push(copy);
      }
    }

    // Assign / reassign from ADAM
    const assignedAdamRows = adamRows
      .filter((row) => row.primaryCleanerId)
      .sort((a, b) => {
        if (a.primaryCleanerId !== b.primaryCleanerId) {
          return Number(a.primaryCleanerId) - Number(b.primaryCleanerId);
        }
        if (a.sequence !== b.sequence) return a.sequence - b.sequence;
        return a.task_id - b.task_id;
      });

    for (const row of assignedAdamRows) {
      handledTaskIds.add(row.task_id);
      const current = currentByTask.get(row.task_id);
      const existingTask =
        current?.task || containerTaskById.get(row.task_id) || null;
      const taskPayload = buildTaskFromAdam(row, existingTask || undefined);
      const collaboratorIds = normalizeIdSet([
        row.primaryCleanerId,
        ...row.secondaryCleanerIds,
      ]);
      const collabCount = Math.max(1, collaboratorIds.length);
      const baseCleaning =
        Number(
          existingTask?.base_cleaning_time ??
            existingTask?.cleaning_time ??
            row.cleaning_time ??
            0
        ) || 0;
      // If existing already split, recover base from count
      const recoveredBase =
        current && current.cleanerIds.length > 1 && existingTask?.cleaning_time
          ? Number(existingTask.cleaning_time) * current.cleanerIds.length
          : baseCleaning;
      const effectiveBase = recoveredBase || row.cleaning_time || 0;
      const splitCleaning = Math.ceil(effectiveBase / collabCount);

      if (collabCount > 1) collaborationUpdated += 1;

      const differs = assignmentDiffers(
        current?.cleanerIds || [],
        current?.primaryCleanerId ?? null,
        current?.sequence ?? null,
        row
      );
      if (!current) {
        assigned += 1;
        moved += 1;
      } else if (differs) {
        moved += 1;
      }

      for (const cleanerId of collaboratorIds) {
        const entry = ensureCleanerEntry(cleanerId);
        const isPrimary = cleanerId === row.primaryCleanerId;
        const copy = cloneTaskPayload(taskPayload, {
          cleaning_time: splitCleaning,
          base_cleaning_time: effectiveBase || undefined,
          is_primary: isPrimary,
          collaborator_ids: collaboratorIds,
          collaborator_count: collabCount,
          // Temporary sort key for primary lane; secondaries appended later by adam order
          _adam_sequence: row.sequence,
          _adam_task_id: row.task_id,
          _is_secondary_copy: !isPrimary,
        });
        entry.tasks.push(copy);
      }

      containerTaskById.delete(row.task_id);
    }

    // Sort each cleaner: primary copies by ADAM sequence, secondary copies after / by adam seq
    for (const entry of cleanerEntryById.values()) {
      entry.tasks.sort((a: any, b: any) => {
        const aSec = a._is_secondary_copy ? 1 : 0;
        const bSec = b._is_secondary_copy ? 1 : 0;
        if (aSec !== bSec) return aSec - bSec;
        const aSeq = Number(a._adam_sequence ?? 9999);
        const bSeq = Number(b._adam_sequence ?? 9999);
        if (aSeq !== bSeq) return aSeq - bSeq;
        return Number(a._adam_task_id ?? a.task_id) - Number(b._adam_task_id ?? b.task_id);
      });
      entry.tasks.forEach((task: any, index: number) => {
        task.sequence = index + 1;
        task.followup = index > 0;
        delete task._adam_sequence;
        delete task._adam_task_id;
        delete task._is_secondary_copy;
      });
    }

    timelineData.cleaners_assignments = Array.from(cleanerEntryById.values());
    timelineData.metadata = {
      ...(timelineData.metadata || {}),
      date: workDate,
      last_updated: getRomeTimestamp(),
    };
    timelineData.meta = {
      total_cleaners: timelineData.cleaners_assignments.length,
      used_cleaners: timelineData.cleaners_assignments.filter(
        (e: any) => (e.tasks || []).length > 0
      ).length,
      assigned_tasks: timelineData.cleaners_assignments.reduce(
        (sum: number, e: any) => sum + ((e.tasks || []).length || 0),
        0
      ),
      total_tasks: 0,
    };
    timelineData.meta.total_tasks = timelineData.meta.assigned_tasks;

    // Recalculate times for cleaners with tasks
    let recalculatedCleaners = 0;
    for (let i = 0; i < timelineData.cleaners_assignments.length; i++) {
      let entry = timelineData.cleaners_assignments[i];
      if (!entry?.tasks?.length) continue;
      try {
        entry = await hydrateTasksFromContainers(entry, workDate);
        entry = await recalculateCleanerTimes(entry, workDate, scope);
        timelineData.cleaners_assignments[i] = entry;
        recalculatedCleaners += 1;
      } catch (error: any) {
        console.warn(
          `⚠️ Recalc dopo sync ADAM fallito per cleaner ${entry?.cleaner?.id}: ${error?.message || error}`
        );
        entry.tasks.forEach((task: any, index: number) => {
          task.sequence = index + 1;
          task.followup = index > 0;
        });
        timelineData.cleaners_assignments[i] = entry;
      }
    }

    await workspaceFiles.saveTimeline(
      workDate,
      timelineData,
      false,
      modifiedBy,
      "timeline_synced_assignments_from_adam",
      undefined,
      scope
    );

    // Rebuild containers: remove assigned; add unassigned back
    if (containersData?.containers) {
      const assignedIds = new Set(
        assignedAdamRows.map((r) => r.task_id)
      );

      for (const containerType of containerTypes) {
        const bucket = containersData.containers[containerType];
        if (!bucket) continue;
        bucket.tasks = (bucket.tasks || []).filter((t: any) => {
          const tid = Number(t?.task_id ?? t?.id);
          return !Number.isFinite(tid) || !assignedIds.has(tid);
        });
      }

      for (const task of tasksToReturnToContainers) {
        const tid = Number(task.task_id);
        if (!Number.isFinite(tid) || assignedIds.has(tid)) continue;
        const priority =
          task.priority === "early_out" ||
          task.priority === "high_priority" ||
          task.priority === "low_priority"
            ? task.priority
            : "low_priority";
        const bucket = containersData.containers[priority];
        if (!bucket) continue;
        const already = (bucket.tasks || []).some(
          (t: any) => Number(t?.task_id) === tid
        );
        if (already) continue;
        const {
          start_time: _s,
          end_time: _e,
          travel_time: _t,
          sequence: _seq,
          followup: _f,
          collaborator_ids: _c,
          collaborator_count: _cc,
          is_primary: _p,
          ...rest
        } = task;
        bucket.tasks.push(rest);
      }

      for (const containerType of containerTypes) {
        const bucket = containersData.containers[containerType];
        if (bucket) bucket.count = bucket.tasks?.length || 0;
      }
      if (containersData.summary) {
        containersData.summary.early_out =
          containersData.containers.early_out?.count || 0;
        containersData.summary.high_priority =
          containersData.containers.high_priority?.count || 0;
        containersData.summary.low_priority =
          containersData.containers.low_priority?.count || 0;
        containersData.summary.total_tasks =
          containersData.summary.early_out +
          containersData.summary.high_priority +
          containersData.summary.low_priority;
      }

      await workspaceFiles.saveContainers(
        workDate,
        containersData,
        modifiedBy,
        "containers_after_assignment_sync",
        scope
      );
    }

    const mergedCleaners = Array.from(selectedById.values()).filter((c: any) =>
      Number.isFinite(Number(c?.id))
    );
    const autoConvokedCleaners = mergedCleaners.filter(
      (c: any) => !initiallySelected.has(Number(c.id))
    ).length;
    if (autoConvokedCleaners > 0) {
      await workspaceFiles.saveSelectedCleaners(
        workDate,
        {
          cleaners: mergedCleaners,
          total_selected: mergedCleaners.length,
          metadata: { date: workDate },
        },
        false,
        modifiedBy,
        "ADAM_ASSIGNMENT_SYNC",
        scope
      );
    }

    console.log(
      `✅ Sync assegnazioni ADAM→WASS ${workDate}: moved=${moved}, unassigned=${unassigned}, assigned=${assigned}, recalc=${recalculatedCleaners}`
    );

    return {
      success: true,
      moved,
      unassigned,
      assigned,
      collaborationUpdated,
      recalculatedCleaners,
      unlockedTaskIds,
      autoConvokedCleaners,
    };
  } catch (error: any) {
    console.error("❌ syncTimelineAssignmentsFromAdam:", error);
    return {
      success: false,
      error: error?.message || String(error),
    };
  }
}
