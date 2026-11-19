import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type ComparisonSelectionValue = {
  taskId: string | null;
  cleanerId: number | null;
  toggleTask: (taskId: string) => void;
  toggleCleaner: (cleanerId: number) => void;
};

const ComparisonSelectionContext = createContext<ComparisonSelectionValue | null>(null);

export function useComparisonSelection() {
  return useContext(ComparisonSelectionContext);
}

export function ComparisonSelectionProvider({
  children,
  onTaskId,
}: {
  children: ReactNode;
  onTaskId?: (taskId: string | null) => void;
}) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [cleanerId, setCleanerId] = useState<number | null>(null);
  const onTaskIdRef = useRef(onTaskId);
  onTaskIdRef.current = onTaskId;

  useEffect(() => {
    if (taskId) onTaskIdRef.current?.(taskId);
  }, [taskId]);

  const value = useMemo<ComparisonSelectionValue>(() => ({
    taskId,
    cleanerId,
    toggleTask: (next) => {
      setCleanerId(null);
      setTaskId((current) => (current === next ? null : next));
    },
    toggleCleaner: (next) => {
      setTaskId(null);
      setCleanerId((current) => (current === next ? null : next));
    },
  }), [taskId, cleanerId]);

  return (
    <ComparisonSelectionContext.Provider value={value}>
      {children}
    </ComparisonSelectionContext.Provider>
  );
}
