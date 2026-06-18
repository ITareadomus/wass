import { describe, expect, it } from "vitest";
import { buildRoutingProblemInputFromSource } from "../server/services/logistics-optimizer-final/build-routing-input";
import type { LogisticsRoutingSourceData } from "../server/services/logistics-optimizer-final/loaders";
import type { RoutingProblemInput } from "../server/services/logistics-optimizer-final/input-contract";
import {
  buildCostMatrixMin,
  buildOrToolsPayload,
  decodeOrToolsSolution,
  DROP_PENALTY_BY_PRIORITY,
  type OrToolsRawSolution,
} from "../server/services/logistics-optimizer-final/solver/ortools/ortools-adapter";
import {
  buildRequiredDriverNotSelectedSolution,
  buildRequiredInfeasibleSolution,
  findTasksWithMissingRequiredVehicle,
} from "../server/services/logistics-optimizer-final/solver/ortools/required-infeasible";
import { solveOrToolsRouting } from "../server/services/logistics-optimizer-final/solver/ortools/ortools-routing-solver";
import { ORTOOLS_SOLVER_ID } from "../server/services/logistics-optimizer-final/solution-contract";
import { validateRoutingSolution } from "../server/services/logistics-optimizer-final/solution-validation";
import type { PriorityWindows } from "../server/services/optimizer/priorityWindows";
import { spawn } from "child_process";

const priorityWindows: PriorityWindows = {
  EO: { startMin: 0, endMin: 659, graceMin: 0 },
  HP: { startMin: 660, endMin: 930, graceMin: 0 },
  LP: { startMin: 660, endMin: null, graceMin: 0 },
};

function buildBaseSourceData(overrides: Partial<LogisticsRoutingSourceData> = {}): LogisticsRoutingSourceData {
  const task101 = {
    taskId: 101,
    logisticCode: 5001,
    priority: "early_out",
    cleaningTime: 60,
    lat: 45.45,
    lng: 9.18,
    checkinDate: null,
    checkoutDate: null,
    checkinTime: null,
    checkoutTime: null,
    cleanerId: 10,
    cleanerStartTime: "10:00",
    cleanerTaskStartTime: "10:00",
    cleanerSequence: 1,
    premium: false,
    paxIn: 2,
    locked: false,
    lockedReason: null,
  };

  return {
    workDate: "2026-06-04",
    allTaskData: [task101],
    unlockedTaskData: [task101],
    schedulableTasks: [task101],
    lockedTasksExcluded: 0,
    tasksExcludedNoCoordinatesIds: [],
    selectedDrivers: [
      {
        id: 7,
        startTime: "09:30",
        startTimeSource: "driver_row",
        endTime: "20:00",
        endTimeSource: "default",
      },
      {
        id: 8,
        startTime: "09:30",
        startTimeSource: "driver_row",
        endTime: "20:00",
        endTimeSource: "default",
      },
    ],
    timelineAssignmentHints: [],
    windowConfig: {
      source: "app_settings",
      workDate: "2026-06-04",
      priorityWindows,
      fallbackUsed: false,
    },
    ...overrides,
  };
}

function buildMinimalInput(): RoutingProblemInput {
  return buildRoutingProblemInputFromSource(buildBaseSourceData());
}

function buildInputWithUnselectedRequiredDriver(): RoutingProblemInput {
  const input = buildMinimalInput();
  input.hardConstraints.push({
    type: "REQUIRED_DRIVER_TASK",
    taskId: 101,
    driverId: 99,
    source: "timeline_pre_assigned",
  });
  return input;
}

async function probeOrToolsPython(): Promise<boolean> {
  for (const pythonPath of ["python3", "python"]) {
    const available = await new Promise<boolean>((resolve) => {
      const proc = spawn(pythonPath, ["-c", "import ortools"], { windowsHide: true });
      proc.on("error", () => resolve(false));
      proc.on("close", (code) => resolve(code === 0));
    });
    if (available) return true;
  }
  return false;
}

describe("buildOrToolsPayload", () => {
  it("maps required driver and per-task service duration", () => {
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        timelineAssignmentHints: [
          {
            taskId: 101,
            driverId: 8,
            source: "timeline",
            sequence: 1,
            manuallyMoved: false,
          },
        ],
      })
    );

    const { payload } = buildOrToolsPayload(input);

    expect(payload.tasks).toHaveLength(1);
    expect(payload.tasks[0]).toMatchObject({
      taskId: 101,
      requiredDriverId: 8,
      requiredVehicleIndex: 1,
      serviceDurationMin: input.serviceDurationMin,
    });
    expect(payload.vehicles.map((v) => v.driverId)).toEqual([7, 8]);
  });

  it("omits requiredVehicleIndex when required driver is not among selected drivers", () => {
    const input = buildInputWithUnselectedRequiredDriver();
    const { payload } = buildOrToolsPayload(input);

    expect(payload.tasks[0].requiredDriverId).toBeUndefined();
    expect(payload.tasks[0].requiredVehicleIndex).toBeUndefined();
    expect(findTasksWithMissingRequiredVehicle(input)).toEqual([
      { taskId: 101, requiredDriverId: 99 },
    ]);
  });

  it("assigns drop penalties EO > HP > LP", () => {
    const makeTask = (taskId: number, priority: string) => ({
      taskId,
      logisticCode: 5000 + taskId,
      priority,
      cleaningTime: 60,
      lat: 45.45 + taskId * 0.001,
      lng: 9.18,
      checkinDate: null,
      checkoutDate: null,
      checkinTime: null,
      checkoutTime: null,
      cleanerId: 10,
      cleanerStartTime: "10:00",
      cleanerTaskStartTime: "10:00",
      cleanerSequence: 1,
      premium: false,
      paxIn: 2,
      locked: false,
      lockedReason: null,
    });

    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        schedulableTasks: [
          makeTask(101, "early_out"),
          makeTask(102, "high_priority"),
          makeTask(103, "low_priority"),
          makeTask(104, "unknown"),
        ],
        allTaskData: [
          makeTask(101, "early_out"),
          makeTask(102, "high_priority"),
          makeTask(103, "low_priority"),
          makeTask(104, "unknown"),
        ],
      })
    );

    const { payload } = buildOrToolsPayload(input);
    const byId = new Map(payload.tasks.map((task) => [task.taskId, task.dropPenalty]));

    expect(byId.get(101)).toBe(DROP_PENALTY_BY_PRIORITY.EO);
    expect(byId.get(102)).toBe(DROP_PENALTY_BY_PRIORITY.HP);
    expect(byId.get(103)).toBe(DROP_PENALTY_BY_PRIORITY.LP);
    expect(byId.get(104)).toBe(DROP_PENALTY_BY_PRIORITY.default);
    expect(byId.get(101)! > byId.get(102)!).toBe(true);
    expect(byId.get(102)! > byId.get(103)!).toBe(true);
  });

  it("shapes costMatrixMin for same-building groups", () => {
    const task102 = {
      taskId: 102,
      logisticCode: 5002,
      priority: "low_priority",
      cleaningTime: 30,
      lat: 45.45,
      lng: 9.18,
      checkinDate: null,
      checkoutDate: null,
      checkinTime: null,
      checkoutTime: null,
      cleanerId: 10,
      cleanerStartTime: "11:00",
      cleanerTaskStartTime: "11:00",
      cleanerSequence: 2,
      premium: false,
      paxIn: 1,
      locked: false,
      lockedReason: null,
    };

    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        schedulableTasks: [buildBaseSourceData().schedulableTasks[0], task102],
        allTaskData: [buildBaseSourceData().schedulableTasks[0], task102],
      })
    );

    const sameBuildingGroup = input.businessGroups.find(
      (group) => group.type === "SAME_COORDINATES_BUILDING" && group.taskIds.length >= 2
    );
    expect(sameBuildingGroup).toBeDefined();

    const { payload } = buildOrToolsPayload(input);
    const node1 = input.tasks.find((t) => t.taskId === 101)!.nodeIndex;
    const node2 = input.tasks.find((t) => t.taskId === 102)!.nodeIndex;

    expect(payload.costMatrixMin[node1][node2]).toBeLessThan(payload.travelMatrixMin[node1][node2]);
  });

  it("includes EO preferred soft time windows and balance weight", () => {
    const input = buildMinimalInput();
    const { payload } = buildOrToolsPayload(input);

    expect(payload.schemaVersion).toBe("logistics-ortools-payload/v2");
    expect(payload.balanceDriverLoadWeight).toBeGreaterThan(0);

    const eoTask = input.tasks.find((task) => task.priority === "EO");
    expect(eoTask).toBeDefined();

    const preferred = payload.softTimeWindows.find((entry) => entry.taskId === eoTask!.taskId);
    expect(preferred).toMatchObject({
      nodeIndex: eoTask!.nodeIndex,
      penaltyPerMinLate: expect.any(Number),
    });
    expect(preferred!.preferredEndMin).toBeGreaterThan(0);
  });
});

const ortoolsAvailable = await probeOrToolsPython();

describe("decodeOrToolsSolution", () => {
  it("decodes timeCumuls using original travelMatrixMin", () => {
    const input = buildMinimalInput();
    const { payload, maps } = buildOrToolsPayload(input);
    const task = input.tasks[0];
    const travel = input.travelMatrixMin[0][task.nodeIndex];
    const arrivalMin = input.drivers[0].workWindow.startMin + travel;
    const startMin = Math.max(arrivalMin, task.hardWindow.earliestStartMin);
    const waitMin = startMin - arrivalMin;

    const raw: OrToolsRawSolution = {
      status: "ok",
      ortoolsStatus: "ROUTING_SUCCESS",
      routes: [
        {
          vehicleIndex: 0,
          nodeIndices: [0, task.nodeIndex, 0],
          timeCumuls: [
            input.drivers[0].workWindow.startMin,
            startMin,
            startMin + task.serviceDurationMin,
          ],
        },
      ],
      droppedTaskIds: [],
      objectiveValue: 100,
      solveDurationMs: 10,
    };

    const solution = decodeOrToolsSolution({
      input,
      payload,
      raw,
      maps,
      generatedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(solution.solverId).toBe(ORTOOLS_SOLVER_ID);
    expect(solution.status).toBe("FEASIBLE");
    expect(solution.routes[0].stops[0]).toMatchObject({
      taskId: 101,
      startMin,
      arrivalMin,
      waitMin,
      travelFromPreviousMin: travel,
    });

    const validation = validateRoutingSolution(input, solution);
    expect(validation.valid).toBe(true);
  });

  it("marks required dropped as INVALID", () => {
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        timelineAssignmentHints: [
          {
            taskId: 101,
            driverId: 7,
            source: "timeline",
            sequence: 1,
            manuallyMoved: false,
          },
        ],
      })
    );
    const { payload, maps } = buildOrToolsPayload(input);

    const solution = decodeOrToolsSolution({
      input,
      payload,
      raw: {
        status: "ok",
        routes: [],
        droppedTaskIds: [101],
      },
      maps,
    });

    expect(solution.status).toBe("INVALID");
    expect(solution.droppedTasks[0]).toMatchObject({
      taskId: 101,
      reason: "REQUIRED_DRIVER_INFEASIBLE",
    });
  });
});

describe("buildRequiredDriverNotSelectedSolution", () => {
  it("returns INVALID when required driver is not among selected drivers", () => {
    const input = buildInputWithUnselectedRequiredDriver();
    const missing = findTasksWithMissingRequiredVehicle(input);
    const solution = buildRequiredDriverNotSelectedSolution(input, missing);

    expect(solution.status).toBe("INVALID");
    expect(solution.routes).toHaveLength(0);
    expect(solution.droppedTasks[0]).toMatchObject({
      taskId: 101,
      reason: "REQUIRED_DRIVER_INFEASIBLE",
      details: "REQUIRED_DRIVER_NOT_SELECTED:99",
    });
    expect(solution.diagnostics?.notes).toContain("required_driver_not_selected");

    const validation = validateRoutingSolution(input, solution);
    expect(validation.valid).toBe(false);
    expect(validation.errors).toContainEqual(
      expect.objectContaining({
        code: "REQUIRED_DRIVER_DROPPED",
        taskId: 101,
      })
    );
  });
});

describe("buildRequiredInfeasibleSolution", () => {
  it("returns INVALID diagnostic solution without throwing", () => {
    const input = buildRoutingProblemInputFromSource(
      buildBaseSourceData({
        timelineAssignmentHints: [
          {
            taskId: 101,
            driverId: 7,
            source: "timeline",
            sequence: 1,
            manuallyMoved: false,
          },
        ],
      })
    );

    const solution = buildRequiredInfeasibleSolution(input, {
      note: "ortools_infeasible_fallback",
    });

    expect(solution.status).toBe("INVALID");
    expect(solution.routes).toHaveLength(0);
    expect(solution.droppedTasks[0].reason).toBe("REQUIRED_DRIVER_INFEASIBLE");
    expect(solution.diagnostics?.notes).toContain("ortools_infeasible_fallback");
  });
});

describe("solveOrToolsRouting integration", () => {
  it("skips Python when required driver is not among selected drivers", async () => {
    const input = buildInputWithUnselectedRequiredDriver();
    const solution = await solveOrToolsRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
    });

    expect(solution.status).toBe("INVALID");
    expect(solution.droppedTasks[0].details).toBe("REQUIRED_DRIVER_NOT_SELECTED:99");
    expect(solution.diagnostics?.solveDurationMs).toBe(0);
  });

  it.skipIf(!ortoolsAvailable)(
    "solves a minimal feasible instance",
    async () => {
    const input = buildMinimalInput();
    const solution = await solveOrToolsRouting(input, {
      generatedAt: "2026-06-04T00:00:00.000Z",
      ortools: { timeLimitSec: 2, timeoutMs: 8000 },
    });

    expect(solution.solverId).toBe(ORTOOLS_SOLVER_ID);
    expect(["FEASIBLE", "PARTIAL"]).toContain(solution.status);

    const validation = validateRoutingSolution(input, solution);
    expect(validation.valid).toBe(true);
    },
    15000
  );

  it.skipIf(!ortoolsAvailable)(
    "assigns required task to mandated driver when feasible",
    async () => {
      const input = buildRoutingProblemInputFromSource(
        buildBaseSourceData({
          timelineAssignmentHints: [
            {
              taskId: 101,
              driverId: 8,
              source: "timeline",
              sequence: 1,
              manuallyMoved: false,
            },
          ],
        })
      );

      const solution = await solveOrToolsRouting(input, {
        generatedAt: "2026-06-04T00:00:00.000Z",
        ortools: { timeLimitSec: 2, timeoutMs: 8000 },
      });

      const route = solution.routes.find((entry) => entry.driverId === 8);
      expect(route).toBeDefined();
      expect(route!.stops.some((stop) => stop.taskId === 101)).toBe(true);
    },
    15000
  );

  it.skipIf(!ortoolsAvailable)(
    "does not require return-to-depot travel inside driver work window",
    async () => {
      const input = buildMinimalInput();
      const task = input.tasks[0];
      input.drivers = [
        {
          ...input.drivers[0],
          workWindow: {
            startMin: 9 * 60,
            endMin: 10 * 60,
            startSource: input.drivers[0].workWindow.startSource,
            endSource: input.drivers[0].workWindow.endSource,
          },
        },
      ];
      task.hardWindow = {
        earliestStartMin: 9 * 60 + 30,
        latestStartMin: 9 * 60 + 45,
        latestEndMin: 10 * 60,
        reasons: [],
      };
      input.travelMatrixMin[0][task.nodeIndex] = 10;
      input.travelMatrixMin[task.nodeIndex][0] = 60;

      const solution = await solveOrToolsRouting(input, {
        generatedAt: "2026-06-04T00:00:00.000Z",
        ortools: { timeLimitSec: 2, timeoutMs: 8000 },
      });

      expect(solution.status).toBe("FEASIBLE");
      expect(solution.routes).toHaveLength(1);
      expect(solution.routes[0].stops[0]).toMatchObject({
        taskId: task.taskId,
        startMin: 9 * 60 + 30,
        endMin: 9 * 60 + 45,
        travelFromPreviousMin: 10,
      });
      expect(solution.routes[0].totalTravelMin).toBe(10);

      const validation = validateRoutingSolution(input, solution);
      expect(validation.valid).toBe(true);
    },
    15000
  );
});

describe("probeOrToolsAvailability", () => {
  it("finds the routing script on disk", async () => {
    const { defaultOrToolsScriptPath, probeOrToolsAvailability } = await import(
      "../server/services/logistics-optimizer-final/solver/ortools/ortools-availability"
    );
    const scriptPath = defaultOrToolsScriptPath();
    const probe = await probeOrToolsAvailability({ scriptPath });
    expect(probe.scriptPath).toBe(scriptPath);
    if (!probe.available) {
      expect(probe.reason).toBeTruthy();
    }
  });
});
