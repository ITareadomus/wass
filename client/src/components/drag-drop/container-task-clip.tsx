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
      setIsClipped(el.scrollWidth > el.clientWidth + 1);
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
      <div ref={clipRef} className="relative min-w-0 max-w-full overflow-hidden">
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
