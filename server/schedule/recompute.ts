import { zonedTimeToUtc, utcToZonedTime, format as formatTz } from 'date-fns-tz';
import { addMinutes, parse } from 'date-fns';

const TIMEZONE = 'Europe/Rome';

interface Assignment {
  taskId: string;
  logisticCode: string;
  cleanerId: number;
  sequence: number;
  cleaningTime?: number;
  address?: string;
  lat?: string | number;
  lng?: string | number;
  startTime?: string;
  endTime?: string;
  travelTime?: number;
}

/**
 * Calcola i minuti di viaggio tra due task
 * Placeholder deterministico - da sostituire con calcolo reale
 */
export function travelMinutes(prev: Assignment | null, curr: Assignment): number {
  if (!prev || !prev.lat || !prev.lng || !curr.lat || !curr.lng) {
    return 0;
  }

  // Placeholder: calcolo euristico basato su distanza euclidea
  const lat1 = Number(prev.lat);
  const lng1 = Number(prev.lng);
  const lat2 = Number(curr.lat);
  const lng2 = Number(curr.lng);

  const distance = Math.sqrt(Math.pow(lat2 - lat1, 2) + Math.pow(lng2 - lng1, 2));

  // Stima approssimativa: 1 grado ≈ 111km, velocità media 30km/h
  const estimatedMinutes = Math.round((distance * 111 * 60) / 30);

  return Math.min(estimatedMinutes, 60); // Cap a 60 minuti
}

/**
 * Ricalcola gli orari per le assegnazioni di un cleaner
 */
export async function recomputeSchedule(
  assignments: Assignment[],
  cleanerStartHHmm: string,
  date: string
): Promise<Assignment[]> {
  if (assignments.length === 0) return assignments;

  // Ordina per sequence
  const sorted = [...assignments].sort((a, b) => a.sequence - b.sequence);

  // Parse data e ora iniziale
  const dateObj = parse(date, 'yyyy-MM-dd', new Date());
  const [startHour, startMin] = cleanerStartHHmm.split(':').map(Number);
  dateObj.setHours(startHour, startMin, 0, 0);

  let currentTime = zonedTimeToUtc(dateObj, TIMEZONE);
  let prevTask: Assignment | null = null;

  const updated = sorted.map((assignment, index) => {
    // Calcola tempo di viaggio dalla task precedente
    const travel = index === 0 ? 0 : travelMinutes(prevTask, assignment);

    // Aggiungi tempo di viaggio
    currentTime = addMinutes(currentTime, travel);

    // Ora di inizio
    const zonedStart = utcToZonedTime(currentTime, TIMEZONE);
    const startTime = formatTz(zonedStart, 'HH:mm', { timeZone: TIMEZONE });

    // Calcola durata pulizia (default 60 minuti se non specificata)
    const cleaningMinutes = assignment.cleaningTime || 60;

    // Ora di fine
    currentTime = addMinutes(currentTime, cleaningMinutes);
    const zonedEnd = utcToZonedTime(currentTime, TIMEZONE);
    const endTime = formatTz(zonedEnd, 'HH:mm', { timeZone: TIMEZONE });

    prevTask = assignment;

    return {
      ...assignment,
      startTime,
      endTime,
      travelTime: travel
    };
  });

  return updated;
}

/**
 * Valida che un orario sia nel formato HH:mm
 */
export function isValidTimeFormat(time?: string): boolean {
  if (!time) return false;
  return /^\d{2}:\d{2}$/.test(time);
}

/**
 * Ricalcola gli orari di tutte le task di un cleaner in base alla sequence.
 * Ritorna un nuovo array di task con start_time, end_time e travel_time aggiornati.
 */
export async function recomputeScheduleForCleaner(
  tasks: any[],
  cleanerStartHHmm: string,
  date: string
): Promise<any[]> {
  if (!tasks || tasks.length === 0) return [];

  const sortedTasks = [...tasks].sort((a, b) => a.sequence - b.sequence);

  const dateObj = parse(date, 'yyyy-MM-dd', new Date());
  const [startHour, startMin] = cleanerStartHHmm.split(':').map(Number);
  dateObj.setHours(startHour, startMin, 0, 0);

  let currentTime = zonedTimeToUtc(dateObj, TIMEZONE);
  let prevTask: any | null = null;

  const updatedTasks = sortedTasks.map((task: any, index: number) => {
    const travel = index === 0 ? 0 : travelMinutes(prevTask, task);

    currentTime = addMinutes(currentTime, travel);

    const zonedStart = utcToZonedTime(currentTime, TIMEZONE);
    const startTime = formatTz(zonedStart, 'HH:mm', { timeZone: TIMEZONE });

    const cleaningMinutes = task.cleaningTime || 60;

    currentTime = addMinutes(currentTime, cleaningMinutes);
    const zonedEnd = utcToZonedTime(currentTime, TIMEZONE);
    const endTime = formatTz(zonedEnd, 'HH:mm', { timeZone: TIMEZONE });

    prevTask = task;

    return {
      ...task,
      startTime,
      endTime,
      travelTime: travel,
    };
  });

  return updatedTasks;
}