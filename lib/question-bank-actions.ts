import { prisma } from "@/lib/prisma"
import type { Prisma } from "@/generated/prisma/client"

export interface BankItemInput {
  type: string
  title: string
  points: number
  required: boolean
  config: unknown
}

/**
 * Returns the caller's existing bank item that is byte-for-byte identical
 * (same type, title, points, required, and config) — used by save-to-bank
 * and shared-item copy to avoid polluting the bank with duplicate rows.
 * config uses jsonb `=` equality in Postgres, so deep object comparison.
 */
export async function findDuplicateBankItem(
  creatorId: string,
  input: BankItemInput
): Promise<{ id: string } | null> {
  return prisma.questionBankItem.findFirst({
    where: {
      creatorId,
      type: input.type as never,
      title: input.title,
      points: input.points,
      required: input.required,
      config: { equals: input.config as never },
    },
    select: { id: true },
  })
}

/** Creates a bank item from validated input, honoring an optional folder. */
export async function createBankItem(
  creatorId: string,
  input: BankItemInput,
  folderId?: string | null
): Promise<Prisma.QuestionBankItemGetPayload<Record<string, never>>> {
  return prisma.questionBankItem.create({
    data: {
      type: input.type as never,
      title: input.title,
      points: input.points,
      required: input.required,
      config: input.config as never,
      creatorId,
      ...(folderId ? { folderId } : {}),
    },
  })
}
