import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The last USER directive in a Dockerfile decides who the runtime process is.
function finalUser(dockerfile: string): string | undefined {
  const text = readFileSync(join(__dirname, "..", dockerfile), "utf8")
  const users = [...text.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1])
  return users.at(-1)
}

describe("runtime containers do not run as root", () => {
  it.each(["Dockerfile", "ws-backend/Dockerfile"])("%s", (dockerfile) => {
    const user = finalUser(dockerfile)
    expect(user).toBeDefined()
    expect(user).not.toMatch(/^(root|0)(:|$)/)
  })
})
