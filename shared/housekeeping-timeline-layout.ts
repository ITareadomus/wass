export type HousekeepingTimelineSlot = {
  initialOffsetMinutes: number;
  travelMinutes: number;
  /** Positive: idle before the task. Negative: pull the task back onto its start time. */
  alignGapMinutes: number;
  nextCursorMinutes: number;
};

/** Same "H.MM" duration label the timeline card turns into a width. */
export function parseHousekeepingDurationLabel(duration?: string | number | null): number {
  if (duration === undefined || duration === null) return 0;
  if (typeof duration === "number") return Number.isFinite(duration) ? duration : 0;

  const [hoursPart = "0", minutesPart = "0"] = String(duration).split(".");
  const hours = Number.parseInt(hoursPart, 10);
  const minutes = Number.parseInt(minutesPart, 10);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

/** Minutes actually occupied by the card, including the minimum pixel width. */
export function renderedHousekeepingCardMinutes(
  duration: string | number | null | undefined,
  pxPerMinute: number,
  minWidthPx: number,
): number {
  const nominal = parseHousekeepingDurationLabel(duration);
  const effective = nominal <= 0 ? 60 : nominal;
  if (!(pxPerMinute > 0) || !(minWidthPx > 0)) return effective;
  return Math.max(effective, minWidthPx / pxPerMinute);
}

/**
 * Place a housekeeping bar so its left edge is the task start time.
 * The idle before a later task is whatever remains after the previous card and the travel,
 * not the gap implied by the previous end_time.
 */
export function layoutHousekeepingTimelineTask(args: {
  isFirst: boolean;
  gridStartMinutes: number;
  cursorMinutes: number;
  startMinutes: number | null;
  fallbackStartMinutes: number | null;
  travelMinutes: number;
  cardMinutes: number;
}): HousekeepingTimelineSlot {
  const cardMinutes = Math.max(0, args.cardMinutes);

  if (args.isFirst) {
    const start = args.startMinutes ?? args.fallbackStartMinutes ?? args.gridStartMinutes;
    const initialOffsetMinutes = Math.max(0, start - args.gridStartMinutes);
    const visualStart = args.gridStartMinutes + initialOffsetMinutes;
    return {
      initialOffsetMinutes,
      travelMinutes: 0,
      alignGapMinutes: 0,
      nextCursorMinutes: visualStart + cardMinutes,
    };
  }

  const travelMinutes = Math.max(0, args.travelMinutes);
  if (args.startMinutes == null) {
    return {
      initialOffsetMinutes: 0,
      travelMinutes,
      alignGapMinutes: 0,
      nextCursorMinutes: args.cursorMinutes + travelMinutes + cardMinutes,
    };
  }

  return {
    initialOffsetMinutes: 0,
    travelMinutes,
    alignGapMinutes: args.startMinutes - args.cursorMinutes - travelMinutes,
    nextCursorMinutes: args.startMinutes + cardMinutes,
  };
}
