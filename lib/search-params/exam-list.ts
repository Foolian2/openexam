import { createLoader } from "nuqs/server"
import { parseAsFilter, parseAsPage } from "./shared"

export const examListSearchParams = {
  page: parseAsPage,
  status: parseAsFilter,
  q: parseAsFilter,
  folder: parseAsFilter,
}

export const loadExamListSearchParams = createLoader(examListSearchParams)
