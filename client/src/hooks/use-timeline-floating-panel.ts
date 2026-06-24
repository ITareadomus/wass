import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

export type TimelineFloatingPanelSide = "left" | "right";
export type TimelineFloatingPanelResizeMode =
  | "drag"
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw";

export interface TimelineFloatingPanelRect {
  top: number;
  inset: number;
  width: number;
  height: number;
}

interface GetDefaultTimelineFloatingPanelOptions {
  width?: number;
  height?: number;
  inset?: number;
  bottomGap?: number;
}

export function getDefaultTimelineFloatingPanel(
  _side: TimelineFloatingPanelSide,
  options: GetDefaultTimelineFloatingPanelOptions = {}
): TimelineFloatingPanelRect {
  const width = options.width ?? 360;
  const height = options.height ?? 360;
  const bottomGap = options.bottomGap ?? 88;
  const inset = options.inset ?? 104;
  const viewportHeight =
    typeof window !== "undefined" ? window.innerHeight : 720;

  return {
    top: Math.max(96, viewportHeight - height - bottomGap),
    inset,
    width,
    height,
  };
}

export function useTimelineFloatingPanel(
  side: TimelineFloatingPanelSide,
  getDefaultPanel: () => TimelineFloatingPanelRect
) {
  const [isOpen, setIsOpen] = useState(false);
  const [panel, setPanel] = useState(getDefaultPanel);
  const interactionRef = useRef<{
    mode: TimelineFloatingPanelResizeMode;
    pointerId: number;
    side: TimelineFloatingPanelSide;
    startX: number;
    startY: number;
    startTop: number;
    startInset: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);

  const resetPanel = useCallback(() => {
    setPanel(getDefaultPanel());
  }, [getDefaultPanel]);

  const handlePointerDown = useCallback(
    (
      event: ReactPointerEvent<HTMLDivElement>,
      mode: TimelineFloatingPanelResizeMode
    ) => {
      event.preventDefault();
      event.stopPropagation();
      interactionRef.current = {
        mode,
        pointerId: event.pointerId,
        side,
        startX: event.clientX,
        startY: event.clientY,
        startTop: panel.top,
        startInset: panel.inset,
        startWidth: panel.width,
        startHeight: panel.height,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [panel, side]
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;

    const dx = event.clientX - interaction.startX;
    const dy = event.clientY - interaction.startY;
    const anchoredRight = interaction.side === "right";

    if (interaction.mode === "drag") {
      setPanel((prev) => ({
        ...prev,
        top: Math.max(0, interaction.startTop + dy),
        inset: Math.max(
          0,
          anchoredRight ? interaction.startInset - dx : interaction.startInset + dx
        ),
      }));
      return;
    }

    const minSize = 260;
    const maxSize = 760;
    const resizesNorth = interaction.mode.includes("n");
    const resizesSouth = interaction.mode.includes("s");
    const resizesEast = interaction.mode.includes("e");
    const resizesWest = interaction.mode.includes("w");

    let nextWidth = interaction.startWidth;
    let nextHeight = interaction.startHeight;
    if (resizesWest) nextWidth = interaction.startWidth - dx;
    if (resizesEast) nextWidth = interaction.startWidth + dx;
    if (resizesNorth) nextHeight = interaction.startHeight - dy;
    if (resizesSouth) nextHeight = interaction.startHeight + dy;

    nextWidth = Math.max(minSize, Math.min(maxSize, nextWidth));
    nextHeight = Math.max(minSize, Math.min(maxSize, nextHeight));

    setPanel((prev) => ({
      ...prev,
      width: nextWidth,
      height: nextHeight,
      top: resizesNorth
        ? interaction.startTop + (interaction.startHeight - nextHeight)
        : prev.top,
      inset: anchoredRight
        ? resizesEast
          ? interaction.startInset - (nextWidth - interaction.startWidth)
          : prev.inset
        : resizesWest
          ? interaction.startInset + (interaction.startWidth - nextWidth)
          : prev.inset,
    }));
  }, []);

  const handlePointerEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || interaction.pointerId !== event.pointerId) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    interactionRef.current = null;
  }, []);

  return {
    isOpen,
    setIsOpen,
    panel,
    setPanel,
    resetPanel,
    handlePointerDown,
    handlePointerMove,
    handlePointerEnd,
  };
}
