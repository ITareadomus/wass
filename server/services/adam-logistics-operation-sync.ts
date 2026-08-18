import type { Connection } from "mysql2/promise";
import {
  normalizeLogisticsTaskKind,
  toAdamLogisticsOperation,
  type LogisticsContainerKindPatch,
} from "../../shared/logistics-task-kind";
import * as workspaceFiles from "./workspace-files";
import {
  enrichLogisticsTimelineData,
  syncLogisticsTimelineAutoKinds,
} from "./logistics-task-kind-enrichment";

export interface SyncLogisticsOperationsResult {
  success: boolean;
  recomputedPg: number;
  updatedAdam: number;
  skippedNoKind: number;
  errors: string[];
  message: string;
}

function collectKindPatchesFromTimeline(timeline: any): {
  patches: LogisticsContainerKindPatch[];
  kindsByTaskId: Map<number, string>;
} {
  const patches: LogisticsContainerKindPatch[] = [];
  const kindsByTaskId = new Map<number, string>();

  for (const entry of timeline?.drivers_assignments || []) {
    for (const task of entry?.tasks || []) {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId) || taskId <= 0) continue;
      const source =
        task?.logistics_task_kind_source != null
          ? String(task.logistics_task_kind_source)
          : null;
      const kind = normalizeLogisticsTaskKind(task?.logistics_task_kind, source);
      if (!kind) continue;
      kindsByTaskId.set(taskId, kind);
      if (source !== "manual") {
        patches.push({
          taskId,
          logistics_task_kind: kind,
          logistics_task_kind_source: "auto",
        });
      }
    }
  }

  return { patches, kindsByTaskId };
}

function collectKindsFromContainers(containers: any): Map<number, string> {
  const kindsByTaskId = new Map<number, string>();
  for (const bucket of [
    containers?.containers?.early_out,
    containers?.containers?.high_priority,
    containers?.containers?.low_priority,
  ]) {
    for (const task of bucket?.tasks || []) {
      const taskId = Number(task?.task_id);
      if (!Number.isFinite(taskId) || taskId <= 0) continue;
      const source =
        task?.logistics_task_kind_source != null
          ? String(task.logistics_task_kind_source)
          : null;
      const kind = normalizeLogisticsTaskKind(task?.logistics_task_kind, source);
      if (!kind) continue;
      if (!kindsByTaskId.has(taskId)) kindsByTaskId.set(taskId, kind);
    }
  }
  return kindsByTaskId;
}

/**
 * Ricalcola `logistics_task_kind` su WASS (rispettando override manuali),
 * lo persiste su PG e scrive solo `lg_operation` su ADAM.
 * Non tocca driven_by_us / lg_sequence / orari / lg_vehicle.
 */
export async function recomputeAndSyncLogisticsOperationsToAdam(
  connection: Connection,
  workDate: string
): Promise<SyncLogisticsOperationsResult> {
  const errors: string[] = [];
  let recomputedPg = 0;

  const timeline =
    (await workspaceFiles.loadLogisticsTimeline(workDate)) || {
      drivers_assignments: [],
      metadata: { date: workDate },
    };

  await enrichLogisticsTimelineData(workDate, timeline);
  const { patches: timelinePatches, kindsByTaskId } = collectKindPatchesFromTimeline(timeline);
  try {
    recomputedPg += await syncLogisticsTimelineAutoKinds(workDate, timelinePatches);
  } catch (e: any) {
    errors.push(`persist timeline kinds: ${e?.message || e}`);
  }

  // loadLogisticsContainers arricchisce e synca già gli auto-kind su lg_containers
  const containers = await workspaceFiles.loadLogisticsContainers(workDate);
  const containerKinds = collectKindsFromContainers(containers);
  for (const [taskId, kind] of containerKinds.entries()) {
    if (!kindsByTaskId.has(taskId)) kindsByTaskId.set(taskId, kind);
  }
  recomputedPg += containerKinds.size;

  let updatedAdam = 0;
  let skippedNoKind = 0;

  for (const [taskId, kind] of kindsByTaskId.entries()) {
    const operation = toAdamLogisticsOperation(kind);
    if (!operation) {
      skippedNoKind += 1;
      continue;
    }
    try {
      await connection.execute(
        `UPDATE app_housekeeping
         SET lg_operation = ?
         WHERE id = ?`,
        [operation, taskId]
      );
      updatedAdam += 1;
    } catch (e: any) {
      errors.push(`task ${taskId}: ${e?.message || e}`);
    }
  }

  const messageParts = [
    `${updatedAdam} lg_operation aggiornate su ADAM`,
    `${kindsByTaskId.size} task con tipologia in WASS`,
  ];
  if (skippedNoKind > 0) messageParts.push(`${skippedNoKind} senza mapping`);
  if (errors.length > 0) messageParts.push(`${errors.length} errori`);

  return {
    success: errors.length === 0,
    recomputedPg,
    updatedAdam,
    skippedNoKind,
    errors,
    message: messageParts.join(", "),
  };
}
