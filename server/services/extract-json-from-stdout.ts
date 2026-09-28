/**
 * On Windows, OR-Tools may print native "load ...dll..." lines on stdout
 * before the JSON result. Take the last parseable JSON object from the stream.
 */
export function extractJsonObjectFromStdout<T = unknown>(stdout: string): T {
  const text = String(stdout ?? "").trim();
  if (!text) {
    throw new Error("empty stdout");
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // continue with extraction
  }

  let searchFrom = text.length;
  while (searchFrom > 0) {
    const start = text.lastIndexOf("{", searchFrom - 1);
    if (start < 0) break;
    const candidate = text.slice(start);
    try {
      return JSON.parse(candidate) as T;
    } catch {
      searchFrom = start;
    }
  }

  throw new Error(`unreadable stdout: ${text.replace(/\s+/g, " ").slice(0, 240)}`);
}
