import { findAdamWassEmployeeIdByEmail, readAdamWassAccess } from "./adam-wass-accounts";
import { pgUsersService } from "./pg-users-service";

export interface AccountAccess {
  role: string;
  betaTester: boolean;
}

export function hasBetaAccess(access: AccountAccess | null | undefined): boolean {
  if (!access) return false;
  return access.betaTester === true;
}

export async function lookupAccountAccess(username: string): Promise<AccountAccess | null> {
  const name = username.trim();
  if (!name) return null;
  const user = await pgUsersService.getUserByUsername(name);
  if (user) {
    return {
      role: String(user.role || "user"),
      betaTester: user.beta_tester === true,
    };
  }
  if (!name.includes("@")) return null;
  try {
    const employeeId = await findAdamWassEmployeeIdByEmail(name);
    if (!employeeId) return null;
    return readAdamWassAccess(employeeId);
  } catch (error) {
    console.warn("lookupAccountAccess: account ADAM non letto", error);
    return null;
  }
}
