import type { CSSProperties } from "react";

export type DndInsertionIndicatorProps = {
  orientation?: "horizontal" | "vertical";
  isValid?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function DndInsertionIndicator({
  orientation = "horizontal",
  isValid = true,
  className = "",
  style,
}: DndInsertionIndicatorProps) {
  const isHorizontal = orientation === "horizontal";

  return (
    <div
      aria-hidden
      className={[
        "pointer-events-none rounded-full transition-colors duration-150",
        isValid ? "bg-sky-500 shadow-sky-500/40" : "bg-red-500 shadow-red-500/40",
        isHorizontal ? "h-12 w-0.5 shadow-[0_0_0_2px_rgba(14,165,233,0.18)]" : "h-0.5 w-full",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    />
  );
}
