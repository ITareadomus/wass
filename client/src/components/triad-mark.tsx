import { useId } from "react";
import { cn } from "@/lib/utils";

/** Livello Triade del cleaner, come arriva da ADAM (app_users.triade_level_id). */
export type CleanerTriadeLevel = {
  level_id?: number;
  name?: string;
  weight?: number;
  color?: string;
  color_bg?: string | null;
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

function readHex(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return HEX.test(text) ? text.toUpperCase() : null;
}

function mixHex(from: string, to: string, amount: number): string {
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(from);
  const [br, bg, bb] = parse(to);
  const channel = (a: number, b: number) => Math.round(a + (b - a) * amount);
  return `#${[channel(ar, br), channel(ag, bg), channel(ab, bb)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

export function parseCleanerTriade(value: unknown): {
  name: string;
  weight: number;
  color: string;
  colorBg: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const row = value as CleanerTriadeLevel & { colorBg?: string | null };
  const weight = Number(row.weight);
  const color = readHex(row.color);
  const name = String(row.name ?? "").trim();
  if (!Number.isFinite(weight) || weight < 1 || !color || !name) return null;
  const colorBg = readHex(row.color_bg) ?? readHex(row.colorBg) ?? mixHex("#FFFFFF", color, 0.82);
  return {
    name,
    weight: Math.min(6, Math.floor(weight)),
    color,
    colorBg,
  };
}

function diamondColors(level: { color: string; colorBg: string }) {
  return {
    light: level.colorBg,
    mid: mixHex(level.colorBg, level.color, 0.45),
    dark: level.color,
    stroke: level.color,
  };
}

function Diamond({
  gradientId,
  colors,
  className,
  faded = false,
  sign,
  strokeColor,
  fillColor,
  signColor,
  opacity,
}: {
  gradientId: string;
  colors: { light: string; mid: string; dark: string; stroke: string };
  className?: string;
  faded?: boolean;
  sign?: "+" | "-";
  strokeColor?: string;
  fillColor?: string;
  signColor?: string;
  opacity?: number;
}) {
  return (
    <svg viewBox="0 0 10 12" className={cn("shrink-0", className)} style={opacity != null ? { opacity } : undefined} aria-hidden>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={colors.light} />
          <stop offset="46%" stopColor={colors.mid} />
          <stop offset="100%" stopColor={colors.dark} />
        </linearGradient>
      </defs>
      <path
        d="M5 0.6 L9.25 6 L5 11.4 L0.75 6 Z"
        fill={fillColor ?? `url(#${gradientId})`}
        fillOpacity={fillColor ? 1 : faded ? 0.4 : 1}
        stroke={strokeColor ?? colors.stroke}
        strokeOpacity={strokeColor ? 1 : faded ? 0.85 : 1}
        strokeWidth={strokeColor ? "0.9" : faded ? "0.7" : "0.55"}
        strokeLinejoin="round"
        strokeDasharray={faded ? "1.15 0.75" : undefined}
      />
      {sign ? (
        <text
          x="5"
          y="8.15"
          textAnchor="middle"
          fontSize="6.2"
          fontWeight="700"
          fill={signColor ?? strokeColor ?? colors.dark}
          fontFamily="ui-sans-serif, system-ui, sans-serif"
        >
          {sign}
        </text>
      ) : null}
    </svg>
  );
}

function EmptyDiamond({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 12" className={cn("shrink-0", className)} aria-hidden>
      <path
        d="M5 0.6 L9.25 6 L5 11.4 L0.75 6 Z"
        fill="#F8F9FB"
        stroke="#C5CAD3"
        strokeWidth="0.55"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TriadDiamondRow({
  level,
  filled,
  total,
  size = "lg",
  className,
}: {
  level: { color: string; colorBg: string } | null;
  filled: number;
  total: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const dim =
    size === "sm" ? "h-[11px] w-[9px]" : size === "lg" ? "h-10 w-8" : "h-3.5 w-[11px]";
  const colors = level ? diamondColors(level) : null;
  return (
    <span className={cn("inline-flex items-center", size === "lg" ? "gap-1" : "gap-px", className)}>
      {Array.from({ length: total }, (_, index) =>
        index < filled && colors ? (
          <Diamond
            key={index}
            gradientId={`triad-pick-${reactId}-${index}`}
            colors={colors}
            className={dim}
          />
        ) : (
          <EmptyDiamond key={index} className={dim} />
        )
      )}
    </span>
  );
}

const UNKNOWN_LABEL = "Livello Triade non determinato";

function UnknownTriadDiamond({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 12" className={cn("shrink-0", className)} aria-hidden>
      <path
        d="M5 0.6 L9.25 6 L5 11.4 L0.75 6 Z"
        fill="#F3F4F6"
        stroke="#4B5563"
        strokeWidth="0.55"
        strokeLinejoin="round"
      />
      <text
        x="5"
        y="8.05"
        textAnchor="middle"
        fontSize="6.4"
        fontWeight="700"
        fill="#1F2937"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        ?
      </text>
    </svg>
  );
}

export function TaskTriadMark({
  triade,
  size = "md",
  className,
}: {
  /** undefined = ancora in caricamento; null = livello non determinabile. */
  triade?: CleanerTriadeLevel | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  if (triade === undefined) return null;
  const level = parseCleanerTriade(triade);
  const dim =
    size === "sm" ? "h-[11px] w-[9px]" : size === "lg" ? "h-10 w-8" : "h-3.5 w-[11px]";
  if (!level) {
    return (
      <span
        className={cn("inline-flex shrink-0", className)}
        title={UNKNOWN_LABEL}
        aria-label={UNKNOWN_LABEL}
      >
        <UnknownTriadDiamond className={dim} />
      </span>
    );
  }
  return <CleanerTriadMark triade={triade} size={size} className={className} />;
}

export function CleanerTriadMark({
  triade,
  size = "md",
  className,
}: {
  triade?: CleanerTriadeLevel | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const level = parseCleanerTriade(triade);
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  if (!level) return null;

  const dim =
    size === "sm" ? "h-[11px] w-[9px]" : size === "lg" ? "h-10 w-8" : "h-3.5 w-[11px]";
  const colors = {
    light: level.colorBg,
    mid: mixHex(level.colorBg, level.color, 0.45),
    dark: level.color,
    stroke: level.color,
  };

  return (
    <span
      className={cn(
        "inline-flex items-center shrink-0",
        size === "lg" ? "gap-1" : "gap-px",
        className
      )}
      title={level.name}
      aria-label={level.name}
    >
      {Array.from({ length: level.weight }, (_, index) => (
        <Diamond
          key={index}
          gradientId={`triad-${reactId}-${index}`}
          colors={colors}
          className={dim}
        />
      ))}
    </span>
  );
}

type DayMark = "solid" | "added" | "removed";

function dayMarks(originalWeight: number, overrideWeight: number | null): DayMark[] {
  const current = overrideWeight ?? originalWeight;
  if (current === originalWeight) {
    return Array.from({ length: originalWeight }, () => "solid");
  }
  const count = Math.max(originalWeight, current);
  return Array.from({ length: count }, (_, index) => {
    const step = index + 1;
    if (step <= Math.min(originalWeight, current)) return "solid";
    return current > originalWeight ? "added" : "removed";
  });
}

function levelForWeight(
  levels: CleanerTriadeLevel[],
  weight: number
): { name: string; weight: number; color: string; colorBg: string } | null {
  const match = levels
    .map((level) => parseCleanerTriade(level))
    .find((level) => level?.weight === weight);
  return match ?? null;
}

/** Rombi del task per la giornata. Nel dialog l'eccezione è tratteggiata; sulla card sembra il livello vero. */
export function DayTriadMark({
  original,
  overrideWeight,
  levels,
  size = "md",
  unknown = "question",
  appearance = "day",
  className,
}: {
  original?: CleanerTriadeLevel | null;
  overrideWeight: number | null;
  levels: CleanerTriadeLevel[];
  size?: "sm" | "md" | "lg";
  unknown?: "question" | "text";
  appearance?: "day" | "real";
  className?: string;
}) {
  if (original === undefined) return null;
  const base = parseCleanerTriade(original);
  const originalWeight = base?.weight ?? 0;
  const currentWeight = overrideWeight ?? originalWeight;
  if (appearance === "real") {
    if (currentWeight <= 0) {
      return <TaskTriadMark triade={null} size={size} className={className} />;
    }
    const current = levelForWeight(levels, currentWeight) ?? (currentWeight === originalWeight ? base : null);
    const shown = current
      ? { ...current, weight: currentWeight, color_bg: current.colorBg }
      : base
        ? { name: base.name, weight: currentWeight, color: base.color, color_bg: base.colorBg }
        : null;
    if (!shown) return <TaskTriadMark triade={null} size={size} className={className} />;
    return <CleanerTriadMark triade={shown} size={size} className={className} />;
  }
  const marks = dayMarks(originalWeight, overrideWeight);
  if (marks.length === 0) {
    if (unknown === "text") {
      return <span className={cn("text-sm text-foreground", className)}>Livello non impostato</span>;
    }
    return <TaskTriadMark triade={null} size={size} className={className} />;
  }

  const reactId = useId().replace(/[^a-zA-Z0-9]/g, "");
  const dim =
    size === "sm" ? "h-[11px] w-[9px]" : size === "lg" ? "h-10 w-8" : "h-3.5 w-[11px]";
  const current = levelForWeight(levels, currentWeight) ?? base;
  const title = overrideWeight != null && current
    ? `${current.name} per questa giornata`
    : base?.name ?? current?.name ?? "";

  return (
    <span
      className={cn(
        "inline-flex items-center shrink-0",
        size === "lg" ? "gap-1" : "gap-px",
        className
      )}
      title={title}
      aria-label={title}
    >
      {marks.map((mark, index) => {
        const source = mark === "added"
          ? levelForWeight(levels, currentWeight) ?? current ?? base
          : base ?? current;
        if (!source) return null;
        return (
          <Diamond
            key={index}
            gradientId={`triad-day-${reactId}-${index}`}
            colors={diamondColors(source)}
            className={dim}
            faded={mark !== "solid"}
            sign={mark === "added" ? "+" : mark === "removed" ? "-" : undefined}
            strokeColor={mark === "added" ? "#3DCF63" : mark === "removed" ? "#FF2B2B" : undefined}
            signColor={mark === "added" ? "#00E03A" : mark === "removed" ? "#FF2B2B" : undefined}
            fillColor={mark === "added" ? "#14532D" : mark === "removed" ? "#7F1D1D" : undefined}
            opacity={mark === "removed" ? 0.55 : undefined}
          />
        );
      })}
    </span>
  );
}
