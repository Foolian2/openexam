// Loads load/data/seed-users.json (written by `pnpm load:seed`) once via
// SharedArray so its memory is shared across VUs instead of copied per-VU.
// open() only works in k6's init context, so this must be imported at the
// top of a scenario file, not called lazily inside default()/setup().
import { SharedArray } from "k6/data"
import { SEED_USERS_PATH } from "../config.js"

export const seedUsers = new SharedArray("seed-users", function () {
  let raw
  try {
    raw = open(SEED_USERS_PATH)
  } catch {
    throw new Error(
      `${SEED_USERS_PATH} not found — run "pnpm load:seed" first to provision student accounts.`
    )
  }
  const users = JSON.parse(raw)
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error(`${SEED_USERS_PATH} is empty — run "pnpm load:seed" with a --count > 0.`)
  }
  return users
})
