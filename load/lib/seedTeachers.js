// Loads load/data/seed-teachers.json (written by `pnpm load:seed`) once via
// SharedArray, mirroring seedUsers.js. See scripts/load-seed.ts's header
// comment for why teachers are pre-minted the same way as students rather
// than provisioned via the real sign-up/promote HTTP flow.
import { SharedArray } from "k6/data"

export const seedTeachers = new SharedArray("seed-teachers", function () {
  let raw
  try {
    raw = open("../data/seed-teachers.json")
  } catch {
    throw new Error(
      'load/data/seed-teachers.json not found — run "pnpm load:seed" first to provision a teacher account.'
    )
  }
  const teachers = JSON.parse(raw)
  if (!Array.isArray(teachers) || teachers.length === 0) {
    throw new Error("load/data/seed-teachers.json is empty — run \"pnpm load:seed\" again.")
  }
  return teachers
})
