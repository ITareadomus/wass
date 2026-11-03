export function taskBlockMinutes(
  startMinutes: number | null,
  endMinutes: number | null,
  cleaningMinutes?: number | null,
): number {
  if (startMinutes != null && endMinutes != null && endMinutes > startMinutes) {
    return endMinutes - startMinutes;
  }
  if (cleaningMinutes != null && Number.isFinite(cleaningMinutes) && cleaningMinutes > 0) {
    return cleaningMinutes;
  }
  return 0;
}

export function minutesToScheduleClock(totalMinutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(totalMinutes)));
  const hours = Math.floor(clamped / 60);
  const minutes = clamped % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export type ShiftedRouteInput = {
  startMinutes: Array<number | null>;
  travelMinutes: number[];
  blockMinutes: number[];
  movedIndex: number;
  movedStartMinutes: number;
  /**
   * Primo appartamento gestito: tutta la coda scorre dello stesso scarto.
   * Poi si chiude comunque ogni buco negativo.
   */
  cascade: boolean;
};

/**
 * Sposta lo start di una task senza far finire la sua barra sopra un'altra.
 * La task non può entrare in quella precedente. Quelle dopo scorrono in avanti
 * se resterebbero coperte.
 */
export function shiftedRouteStarts(input: ShiftedRouteInput): Array<number | null> {
  const starts = input.startMinutes.map((value) => value);
  const movedIndex = input.movedIndex;
  if (movedIndex < 0 || movedIndex >= starts.length) return starts;

  const original = starts[movedIndex];
  let movedStart = input.movedStartMinutes;
  if (movedIndex > 0 && starts[movedIndex - 1] != null) {
    const earliest =
      (starts[movedIndex - 1] as number) +
      Math.max(0, input.blockMinutes[movedIndex - 1] ?? 0) +
      Math.max(0, input.travelMinutes[movedIndex] ?? 0);
    movedStart = Math.max(movedStart, earliest);
  }
  starts[movedIndex] = movedStart;

  if (input.cascade && original != null) {
    const delta = movedStart - original;
    for (let index = movedIndex + 1; index < starts.length; index += 1) {
      if (starts[index] != null) starts[index] = (starts[index] as number) + delta;
    }
  }

  for (let index = Math.max(movedIndex, 0) + 1; index < starts.length; index += 1) {
    const previousStart = starts[index - 1];
    if (previousStart == null || starts[index] == null) continue;
    const earliest =
      previousStart +
      Math.max(0, input.blockMinutes[index - 1] ?? 0) +
      Math.max(0, input.travelMinutes[index] ?? 0);
    if ((starts[index] as number) < earliest) starts[index] = earliest;
  }

  return starts;
}
