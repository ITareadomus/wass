import { describe, expect, it } from "vitest";
import { mergeHypothesisPreviewAssignments } from "./logistics-hypothesis-preview";

describe("mergeHypothesisPreviewAssignments", () => {
  const drivers = [
    { id: 7, name: "Anna", start_time: "09:30" },
    { id: 8, name: "Luca", start_time: "09:30" },
  ];

  it("uses server preview assignments and keeps selected driver names", () => {
    const merged = mergeHypothesisPreviewAssignments({
      drivers,
      preview: {
        drivers_assignments: [
          {
            driver: { id: 7, name: "Driver", start_time: "09:45" },
            tasks: [{ task_id: 101, start_time: "10:00" }],
          },
        ],
      },
      solution: { routes: [] },
      containerTasks: [],
      baselineAssignments: [],
    });

    expect(merged).toHaveLength(2);
    expect(merged[0].driver).toMatchObject({ id: 7, name: "Anna", start_time: "09:45" });
    expect(merged[0].tasks).toEqual([{ task_id: 101, start_time: "10:00" }]);
    expect(merged[1].tasks).toEqual([]);
  });

  it("falls back to solution stops when preview is missing", () => {
    const merged = mergeHypothesisPreviewAssignments({
      drivers,
      preview: null,
      solution: {
        routes: [
          {
            driverId: 8,
            startMin: 10 * 60,
            stops: [
              {
                taskId: 55,
                startMin: 10 * 60 + 15,
                endMin: 10 * 60 + 30,
                sequence: 1,
                travelFromPreviousMin: 12,
                waitMin: 0,
              },
            ],
          },
        ],
      },
      containerTasks: [{ task_id: 55, address: "Via Roma", logistic_code: 8055 }],
      baselineAssignments: [],
    });

    expect(merged[0].tasks).toEqual([]);
    expect(merged[1].driver.start_time).toBe("10:00");
    expect(merged[1].tasks[0]).toMatchObject({
      task_id: 55,
      address: "Via Roma",
      logistic_code: 8055,
      start_time: "10:15",
      end_time: "10:30",
      travel_time: 12,
    });
  });

  it("copies HK window fields from baseline onto preview tasks", () => {
    const merged = mergeHypothesisPreviewAssignments({
      drivers,
      preview: {
        drivers_assignments: [
          {
            driver: { id: 7, name: "Driver", start_time: "09:45" },
            tasks: [
              {
                task_id: 101,
                start_time: "12:40",
                logistics_task_kind: "delivery/pick-up",
              },
            ],
          },
        ],
      },
      solution: { routes: [] },
      containerTasks: [],
      baselineAssignments: [
        {
          driver: { id: 7 },
          tasks: [
            {
              task_id: 101,
              hk_start_time: "11:20",
              cleaning_time: 60,
              cleaner_sequence: 2,
            },
          ],
        },
      ],
    });

    expect(merged[0].tasks[0]).toMatchObject({
      task_id: 101,
      start_time: "12:40",
      hk_start_time: "11:20",
      cleaning_time: 60,
      cleaner_sequence: 2,
    });
  });
});
