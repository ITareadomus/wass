import { Building2, Truck } from "lucide-react";
import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { type MouseEvent } from "react";
import { getStoredUserRole, isLogisticaRole } from "@/lib/auth-role";

export type AssignmentsFlow = "housekeeping" | "office" | "logistics";

const segmentCommon =
  "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Evidenza selezione (il bordo esterno è sul wrapper, come l’input di ricerca). */
const segmentActive = "bg-custom-blue-light text-custom-blue";

const segmentInactive = "text-muted-foreground hover:text-foreground";

interface HousekeepingLogisticsSwitchProps {
  active: AssignmentsFlow;
  className?: string;
  workDate?: string | null;
}

export function HousekeepingLogisticsSwitch({
  active,
  className,
  workDate,
}: HousekeepingLogisticsSwitchProps) {
  const logisticsOnly = isLogisticaRole(getStoredUserRole());
  const date =
    workDate ||
    (typeof window !== "undefined" ? localStorage.getItem("selected_work_date") : null);
  const unconfirmedHref = date ? `/unconfirmed-tasks?date=${date}` : "/unconfirmed-tasks";

  const goHousekeeping = (e: MouseEvent) => {
    e.preventDefault();
    if (logisticsOnly) return;
    localStorage.setItem("assignments_scope", "housekeeping");
    window.location.assign("/generate-assignments");
  };

  if (logisticsOnly) {
    return (
      <div
        className={cn(
          "inline-flex items-center gap-0.5 rounded-md border-2 border-custom-blue bg-background p-0.5",
          className
        )}
        role="tablist"
        aria-label="Ambito Logistica"
      >
        <span
          className={cn(segmentCommon, segmentActive)}
          aria-current="page"
          data-testid="switch-logistics"
        >
          <Truck className="h-4 w-4 shrink-0" aria-hidden />
          Logistica
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border-2 border-custom-blue bg-background p-0.5",
        className
      )}
      role="tablist"
      aria-label="Passa tra Housekeeping e Logistica"
    >
      <div className="group/hk relative">
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
        <div className="pointer-events-none absolute bottom-full right-0 z-30 pb-1 opacity-0 transition-opacity group-hover/hk:pointer-events-auto group-hover/hk:opacity-100 group-focus-within/hk:pointer-events-auto group-focus-within/hk:opacity-100">
          <Link
            href={unconfirmedHref}
            data-testid="link-unconfirmed-tasks-hover"
            data-viewer-allow=""
            className="inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-md border-2 border-custom-blue bg-background px-2 py-1 text-xs font-medium text-custom-blue transition-colors hover:bg-custom-blue hover:text-white"
          >
            Tipologie Non-Migrate
          </Link>
        </div>
      </div>
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
