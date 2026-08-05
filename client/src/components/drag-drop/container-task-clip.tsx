import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContainerTaskClipProps {
  children: ReactNode;
  className?: string;
}

/** Taglia le task più larghe del container e indica che il contenuto continua oltre il bordo. */
export function ContainerTaskClip({ children, className }: ContainerTaskClipProps) {
  const clipRef = useRef<HTMLDivElement>(null);
  const [isClipped, setIsClipped] = useState(false);

  useEffect(() => {
    const el = clipRef.current;
    if (!el) return;

    const update = () => {
      // Ignore tiny overhangs from borders/shadows/badges; only show the continuation
      // marker when the actual task body is wider than the available container.
      // Threshold must stay above the horizontal gutter padding below (2+2=1rem=16px),
      // otherwise cards that merely fill the column get flagged as "clipped" and the
      // chevron toggling causes a ResizeObserver feedback loop (twitching).
      setIsClipped(el.scrollWidth - el.clientWidth > 20);
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div
      className={cn("flex max-w-full min-w-0 items-center", className)}
      title={isClipped ? "Task più lungo dello spazio disponibile nel container" : undefined}
    >
      <div
        ref={clipRef}
        // Symmetric gutter (margin cancels padding) so corner badges at -top/-left/-right
        // are not clipped by overflow-hidden, without shifting the card in the layout.
        // No max-w-full here: the outer wrapper already caps width to the column, so a
        // normal card keeps its natural size (no right-edge clipping), while genuinely
        // long cards still get shrunk by the flex parent and clipped + chevron.
        className="relative -ml-2 -mr-2 -mt-2 min-w-0 overflow-hidden pl-2 pr-2 pt-2"
      >
        {children}
        {isClipped && (
          <div
            className="pointer-events-none absolute inset-y-0 right-0 w-5 bg-gradient-to-l from-custom-blue-light to-transparent"
            aria-hidden
          />
        )}
      </div>
      {isClipped && (
        <span
          className="ml-0.5 flex shrink-0 items-center self-center text-custom-blue/80"
          aria-hidden
        >
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}
