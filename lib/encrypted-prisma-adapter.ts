import { prismaAdapter } from "better-auth/adapters/prisma"
import type {
  BetterAuthOptions,
  DBAdapter,
  DBTransactionAdapter,
  JoinOption,
  Where,
} from "better-auth"
import { decryptSecret, encryptSecret } from "@/lib/at-rest-encryption"

type PrismaAdapterFactory = ReturnType<typeof prismaAdapter>

/**
 * Fields better-auth's OAuth plugins persist that are bearer credentials for
 * the user's *external* identity (Microsoft 365) and must not sit in the
 * database in plaintext. Encrypted at rest with AES-256-GCM
 * (lib/at-rest-encryption.ts); a database dump no longer yields usable
 * refresh tokens.
 */
export const TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const

function encryptTokens(data: Record<string, unknown>): Record<string, unknown> {
  for (const field of TOKEN_FIELDS) {
    const value = data[field]
    if (typeof value === "string" && value !== "") {
      data[field] = encryptSecret(value)
    }
  }
  return data
}

function decryptTokens(row: Record<string, unknown>): Record<string, unknown> {
  for (const field of TOKEN_FIELDS) {
    const value = row[field]
    if (typeof value === "string" && value !== "") {
      row[field] = decryptSecret(value)
    }
  }
  return row
}

const maybeEncrypt = (model: string, write: Record<string, unknown>) =>
  model === "account" ? encryptTokens(write) : write

/**
 * Wraps an adapter instance so the `account` model's token columns are
 * encrypted on write and decrypted on read. Everything else passes through
 * untouched. Legacy plaintext values (rows written before this wrapper
 * existed) read back unchanged; the next OAuth refresh rewrites them
 * encrypted.
 *
 * Applied to BOTH the top-level adapter and the transaction adapter handed
 * to `transaction(callback)` callbacks: better-auth runs `createOAuthUser`
 * (the first sign-in of a new OAuth user) inside `adapter.transaction`, and
 * the stock "as-is" transaction passes the callback the raw, unwrapped
 * adapter — without re-wrapping it, that first sign-in would write the
 * Microsoft tokens in plaintext.
 */
function wrapAdapter(
  base: DBAdapter<BetterAuthOptions>
): DBAdapter<BetterAuthOptions> {
  return {
    ...base,
    create: async <T extends Record<string, unknown>, R = T>(args: {
      model: string
      data: Omit<T, "id">
      select?: string[]
      forceAllowId?: boolean
    }): Promise<R> => {
      const { model, data, ...rest } = args
      return base.create<T, R>({
        model,
        data: maybeEncrypt(model, data as Record<string, unknown>) as Omit<
          T,
          "id"
        >,
        ...rest,
      })
    },
    update: async <T>(args: {
      model: string
      where: Where[]
      update: Record<string, unknown>
    }): Promise<T | null> => {
      const { model, update, ...rest } = args
      return base.update<T>({
        model,
        where: rest.where,
        update: maybeEncrypt(model, update),
      })
    },
    updateMany: async (args: {
      model: string
      where: Where[]
      update: Record<string, unknown>
    }): Promise<number> => {
      return base.updateMany({
        model: args.model,
        where: args.where,
        update: maybeEncrypt(args.model, args.update),
      })
    },
    findOne: async <T>(args: {
      model: string
      where: Where[]
      select?: string[]
      join?: JoinOption
    }): Promise<T | null> => {
      const row = await base.findOne<T>(args)
      if (args.model !== "account" || !row) return row as T | null
      return decryptTokens(row as Record<string, unknown>) as T
    },
    // 1.7's atomic primitives return the affected row, so the account
    // model's token columns need the same decryption on the way out (and,
    // for incrementOne's absolute `set` map, encryption on the way in).
    // Neither is used against `account` today; wrapping them keeps the
    // encryption boundary a property of the model, not of the call site.
    consumeOne: async <T>(args: {
      model: string
      where: Where[]
    }): Promise<T | null> => {
      const row = await base.consumeOne<T>(args)
      if (args.model !== "account" || !row) return row as T | null
      return decryptTokens(row as Record<string, unknown>) as T
    },
    incrementOne: async <T>(args: {
      model: string
      where: Where[]
      increment: Record<string, number>
      set?: Record<string, unknown>
    }): Promise<T | null> => {
      const row = await base.incrementOne<T>({
        ...args,
        set: args.set ? maybeEncrypt(args.model, args.set) : args.set,
      })
      if (args.model !== "account" || !row) return row as T | null
      return decryptTokens(row as Record<string, unknown>) as T
    },
    findMany: async <T>(args: {
      model: string
      where?: Where[]
      limit?: number
      select?: string[]
      sortBy?: { field: string; direction: "asc" | "desc" }
      offset?: number
      join?: JoinOption
    }): Promise<T[]> => {
      const rows = await base.findMany<T>(args)
      if (args.model !== "account") return rows
      return rows.map(
        (row) => decryptTokens(row as Record<string, unknown>) as T
      )
    },
  }
}

/**
 * prismaAdapter wrapped with {@link wrapAdapter}. The returned factory also
 * re-wraps the transaction adapter so writes inside `adapter.transaction`
 * (notably better-auth's `createOAuthUser`) are encrypted too.
 */
export function encryptedPrismaAdapter(
  prisma: Parameters<typeof prismaAdapter>[0],
  config: Parameters<typeof prismaAdapter>[1]
): PrismaAdapterFactory {
  const baseFactory = prismaAdapter(prisma, config)
  return (options: BetterAuthOptions): DBAdapter<BetterAuthOptions> => {
    const base = baseFactory(options)
    const wrapped = wrapAdapter(base)

    return {
      ...wrapped,
      transaction:
        typeof base.transaction === "function"
          ? <R>(
              callback: (
                trx: DBTransactionAdapter<BetterAuthOptions>
              ) => Promise<R>
            ): Promise<R> =>
              (
                base.transaction as <R2>(
                  cb: (
                    trx: DBTransactionAdapter<BetterAuthOptions>
                  ) => Promise<R2>
                ) => Promise<R2>
              )((trx) =>
                callback(
                  wrapAdapter(
                    trx as unknown as DBAdapter<BetterAuthOptions>
                  ) as unknown as DBTransactionAdapter<BetterAuthOptions>
                )
              )
          : base.transaction,
    }
  }
}
