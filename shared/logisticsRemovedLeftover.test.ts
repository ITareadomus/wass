import { describe, expect, it } from "vitest";
import {
  clearLogisticsRemovedLeftoverTaskInPlace,
  isLogisticsRemovedLeftoverTask,
  logisticsDriverLaneKey,
  markLogisticsRemovedLeftoverTaskInPlace,
  resolveLogisticsLaneStaffId,
  splitLogisticsAssignmentLanes,
  logisticsLeftoverLaneStaffId,
} from "./logistics-removed-leftover";

describe("logistics leftover lanes", () => {
  it("marca e pulisce il reason leftover", () => {
    const task: any = { task_id: 1, reasons: ["manual_assignment"] };
    markLogisticsRemovedLeftoverTaskInPlace(task);
    expect(isLogisticsRemovedLeftoverTask(task)).toBe(true);
    clearLogisticsRemovedLeftoverTaskInPlace(task);
    expect(isLogisticsRemovedLeftoverTask(task)).toBe(false);
    expect(task.reasons).toEqual(["manual_assignment"]);
  });

  it("spezza live e leftover nello stesso driver", () => {
    const rows = splitLogisticsAssignmentLanes([
      {
        driver: { id: 7, isRemoved: false },
        tasks: [
          { task_id: 1, reasons: [] },
          { task_id: 2, reasons: ["lg_removed_leftover"] },
        ],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].driver?.isRemoved).toBe(false);
    expect(rows[0].tasks?.map((t: any) => t.task_id)).toEqual([1]);
    expect(rows[1].driver?.leftoverLane).toBe(true);
    expect(rows[1].driver?.isRemoved).toBe(true);
    expect(rows[1].tasks?.map((t: any) => t.task_id)).toEqual([2]);
    expect(logisticsDriverLaneKey(rows[1].driver as any)).toBe("removed-7");
  });

  it("risolve lo staffId della lane leftover", () => {
    const staffId = logisticsLeftoverLaneStaffId(11);
    expect(resolveLogisticsLaneStaffId(staffId)).toEqual({ driverId: 11, leftoverLane: true });
    expect(resolveLogisticsLaneStaffId(11)).toEqual({ driverId: 11, leftoverLane: false });
  });

  it("tiene la lane leftover anche se il driver torna convocato", () => {
    const rows = splitLogisticsAssignmentLanes([
      {
        driver: { id: 7, isRemoved: false },
        tasks: [{ task_id: 2, reasons: ["lg_removed_leftover"] }],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].tasks).toEqual([]);
    expect(rows[1].driver?.leftoverLane).toBe(true);
    expect(rows[1].tasks?.map((t: any) => t.task_id)).toEqual([2]);
  });
});
