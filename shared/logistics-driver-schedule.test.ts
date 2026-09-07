import { describe, expect, it } from "vitest";
import { buildLogisticsScheduleForDriver } from "../server/services/logistics-optimizer/logistics-driver-schedule";

describe("buildLogisticsScheduleForDriver manual first-task start", () => {
  it("pins the first stop and skips wait absorption", () => {
    const built = buildLogisticsScheduleForDriver({
      tasks: [
        {
          taskId: 1,
          logisticCode: 101,
          lat: null,
          lng: null,
          travelMinutesFromPrevious: 20,
          checkoutTime: "11:00",
          checkoutDate: "2026-09-02",
          manualStartMin: 10 * 60 + 30,
        },
        {
          taskId: 2,
          logisticCode: 102,
          lat: null,
          lng: null,
          travelMinutesFromPrevious: 15,
        },
      ],
      driverStartMin: 10 * 60,
      workDate: "2026-09-02",
    });

    expect(built.tasks[0].startTime).toBe("10:30");
    expect(built.tasks[0].endTime).toBe("10:45");
    expect(built.tasks[1].startTime).toBe("11:00");
    expect(built.effectiveDriverStartMin).toBe(10 * 60);
  });

  it("without a pin still waits for checkout on the first stop", () => {
    const built = buildLogisticsScheduleForDriver({
      tasks: [
        {
          taskId: 1,
          logisticCode: 101,
          lat: null,
          lng: null,
          travelMinutesFromPrevious: 20,
          checkoutTime: "11:00",
          checkoutDate: "2026-09-02",
        },
      ],
      driverStartMin: 10 * 60,
      workDate: "2026-09-02",
    });

    expect(built.tasks[0].startTime).toBe("11:00");
    expect(built.effectiveDriverStartMin).toBeGreaterThan(10 * 60);
  });

  it("does not start the first stop before the driver shift", () => {
    const built = buildLogisticsScheduleForDriver({
      tasks: [
        {
          taskId: 1,
          logisticCode: 101,
          lat: null,
          lng: null,
          travelMinutesFromPrevious: 20,
          manualStartMin: 9 * 60,
        },
      ],
      driverStartMin: 10 * 60,
      workDate: "2026-09-02",
    });

    expect(built.tasks[0].startTime).toBe("10:00");
  });
});
