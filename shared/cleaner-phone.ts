export function normalizeCleanerPhone(value: unknown): string | null {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  return raw || null;
}

export function pickCleanerPhone(row: { mobile?: unknown; phone?: unknown }): string | null {
  return normalizeCleanerPhone(row.mobile) ?? normalizeCleanerPhone(row.phone);
}
