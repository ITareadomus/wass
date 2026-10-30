import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";

export const TIMELINE_HOUR_SCALE_KEY = "wass.hk.timelineHourScale";
export const TIMELINE_HOUR_SCALE_MIN = 0.5;
export const TIMELINE_HOUR_SCALE_MAX = 2;

const PREVIEW_START_MINUTES = 8 * 60;
const PREVIEW_HOURS = 5;
const PREVIEW_SPAN_MINUTES = PREVIEW_HOURS * 60;
const PREVIEW_VIEW_PX = 460;

const FAKE_TASKS = [
  { name: "1741", start: 8 * 60 + 30, minutes: 60 },
  { name: "1621", start: 10 * 60, minutes: 90 },
  { name: "1761", start: 12 * 60 + 15, minutes: 45 },
];

export function readTimelineHourScale(): number {
  try {
    const stored = localStorage.getItem(TIMELINE_HOUR_SCALE_KEY);
    // Nessuna preferenza salvata (nuovo accesso): scala automatica, non il minimo.
    // Number(null) vale 0 e verrebbe clampato a TIMELINE_HOUR_SCALE_MIN.
    if (stored == null || stored.trim() === "") return 1;
    const raw = Number(stored);
    if (!Number.isFinite(raw)) return 1;
    return clampTimelineHourScale(raw);
  } catch {
    return 1;
  }
}

export function clampTimelineHourScale(value: number): number {
  return Math.min(TIMELINE_HOUR_SCALE_MAX, Math.max(TIMELINE_HOUR_SCALE_MIN, value));
}

function ScalePreview({ scale }: { scale: number }) {
  const pxPerMinute = (PREVIEW_VIEW_PX / PREVIEW_SPAN_MINUTES) * scale;
  const contentWidth = PREVIEW_SPAN_MINUTES * pxPerMinute;

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-background">
      <div className="relative h-[92px]" style={{ width: contentWidth }}>
        {Array.from({ length: PREVIEW_HOURS + 1 }, (_, index) => {
          const left = index * 60 * pxPerMinute;
          const hour = 8 + index;
          return (
            <div key={hour} className="absolute top-0 h-full border-l border-border/70" style={{ left }}>
              <span className="absolute top-1 left-1 text-[10px] tabular-nums text-muted-foreground">
                {String(hour).padStart(2, "0")}:00
              </span>
            </div>
          );
        })}
        {FAKE_TASKS.map((task) => (
          <div
            key={task.name}
            className="absolute top-8 flex h-9 items-center overflow-hidden rounded border-2 border-custom-blue bg-custom-blue-light px-1.5 text-xs font-semibold text-custom-blue"
            style={{
              left: (task.start - PREVIEW_START_MINUTES) * pxPerMinute,
              width: Math.max(28, task.minutes * pxPerMinute),
            }}
          >
            {task.name}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TimelineScaleDialog({
  open,
  scale,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  scale: number;
  onOpenChange: (open: boolean) => void;
  onApply: (scale: number) => void;
}) {
  const [draft, setDraft] = useState(scale);

  useEffect(() => {
    if (open) setDraft(scale);
  }, [open, scale]);

  const percent = Math.round(draft * 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl" data-viewer-allow="">
        <DialogHeader>
          <DialogTitle>Scala degli orari</DialogTitle>
          <DialogDescription>
            Allarga o stringi le ore. L&apos;anteprima usa task di esempio: la timeline vera cambia solo con Applica.
          </DialogDescription>
        </DialogHeader>

        <ScalePreview scale={draft} />

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Più stretta</span>
            <span className="font-medium tabular-nums">{percent}%</span>
            <span className="text-muted-foreground">Più larga</span>
          </div>
          <Slider
            data-viewer-allow=""
            min={TIMELINE_HOUR_SCALE_MIN}
            max={TIMELINE_HOUR_SCALE_MAX}
            step={0.05}
            value={[draft]}
            onValueChange={(value) => setDraft(clampTimelineHourScale(value[0] ?? 1))}
          />
          <p className="text-xs text-muted-foreground">100% è la scala automatica della giornata.</p>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" data-viewer-allow="" onClick={() => setDraft(1)}>
            Automatica
          </Button>
          <Button type="button" variant="outline" data-viewer-allow="" onClick={() => onOpenChange(false)}>
            Annulla
          </Button>
          <Button
            type="button"
            data-viewer-allow=""
            className="border-2 border-custom-blue"
            onClick={() => onApply(clampTimelineHourScale(draft))}
          >
            Applica
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
