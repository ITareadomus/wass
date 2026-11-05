import { Truck } from "lucide-react";
import { cn } from "@/lib/utils";

export function DriverMark({ className }: { className?: string }) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <Truck className="h-full w-full" strokeWidth={1.5} aria-hidden />
      <svg viewBox="0 0 24 24" className="absolute inset-0 h-full w-full" aria-hidden>
        <text
          x="8"
          y="12"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="currentColor"
          fontSize="7.5"
          fontWeight="700"
        >
          A
        </text>
      </svg>
    </span>
  );
}

export function DriverKeyBadge({ className }: { className?: string }) {
  return (
    <span
      title="Chiave dell'autista"
      aria-label="Chiave dell'autista"
      className={cn(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-700 text-white",
        className
      )}
    >
      <DriverMark className="h-6 w-6" />
    </span>
  );
}
