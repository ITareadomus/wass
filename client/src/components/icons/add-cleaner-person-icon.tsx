import { cn } from "@/lib/utils";

type Props = {
  className?: string;
};

/**
 * Omino + per "aggiungi cleaner": toni blu/azzurro distinti in light e dark
 * (allineati alla timeline `custom-blue`).
 */
export function AddCleanerPersonIcon({ className }: Props) {
  return (
    <svg
      viewBox="0 0 20 18"
      fill="none"
      className={cn("size-4 shrink-0", className)}
      aria-hidden
    >
      <circle
        cx="7.25"
        cy="5.75"
        r="2.35"
        className="fill-[hsl(199,89%,54%)] dark:fill-[hsl(217,91%,62%)]"
      />
      <path
        d="M2.75 15.5c0-2.45 1.95-4.45 4.5-4.45s4.5 2 4.5 4.45"
        strokeWidth="1.35"
        strokeLinecap="round"
        className="stroke-[hsl(199,89%,42%)] dark:stroke-[hsl(217,91%,72%)]"
      />
      <path
        d="M14.25 7.75v2.75M12.875 9.125h2.75"
        strokeWidth="1.35"
        strokeLinecap="round"
        className="stroke-[hsl(199,89%,36%)] dark:stroke-[hsl(217,91%,78%)]"
      />
    </svg>
  );
}
