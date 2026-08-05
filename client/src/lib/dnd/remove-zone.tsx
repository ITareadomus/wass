import { Trash2 } from "lucide-react";
import { useDroppable } from "@dnd-kit/core";
import { removeZoneContainerDndId } from "./ids";
import type { AppDndContainer, DndScope } from "./types";

export type DndRemoveZoneProps = {
  scope: DndScope;
  visible: boolean;
  disabled?: boolean;
  label?: string;
  description?: string;
  className?: string;
};

export function DndRemoveZone({
  scope,
  visible,
  disabled = false,
  label = "Rimuovi dalla timeline",
  description = "Rilascia qui per riportare la task nei container",
  className = "",
}: DndRemoveZoneProps) {
  const data: AppDndContainer = {
    kind: "container",
    scope,
    type: "remove-zone",
    accepts: ["timeline", "summary"],
  };

  const { isOver, setNodeRef } = useDroppable({
    id: removeZoneContainerDndId(scope),
    data,
    disabled: disabled || !visible,
  });

  return (
    <div
      className={[
        "pointer-events-none fixed inset-x-0 bottom-0 z-[1000] flex justify-center px-4 pb-6 pt-8",
        visible ? "opacity-100" : "opacity-0",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div
        ref={setNodeRef}
        data-dnd-remove-zone-scope={scope}
        className={[
          "flex min-h-[4.5rem] w-[min(420px,calc(100vw-32px))] items-center justify-center gap-2.5 rounded-xl border-2 px-6 py-3.5 transition-all duration-150",
          visible ? "pointer-events-auto" : "pointer-events-none",
          disabled
            ? "border-slate-300 bg-slate-100 text-slate-400 dark:border-slate-700 dark:bg-slate-900"
            : isOver
              ? "border-red-300 bg-red-600 text-white ring-4 ring-red-500/35 dark:border-red-300 dark:bg-red-600 dark:text-white"
              : "border-red-400 bg-red-50 text-red-700 dark:border-red-600 dark:bg-red-950 dark:text-red-100",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        role="status"
        aria-live="polite"
        aria-hidden={!visible}
      >
        <Trash2 className="pointer-events-none h-5 w-5 shrink-0" aria-hidden />
        <div className="pointer-events-none min-w-0">
          <p className="text-sm font-semibold leading-tight">{label}</p>
          <p className="text-xs leading-tight opacity-80">{description}</p>
        </div>
      </div>
    </div>
  );
}
