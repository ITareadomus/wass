import { useId } from "react";
import { cn } from "@/lib/utils";

/** Livelli Triade. Il valore definitivo arriverà da ADAM; questa è solo la bozza visiva. */
export type TriadLevel = "essential" | "plus" | "signature";

const LEVELS: Record<
  TriadLevel,
  { count: 1 | 2 | 3; label: string; light: string; mid: string; dark: string; stroke: string }
> = {
  essential: {
    count: 1,
    label: "Essential",
    light: "#F3F4F6",
    mid: "#9CA3AF",
    dark: "#6B7280",
    stroke: "#4B5563",
  },
  plus: {
    count: 2,
    label: "Plus",
    light: "#E0F6FF",
    mid: "#38BDF8",
    dark: "#0284C7",
    stroke: "#0369A1",
  },
  signature: {
    count: 3,
    label: "Signature",
    light: "#FFF6C9",
    mid: "#F0C14B",
    dark: "#C48A12",
    stroke: "#8A5A08",
  },
};

/**
 * Mappatura provvisoria finché il campo Triade non è in database.
 * Standard → essential, premium → plus, straordinario e formatore → signature.
 * Ufficio resta fuori: non è un livello della triade.
 */
export function triadLevelFromCleanerRole(role: string | null | undefined): TriadLevel | null {
  const normalized = String(role ?? "").trim().toLowerCase();
  if (normalized.includes("ufficio") || normalized.includes("office")) return null;
  if (normalized.includes("straord") || normalized.includes("formatore")) return "signature";
  if (normalized.includes("premium")) return "plus";
  if (!normalized || normalized.includes("standard")) return "essential";
  return null;
}

function Diamond({
  gradientId,
  colors,
  className,
}: {
  gradientId: string;
  colors: { light: string; mid: string; dark: string; stroke: string };
  className?: string;
}) {
  return (
    <svg viewBox="0 0 10 12" className={cn("shrink-0", className)} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={colors.light} />
          <stop offset="46%" stopColor={colors.mid} />
          <stop offset="100%" stopColor={colors.dark} />
        </linearGradient>
      </defs>
      <path
        d="M5 0.6 L9.25 6 L5 11.4 L0.75 6 Z"
        fill={`url(#${gradientId})`}
        stroke={colors.stroke}
        strokeWidth="0.55"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TriadMark({
  level,
  size = "md",
  className,
}: {
  level: TriadLevel;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = LEVELS[level];
  const dim = size === "sm" ? "h-[11px] w-[9px]" : "h-3.5 w-[11px]";
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");

  return (
    <span
      className={cn("inline-flex items-center gap-px shrink-0", className)}
      title={meta.label}
      aria-label={meta.label}
    >
      {Array.from({ length: meta.count }, (_, index) => (
        <Diamond
          key={index}
          gradientId={`triad-${reactId}-${index}`}
          colors={meta}
          className={dim}
        />
      ))}
    </span>
  );
}

export function CleanerTriadMark({
  role,
  size = "md",
  className,
}: {
  role: string | null | undefined;
  size?: "sm" | "md";
  className?: string;
}) {
  const level = triadLevelFromCleanerRole(role);
  if (!level) return null;
  return <TriadMark level={level} size={size} className={className} />;
}
