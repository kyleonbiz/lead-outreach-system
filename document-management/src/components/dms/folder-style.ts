import type { FolderColor } from "@/lib/dms/types";

/** Pastel tile + icon + hover-ring colours per folder colour. */
export const FOLDER_STYLES: Record<FolderColor, { tile: string; icon: string; ring: string; dot: string }> = {
  violet: { tile: "bg-violet-100", icon: "text-violet-500", ring: "ring-violet-300", dot: "bg-violet-400" },
  blue: { tile: "bg-blue-100", icon: "text-blue-500", ring: "ring-blue-300", dot: "bg-blue-400" },
  emerald: { tile: "bg-emerald-100", icon: "text-emerald-600", ring: "ring-emerald-300", dot: "bg-emerald-400" },
  amber: { tile: "bg-amber-100", icon: "text-amber-600", ring: "ring-amber-300", dot: "bg-amber-400" },
  rose: { tile: "bg-rose-100", icon: "text-rose-500", ring: "ring-rose-300", dot: "bg-rose-400" },
  sky: { tile: "bg-sky-100", icon: "text-sky-500", ring: "ring-sky-300", dot: "bg-sky-400" },
  orange: { tile: "bg-orange-100", icon: "text-orange-500", ring: "ring-orange-300", dot: "bg-orange-400" },
  slate: { tile: "bg-slate-100", icon: "text-slate-500", ring: "ring-slate-300", dot: "bg-slate-400" },
};
