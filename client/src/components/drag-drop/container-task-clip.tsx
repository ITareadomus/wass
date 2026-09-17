import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface ContainerTaskClipProps {
  children: ReactNode;
  className?: string;
}

const CLIP_OVERFLOW_PX = 20;

/** Taglia solo le task più larghe della colonna; le altre restano intere e vanno a capo. */
export function ContainerTaskClip({ children, className }: ContainerTaskClipProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const [isClipped, setIsClipped] = useState(false);

  useEffect(() => {
    const outer = outerRef.current;
    const clip = clipRef.current;
    if (!outer || !clip) return;

    const columnFor = (node: HTMLElement) =>
      node.closest<HTMLElement>('[data-testid^="priority-column-"]') ??
      node.parentElement;

    const update = () => {
      const column = columnFor(outer);
      const available = column?.clientWidth ?? 0;
      const surface = clip.querySelector<HTMLElement>(
        '[data-dnd-task-card-surface="true"]'
      );
      const contentWidth = surface
        ? Math.max(surface.scrollWidth, surface.offsetWidth)
        : clip.scrollWidth;
      const nextClipped =
        available > 0 && contentWidth - available > CLIP_OVERFLOW_PX;

      if (nextClipped) {
        const nextMaxWidth = `${available}px`;
        if (outer.style.maxWidth !== nextMaxWidth) {
          outer.style.maxWidth = nextMaxWidth;
        }
        if (outer.style.minWidth !== "0px") {
          outer.style.minWidth = "0px";
        }
      } else {
        if (outer.style.maxWidth) outer.style.maxWidth = "";
        if (outer.style.minWidth) outer.style.minWidth = "";
      }

      setIsClipped((prev) => (prev === nextClipped ? prev : nextClipped));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(clip);
    observer.observe(outer);
    const column = columnFor(outer);
    if (column) observer.observe(column);
    return () => observer.disconnect();
  }, [children]);

  return (
    <div
      ref={outerRef}
      className={cn(
        "flex w-max items-center",
        isClipped ? "min-w-0 max-w-full" : "shrink-0",
        className
      )}
      title={isClipped ? "Task più lungo dello spazio disponibile nel container" : undefined}
    >
      <div
        ref={clipRef}
        // Symmetric gutter (margin cancels padding) so corner badges at -top/-left/-right
        // are not clipped by overflow-hidden, without shifting the card in the layout.
        // When clipped, skip -mr-2 so the card does not cover the chevron slot.
        className={cn(
          "relative -ml-2 -mt-2 overflow-hidden pl-2 pr-2 pt-2",
          isClipped ? "min-w-0 max-w-full flex-1" : "-mr-2"
        )}
      >
        {children}
        {isClipped && (
          <div
            className="pointer-events-none absolute top-2 right-0 bottom-0 w-4 bg-gradient-to-l from-custom-blue-light to-transparent"
            aria-hidden
          />
        )}
      </div>
      {isClipped && (
        <span
          className="flex h-10 w-5 shrink-0 items-center justify-center self-end text-custom-blue"
          aria-hidden
        >
          <ChevronRight className="h-3.5 w-3.5" strokeWidth={2.5} />
        </span>
      )}
    </div>
  );
}
