import { cn } from "@/lib/utils";

const BADGE_CLASS =
  "inline-flex items-center rounded border px-2.5 py-0.5 text-xs font-medium";

const ROLE_BADGE: Record<string, string> = {
  Formatore:
    "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-200 border-orange-300 dark:border-orange-700",
  Standard:
    "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700",
  Straordinario:
    "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700",
  Premium:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700",
  Ufficio:
    "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200 border-sky-300 dark:border-sky-700",
};

function roleLabel(role?: string | null) {
  const name = String(role ?? "").trim();
  return ROLE_BADGE[name] ? name : "Standard";
}

export function CleanerRoleBadge({
  role,
  className,
}: {
  role?: string | null;
  className?: string;
}) {
  const label = roleLabel(role);
  return (
    <span className={cn(BADGE_CLASS, ROLE_BADGE[label], className)}>{label}</span>
  );
}

/** Lettera sulla riga timeline: S, P o F. Standard non ha lettera. */
export function CleanerRoleLetter({ role }: { role?: string | null }) {
  if (role === "Straordinario") {
    return (
      <div className="bg-red-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
        S
      </div>
    );
  }
  if (role === "Premium") {
    return (
      <div className="bg-yellow-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
        P
      </div>
    );
  }
  if (role === "Formatore") {
    return (
      <div className="bg-orange-500 text-white dark:text-black font-bold text-[10px] px-1 py-0.5 rounded flex-shrink-0">
        F
      </div>
    );
  }
  return null;
}
