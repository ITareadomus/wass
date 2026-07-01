import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  TimelineFloatingPanelRect,
  TimelineFloatingPanelResizeMode,
  TimelineFloatingPanelSide,
} from "@/hooks/use-timeline-floating-panel";

const RESIZE_HANDLES: Array<{
  key: TimelineFloatingPanelResizeMode;
  className: string;
}> = [
  { key: "n", className: "inset-x-3 top-0 h-2 cursor-n-resize" },
  { key: "s", className: "inset-x-3 bottom-0 h-2 cursor-s-resize" },
  { key: "e", className: "inset-y-3 right-0 w-2 cursor-e-resize" },
  { key: "w", className: "inset-y-3 left-0 w-2 cursor-w-resize" },
  { key: "ne", className: "right-0 top-0 h-4 w-4 cursor-ne-resize" },
  { key: "nw", className: "left-0 top-0 h-4 w-4 cursor-nw-resize" },
  { key: "se", className: "bottom-0 right-0 h-4 w-4 cursor-se-resize" },
  { key: "sw", className: "bottom-0 left-0 h-4 w-4 cursor-sw-resize" },
];

interface TimelineFloatingPanelProps {
  side: TimelineFloatingPanelSide;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  panel: TimelineFloatingPanelRect;
  onResetPanel: () => void;
  toggleAriaLabel: string;
  toggleTitle: string;
  toggleIcon: ReactNode;
  dragTitle?: string;
  closeAriaLabel?: string;
  closeTitle?: string;
  onPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    mode: TimelineFloatingPanelResizeMode
  ) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
  children: ReactNode;
  contentClassName?: string;
  /** Riduce l'altezza del pannello al contenuto (max = panel.height). */
  fitContent?: boolean;
  /** Riduce la larghezza del pannello al contenuto (max = panel.width). */
  fitContentWidth?: boolean;
  /** Offset verticale del tab rispetto al centro (px). Utile per impilare più tab a destra. */
  toggleVerticalOffset?: number;
}

export default function TimelineFloatingPanel({
  side,
  isOpen,
  onOpenChange,
  panel,
  onResetPanel,
  toggleAriaLabel,
  toggleTitle,
  toggleIcon,
  dragTitle = "Trascina pannello",
  closeAriaLabel = "Nascondi pannello",
  closeTitle = "Nascondi pannello",
  onPointerDown,
  onPointerMove,
  onPointerEnd,
  children,
  contentClassName,
  fitContent = false,
  fitContentWidth = false,
  toggleVerticalOffset = 0,
}: TimelineFloatingPanelProps) {
  const [closedToggleTop, setClosedToggleTop] = useState<number | null>(null);
  const suppressClosedToggleClickRef = useRef(false);
  const closedToggleDragRef = useRef<{
    pointerId: number;
    startY: number;
    startTop: number;
    maxTop: number;
    hasMoved: boolean;
  } | null>(null);
  const wasOpenRef = useRef(isOpen);

  useEffect(() => {
    if (wasOpenRef.current && !isOpen) {
      setClosedToggleTop(null);
    }
    wasOpenRef.current = isOpen;
  }, [isOpen]);

  const handleClosedTogglePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;

      const button = event.currentTarget;
      const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
      const parentHeight = parent?.clientHeight ?? window.innerHeight;
      const buttonRect = button.getBoundingClientRect();
      const parentRect = parent?.getBoundingClientRect();
      const currentTop =
        closedToggleTop ??
        (parentRect
          ? buttonRect.top - parentRect.top
          : buttonRect.top);

      closedToggleDragRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startTop: currentTop,
        maxTop: Math.max(0, parentHeight - buttonRect.height),
        hasMoved: false,
      };
      button.setPointerCapture(event.pointerId);
    },
    [closedToggleTop]
  );

  const handleClosedTogglePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = closedToggleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dy = event.clientY - drag.startY;
    if (Math.abs(dy) > 3) {
      drag.hasMoved = true;
    }
    if (!drag.hasMoved) return;

    event.preventDefault();
    event.stopPropagation();
    setClosedToggleTop(Math.max(0, Math.min(drag.maxTop, drag.startTop + dy)));
  }, []);

  const handleClosedTogglePointerEnd = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = closedToggleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    suppressClosedToggleClickRef.current = drag.hasMoved;
    closedToggleDragRef.current = null;
  }, []);

  const panelPositionStyle =
    side === "right"
      ? {
          top: `${panel.top}px`,
          right: `${panel.inset}px`,
          ...(fitContentWidth
            ? {
                width: "max-content",
                maxWidth: `${panel.width}px`,
                minWidth: "220px",
              }
            : { width: `${panel.width}px` }),
          ...(fitContent
            ? { height: "auto", maxHeight: `${panel.height}px` }
            : { height: `${panel.height}px` }),
        }
      : {
          top: `${panel.top}px`,
          left: `${panel.inset}px`,
          ...(fitContentWidth
            ? {
                width: "max-content",
                maxWidth: `${panel.width}px`,
                minWidth: "220px",
              }
            : { width: `${panel.width}px` }),
          ...(fitContent
            ? { height: "auto", maxHeight: `${panel.height}px` }
            : { height: `${panel.height}px` }),
        };

  return (
    <>
      {!isOpen && (
        <button
          type="button"
          onClick={(event) => {
            if (suppressClosedToggleClickRef.current) {
              suppressClosedToggleClickRef.current = false;
              event.preventDefault();
              return;
            }
            onOpenChange(true);
          }}
          onPointerDown={handleClosedTogglePointerDown}
          onPointerMove={handleClosedTogglePointerMove}
          onPointerUp={handleClosedTogglePointerEnd}
          onPointerCancel={handleClosedTogglePointerEnd}
          className={cn(
            "absolute z-50 inline-flex cursor-grab touch-none select-none border-2 border-custom-blue bg-background px-2 py-3 text-custom-blue shadow-lg transition-colors hover:bg-accent active:cursor-grabbing",
            side === "right"
              ? "right-0 translate-x-1/2 rounded-l-lg"
              : "left-0 -translate-x-1/2 rounded-r-lg"
          )}
          aria-label={toggleAriaLabel}
          title={toggleTitle}
          style={{
            writingMode: "vertical-rl",
            top:
              closedToggleTop == null
                ? `calc(50% + ${toggleVerticalOffset}px)`
                : `${closedToggleTop}px`,
            transform:
              side === "right"
                ? closedToggleTop == null
                  ? "translateY(-50%) translateX(50%)"
                  : "translateX(50%)"
                : closedToggleTop == null
                  ? "translateY(-50%) translateX(-50%)"
                  : "translateX(-50%)",
          }}
        >
          {toggleIcon}
        </button>
      )}

      {isOpen && (
        <div className="fixed z-50 block" style={panelPositionStyle}>
          <div className={cn("relative", fitContentWidth ? "w-fit" : "w-full", fitContent ? "h-auto" : "h-full")}>
            <div
              className="absolute inset-x-0 top-0 z-30 h-9 cursor-move rounded-t-lg"
              onPointerDown={(event) => onPointerDown(event, "drag")}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              title={dragTitle}
            />
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                onResetPanel();
              }}
              className="absolute right-2 top-2 z-40 inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-background text-foreground shadow-md transition-colors hover:bg-accent"
              aria-label={closeAriaLabel}
              title={closeTitle}
            >
              <X className="h-4 w-4" />
            </button>
            <div
              className={cn(
                fitContent
                  ? "h-auto overflow-y-auto"
                  : "h-full overflow-hidden",
                "rounded-lg border-2 border-custom-blue bg-background shadow-xl",
                contentClassName
              )}
            >
              {children}
            </div>
            {RESIZE_HANDLES.map((handle) => (
              <div
                key={handle.key}
                className={cn("absolute z-40", handle.className)}
                onPointerDown={(event) => onPointerDown(event, handle.key)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerEnd}
                onPointerCancel={onPointerEnd}
                title="Ridimensiona pannello"
              />
            ))}
          </div>
        </div>
      )}
    </>
  );
}
