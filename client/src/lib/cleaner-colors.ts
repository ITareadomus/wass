// Palette di colori vibrant per i cleaner
const COLORS = [
  { bg: "bg-red-100 dark:bg-red-900", text: "text-red-700 dark:text-red-200", badge: "bg-red-500", hex: "#ef4444" },
  { bg: "bg-blue-100 dark:bg-blue-900", text: "text-blue-700 dark:text-blue-200", badge: "bg-blue-500", hex: "#3b82f6" },
  { bg: "bg-green-100 dark:bg-green-900", text: "text-green-700 dark:text-green-200", badge: "bg-green-500", hex: "#22c55e" },
  { bg: "bg-purple-100 dark:bg-purple-900", text: "text-purple-700 dark:text-purple-200", badge: "bg-purple-500", hex: "#a855f7" },
  { bg: "bg-pink-100 dark:bg-pink-900", text: "text-pink-700 dark:text-pink-200", badge: "bg-pink-500", hex: "#ec4899" },
  { bg: "bg-yellow-100 dark:bg-yellow-900", text: "text-yellow-700 dark:text-yellow-200", badge: "bg-yellow-500", hex: "#eab308" },
  { bg: "bg-indigo-100 dark:bg-indigo-900", text: "text-indigo-700 dark:text-indigo-200", badge: "bg-indigo-500", hex: "#6366f1" },
  { bg: "bg-cyan-100 dark:bg-cyan-900", text: "text-cyan-700 dark:text-cyan-200", badge: "bg-cyan-500", hex: "#06b6d4" },
  { bg: "bg-orange-100 dark:bg-orange-900", text: "text-orange-700 dark:text-orange-200", badge: "bg-orange-500", hex: "#f97316" },
  { bg: "bg-teal-100 dark:bg-teal-900", text: "text-teal-700 dark:text-teal-200", badge: "bg-teal-500", hex: "#14b8a6" },
  { bg: "bg-rose-100 dark:bg-rose-900", text: "text-rose-700 dark:text-rose-200", badge: "bg-rose-500", hex: "#f43f5e" },
  { bg: "bg-amber-100 dark:bg-amber-900", text: "text-amber-700 dark:text-amber-200", badge: "bg-amber-500", hex: "#f59e0b" },
];

export function getCleanerColor(cleanerId: number) {
  const index = cleanerId % COLORS.length;
  return COLORS[index];
}

export function getCleanerBgColor(cleanerId: number) {
  return getCleanerColor(cleanerId).bg;
}

export function getCleanerTextColor(cleanerId: number) {
  return getCleanerColor(cleanerId).text;
}

export function getCleanerBadgeColor(cleanerId: number) {
  return getCleanerColor(cleanerId).badge;
}

export function getCleanerHexColor(cleanerId: number) {
  return getCleanerColor(cleanerId).hex;
}
