import { useCallback, useEffect, useRef, useState, type ReactNode, type UIEventHandler } from "react";

type TimelineHorizontalScrollbarProps = {
  labelColumnWidth: number;
  contentWidth: string | number;
  registerRef: (node: HTMLDivElement | null) => void;
  onScroll: UIEventHandler<HTMLDivElement>;
  /** Contenuto nella colonna sinistra (es. pulsante +), allineato alla scrollbar. */
  labelContent?: ReactNode;
};

/** Barra di scroll orizzontale allineata alla colonna timeline (sincronizzata via registerRef). */
export function TimelineHorizontalScrollbar({
  labelColumnWidth,
  contentWidth,
  registerRef,
  onScroll,
  labelContent,
}: TimelineHorizontalScrollbarProps) {
  const scrollNodeRef = useRef<HTMLDivElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const assignRef = useCallback(
    (node: HTMLDivElement | null) => {
      scrollNodeRef.current = node;
      registerRef(node);
    },
    [registerRef]
  );

  useEffect(() => {
    const el = scrollNodeRef.current;
    if (!el) return;

    const update = () => {
      if (el.clientWidth === 0) return;
      setIsOverflowing(el.scrollWidth > el.clientWidth + 1);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    const inner = el.firstElementChild;
    if (inner) observer.observe(inner);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [contentWidth, labelColumnWidth]);

  const collapseRow = !labelContent && !isOverflowing;
  const showTrack = isOverflowing;

  return (
    <div
      className={`flex shrink-0 items-center leading-none px-1 ${
        labelContent ? "h-[38px]" : showTrack ? "h-[12px]" : "h-0 overflow-hidden"
      }`}
    >
      <div
        className="relative h-full flex-shrink-0 overflow-visible print:hidden"
        style={{ width: `${labelColumnWidth}px` }}
      >
        {labelContent}
      </div>
      <div
        ref={assignRef}
        onScroll={onScroll}
        className="timeline-h-scrollbar min-w-0 flex-1 self-center"
        style={{
          height: 12,
          overflowX: showTrack ? "auto" : "hidden",
        }}
        aria-hidden={!showTrack}
        aria-label={showTrack ? "Scorri timeline orizzontalmente" : undefined}
      >
        <div
          style={{ width: contentWidth, minWidth: "100%", height: 1 }}
          aria-hidden
        />
      </div>
      <div className="h-full w-20 flex-shrink-0" aria-hidden />
    </div>
  );
}

export default TimelineHorizontalScrollbar;
