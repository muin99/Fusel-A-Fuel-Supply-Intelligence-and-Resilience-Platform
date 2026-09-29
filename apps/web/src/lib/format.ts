import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export const cn = (...c: ClassValue[]) => twMerge(clsx(c));
export const liters = (n: number) => `${Math.round(n).toLocaleString()} L`;
export const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;
export const hours = (h: number | null) => (h === null ? "—" : `${h.toFixed(1)} h`);
