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

export type ScheduleFloor = {
  /** Null se checkout e task precedente non impongono un minimo. */
  minStartMinutes: number | null;
  minEndMinutes: number | null;
};

/**
 * Il primo orario accettabile.
 * Lo start non può precedere il checkout né la fine della task precedente più lo spostamento.
 * L'end non può precedere quello start più la durata del task.
 */
export function taskScheduleFloor(input: {
  checkoutMinutes: number | null;
  previousEndMinutes: number | null;
  travelMinutes: number;
  durationMinutes: number;
}): ScheduleFloor {
  const floors: number[] = [];
  if (input.previousEndMinutes != null && Number.isFinite(input.previousEndMinutes)) {
    const travel = Number.isFinite(input.travelMinutes) ? Math.max(0, input.travelMinutes) : 0;
    floors.push(input.previousEndMinutes + travel);
  }
  if (input.checkoutMinutes != null && Number.isFinite(input.checkoutMinutes)) {
    floors.push(input.checkoutMinutes);
  }
  if (floors.length === 0) {
    return { minStartMinutes: null, minEndMinutes: null };
  }
  const minStart = Math.max(...floors);
  const duration =
    Number.isFinite(input.durationMinutes) && input.durationMinutes > 0
      ? Math.round(input.durationMinutes)
      : 1;
  const dayEnd = 23 * 60 + 59;
  const minEnd = Math.min(dayEnd, minStart + duration);
  if (minEnd <= minStart) {
    return { minStartMinutes: Math.max(0, minEnd - 1), minEndMinutes: minEnd };
  }
  return { minStartMinutes: minStart, minEndMinutes: minEnd };
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

export type ManualMoveRouteInput = {
  startMinutes: Array<number | null>;
  travelMinutes: number[];
  blockMinutes: number[];
  /** Checkout e finestra priorità: la task non parte prima di questo orario. */
  earliestMinutes: Array<number | null>;
  /** Orario fissato a mano: non torna indietro, scorre solo se la precedente lo copre. */
  pinned: boolean[];
  movedIndex: number;
  movedStartMinutes: number;
};

/**
 * Dopo lo spostamento di una task non gestita, quelle dopo senza orario manuale
 * partono appena possono: fine della precedente più spostamento, e non prima di
 * checkout o finestra priorità.
 */
export function reflowStartsAfterManualMove(input: ManualMoveRouteInput): Array<number | null> {
  const starts = input.startMinutes.map((value) => value);
  const movedIndex = input.movedIndex;
  if (movedIndex < 0 || movedIndex >= starts.length) return starts;

  let movedStart = input.movedStartMinutes;
  if (movedIndex > 0 && starts[movedIndex - 1] != null) {
    const earliest =
      (starts[movedIndex - 1] as number) +
      Math.max(0, input.blockMinutes[movedIndex - 1] ?? 0) +
      Math.max(0, input.travelMinutes[movedIndex] ?? 0);
    movedStart = Math.max(movedStart, earliest);
  }
  starts[movedIndex] = movedStart;

  for (let index = movedIndex + 1; index < starts.length; index += 1) {
    const previousStart = starts[index - 1];
    if (previousStart == null) continue;
    const arrival =
      previousStart +
      Math.max(0, input.blockMinutes[index - 1] ?? 0) +
      Math.max(0, input.travelMinutes[index] ?? 0);
    if (input.pinned[index]) {
      const current = starts[index];
      if (current == null || current < arrival) starts[index] = arrival;
      continue;
    }
    const floor = input.earliestMinutes[index];
    starts[index] = floor == null ? arrival : Math.max(arrival, floor);
  }

  return starts;
}
