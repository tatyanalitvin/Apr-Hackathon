import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class strings safely. Use for all conditional className logic. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
