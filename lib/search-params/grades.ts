import { createLoader } from "nuqs/server"
import { parseAsPage } from "./shared"

export const gradesSearchParams = {
  page: parseAsPage,
}

export const loadGradesSearchParams = createLoader(gradesSearchParams)
