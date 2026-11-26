export function SequenceSummaryViolationIndicator({
  className = "",
  tone = "red",
}: {
  className?: string;
  tone?: "red" | "yellow";
}) {
  const toneClass =
    tone === "yellow"
      ? "bg-amber-400 text-amber-950"
      : "bg-red-600 text-white";
  return (
    <span
      className={`pointer-events-none absolute -top-1.5 z-[37] flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none shadow-sm ring-1 ring-background ${tone === "yellow" ? "-right-1.5" : "-left-1.5"} ${toneClass} ${className}`}
      aria-hidden
      title={tone === "yellow" ? "Livello triade non corrispondente" : "Violazione timeline"}
    >
      !
    </span>
  );
}
