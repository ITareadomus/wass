import type { Express } from "express";
import { format } from "date-fns";
import * as workspaceFiles from "./services/workspace-files";
import {
  hydrateTasksFromLogisticsContainers,
  recalculateLogisticsDriverTimes,
} from "./services/logistics-timeline-utils";

type Deps = {
  getCurrentUsername: (req?: any) => string;
  getRomeTimestamp: () => string;
};

export function registerLogisticsTimelineMutationRoutes(app: Express, deps: Deps) {
  const { getCurrentUsername, getRomeTimestamp } = deps;

  app.post("/api/save-logistics-timeline-assignment", async (req, res) => {
    try {
      const {
        taskId,
        driverId,
        logisticCode,
        date,
        insertAt,
        taskData,
        priority,
        modified_by,
        modification_type,
      } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const currentUsername = modified_by || getCurrentUsername(req);
      const modificationType = modification_type || "task_assigned_manually";

      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      if (taskId) {
        const isLocked = await pgDailyAssignmentsService.isTaskLocked(workDate, Number(taskId));
        if (isLocked) {
          const lockInfo = await pgDailyAssignmentsService.getTaskLock(workDate, Number(taskId));
          return res.status(423).json({
            success: false,
            error: "TASK_LOCKED",
            message: "Task bloccata: impossibile assegnare",
            locked_reason: lockInfo?.lockedReason,
          });
        }
      }

      let fullTaskData: any = null;
      let sourceContainerType: string | null = null;
      let containersData: any = null;
      try {
        containersData = await workspaceFiles.loadLogisticsContainers(workDate);
      } catch {
        /* ignore */
      }
      if (containersData) {
        for (const containerType of ["early_out", "high_priority", "low_priority"]) {
          const container = containersData.containers?.[containerType];
          if (container?.tasks) {
            const found = container.tasks.find(
              (t: any) => String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
            );
            if (found) {
              fullTaskData = JSON.parse(JSON.stringify(found));
              sourceContainerType = containerType;
              break;
            }
          }
        }
      }
      if (!fullTaskData && taskData) {
        fullTaskData = JSON.parse(JSON.stringify(taskData));
      }
      if (!fullTaskData) {
        return res.status(404).json({ success: false, error: `Task ${logisticCode} non trovata` });
      }
      if (!fullTaskData.task_id && fullTaskData.id) fullTaskData.task_id = fullTaskData.id;
      if (!fullTaskData.logistic_code && fullTaskData.name) fullTaskData.logistic_code = fullTaskData.name;
      if (!fullTaskData.cleaning_time && fullTaskData.duration) {
        const duration = String(fullTaskData.duration);
        const [hours, mins] = duration.split(".").map(Number);
        fullTaskData.cleaning_time = (hours || 0) * 60 + (mins || 0);
      }
      fullTaskData.address = fullTaskData.address || null;
      fullTaskData.lat = fullTaskData.lat || null;
      fullTaskData.lng = fullTaskData.lng || null;
      fullTaskData.premium = fullTaskData.premium || false;
      fullTaskData.cleaning_time = fullTaskData.cleaning_time || 0;

      let timelineData: any = await workspaceFiles.loadLogisticsTimeline(workDate);
      if (!timelineData) {
        timelineData = {
          drivers_assignments: [],
          metadata: { date: workDate, last_updated: getRomeTimestamp(), created_by: currentUsername, modified_by: [] },
          meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
        };
      }
      timelineData.metadata = timelineData.metadata || {};
      if (!timelineData.metadata.created_by) timelineData.metadata.created_by = currentUsername;
      timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
      if (currentUsername && !timelineData.metadata.modified_by.includes(currentUsername)) {
        timelineData.metadata.modified_by.push(currentUsername);
      }

      const normalizedDriverId = Number(driverId);
      let driverEntry = timelineData.drivers_assignments.find((d: any) => d.driver.id === normalizedDriverId);
      if (!driverEntry) {
        const driversData = (await workspaceFiles.loadSelectedLogisticsDrivers(workDate)) || { drivers: [] };
        const info = driversData.drivers?.find((d: any) => d.id === normalizedDriverId);
        driverEntry = {
          driver: {
            id: normalizedDriverId,
            name: info?.name || "Driver",
            lastname: info?.lastname || "",
            role: info?.role || "Standard",
            premium: info?.premium || false,
            start_time: info?.start_time || "10:00",
            end_time: info?.end_time || "20:00",
          },
          tasks: [],
        };
        timelineData.drivers_assignments.push(driverEntry);
      }

      const normalizedTaskId = String(taskId);
      const normalizedLogisticCode = String(logisticCode);
      driverEntry.tasks = driverEntry.tasks.filter(
        (t: any) => String(t.logistic_code) !== normalizedLogisticCode && String(t.task_id) !== normalizedTaskId
      );

      const taskForTimeline = {
        task_id: parseInt(String(fullTaskData.task_id || fullTaskData.id), 10),
        logistic_code: parseInt(String(fullTaskData.logistic_code || fullTaskData.name), 10),
        client_id: fullTaskData.client_id || null,
        premium: Boolean(fullTaskData.premium),
        address: fullTaskData.address || null,
        lat: fullTaskData.lat || null,
        lng: fullTaskData.lng || null,
        cleaning_time: fullTaskData.cleaning_time || 0,
        checkin_date: fullTaskData.checkin_date || null,
        checkout_date: fullTaskData.checkout_date || null,
        checkin_time: fullTaskData.checkin_time || null,
        checkout_time: fullTaskData.checkout_time || null,
        pax_in: fullTaskData.pax_in || 0,
        pax_out: fullTaskData.pax_out || 0,
        small_equipment: Boolean(fullTaskData.small_equipment),
        operation_id: fullTaskData.operation_id !== undefined ? fullTaskData.operation_id : 2,
        confirmed_operation:
          fullTaskData.confirmed_operation !== undefined ? Boolean(fullTaskData.confirmed_operation) : true,
        straordinaria: Boolean(fullTaskData.straordinaria),
        type_apt: fullTaskData.type_apt || null,
        alias: fullTaskData.alias || null,
        customer_name: fullTaskData.customer_name || fullTaskData.type || null,
        customer_reference: fullTaskData.customer_reference || null,
        reasons: [...(fullTaskData.reasons || []), "manually_moved_to_timeline"],
        manually_moved: true,
        priority: priority || sourceContainerType || "low_priority",
        start_time: null,
        end_time: null,
        followup: false,
        sequence: 0,
        travel_time: 0,
      };

      const targetIndex =
        insertAt !== undefined ? Math.max(0, Math.min(insertAt, driverEntry.tasks.length)) : driverEntry.tasks.length;
      driverEntry.tasks.splice(targetIndex, 0, taskForTimeline);

      try {
        const sel = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
        const sd = sel?.drivers?.find((d: any) => d.id === normalizedDriverId);
        driverEntry.driver.start_time = sd?.start_time || driverEntry.driver.start_time || "10:00";
        driverEntry.driver.end_time = sd?.end_time || driverEntry.driver.end_time || "20:00";
      } catch {
        driverEntry.driver.start_time = driverEntry.driver.start_time || "10:00";
        driverEntry.driver.end_time = driverEntry.driver.end_time || "20:00";
      }

      try {
        await hydrateTasksFromLogisticsContainers(driverEntry, workDate);
        const updated = await recalculateLogisticsDriverTimes(driverEntry, workDate);
        driverEntry.tasks = updated.tasks;
      } catch (e: any) {
        driverEntry.tasks.forEach((t: any, i: number) => {
          t.sequence = i + 1;
          t.followup = i > 0;
        });
      }

      const modifyingUser = req.body.modified_by || req.body.created_by || currentUsername;
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;
      timelineData.meta = timelineData.meta || {};
      timelineData.meta.total_drivers = timelineData.drivers_assignments.length;
      timelineData.meta.assigned_tasks = timelineData.drivers_assignments.reduce(
        (s: number, d: any) => s + d.tasks.length,
        0
      );

      await workspaceFiles.saveLogisticsTimeline(workDate, timelineData, false, modifyingUser, modificationType);

      if (containersData?.containers) {
        try {
          await pgDailyAssignmentsService.saveLogisticsContainersToHistory(
            workDate,
            modifyingUser,
            "task_moved_to_timeline"
          );
          const normalizedId = String(taskForTimeline.task_id);
          for (const [, container] of Object.entries(containersData.containers)) {
            const c = container as any;
            if (!c.tasks) continue;
            const orig = c.tasks.length;
            c.tasks = c.tasks.filter((t: any) => String(t.task_id) !== normalizedId);
            if (c.tasks.length !== orig) c.count = c.tasks.length;
          }
          if (containersData.summary) {
            containersData.summary.early_out = containersData.containers.early_out?.count || 0;
            containersData.summary.high_priority = containersData.containers.high_priority?.count || 0;
            containersData.summary.low_priority = containersData.containers.low_priority?.count || 0;
            containersData.summary.total_tasks =
              containersData.summary.early_out +
              containersData.summary.high_priority +
              containersData.summary.low_priority;
          }
          await workspaceFiles.saveLogisticsContainers(workDate, containersData);
        } catch (e) {
          console.warn("save-logistics-timeline-assignment containers:", e);
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("save-logistics-timeline-assignment:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/remove-logistics-timeline-assignment", async (req, res) => {
    try {
      const { taskId, logisticCode, date, modified_by } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const modifyingUser = modified_by || getCurrentUsername(req);

      let assignmentsData: any = await workspaceFiles.loadLogisticsTimeline(workDate);
      if (!assignmentsData) {
        assignmentsData = {
          drivers_assignments: [],
          metadata: { date: workDate, last_updated: getRomeTimestamp() },
          meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
        };
      }

      let removedTask: any = null;
      assignmentsData.drivers_assignments = assignmentsData.drivers_assignments
        .map((driverEntry: any) => {
          const initial = driverEntry.tasks?.length || 0;
          driverEntry.tasks = (driverEntry.tasks || []).filter((t: any) => {
            const matchCode = String(t.logistic_code) === String(logisticCode);
            const matchId = String(t.task_id) === String(taskId);
            if (matchCode || matchId) removedTask = t;
            return !matchCode && !matchId;
          });
          const removed = initial - (driverEntry.tasks?.length || 0);
          if (removed > 0 && driverEntry.tasks.length > 0) {
            driverEntry.tasks = driverEntry.tasks.map((task: any, idx: number) => {
              task.sequence = idx + 1;
              task.followup = idx > 0;
              return task;
            });
            driverEntry._needsRecalculation = true;
          }
          return driverEntry;
        })
        .filter((d: any) => d.tasks.length > 0);

      for (const driverEntry of assignmentsData.drivers_assignments) {
        if (driverEntry._needsRecalculation) {
          try {
            await hydrateTasksFromLogisticsContainers(driverEntry, workDate);
            const updated = await recalculateLogisticsDriverTimes(driverEntry, workDate);
            Object.assign(driverEntry, updated);
          } catch (e: any) {
            console.warn(`recalc logistics driver ${driverEntry.driver?.id}:`, e.message);
          }
          delete driverEntry._needsRecalculation;
        }
      }

      assignmentsData.metadata = assignmentsData.metadata || {};
      assignmentsData.metadata.last_updated = getRomeTimestamp();
      assignmentsData.metadata.date = workDate;
      assignmentsData.meta = assignmentsData.meta || {};
      assignmentsData.meta.total_drivers = assignmentsData.drivers_assignments.length;
      assignmentsData.meta.assigned_tasks = assignmentsData.drivers_assignments.reduce(
        (s: number, d: any) => s + d.tasks.length,
        0
      );

      await workspaceFiles.saveLogisticsTimeline(workDate, assignmentsData, false, modifyingUser, "task_removed_from_timeline");

      if (removedTask) {
        try {
          const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
          await pgDailyAssignmentsService.saveLogisticsContainersToHistory(
            workDate,
            modifyingUser,
            "task_returned_to_container"
          );
          const containersData =
            (await workspaceFiles.loadLogisticsContainers(workDate)) || {
              containers: {
                early_out: { tasks: [], count: 0 },
                high_priority: { tasks: [], count: 0 },
                low_priority: { tasks: [], count: 0 },
              },
              summary: {},
            };
          const pr = removedTask.priority || "low_priority";
          const containerType =
            pr === "early_out" ? "early_out" : pr === "high_priority" ? "high_priority" : "low_priority";
          delete removedTask.start_time;
          delete removedTask.end_time;
          delete removedTask.travel_time;
          delete removedTask.checkout_wait_minutes;
          delete removedTask.sequence;
          delete removedTask.followup;
          if (removedTask.reasons) {
            removedTask.reasons = removedTask.reasons.filter(
              (r: string) =>
                ![
                  "automatic_assignment_eo",
                  "automatic_assignment_hp",
                  "automatic_assignment_lp",
                  "manual_assignment",
                  "manually_moved_to_timeline",
                ].includes(r)
            );
          }
          if (!containersData.containers[containerType].tasks) {
            containersData.containers[containerType].tasks = [];
          }
          const rid = String(removedTask.task_id);
          containersData.containers[containerType].tasks = containersData.containers[containerType].tasks.filter(
            (t: any) => String(t.task_id) !== rid
          );
          containersData.containers[containerType].tasks.push(removedTask);
          containersData.containers[containerType].count = containersData.containers[containerType].tasks.length;
          if (containersData.summary) {
            containersData.summary.early_out = containersData.containers.early_out?.count || 0;
            containersData.summary.high_priority = containersData.containers.high_priority?.count || 0;
            containersData.summary.low_priority = containersData.containers.low_priority?.count || 0;
            containersData.summary.total_tasks =
              containersData.summary.early_out +
              containersData.summary.high_priority +
              containersData.summary.low_priority;
          }
          await workspaceFiles.saveLogisticsContainers(workDate, containersData);
        } catch (e) {
          console.warn("remove-logistics restore container:", e);
        }
      }

      res.json({ success: true });
    } catch (error: any) {
      console.error("remove-logistics-timeline-assignment:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/reorder-logistics-timeline", async (req, res) => {
    try {
      const { date, driverId, taskId, logisticCode, fromIndex, toIndex, modified_by } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      let timelineData: any = await workspaceFiles.loadLogisticsTimeline(workDate);
      if (!timelineData) {
        return res.status(404).json({ success: false, message: "Timeline non trovata" });
      }
      const driverEntry = timelineData.drivers_assignments.find((d: any) => d.driver.id === driverId);
      if (!driverEntry) {
        return res.status(404).json({ success: false, message: "Driver non trovato" });
      }
      const actualFrom = driverEntry.tasks.findIndex(
        (t: any) => String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
      );
      if (actualFrom === -1) {
        return res.status(404).json({ success: false, message: "Task non trovata" });
      }
      if (toIndex < 0 || toIndex > driverEntry.tasks.length) {
        return res.status(400).json({ success: false, message: "toIndex non valido" });
      }
      const [task] = driverEntry.tasks.splice(actualFrom, 1);
      driverEntry.tasks.splice(toIndex, 0, task);
      try {
        await hydrateTasksFromLogisticsContainers(driverEntry, workDate);
        const updated = await recalculateLogisticsDriverTimes(driverEntry, workDate);
        driverEntry.tasks = updated.tasks;
      } catch (e: any) {
        driverEntry.tasks.forEach((t: any, i: number) => {
          t.sequence = i + 1;
          t.followup = i > 0;
        });
      }
      const modifyingUser = modified_by || getCurrentUsername(req);
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;
      for (const t of driverEntry.tasks) t.manually_moved = true;
      await workspaceFiles.saveLogisticsTimeline(workDate, timelineData, false, modifyingUser, "task_reordered_same_driver");
      res.json({ success: true });
    } catch (error: any) {
      console.error("reorder-logistics-timeline:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/move-task-between-drivers", async (req, res) => {
    try {
      const { taskId, logisticCode, sourceDriverId, destDriverId, destIndex, date, modified_by } = req.body;
      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");
      if (taskId) {
        const isLocked = await pgDailyAssignmentsService.isTaskLocked(workDate, Number(taskId));
        if (isLocked) {
          const lockInfo = await pgDailyAssignmentsService.getTaskLock(workDate, Number(taskId));
          return res.status(423).json({
            success: false,
            error: "TASK_LOCKED",
            locked_reason: lockInfo?.lockedReason,
          });
        }
      }

      let timelineData: any = await workspaceFiles.loadLogisticsTimeline(workDate);
      if (!timelineData) {
        timelineData = {
          drivers_assignments: [],
          metadata: { date: workDate },
          meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
        };
      }

      let taskToMove: any = null;
      const sourceEntry = timelineData.drivers_assignments.find((d: any) => d.driver.id === sourceDriverId);
      if (sourceEntry) {
        const ti = sourceEntry.tasks.findIndex(
          (t: any) => String(t.task_id) === String(taskId) || String(t.logistic_code) === String(logisticCode)
        );
        if (ti !== -1) {
          taskToMove = sourceEntry.tasks.splice(ti, 1)[0];
          sourceEntry.tasks.forEach((t: any, i: number) => {
            t.sequence = i + 1;
            t.followup = i > 0;
          });
        }
      }
      if (!taskToMove) {
        return res.status(404).json({ success: false, message: "Task non trovata" });
      }

      let destEntry = timelineData.drivers_assignments.find((d: any) => d.driver.id === destDriverId);
      if (!destEntry) {
        const driversData = await workspaceFiles.loadSelectedLogisticsDrivers(workDate);
        const info = driversData?.drivers?.find((d: any) => d.id === destDriverId);
        if (!info) {
          return res.status(404).json({ success: false, message: "Driver destinazione non trovato" });
        }
        destEntry = { driver: { ...info }, tasks: [] };
        timelineData.drivers_assignments.push(destEntry);
      }

      taskToMove.reasons = taskToMove.reasons || [];
      if (!taskToMove.reasons.includes("manual_assignment")) taskToMove.reasons.push("manual_assignment");
      taskToMove.reasons = taskToMove.reasons.filter(
        (r: string) =>
          !["auto_assignment", "early_out_assignment", "high_priority_assignment", "low_priority_assignment"].includes(r)
      );
      taskToMove.manually_moved = true;

      const targetIndex =
        destIndex !== undefined ? Math.max(0, Math.min(destIndex, destEntry.tasks.length)) : destEntry.tasks.length;
      destEntry.tasks.splice(targetIndex, 0, taskToMove);

      try {
        if (sourceEntry && sourceEntry.tasks.length > 0) {
          await hydrateTasksFromLogisticsContainers(sourceEntry, workDate);
          const u = await recalculateLogisticsDriverTimes(sourceEntry, workDate);
          sourceEntry.tasks = u.tasks;
        }
        await hydrateTasksFromLogisticsContainers(destEntry, workDate);
        const u2 = await recalculateLogisticsDriverTimes(destEntry, workDate);
        destEntry.tasks = u2.tasks;
      } catch (e: any) {
        if (sourceEntry && sourceEntry.tasks.length > 0) {
          sourceEntry.tasks.forEach((t: any, i: number) => {
            t.sequence = i + 1;
            t.followup = i > 0;
          });
        }
        destEntry.tasks.forEach((t: any, i: number) => {
          t.sequence = i + 1;
          t.followup = i > 0;
        });
      }

      const modifyingUser = modified_by || getCurrentUsername(req);
      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;
      timelineData.meta = timelineData.meta || {};
      timelineData.meta.total_drivers = timelineData.drivers_assignments.length;
      timelineData.meta.assigned_tasks = timelineData.drivers_assignments.reduce(
        (s: number, d: any) => s + d.tasks.length,
        0
      );

      await workspaceFiles.saveLogisticsTimeline(workDate, timelineData, false, modifyingUser, "dnd_between_drivers");
      res.json({ success: true });
    } catch (error: any) {
      console.error("move-task-between-drivers:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/swap-drivers-tasks", async (req, res) => {
    try {
      const { sourceDriverId, destDriverId, date, modified_by } = req.body;
      if (sourceDriverId == null || destDriverId == null) {
        return res.status(400).json({
          success: false,
          message: "sourceDriverId e destDriverId sono obbligatori",
        });
      }
      if (Number(sourceDriverId) === Number(destDriverId)) {
        return res.status(400).json({
          success: false,
          message: "Non puoi scambiare le task con lo stesso driver",
        });
      }

      const workDate = date || format(new Date(), "yyyy-MM-dd");
      const modifyingUser = modified_by || getCurrentUsername(req);
      const { pgDailyAssignmentsService } = await import("./services/pg-daily-assignments-service");

      let timelineData: any = await workspaceFiles.loadLogisticsTimeline(workDate);
      if (!timelineData) {
        timelineData = {
          drivers_assignments: [],
          metadata: { date: workDate, last_updated: getRomeTimestamp() },
          meta: { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 },
        };
      }
      timelineData.drivers_assignments = timelineData.drivers_assignments || [];
      timelineData.meta = timelineData.meta || { total_drivers: 0, used_drivers: 0, assigned_tasks: 0 };

      const srcId = Number(sourceDriverId);
      const dstId = Number(destDriverId);

      let sourceEntry = timelineData.drivers_assignments.find((d: any) => d.driver?.id === srcId);
      let destEntry = timelineData.drivers_assignments.find((d: any) => d.driver?.id === dstId);

      const selectedData = (await workspaceFiles.loadSelectedLogisticsDrivers(workDate)) || { drivers: [] };

      const buildDriverStub = (id: number) => {
        const row = selectedData.drivers?.find((d: any) => d.id === id);
        if (!row) return null;
        return {
          id: row.id,
          name: row.name || "Driver",
          lastname: row.lastname ?? String(id),
          role: row.role || "Driver",
          premium: Boolean(row.premium || row.role === "Premium"),
          start_time: row.start_time || "10:00",
          end_time: row.end_time || "20:00",
        };
      };

      if (!sourceEntry) {
        const stub = buildDriverStub(srcId);
        if (!stub) {
          return res.status(404).json({
            success: false,
            message: `Driver sorgente ${srcId} non trovato`,
          });
        }
        sourceEntry = { driver: stub, tasks: [] };
        timelineData.drivers_assignments.push(sourceEntry);
      }

      if (!destEntry) {
        const stub = buildDriverStub(dstId);
        if (!stub) {
          return res.status(404).json({
            success: false,
            message: `Driver destinazione ${dstId} non trovato`,
          });
        }
        destEntry = { driver: stub, tasks: [] };
        timelineData.drivers_assignments.push(destEntry);
      }

      const allTaskIds = [
        ...(sourceEntry.tasks || []).map((t: any) => Number(t.task_id)).filter((x: number) => Number.isFinite(x)),
        ...(destEntry.tasks || []).map((t: any) => Number(t.task_id)).filter((x: number) => Number.isFinite(x)),
      ];
      for (const tid of allTaskIds) {
        const locked = await pgDailyAssignmentsService.isTaskLocked(workDate, tid);
        if (locked) {
          const lockInfo = await pgDailyAssignmentsService.getTaskLock(workDate, tid);
          return res.status(423).json({
            success: false,
            error: "TASK_LOCKED",
            message: "Task bloccata: impossibile scambiare",
            locked_reason: lockInfo?.lockedReason,
          });
        }
      }

      const sourceTasks = sourceEntry.tasks || [];
      const destTasks = destEntry.tasks || [];
      sourceEntry.tasks = destTasks;
      destEntry.tasks = sourceTasks;

      const markTasks = (tasks: any[]) => {
        tasks.forEach((task: any) => {
          task.reasons = task.reasons || [];
          if (!task.reasons.includes("manual_assignment")) task.reasons.push("manual_assignment");
          task.reasons = task.reasons.filter(
            (r: string) =>
              ![
                "auto_assignment",
                "early_out_assignment",
                "high_priority_assignment",
                "low_priority_assignment",
              ].includes(r)
          );
          task.manually_moved = true;
        });
      };
      markTasks(sourceEntry.tasks);
      markTasks(destEntry.tasks);

      for (const entry of [sourceEntry, destEntry]) {
        try {
          if (entry.tasks.length > 0) {
            await hydrateTasksFromLogisticsContainers(entry, workDate);
            const updated = await recalculateLogisticsDriverTimes(entry, workDate);
            entry.tasks = updated.tasks;
          }
        } catch (e: any) {
          console.warn(`swap-drivers recalc ${entry.driver?.id}:`, e?.message);
          entry.tasks.forEach((t: any, i: number) => {
            t.sequence = i + 1;
            t.followup = i > 0;
          });
        }
      }

      timelineData.metadata = timelineData.metadata || {};
      timelineData.metadata.last_updated = getRomeTimestamp();
      timelineData.metadata.date = workDate;
      if (!timelineData.metadata.created_by) timelineData.metadata.created_by = modifyingUser;
      timelineData.metadata.modified_by = timelineData.metadata.modified_by || [];
      if (
        modifyingUser &&
        modifyingUser !== "system" &&
        modifyingUser !== "unknown" &&
        !timelineData.metadata.modified_by.includes(modifyingUser)
      ) {
        timelineData.metadata.modified_by.push(modifyingUser);
      }

      const das = timelineData.drivers_assignments;
      timelineData.meta.total_drivers = das.length;
      timelineData.meta.assigned_tasks = das.reduce((s: number, d: any) => s + (d.tasks?.length || 0), 0);
      timelineData.meta.used_drivers = das.filter((d: any) => (d.tasks?.length || 0) > 0).length;

      await workspaceFiles.saveLogisticsTimeline(workDate, timelineData, false, modifyingUser, "swap_drivers_tasks");

      res.json({
        success: true,
        message: "Task scambiate con successo tra i driver",
        swapped: {
          source: { driverId: srcId, tasksCount: sourceEntry.tasks.length },
          dest: { driverId: dstId, tasksCount: destEntry.tasks.length },
        },
      });
    } catch (error: any) {
      console.error("swap-drivers-tasks:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });
}
