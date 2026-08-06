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

/** True se l'utente logistica può restare su path+search correnti. */
export function isLogisticaPathAllowed(pathname: string, search = ""): boolean {
  if (
    pathname === LOGISTICS_HOME_PATH ||
    pathname.startsWith(`${LOGISTICS_HOME_PATH}/`)
  ) {
    return true;
  }

  if (pathname === "/convocazioni") {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    return params.get("kind") === "drivers";
  }

  return false;
}

export function homePathForRole(role?: string | null): string {
  return isLogisticaRole(role) ? LOGISTICS_HOME_PATH : "/generate-assignments";
}
