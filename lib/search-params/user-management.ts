import { createLoader } from "nuqs/server"
import { parseAsFilter, parseAsPage } from "./shared"

export const userManagementSearchParams = {
  page: parseAsPage,
  q: parseAsFilter,
}

export const loadUserManagementSearchParams = createLoader(
  userManagementSearchParams
)
