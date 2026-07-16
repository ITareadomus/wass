import type { ReactNode, UIEventHandler } from "react";

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
  return (
    <div
      className={`flex shrink-0 items-center leading-none px-1 ${
        labelContent ? "h-[38px]" : "h-[12px]"
      }`}
    >
      <div
        className="relative h-full flex-shrink-0 overflow-visible print:hidden"
        style={{ width: `${labelColumnWidth}px` }}
      >
        {labelContent}
      </div>
      <div
        ref={registerRef}
        onScroll={onScroll}
        className="timeline-h-scrollbar h-[12px] min-w-0 flex-1 self-center"
        aria-label="Scorri timeline orizzontalmente"
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
