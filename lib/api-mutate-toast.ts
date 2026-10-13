import { toast } from "sonner"
import {
  apiMutate,
  type MutateOptions,
  type MutateResult,
} from "@/lib/api-mutate"

/**
 * `apiMutate` plus the toast pair almost every teacher-facing mutation shows.
 *
 * Split from `lib/api-mutate.ts` so the transport core carries no UI
 * dependency and its unit test needs no sonner stub — the same reason
 * `lib/session-state.ts` is kept apart from the server-only
 * `lib/exam-session.ts`.
 *
 * Not every call site belongs here. Anything that reports inline instead of
 * toasting (the exam runner's submit error, the file-upload viewer, the
 * registration form), rolls back optimistic state, or needs toast options
 * beyond a plain message should call `apiMutate` directly and toast itself.
 */
export interface MutateToastOptions<T> extends MutateOptions {
  /**
   * Shown on success. Omit to stay silent — several mutations navigate or
   * refresh instead, where a toast would be noise. A function receives the
   * parsed body, for messages that quote a count returned by the server.
   */
  success?: string | ((data: T) => string)
}

/**
 * Mutate, then toast: the server's `error.message` on failure (falling back
 * to `fallbackError`), and `success` if given. Returns the same
 * {@link MutateResult} as {@link apiMutate} so callers can still branch.
 */
export async function apiMutateToast<T = unknown>(
  url: string,
  options: MutateToastOptions<T>
): Promise<MutateResult<T>> {
  const { success, ...rest } = options
  const result = await apiMutate<T>(url, rest)

  if (!result.ok) {
    toast.error(result.message)
    return result
  }

  if (success !== undefined) {
    toast.success(
      typeof success === "function" ? success(result.data) : success
    )
  }
  return result
}
