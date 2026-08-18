import { describe, expect, it } from "vitest";
import {
  enrichSolutionIssuesWithLogisticCodes,
  formatInputValidationIssueForUser,
  formatRoutingSolutionValidationForUser,
  formatSolutionValidationIssueForUser,
} from "../server/services/logistics-optimizer-final/user-facing-errors";
import type { RoutingProblemInput } from "../server/services/logistics-optimizer-final/input-contract";

describe("formatSolutionValidationIssueForUser", () => {
  it("include codice ADAM e task id per REQUIRED_DRIVER_DROPPED", () => {
    const text = formatSolutionValidationIssueForUser({
      code: "REQUIRED_DRIVER_DROPPED",
      severity: "error",
      message: "Task with REQUIRED_DRIVER_TASK was dropped from the solution",
      taskId: 235692,
      logisticCode: 88421,
      driverId: 7,
    });

    expect(text).toContain("codice ADAM 88421");
    expect(text).toContain("task 235692");
    expect(text).toContain("autista 7");
    expect(text.toLowerCase()).not.toContain("required_driver");
  });
});

describe("enrichSolutionIssuesWithLogisticCodes", () => {
  it("arricchisce gli issue con logisticCode dalle task", () => {
    const input = {
      tasks: [{ taskId: 101, logisticCode: 555 }],
    } as unknown as RoutingProblemInput;

    const enriched = enrichSolutionIssuesWithLogisticCodes(input, [
      {
        code: "TASK_HARD_WINDOW_VIOLATION",
        severity: "error",
        message: "window",
        taskId: 101,
      },
    ]);

    expect(enriched[0].logisticCode).toBe(555);
  });
});

describe("formatRoutingSolutionValidationForUser", () => {
  it("produce un messaggio italiano unico leggibile", () => {
    const text = formatRoutingSolutionValidationForUser({
      valid: false,
      errors: [
        {
          code: "REQUIRED_DRIVER_DROPPED",
          severity: "error",
          message: "dropped",
          taskId: 1,
          logisticCode: 100,
          driverId: 9,
        },
      ],
      warnings: [],
    });

    expect(text.startsWith("Assegnazione non riuscita:")).toBe(true);
    expect(text).toContain("codice ADAM 100");
  });
});

describe("formatInputValidationIssueForUser", () => {
  it("traduce INVALID_TASK_HARD_WINDOW con codice ADAM", () => {
    const text = formatInputValidationIssueForUser({
      code: "INVALID_TASK_HARD_WINDOW",
      severity: "error",
      message: "Task 234629 has inconsistent hard window",
      taskId: 234629,
      logisticCode: 99112,
    });

    expect(text).toContain("codice ADAM 99112");
    expect(text).toContain("task 234629");
    expect(text).not.toContain("Invalid RoutingProblemInput");
    expect(text).not.toContain("INVALID_TASK_HARD_WINDOW");
  });
});
