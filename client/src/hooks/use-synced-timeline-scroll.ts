import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type UIEvent as ReactUIEvent,
} from "react";

const DEFAULT_PAN_IGNORE_SELECTOR = [
  "[data-rbd-draggable-id]",
  "[data-rbd-drag-handle-draggable-id]",
  "button",
  "input",
  "textarea",
  "select",
  "a",
  '[role="button"]',
  "[data-first-apt-time-shift]",
].join(", ");

type TimelineScrollDragState = {
  pointerId: number;
  startX: number;
  startScrollLeft: number;
};

function horizontalWheelDelta(event: WheelEvent): number | null {
  const absX = Math.abs(event.deltaX);
  const absY = Math.abs(event.deltaY);
  if (!event.shiftKey && absX <= absY) return null;

  let delta = event.shiftKey && absX <= absY ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) delta *= 16;
  if (event.deltaMode === 2) delta *= 16 * 16;
  return delta;
}

export function useSyncedTimelineScroll() {
  const [scrollLeft, setScrollLeft] = useState(0);
  const nodesRef = useRef<HTMLDivElement[]>([]);
  const isSyncingRef = useRef(false);
  const dragRef = useRef<TimelineScrollDragState | null>(null);
  const applyScrollLeftRef = useRef<(left: number) => void>(() => {});
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);

  const applyScrollLeft = useCallback((left: number) => {
    const nodes = (nodesRef.current = nodesRef.current.filter((node) => node.isConnected));
    if (nodes.length === 0) return;

    const maxScroll = nodes.reduce(
      (max, node) => Math.max(max, node.scrollWidth - node.clientWidth),
      0
    );
    if (maxScroll <= 0) return;

    const next = Math.max(0, Math.min(maxScroll, left));
    isSyncingRef.current = true;
    for (const node of nodes) {
      if (node.scrollLeft !== next) node.scrollLeft = next;
    }
    setScrollLeft(next);
    requestAnimationFrame(() => {
      isSyncingRef.current = false;
    });
  }, []);

  applyScrollLeftRef.current = applyScrollLeft;

  const registerScrollRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || nodesRef.current.includes(node)) return;
    nodesRef.current.push(node);
  }, []);

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    if (isSyncingRef.current) return;
    applyScrollLeft(event.currentTarget.scrollLeft);
  }, [applyScrollLeft]);

  const canStartPan = useCallback((target: EventTarget | null) => {
    const element = target instanceof HTMLElement ? target : null;
    if (!element) return false;
    return !element.closest(DEFAULT_PAN_IGNORE_SELECTOR);
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const scrollContainer = event.currentTarget;
    if (!(event.target instanceof Node) || !scrollContainer.contains(event.target)) return;
    if (event.button !== 0 || !canStartPan(event.target)) return;
    if (scrollContainer.scrollWidth <= scrollContainer.clientWidth) return;

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: scrollContainer.scrollLeft,
    };
    scrollContainer.setPointerCapture(event.pointerId);
    scrollContainer.classList.add("is-panning");
    event.preventDefault();
  }, [canStartPan]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    applyScrollLeft(dragState.startScrollLeft - (event.clientX - dragState.startX));
    event.preventDefault();
  }, [applyScrollLeft]);

  const stopPan = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;

    event.currentTarget.releasePointerCapture(event.pointerId);
    event.currentTarget.classList.remove("is-panning");
    dragRef.current = null;
  }, []);

  const setScrollRootRef = useCallback((node: HTMLDivElement | null) => {
    setScrollRoot(node);
  }, []);

  useEffect(() => {
    if (!scrollRoot) return;

    const onWheel = (event: WheelEvent) => {
      const delta = horizontalWheelDelta(event);
      if (delta == null || delta === 0) return;

      const sample = nodesRef.current.find((node) => node.isConnected);
      if (!sample || sample.scrollWidth <= sample.clientWidth) return;

      event.preventDefault();
      applyScrollLeftRef.current(sample.scrollLeft + delta);
    };

    scrollRoot.addEventListener("wheel", onWheel, { passive: false });
    return () => scrollRoot.removeEventListener("wheel", onWheel);
  }, [scrollRoot]);

  return {
    scrollLeft,
    setScrollRootRef,
    registerScrollRef,
    handleScroll,
    handlePointerDown,
    handlePointerMove,
    stopPan,
  };
}
