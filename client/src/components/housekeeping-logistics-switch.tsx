import { Building2, Truck } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import type { MouseEvent } from "react";

export type AssignmentsFlow = "housekeeping" | "office" | "logistics";

const segmentCommon =
  "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Evidenza selezione (il bordo esterno è sul wrapper, come l’input di ricerca). */
const segmentActive = "bg-custom-blue-light text-custom-blue";

const segmentInactive = "text-muted-foreground hover:text-foreground";

interface HousekeepingLogisticsSwitchProps {
  active: AssignmentsFlow;
  className?: string;
}

export function HousekeepingLogisticsSwitch({
  active,
  className,
}: HousekeepingLogisticsSwitchProps) {
  const goHousekeeping = (e: MouseEvent) => {
    e.preventDefault();
    localStorage.setItem("assignments_scope", "housekeeping");
    window.location.assign("/generate-assignments");
  };

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border-2 border-custom-blue bg-background p-0.5",
        className
      )}
      role="tablist"
      aria-label="Passa tra Housekeeping e Logistica"
    >
      <Link
        href="/generate-assignments"
        className={cn(
          segmentCommon,
          active === "housekeeping" ? segmentActive : segmentInactive
        )}
        aria-current={active === "housekeeping" ? "page" : undefined}
        data-testid="switch-housekeeping"
        onClick={goHousekeeping}
      >
        <Building2 className="h-4 w-4 shrink-0" aria-hidden />
        Housekeeping
      </Link>
      <Link
        href="/generate-logistics-assignments"
        className={cn(
          segmentCommon,
          active === "logistics" ? segmentActive : segmentInactive
        )}
        aria-current={active === "logistics" ? "page" : undefined}
        data-testid="switch-logistics"
      >
        <Truck className="h-4 w-4 shrink-0" aria-hidden />
        Logistica
      </Link>
    </div>
  );
}
