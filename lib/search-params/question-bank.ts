import { createLoader, createSerializer } from "nuqs/server"
import { parseAsFilter, parseAsPage } from "./shared"

export const questionBankSearchParams = {
  page: parseAsPage,
  q: parseAsFilter,
  type: parseAsFilter,
  folderId: parseAsFilter,
  sortBy: parseAsFilter,
  sortDir: parseAsFilter,
}

export const loadQuestionBankSearchParams = createLoader(
  questionBankSearchParams
)

export const serializeQuestionBankSearchParams = createSerializer(
  questionBankSearchParams
)
