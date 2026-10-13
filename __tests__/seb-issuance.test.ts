import { describe, expect, it, vi, beforeEach } from "vitest"

const { prismaMock, sebSecretsMock, auditLogMock } = vi.hoisted(() => ({
  prismaMock: {
    exam: { findUnique: vi.fn(), updateMany: vi.fn() },
    examSession: { findUnique: vi.fn(), update: vi.fn() },
  },
  sebSecretsMock: {
    ensureSebQuitPassword: vi.fn(),
    ensureSebExamKeySalt: vi.fn(),
  },
  auditLogMock: { createAuditLog: vi.fn() },
}))

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }))
vi.mock("@/lib/seb-secrets", () => ({
  ensureSebQuitPassword: sebSecretsMock.ensureSebQuitPassword,
  ensureSebExamKeySalt: sebSecretsMock.ensureSebExamKeySalt,
}))
vi.mock("@/lib/audit", () => ({ createAuditLog: auditLogMock.createAuditLog }))

const EXAM_ID = "c000000000000000000000001"
const USER_ID = "c000000000000000000000002"
const CREATOR_ID = "c000000000000000000000003"
const SESSION_ID = "c000000000000000000000004"
const LOGIN_TOKEN = "one-time-login-token"

/** An ACTIVE SEB exam with no key frozen yet. */
function activeExam(overrides: Record<string, unknown> = {}) {
  return {
    id: EXAM_ID,
    status: "ACTIVE",
    sebRequired: true,
    creatorId: CREATOR_ID,
    allowSpellCheck: false,
    sebConfigKey: null,
    ...overrides,
  }
}

function issuanceInput(overrides: Record<string, unknown> = {}) {
  return {
    examId: EXAM_ID,
    userId: USER_ID,
    loginToken: null as string | null,
    launchTokenUsed: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sebSecretsMock.ensureSebQuitPassword.mockResolvedValue("TESTQUITPASS1234")
  sebSecretsMock.ensureSebExamKeySalt.mockResolvedValue(Buffer.alloc(32, 1))
  auditLogMock.createAuditLog.mockResolvedValue(undefined)
  prismaMock.exam.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.examSession.update.mockResolvedValue({})
  prismaMock.examSession.findUnique.mockResolvedValue({
    id: SESSION_ID,
    status: "IN_PROGRESS",
  })
})

describe("computeSebConfigKey", () => {
  it("derives the key from the persisted quit password and exam key salt", async () => {
    const { computeSebConfigKey } = await import("@/lib/seb-issuance")
    const key = await computeSebConfigKey({
      id: EXAM_ID,
      allowSpellCheck: false,
    })

    expect(sebSecretsMock.ensureSebQuitPassword).toHaveBeenCalledWith(
      EXAM_ID,
      prismaMock
    )
    expect(sebSecretsMock.ensureSebExamKeySalt).toHaveBeenCalledWith(
      EXAM_ID,
      prismaMock
    )
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it("threads a null salt through unchanged for pre-salt exams", async () => {
    const { computeSebConfigKey } = await import("@/lib/seb-issuance")
    const salted = await computeSebConfigKey({
      id: EXAM_ID,
      allowSpellCheck: false,
    })

    sebSecretsMock.ensureSebExamKeySalt.mockResolvedValue(null)
    const unsalted = await computeSebConfigKey({
      id: EXAM_ID,
      allowSpellCheck: false,
    })

    // An exam whose key was frozen before the salt field existed must keep
    // producing its original, unsalted key — not silently acquire a salt.
    expect(unsalted).not.toBe(salted)
  })

  it("agrees with the key the download path freezes", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ creatorId: USER_ID })
    )
    const { computeSebConfigKey, issueSebConfig } =
      await import("@/lib/seb-issuance")

    const activationKey = await computeSebConfigKey({
      id: EXAM_ID,
      allowSpellCheck: false,
    })
    const issued = await issueSebConfig(issuanceInput())
    expect(issued.ok).toBe(true)

    // The activate route and the .seb download must compute the same value —
    // the guard fails closed when they disagree.
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith({
      where: { id: EXAM_ID, sebConfigKey: null },
      data: { sebConfigKey: activationKey },
    })
  })
})

describe("issueSebConfig — eligibility", () => {
  it("refuses a missing exam or one that is not SEB-required", async () => {
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    prismaMock.exam.findUnique.mockResolvedValue(null)
    expect(await issueSebConfig(issuanceInput())).toEqual({
      ok: false,
      reason: "not_available",
    })

    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ sebRequired: false })
    )
    expect(await issueSebConfig(issuanceInput())).toEqual({
      ok: false,
      reason: "not_available",
    })
  })

  it("refuses a student when the exam is not ACTIVE", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ status: "DRAFT" })
    )
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    expect(await issueSebConfig(issuanceInput())).toEqual({
      ok: false,
      reason: "not_available",
    })
    expect(prismaMock.examSession.findUnique).not.toHaveBeenCalled()
  })

  it("refuses a student without an open session", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    prismaMock.examSession.findUnique.mockResolvedValue(null)
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    expect(await issueSebConfig(issuanceInput())).toEqual({
      ok: false,
      reason: "not_available",
    })

    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      status: "SUBMITTED",
    })
    expect(await issueSebConfig(issuanceInput())).toEqual({
      ok: false,
      reason: "not_available",
    })
  })

  it("lets the creator preview a DRAFT exam", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ status: "DRAFT", creatorId: USER_ID })
    )
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    const result = await issueSebConfig(issuanceInput())
    expect(result.ok).toBe(true)
    // A teacher has no ExamSession to bind to; the preview stays anonymous.
    expect(prismaMock.examSession.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.examSession.update).not.toHaveBeenCalled()
  })
})

describe("issueSebConfig — key drift", () => {
  it("refuses a stored key that predates the hardened profile", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ creatorId: USER_ID, sebConfigKey: "old-unhardened-key" })
    )
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    expect(await issueSebConfig(issuanceInput())).toEqual({
      ok: false,
      reason: "key_drift",
    })
  })

  it("writes nothing when the key has drifted", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ sebConfigKey: "old-unhardened-key" })
    )
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    await issueSebConfig(issuanceInput({ loginToken: LOGIN_TOKEN }))

    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.examSession.update).not.toHaveBeenCalled()
    expect(auditLogMock.createAuditLog).not.toHaveBeenCalled()
  })
})

describe("issueSebConfig — key freeze", () => {
  it("freezes the exam key conditionally, so concurrent issuances race on the DB", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ creatorId: USER_ID })
    )
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    await issueSebConfig(issuanceInput())

    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith({
      where: { id: EXAM_ID, sebConfigKey: null },
      data: { sebConfigKey: expect.stringMatching(/^[0-9a-f]{64}$/) },
    })
  })

  it("freezes the ANONYMOUS key, never the student's personalized one", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    const { computeSebConfigKey, issueSebConfig } =
      await import("@/lib/seb-issuance")
    const anonymousKey = await computeSebConfigKey({
      id: EXAM_ID,
      allowSpellCheck: false,
    })

    await issueSebConfig(issuanceInput({ loginToken: LOGIN_TOKEN }))

    // Freezing the personalized key here would make one student's key the
    // value every other student's token is compared against, and the
    // fail-closed guard would deny the entire cohort.
    expect(prismaMock.exam.updateMany).toHaveBeenCalledWith({
      where: { id: EXAM_ID, sebConfigKey: null },
      data: { sebConfigKey: anonymousKey },
    })
    const personalizedKey =
      prismaMock.examSession.update.mock.calls[0][0].data.sebConfigKey
    expect(personalizedKey).not.toBe(anonymousKey)
  })

  it("does not re-freeze an exam whose key is already set", async () => {
    const { computeSebConfigKey, issueSebConfig } =
      await import("@/lib/seb-issuance")
    const currentKey = await computeSebConfigKey({
      id: EXAM_ID,
      allowSpellCheck: false,
    })
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ sebConfigKey: currentKey })
    )

    const result = await issueSebConfig(issuanceInput())

    expect(result.ok).toBe(true)
    expect(prismaMock.exam.updateMany).not.toHaveBeenCalled()
  })
})

describe("issueSebConfig — personalization", () => {
  it("stores the per-session key and clears sebKeyHash, keeping sebUserAgent", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    await issueSebConfig(issuanceInput({ loginToken: LOGIN_TOKEN }))

    expect(prismaMock.examSession.update).toHaveBeenCalledWith({
      where: { id: SESSION_ID },
      data: {
        sebConfigKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        sebKeyHash: null,
      },
    })
    // sebUserAgent must survive: lib/seb-guard.ts requires the rebinding
    // request to come from the same UA, which is what stops a student
    // re-downloading the config in a normal browser to escape SEB.
    const { data } = prismaMock.examSession.update.mock.calls[0][0]
    expect(data).not.toHaveProperty("sebUserAgent")
  })

  it("does not personalize the browser-download path (no login token)", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    const result = await issueSebConfig(issuanceInput({ loginToken: null }))

    expect(result.ok).toBe(true)
    expect(prismaMock.examSession.update).not.toHaveBeenCalled()
  })

  it("ignores a login token handed in for a creator preview", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ status: "DRAFT", creatorId: USER_ID })
    )
    const { computeSebConfigKey, issueSebConfig } =
      await import("@/lib/seb-issuance")
    const anonymousKey = await computeSebConfigKey({
      id: EXAM_ID,
      allowSpellCheck: false,
    })
    const anonymous = await issueSebConfig(issuanceInput())
    prismaMock.exam.updateMany.mockClear()

    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({
        status: "DRAFT",
        creatorId: USER_ID,
        sebConfigKey: anonymousKey,
      })
    )
    const withToken = await issueSebConfig(
      issuanceInput({ loginToken: LOGIN_TOKEN })
    )

    expect(prismaMock.examSession.update).not.toHaveBeenCalled()
    // Byte-identical: a teacher's config never carries a login token, so
    // handing one in cannot turn their download into a standing credential.
    expect(anonymous.ok && withToken.ok).toBe(true)
    if (anonymous.ok && withToken.ok) {
      expect(withToken.file.equals(anonymous.file)).toBe(true)
    }
  })
})

describe("issueSebConfig — audit", () => {
  it("audits every successful issuance, recording whether a launch token was used", async () => {
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    const { issueSebConfig } = await import("@/lib/seb-issuance")

    await issueSebConfig(
      issuanceInput({
        loginToken: LOGIN_TOKEN,
        launchTokenUsed: true,
        ipAddress: "203.0.113.7",
        userAgent: "SEB/3.9",
      })
    )

    expect(auditLogMock.createAuditLog).toHaveBeenCalledWith({
      action: "SEB_CONFIG_DOWNLOADED",
      entityType: "Exam",
      entityId: EXAM_ID,
      examId: EXAM_ID,
      userId: USER_ID,
      ipAddress: "203.0.113.7",
      userAgent: "SEB/3.9",
      metadata: { launchTokenUsed: true },
    })
  })
})

describe("canLaunchSeb", () => {
  it("allows the creator without an exam session", async () => {
    const { canLaunchSeb } = await import("@/lib/seb-issuance")
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    expect(await canLaunchSeb(EXAM_ID, CREATOR_ID)).toBe(true)
    expect(prismaMock.examSession.findUnique).not.toHaveBeenCalled()
  })

  it("allows a student with an open session in an active exam", async () => {
    const { canLaunchSeb } = await import("@/lib/seb-issuance")
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(true)
  })

  it("refuses an unenrolled caller", async () => {
    const { canLaunchSeb } = await import("@/lib/seb-issuance")
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    prismaMock.examSession.findUnique.mockResolvedValue(null)
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(false)
  })

  it("allows a waiting student in a published shared-start exam", async () => {
    const { canLaunchSeb } = await import("@/lib/seb-issuance")
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ status: "PUBLISHED", waitingRoom: true })
    )
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      status: "WAITING",
    })
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(true)
  })

  it("refuses WAITING outside a published waiting-room exam", async () => {
    const { canLaunchSeb } = await import("@/lib/seb-issuance")
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      status: "WAITING",
    })
    // Waiting room switched off.
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ status: "PUBLISHED", waitingRoom: false })
    )
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(false)
    // Already started: a session still WAITING is not an open one.
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ waitingRoom: true })
    )
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(false)
  })

  it("refuses a student in a published exam without a waiting session", async () => {
    const { canLaunchSeb } = await import("@/lib/seb-issuance")
    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ status: "PUBLISHED", waitingRoom: true })
    )
    prismaMock.examSession.findUnique.mockResolvedValue(null)
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(false)
  })

  it("refuses a submitted session, an inactive exam, and a non-SEB exam", async () => {
    const { canLaunchSeb } = await import("@/lib/seb-issuance")
    prismaMock.exam.findUnique.mockResolvedValue(activeExam())
    prismaMock.examSession.findUnique.mockResolvedValue({
      id: SESSION_ID,
      status: "SUBMITTED",
    })
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(false)

    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ status: "CLOSED" })
    )
    expect(await canLaunchSeb(EXAM_ID, USER_ID)).toBe(false)

    prismaMock.exam.findUnique.mockResolvedValue(
      activeExam({ sebRequired: false })
    )
    expect(await canLaunchSeb(EXAM_ID, CREATOR_ID)).toBe(false)
  })
})
