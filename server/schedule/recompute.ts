
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
 * Converte HH:mm in minuti dal mezzanotte
 */
function timeToMinutes(time: string): number {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

/**
 * Rappresenta una collisione oraria tra task
 */
export interface OverlapInfo {
  hasOverlap: boolean;
  cleanerId?: number;
  task1?: { taskId: string; startTime: string; endTime: string };
  task2?: { taskId: string; startTime: string; endTime: string };
  message?: string;
}

/**
 * Valida che non ci siano sovrapposizioni orarie tra i task di un cleaner
 * I task devono essere già ordinati per sequence e con orari calcolati
 */
export function validateOverlap(
  tasks: Array<{ taskId: string; startTime?: string; endTime?: string }>,
  cleanerId: number
): OverlapInfo {
  if (tasks.length < 2) {
    return { hasOverlap: false };
  }

  // Filtra task con orari validi
  const validTasks = tasks.filter(t => t.startTime && t.endTime);

  for (let i = 0; i < validTasks.length - 1; i++) {
    const current = validTasks[i];
    const next = validTasks[i + 1];

    const currentEnd = timeToMinutes(current.endTime!);
    const nextStart = timeToMinutes(next.startTime!);

    // Overlap se il task corrente finisce dopo l'inizio del successivo
    if (currentEnd > nextStart) {
      return {
        hasOverlap: true,
        cleanerId,
        task1: {
          taskId: current.taskId,
          startTime: current.startTime!,
          endTime: current.endTime!
        },
        task2: {
          taskId: next.taskId,
          startTime: next.startTime!,
          endTime: next.endTime!
        },
        message: `Cleaner ${cleanerId}: task ${current.taskId} (ends ${current.endTime}) overlaps with task ${next.taskId} (starts ${next.startTime})`
      };
    }
  }

  return { hasOverlap: false };
}
