export function SequenceSummaryViolationIndicator({ className = "" }: { className?: string }) {
  return (
    <span
      className={`pointer-events-none absolute -left-1.5 -top-1.5 z-[70] flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold leading-none text-white shadow-sm ring-1 ring-background ${className}`}
      aria-hidden
      title="Violazione timeline"
    >
      !
    </span>
  );
}
