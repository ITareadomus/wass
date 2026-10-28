/** Ruoli account applicativi (localStorage `user.role`). */
export type AppUserRole = "admin" | "user" | "viewer" | "logistica";

export const LOGISTICS_HOME_PATH = "/generate-logistics-assignments";

export function getStoredUser(): { username?: string; role?: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("user");
    if (!raw) return null;
    return JSON.parse(raw) as { username?: string; role?: string };
  } catch {
    return null;
  }
}

export function getStoredUserRole(): string | null {
  return getStoredUser()?.role ?? null;
}

export function isLogisticaRole(role?: string | null): boolean {
  return String(role ?? "").toLowerCase() === "logistica";
}

export function isViewerRole(role?: string | null): boolean {
  return String(role ?? "").toLowerCase() === "viewer";
}

function pathWithoutQuery(pathname: string): string {
  const query = pathname.search(/[?#]/);
  return query >= 0 ? pathname.slice(0, query) : pathname;
}

/** True se l'utente logistica può restare su path+search correnti. */
export function isLogisticaPathAllowed(pathname: string, search = ""): boolean {
  const path = pathWithoutQuery(pathname);
  if (
    path === LOGISTICS_HOME_PATH ||
    path.startsWith(`${LOGISTICS_HOME_PATH}/`)
  ) {
    return true;
  }

  if (
    path === "/keys" ||
    path === "/registro-chiavi" ||
    path === "/chiavi-smarrite" ||
    path === "/chiavi-non-restituite"
  ) {
    return true;
  }

  if (path === "/convocazioni") {
    const embedded = pathname.includes("?") ? pathname.slice(pathname.indexOf("?") + 1).split("#")[0] : "";
    const extra = search.startsWith("?") ? search.slice(1) : search;
    const params = new URLSearchParams(embedded || extra);
    return params.get("kind") === "drivers";
  }

  return false;
}

export function homePathForRole(role?: string | null): string {
  return isLogisticaRole(role) ? LOGISTICS_HOME_PATH : "/generate-assignments";
}
