export type AssignmentScope = "housekeeping" | "office" | "alg-test";

export function normalizeAssignmentScope(scope: unknown): AssignmentScope {
  const value = String(scope ?? "").trim().toLowerCase();
  if (value === "office") return "office";
  if (value === "alg-test") return "alg-test";
  return "housekeeping";
}

/** Filtro SQL sicuro: il valore arriva solo da normalizeAssignmentScope. */
export function assignmentScopeSql(scope: AssignmentScope, column = "scope"): string {
  if (scope === "office") return `${column} = 'office'`;
  if (scope === "alg-test") return `${column} = 'alg-test'`;
  return `(${column} = 'housekeeping' OR ${column} IS NULL)`;
}

/** Tabelle fisiche della prova. Non sono le tabelle della giornata ufficiale. */
export function assignmentsTableFor(scope: AssignmentScope): "alg_test_assignments" | "daily_assignments_current" {
  return scope === "alg-test" ? "alg_test_assignments" : "daily_assignments_current";
}

export function containersTableFor(scope: AssignmentScope): "alg_test_containers" | "daily_containers" {
  return scope === "alg-test" ? "alg_test_containers" : "daily_containers";
}

export function selectedCleanersTableFor(scope: AssignmentScope): "alg_test_selected_cleaners" | "daily_selected_cleaners" {
  return scope === "alg-test" ? "alg_test_selected_cleaners" : "daily_selected_cleaners";
}

export function isAlgTestPath(pathname: string): boolean {
  return pathname === "/alg-test" || pathname.startsWith("/alg-test/");
}

export function assignmentScopeFromWindow(): AssignmentScope {
  if (typeof globalThis === "undefined" || !("window" in globalThis)) return "housekeeping";
  const win = (globalThis as { window?: { location?: { pathname?: string; search?: string }; localStorage?: { getItem(key: string): string | null } } }).window;
  if (!win?.location) return "housekeeping";
  if (isAlgTestPath(win.location.pathname || "")) return "alg-test";
  const params = new URLSearchParams(win.location.search || "");
  if (params.get("scope") === "office" || params.get("kind") === "office") return "office";
  if (win.localStorage?.getItem("assignments_scope") === "office") return "office";
  return "housekeeping";
}

export function assignmentScopeFromLocation(pathname: string, search = ""): AssignmentScope {
  if (isAlgTestPath(pathname)) return "alg-test";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("scope") === "alg-test") return "alg-test";
  if (
    params.get("scope") === "office" ||
    params.get("kind") === "office"
  ) {
    return "office";
  }
  return "housekeeping";
}
