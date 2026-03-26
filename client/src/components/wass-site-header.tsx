import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface WassSiteHeaderProps {
  /** Contenuto a destra (es. link non confermate + ThemeToggle). */
  right: ReactNode;
  className?: string;
}

/** Altezza fissa barra header, leggermente piu ariosa e uniforme su tutte le route. */
const HEADER_BAR = "h-[3.5rem] md:h-[3.75rem]";

export function WassSiteHeader({ right, className }: WassSiteHeaderProps) {
  return (
    <header
      className={cn(
        "border-b border-border/50 bg-muted/50 dark:bg-muted/30",
        className
      )}
    >
      <div className="mx-auto flex w-full max-w-[1920px] items-stretch">
        <div
          className={cn(
            "flex w-14 shrink-0 items-center justify-center border-r border-border/50 bg-muted/90 px-2.5 dark:bg-muted/45 md:w-[4.5rem]",
            HEADER_BAR
          )}
          data-testid="site-header-logo"
        >
          <img
            src="/AD_PREMIUM_nero.png"
            alt=""
            decoding="async"
            className="max-h-full max-w-full object-contain dark:invert"
            aria-hidden
          />
        </div>

        <div
          className={cn(
            "flex flex-1 items-center justify-between gap-3 pl-3 pr-4",
            HEADER_BAR
          )}
        >
          <span
            className="inline-block w-[53px] text-[32px] font-bold tracking-tight text-foreground"
            data-testid="site-header-title"
          >
            WASS
          </span>
          <div className="flex items-center gap-3">{right}</div>
        </div>
      </div>
    </header>
  );
}
