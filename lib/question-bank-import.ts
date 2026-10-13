/**
 * Keep each request comfortably below the API's 8 MiB bulk-import limit.
 *
 * Question-bank exports may contain 100 individually valid, rich CODE
 * questions. Splitting is based on the encoded JSON payload (rather than JS
 * string length) so non-ASCII content cannot make a batch exceed the limit.
 */
export const QUESTION_BANK_IMPORT_BATCH_BYTES = 7 * 1024 * 1024

function encodedPayloadSize(items: unknown[]): number {
  return new TextEncoder().encode(JSON.stringify({ items })).byteLength
}

export function splitQuestionBankImport(
  items: unknown[],
  maxBytes = QUESTION_BANK_IMPORT_BATCH_BYTES
): unknown[][] {
  const batches: unknown[][] = []
  let batch: unknown[] = []

  for (const item of items) {
    const nextBatch = [...batch, item]
    if (batch.length > 0 && encodedPayloadSize(nextBatch) > maxBytes) {
      batches.push(batch)
      batch = [item]
      continue
    }
    batch = nextBatch
  }

  if (batch.length > 0) batches.push(batch)
  return batches
}
