import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import type { ZodError } from "zod"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.classList.contains("reduce-motion")
  )
}

/** Human-readable summary of a ZodError, for API error responses. `error.message` is raw JSON. */
export function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => issue.message).join("; ")
}
