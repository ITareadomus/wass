import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveLogisticsTaskExecutionStatus,
  parseLogisticsPaused,
  isLogisticsExecutionFieldSet,
  pickLogisticsExecutionStatusFields,
  mergeLogisticsExecutionStatusIntoAssignments,
} from "./logistics-task-execution-status";

describe("resolveLogisticsTaskExecutionStatus", () => {
  it("maps not started", () => {
    assert.equal(
      resolveLogisticsTaskExecutionStatus({
        lg_real_start: null,
        lg_real_end: null,
        lg_paused: 0,
      }),
      "not_started"
    );
  });

  it("maps in progress", () => {
    assert.equal(
      resolveLogisticsTaskExecutionStatus({
        lg_real_start: "10:22:55",
        lg_real_end: null,
        lg_paused: false,
      }),
      "in_progress"
    );
  });

  it("maps paused", () => {
    assert.equal(
      resolveLogisticsTaskExecutionStatus({
        lg_real_start: "10:22:55",
        lg_real_end: null,
        lg_paused: 1,
      }),
      "paused"
    );
  });

  it("maps completed even if paused flag still set", () => {
    assert.equal(
      resolveLogisticsTaskExecutionStatus({
        lg_real_start: "12:34:16",
        lg_real_end: "12:34:42",
        lg_paused: 1,
      }),
      "completed"
    );
  });
});

describe("parseLogisticsPaused / isLogisticsExecutionFieldSet", () => {
  it("parses tinyint and strings", () => {
    assert.equal(parseLogisticsPaused(1), true);
    assert.equal(parseLogisticsPaused("true"), true);
    assert.equal(parseLogisticsPaused(0), false);
  });

  it("treats empty time as unset", () => {
    assert.equal(isLogisticsExecutionFieldSet(null), false);
    assert.equal(isLogisticsExecutionFieldSet(""), false);
    assert.equal(isLogisticsExecutionFieldSet("10:00:00"), true);
  });
});

describe("pickLogisticsExecutionStatusFields", () => {
  it("preserves status for timeline mappers", () => {
    const picked = pickLogisticsExecutionStatusFields({
      lg_real_start: "10:22:55",
      lg_real_end: null,
      lg_paused: 1,
      logistics_execution_status: "paused",
    });
    assert.equal(picked.logistics_execution_status, "paused");
    assert.equal(picked.lg_real_start, "10:22:55");
    assert.equal(picked.lg_paused, true);
  });
});

describe("mergeLogisticsExecutionStatusIntoAssignments", () => {
  it("patches only changed execution fields and keeps other task data", () => {
    const assignments = [
      {
        driver: { id: 7 },
        tasks: [
          {
            task_id: 101,
            start_time: "10:00",
            lg_real_start: null,
            lg_real_end: null,
            lg_paused: false,
            logistics_execution_status: "not_started",
          },
          {
            task_id: 102,
            start_time: "10:30",
            lg_real_start: "10:22:55",
            lg_real_end: null,
            lg_paused: false,
            logistics_execution_status: "in_progress",
          },
        ],
      },
    ];

    const { assignments: next, changed } = mergeLogisticsExecutionStatusIntoAssignments(
      assignments,
      {
        "101": {
          lg_real_start: "10:05:01",
          lg_real_end: null,
          lg_paused: false,
          logistics_execution_status: "in_progress",
        },
        "102": {
          lg_real_start: "10:22:55",
          lg_real_end: null,
          lg_paused: false,
          logistics_execution_status: "in_progress",
        },
      }
    );

    assert.equal(changed, true);
    assert.equal(next[0].tasks[0].logistics_execution_status, "in_progress");
    assert.equal(next[0].tasks[0].lg_real_start, "10:05:01");
    assert.equal(next[0].tasks[0].start_time, "10:00");
    assert.equal(next[0].tasks[1], assignments[0].tasks[1]);
  });

  it("returns the same array when nothing changed", () => {
    const assignments = [
      {
        tasks: [
          {
            task_id: 101,
            lg_real_start: "10:05:01",
            lg_real_end: null,
            lg_paused: false,
            logistics_execution_status: "in_progress",
          },
        ],
      },
    ];
    const { assignments: next, changed } = mergeLogisticsExecutionStatusIntoAssignments(
      assignments,
      {
        "101": {
          lg_real_start: "10:05:01",
          lg_real_end: null,
          lg_paused: false,
          logistics_execution_status: "in_progress",
        },
      }
    );
    assert.equal(changed, false);
    assert.equal(next, assignments);
  });
});
