import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Altezza utile sotto `WassSiteHeader` (h-[3.5rem] md:h-[3.75rem] + border). */
export const PAGE_BELOW_HEADER_MIN_H =
  "min-h-[calc(100dvh-3.5rem-1px)] md:min-h-[calc(100dvh-3.75rem-1px)]";

type PageViewportCenteredProps = {
  children: ReactNode;
  className?: string;
  /**
   * `viewport` — pagina quasi vuota (solo loader): usa altezza sotto header.
   * `fill` — dentro un flex parent con `flex-1 min-h-0`: centra nel riquadro rimanente.
   */
  layout?: "viewport" | "fill";
} & Omit<HTMLAttributes<HTMLDivElement>, "children">;

/**
 * Centra il contenuto in orizzontale e verticale (loader, messaggi iniziali).
 */
export function PageViewportCentered({
  children,
  className,
  layout = "viewport",
  ...rest
}: PageViewportCenteredProps) {
  return (
    <div
      className={cn(
        "flex w-full flex-col items-center justify-center px-4 py-6",
        layout === "viewport" && PAGE_BELOW_HEADER_MIN_H,
        layout === "fill" && "min-h-0 flex-1",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
