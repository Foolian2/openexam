import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  generateOneTimeToken: vi.fn(),
  examFindUnique: vi.fn(),
  canLaunchSeb: vi.fn(),
  rateLimit: vi.fn(),
  mintLaunchToken: vi.fn(),
}))

vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`)
  },
}))
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: mocks.getSession,
      generateOneTimeToken: mocks.generateOneTimeToken,
    },
  },
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { exam: { findUnique: mocks.examFindUnique } },
}))
vi.mock("@/lib/seb-issuance", () => ({ canLaunchSeb: mocks.canLaunchSeb }))
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit }))
vi.mock("@/lib/seb-launch-token", () => ({
  mintLaunchToken: mocks.mintLaunchToken,
  LAUNCH_TOKEN_TTL_SECONDS: 300,
}))
vi.mock("@/lib/seb-urls", () => ({ sebBaseUrl: () => "https://openexam.ch" }))
vi.mock("@/components/exam-taking/seb-launch-refresher", () => ({
  SebLaunchRefresher: () => null,
}))

const { default: LaunchSEBPage } =
  await import("@/app/exam/[id]/launch-seb/page")
const render = () => LaunchSEBPage({ params: Promise.resolve({ id: "e1" }) })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getSession.mockResolvedValue({ user: { id: "u1" } })
  mocks.examFindUnique.mockResolvedValue({
    id: "e1",
    title: "Prüfung",
    sebRequired: true,
  })
  mocks.canLaunchSeb.mockResolvedValue(true)
  mocks.rateLimit.mockResolvedValue({ allowed: true, resetInSeconds: 300 })
  mocks.mintLaunchToken.mockResolvedValue("lt-token")
  mocks.generateOneTimeToken.mockResolvedValue({ token: "ott-token" })
})

describe("launch-seb page token issuance", () => {
  it("mints no token state for a user who may not launch this exam", async () => {
    mocks.canLaunchSeb.mockResolvedValue(false)
    await expect(render()).rejects.toThrow("REDIRECT:/dashboard/student")
    expect(mocks.canLaunchSeb).toHaveBeenCalledWith("e1", "u1")
    expect(mocks.rateLimit).not.toHaveBeenCalled()
    expect(mocks.mintLaunchToken).not.toHaveBeenCalled()
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled()
  })

  it("mints no token state when the per-user issuance limit is exhausted", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false, resetInSeconds: 120 })
    await render()
    expect(mocks.rateLimit).toHaveBeenCalledWith(
      "seb-launch:u1",
      30,
      300,
      "closed"
    )
    expect(mocks.mintLaunchToken).not.toHaveBeenCalled()
    expect(mocks.generateOneTimeToken).not.toHaveBeenCalled()
  })

  it("mints exactly one launch token and OTT for an eligible user", async () => {
    await render()
    expect(mocks.mintLaunchToken).toHaveBeenCalledExactlyOnceWith({
      userId: "u1",
      examId: "e1",
    })
    expect(mocks.generateOneTimeToken).toHaveBeenCalledOnce()
  })
})
