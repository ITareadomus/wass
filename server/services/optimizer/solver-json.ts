/** OR-Tools on Windows prints "load *.dll" lines before the JSON result. */
export function parseSolverJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].startsWith("{")) continue;
      try {
        return JSON.parse(lines[index]) as T;
      } catch {
        continue;
      }
    }
    throw new Error("solver output is not JSON");
  }
}
