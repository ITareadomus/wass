import {
  useAssignmentDnd,
  type UseAssignmentDndOptions,
} from "./useAssignmentDnd";

export type UseLogisticsDndOptions = Omit<UseAssignmentDndOptions, "scope">;

export function useLogisticsDnd(options: UseLogisticsDndOptions) {
  return useAssignmentDnd({
    ...options,
    scope: "logistics",
  });
}
