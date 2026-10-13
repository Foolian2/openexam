import { createLoader, createSerializer } from "nuqs/server"
import { parseAsFilter, parseAsPage } from "./shared"

export const auditSearchParams = {
  page: parseAsPage,
  examId: parseAsFilter,
  action: parseAsFilter,
  userId: parseAsFilter,
  from: parseAsFilter,
  to: parseAsFilter,
  ip: parseAsFilter,
}

export const loadAuditSearchParams = createLoader(auditSearchParams)

export const serializeAuditSearchParams = createSerializer(auditSearchParams)
