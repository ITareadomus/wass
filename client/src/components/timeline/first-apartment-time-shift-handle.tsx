import { useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { ChevronsLeftRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  clampFirstApartmentStart,
  clockToMinutes,
  minutesToClock,
  FIRST_APT_TIME_SHIFT_ATTRIBUTE,
} from "@/lib/first-apartment-time-shift";

type FirstApartmentTimeShiftProps = {
  enabled: boolean;
  isPinned: boolean;
  startTime?: string | null;
  cleanerStartTime?: string | null;
  cleanerEndTime?: string | null;
  pxPerMinute: number;
  disabled?: boolean;
  /** Pixels of empty timeline before the first card. If too small, dock the handle on the right. */
  leftSpacePx?: number;
  children: ReactNode;
  onPreview: (startMinutes: number) => void;
  onCommit: (startTime: string) => void | Promise<void>;
  onReset: () => void | Promise<void>;
  onCancel: () => void;
};

const HANDLE_DOCK_PX = 40;

export function FirstApartmentTimeShift({
  enabled,
  isPinned,
  startTime,
  cleanerStartTime,
  cleanerEndTime,
  pxPerMinute,
  disabled = false,
  leftSpacePx = 0,
  children,
  onPreview,
  onCommit,
  onReset,
  onCancel,
}: FirstApartmentTimeShiftProps) {
  const hideTimerRef = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [previewLabel, setPreviewLabel] = useState<string | null>(null);
  const [lockedDock, setLockedDock] = useState<"left" | "right" | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    originX: number;
    originMinutes: number;
    lastMinutes: number;
    moved: boolean;
  } | null>(null);

  const cleanerStartMin = clockToMinutes(cleanerStartTime) ?? 10 * 60;
  const cleanerEndMin = clockToMinutes(cleanerEndTime) ?? 20 * 60;
  const originMinutes = clockToMinutes(startTime) ?? cleanerStartMin;
  const showHandle = enabled && (hovered || isDragging);
  const preferredDock: "left" | "right" = leftSpacePx < HANDLE_DOCK_PX ? "right" : "left";
  const dock = lockedDock ?? preferredDock;
  const dockOnRight = dock === "right";

  const clearHideTimer = () => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };

  const reveal = () => {
    clearHideTimer();
    setHovered(true);
  };

  const scheduleHide = () => {
    if (isDragging) return;
    clearHideTimer();
    hideTimerRef.current = window.setTimeout(() => {
      setHovered(false);
      hideTimerRef.current = null;
    }, 180);
  };

  if (!enabled) {
    return <>{children}</>;
  }

  const resolveMinutes = (clientX: number, originX: number, baseMinutes: number) => {
    const deltaPx = clientX - originX;
    const deltaMinutes = pxPerMinute > 0 ? deltaPx / pxPerMinute : 0;
    return clampFirstApartmentStart(
      baseMinutes + deltaMinutes,
      cleanerStartMin,
      cleanerEndMin,
    );
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      originX: event.clientX,
      originMinutes,
      lastMinutes: originMinutes,
      moved: false,
    };
    setIsDragging(true);
    setLockedDock(dock);
    setPreviewLabel(minutesToClock(originMinutes));
    onPreview(originMinutes);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (Math.abs(event.clientX - drag.originX) >= 4) {
      drag.moved = true;
    }
    const nextMinutes = resolveMinutes(event.clientX, drag.originX, drag.originMinutes);
    if (nextMinutes === drag.lastMinutes) return;
    drag.lastMinutes = nextMinutes;
    setPreviewLabel(minutesToClock(nextMinutes));
    onPreview(nextMinutes);
  };

  const finishDrag = async (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    setIsDragging(false);
    setLockedDock(null);
    setPreviewLabel(null);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    if (!drag.moved || drag.lastMinutes === drag.originMinutes) {
      onCancel();
      return;
    }
    await onCommit(minutesToClock(drag.lastMinutes));
  };

  const handleDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled || !isPinned) return;
    void onReset();
  };

  return (
    <div
      className="relative z-20 flex-shrink-0"
      style={
        dockOnRight
          ? { marginRight: -HANDLE_DOCK_PX, paddingRight: HANDLE_DOCK_PX }
          : { marginLeft: -HANDLE_DOCK_PX, paddingLeft: HANDLE_DOCK_PX }
      }
      onMouseEnter={reveal}
      onMouseLeave={scheduleHide}
    >
      <div
        {...{ [FIRST_APT_TIME_SHIFT_ATTRIBUTE]: "true" }}
        role="slider"
        aria-label="Sposta inizio primo appartamento a scatti di 30 minuti"
        aria-valuetext={previewLabel || startTime || undefined}
        aria-hidden={!showHandle}
        title={
          isPinned
            ? "Trascina per spostare l'inizio (scatti da 30 min). Doppio click per tornare all'orario calcolato."
            : "Trascina per spostare l'inizio del primo appartamento (scatti da 30 min)"
        }
        className={cn(
          "absolute top-1/2 z-30 flex h-9 w-9 -translate-y-1/2 cursor-ew-resize touch-none select-none items-center justify-center rounded-md border border-sky-400 bg-white shadow-md transition-opacity dark:bg-slate-900",
          dockOnRight ? "right-0" : "left-0",
          showHandle ? "opacity-100" : "opacity-0",
          isDragging && "bg-sky-100 dark:bg-sky-950",
          disabled && "pointer-events-none",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={reveal}
      >
        <ChevronsLeftRight className="h-5 w-5 text-sky-700 dark:text-sky-300" />
        {previewLabel && (
          <span
            className={cn(
              "pointer-events-none absolute whitespace-nowrap rounded bg-sky-700 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white shadow",
              dockOnRight ? "left-full ml-1" : "right-full mr-1",
            )}
          >
            {previewLabel}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
