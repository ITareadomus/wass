import { cn } from "@/lib/utils";
import type { SequenceSummaryGroup } from "@/lib/sequence-summary";

function HeadingDash() {
  return <span className="shrink-0 font-normal text-muted-foreground/60">-</span>;
}

interface SequenceSummaryGroupHeadingProps {
  group: SequenceSummaryGroup;
  as?: "h1" | "h4";
  className?: string;
  vehicleNameClassName?: string;
  taskCountClassName?: string;
  plateClassName?: string;
}

export function SequenceSummaryGroupHeading({
  group,
  as: Tag = "h4",
  className,
  vehicleNameClassName,
  taskCountClassName,
  plateClassName,
}: SequenceSummaryGroupHeadingProps) {
  const hasVehicleInfo = Boolean(group.vehicleName || group.vehiclePlate);

  return (
    <Tag
      className={cn(
        "inline-flex min-w-0 flex-wrap items-center gap-x-1.5 whitespace-nowrap text-sm font-semibold text-foreground",
        className
      )}
    >
      <span>{group.label}</span>
      {hasVehicleInfo && (
        <>
          <HeadingDash />
          <span className="inline-flex items-center gap-x-1 font-normal">
            {group.vehicleName && (
              <span className={cn("text-muted-foreground", vehicleNameClassName)}>
                {group.vehicleName}
              </span>
            )}
            {group.vehiclePlate && (
              <span
                className={cn(
                  "shrink-0 rounded border border-custom-blue/40 bg-background/80 px-1.5 text-[10px] font-semibold leading-4 text-custom-blue",
                  plateClassName
                )}
              >
                {group.vehiclePlate}
              </span>
            )}
          </span>
        </>
      )}
      <HeadingDash />
      <span className={cn("font-normal text-foreground", taskCountClassName)}>
        {group.tasks.length} task
      </span>
    </Tag>
  );
}
