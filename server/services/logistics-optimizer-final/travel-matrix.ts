import {
  estimateCarTravelMinutes,
  LOGISTICS_DEPOT_LAT,
  LOGISTICS_DEPOT_LNG,
} from "../logistics-timeline-utils";
import type { LocationNode, TaskNode } from "./input-contract";

export function buildDepotNode(): LocationNode {
  return {
    nodeId: "depot",
    nodeIndex: 0,
    kind: "DEPOT",
    lat: LOGISTICS_DEPOT_LAT,
    lng: LOGISTICS_DEPOT_LNG,
  };
}

export function buildLocationNodes(tasks: TaskNode[]): LocationNode[] {
  const depot = buildDepotNode();
  const taskNodes = tasks.map((task) => ({
    nodeId: `task:${task.taskId}`,
    nodeIndex: task.nodeIndex,
    kind: "TASK" as const,
    taskId: task.taskId,
    lat: task.location.lat,
    lng: task.location.lng,
  }));

  return [depot, ...taskNodes];
}

export function buildTravelMatrixMin(nodes: LocationNode[]): number[][] {
  return nodes.map((from) =>
    nodes.map((to) => {
      if (from.nodeIndex === to.nodeIndex) return 0;
      return estimateCarTravelMinutes(
        { lat: from.lat, lng: from.lng },
        { lat: to.lat, lng: to.lng }
      );
    })
  );
}
