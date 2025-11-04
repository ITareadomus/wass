
import * as fs from "fs/promises";
import path from "path";
import { runRemixPython } from "../../utils/runRemix";

type Task = {
  task_id: string | number;
  lat: string | number;
  lng: string | number;
  cleaning_time: number;
  checkout_time?: string | null;
  priority?: "early_out" | "high_priority" | "low_priority";
  [k: string]: any;
};

type ByCleaner = Record<string, Task[]>;

const OUTPUT_DIR = path.join(process.cwd(), "client/public/data/output");

async function readJSON<T = any>(p: string): Promise<T> {
  const s = await fs.readFile(p, "utf-8");
  return JSON.parse(s);
}

async function writeJSON(p: string, data: any) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf-8");
}

export async function buildAssignedByCleaner(): Promise<ByCleaner> {
  const timelinePath = path.join(OUTPUT_DIR, "timeline.json");
  try {
    const tl = await readJSON<any>(timelinePath);
    
    // Handle new structure with cleaners_assignments
    if (tl.cleaners_assignments && Array.isArray(tl.cleaners_assignments)) {
      const byCleaner: ByCleaner = {};
      for (const entry of tl.cleaners_assignments) {
        const cleanerId = String(entry.cleaner?.id || entry.cleaner_id);
        byCleaner[cleanerId] = entry.tasks || [];
      }
      return byCleaner;
    }
    
    // Fallback to old structure
    return tl as ByCleaner;
  } catch {
    return {};
  }
}

export async function buildLeftoversByCleaner(): Promise<ByCleaner> {
  const containersPath = path.join(OUTPUT_DIR, "containers.json");

  const out: ByCleaner = {};
  const push = (cId: string, t: Task) => (out[cId] ||= []).push(t);

  try {
    const containersData = await readJSON<any>(containersPath);
    const containers = containersData?.containers || {};

    const addFrom = (arr: any[], priority: Task["priority"]) => {
      if (!Array.isArray(arr)) return;
      for (const t of arr) {
        const tt: Task = {
          ...t,
          task_id: String((t as any).task_id ?? (t as any).id ?? (t as any).code),
          priority,
        };
        push("all", tt);
      }
    };

    addFrom(containers.early_out?.tasks || [], "early_out");
    addFrom(containers.high_priority?.tasks || [], "high_priority");
    addFrom(containers.low_priority?.tasks || [], "low_priority");
  } catch (err) {
    console.warn("Could not read containers.json for leftovers:", err);
  }

  return out;
}

export async function hasLeftoversInContainers(): Promise<boolean> {
  const containersPath = path.join(OUTPUT_DIR, "containers.json");
  
  try {
    const containersData = await readJSON<any>(containersPath);
    const containers = containersData?.containers || {};
    
    const earlyCount = containers.early_out?.tasks?.length || 0;
    const highCount = containers.high_priority?.tasks?.length || 0;
    const lowCount = containers.low_priority?.tasks?.length || 0;
    
    return (earlyCount + highCount + lowCount) > 0;
  } catch {
    return false;
  }
}

export async function writeTimelineByCleaner(timelineByCleaner: ByCleaner) {
  const timelinePath = path.join(OUTPUT_DIR, "timeline.json");
  
  // Convert back to cleaners_assignments structure
  const cleanersAssignments = Object.entries(timelineByCleaner).map(([cleanerId, tasks]) => ({
    cleaner: { id: parseInt(cleanerId) },
    tasks: tasks || []
  }));
  
  const timelineData = {
    metadata: {
      last_updated: new Date().toISOString(),
      date: new Date().toISOString().split('T')[0]
    },
    cleaners_assignments: cleanersAssignments,
    meta: {
      total_cleaners: cleanersAssignments.length,
      total_tasks: cleanersAssignments.reduce((sum, c) => sum + (c.tasks?.length || 0), 0),
      last_updated: new Date().toISOString()
    }
  };
  
  await writeJSON(timelinePath, timelineData);
}

export async function maybeRemixAfterPhase(): Promise<{ remixed: boolean; leftoversCount: number; }> {
  const leftoversExist = await hasLeftoversInContainers();
  if (!leftoversExist) {
    return { remixed: false, leftoversCount: 0 };
  }

  const assignedByCleaner = await buildAssignedByCleaner();
  const leftoversByCleaner = await buildLeftoversByCleaner();

  const leftoversCount = Object
    .values(leftoversByCleaner)
    .reduce((acc, arr) => acc + (arr?.length || 0), 0);

  if (leftoversCount === 0) {
    return { remixed: false, leftoversCount: 0 };
  }

  console.log(`🔄 Remix: ${leftoversCount} leftovers trovati, avvio remix...`);

  const payload = {
    day_start: "08:00",
    assigned_by_cleaner: assignedByCleaner,
    leftovers_by_cleaner: leftoversByCleaner,
  };

  const remixOut = await runRemixPython(payload);
  const final = remixOut?.timeline_by_cleaner || assignedByCleaner;

  await writeTimelineByCleaner(final);

  console.log(`✅ Remix completato`);

  return { remixed: true, leftoversCount };
}
