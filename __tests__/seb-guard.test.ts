import { beforeEach, describe, expect, it, vi } from "vitest"
import { configKeyTokenForUrl } from "@/lib/seb-key"

const updateMock = vi.fn()
const updateManyMock = vi.fn()
const findUniqueMock = vi.fn()
const auditLogCreateMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    examSession: {
      update: (...args: unknown[]) => updateMock(...args),
      updateMany: (...args: unknown[]) => updateManyMock(...args),
      findUnique: (...args: unknown[]) => findUniqueMock(...args),
    },
    auditLog: {
      create: (...args: unknown[]) => auditLogCreateMock(...args),
    },
  },
}))

const publishMock = vi.fn()
vi.mock("@/lib/redis", () => ({
  redis: { publish: (...args: unknown[]) => publishMock(...args) },
}))

const { verifySebAccess, isSEBUserAgent } = await import("@/lib/seb-guard")

const baseUrl = "http://localhost:3000"
const examId = "exam1"
const configKey = "the-config-key"
const takeUrl = `${baseUrl}/exam/${examId}/take`
const validToken = configKeyTokenForUrl(takeUrl, configKey)

function exam(
  overrides: Partial<{ sebRequired: boolean; sebConfigKey: string | null }> = {}
) {
  return {
    id: examId,
    sebRequired: true,
    sebConfigKey: configKey,
    ...overrides,
  }
}

function session(
  overrides: Partial<{
    sebConfigKey: string | null
    sebKeyHash: string | null
    sebUserAgent: string | null
    sebBrowserExamKey: string | null
    sebIntegrityFlaggedAt: Date | null
  }> = {}
) {
  return {
    id: "session1",
    // Defaults to null — the session never fetched a personalized config, so
    // it validates against the exam-level key alone. That keeps every existing
    // case below testing exactly the behaviour it tested before per-session
    // keys existed.
    sebConfigKey: null,
    sebKeyHash: null,
    sebUserAgent: null,
    sebBrowserExamKey: null,
    sebIntegrityFlaggedAt: null,
    ...overrides,
  }
}

function headersWith(token?: string, ua = "SEB/3.6.0", bek?: string) {
  const h = new Headers()
  if (token) h.set("x-safeexambrowser-configkeyhash", token)
  // Our own header, not SEB's: SEB's is per-URL and the guard ignores it
  // outright. See SEB_BEK_HEADER in lib/seb-guard.ts.
  if (bek) h.set("x-openexam-seb-requesthash", bek)
  h.set("user-agent", ua)
  return h
}

beforeEach(() => {
  updateMock.mockReset()
  updateMock.mockResolvedValue(undefined)
  updateManyMock.mockReset()
  updateManyMock.mockResolvedValue({ count: 1 })
  findUniqueMock.mockReset()
  findUniqueMock.mockResolvedValue(null)
  publishMock.mockReset()
  publishMock.mockResolvedValue(undefined)
  auditLogCreateMock.mockReset()
  auditLogCreateMock.mockResolvedValue(undefined)
  process.env.NEXT_PUBLIC_BASE_URL = baseUrl
})

describe("isSEBUserAgent", () => {
  it("detects SEB user agents", () => {
    expect(
      isSEBUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) SEB/3.6.0")
    ).toBe(true)
  })

  it("rejects regular browser user agents", () => {
    expect(
      isSEBUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15"
      )
    ).toBe(false)
  })
})

describe("verifySebAccess", () => {
  it("allows when the exam does not require SEB, without looking at the token", async () => {
    const result = await verifySebAccess({
      exam: exam({ sebRequired: false }),
      examSession: session(),
      headers: headersWith(),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("denies when sebRequired but no token is present (fail closed)", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "missing_token" })
  })

  it("denies on a junk token", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith("not-a-real-token"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "invalid_token" })
  })

  it("denies when sebRequired but Exam.sebConfigKey was never persisted — this is the regression from the dead activation write, which used to silently ALLOW", async () => {
    const result = await verifySebAccess({
      exam: exam({ sebConfigKey: null }),
      examSession: session(),
      headers: headersWith(validToken),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "seb_not_configured" })
  })

  it("allows a valid token for the take-page URL and binds the session on first use", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(validToken),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "session1", sebKeyHash: null },
      data: { sebKeyHash: validToken, sebUserAgent: "SEB/3.6.0" },
    })
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("makes the first bind set-once and judges against the winner when the race is lost", async () => {
    updateManyMock.mockResolvedValue({ count: 0 })
    findUniqueMock.mockResolvedValue({
      sebKeyHash: validToken,
      sebUserAgent: "SEB/3.6.0",
      sebBrowserExamKey: null,
      sebIntegrityFlaggedAt: null,
    })
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(validToken),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "session1", sebKeyHash: null },
      data: { sebKeyHash: validToken, sebUserAgent: "SEB/3.6.0" },
    })
    expect(findUniqueMock).toHaveBeenCalled()
  })

  it("denies the loser of the bind race when its UA differs from the winner's", async () => {
    updateManyMock.mockResolvedValue({ count: 0 })
    findUniqueMock.mockResolvedValue({
      sebKeyHash: validToken,
      sebUserAgent: "SEB/3.6.0",
      sebBrowserExamKey: null,
      sebIntegrityFlaggedAt: null,
    })
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(validToken, "SEB/3.7.0"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "ua_mismatch" })
  })

  it("denies a lost first-bind race when this request's token differs from the winner's", async () => {
    updateManyMock.mockResolvedValueOnce({ count: 0 })
    findUniqueMock.mockResolvedValue({
      sebKeyHash: configKeyTokenForUrl(takeUrl, "a-different-config-key"),
      sebUserAgent: "SEB/3.6.0",
      sebBrowserExamKey: null,
      sebIntegrityFlaggedAt: null,
    })

    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(validToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "key_mismatch" })
  })

  it("also accepts a token computed for the specific subresource request URL (Windows native per-URL header)", async () => {
    const requestUrl = `${baseUrl}/api/sessions/session1`
    const perUrlToken = configKeyTokenForUrl(requestUrl, configKey)
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(perUrlToken),
      requestUrl,
    })
    expect(result.ok).toBe(true)
  })

  it("denies once bound if a later request presents a different token", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        sebKeyHash: validToken,
        sebUserAgent: "SEB/3.6.0",
      }),
      headers: headersWith(
        configKeyTokenForUrl(
          `${baseUrl}/api/sessions/session1`,
          "different-key"
        )
      ),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "invalid_token" })
  })

  it("denies once bound if the User-Agent changes (session hijacked to a plain browser)", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        sebKeyHash: validToken,
        sebUserAgent: "SEB/3.6.0",
      }),
      headers: headersWith(validToken, "Mozilla/5.0 (plain browser)"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "ua_mismatch" })
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("allows a bound session presenting the same token and UA again", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        sebKeyHash: validToken,
        sebUserAgent: "SEB/3.6.0",
      }),
      headers: headersWith(validToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateMock).not.toHaveBeenCalled()
  })
})

describe("verifySebAccess — Browser Exam Key trust-on-first-use", () => {
  const bound = { sebKeyHash: validToken, sebUserAgent: "SEB/3.6.0" }

  it("binds the BEK in the same write that binds the Config Key token", async () => {
    await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-aaa"),
      requestUrl: takeUrl,
    })
    expect(updateManyMock).toHaveBeenCalledTimes(1)
    expect(updateManyMock.mock.calls[0][0].data).toMatchObject({
      sebKeyHash: validToken,
      sebBrowserExamKey: "bek-aaa",
    })
  })

  it("omits the BEK entirely when none is presented on first bind", async () => {
    // An absent value is indistinguishable from an SEB build that exposes
    // none, so it must not be written as null-that-means-something.
    await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(validToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
    })
    expect(updateManyMock.mock.calls[0][0].data).not.toHaveProperty(
      "sebBrowserExamKey"
    )
  })

  it("binds on first sighting when the session was bound without one", async () => {
    await verifySebAccess({
      exam: exam(),
      examSession: session(bound),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-aaa"),
      requestUrl: takeUrl,
    })
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "session1",
        OR: [{ sebBrowserExamKey: null }, { sebBrowserExamKey: "" }],
      },
      data: { sebBrowserExamKey: "bek-aaa" },
    })
  })

  it("does nothing when a matching BEK is presented again", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-aaa"),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(publishMock).not.toHaveBeenCalled()
  })

  it("flags bek_changed WITHOUT denying when the key changes mid-exam", async () => {
    // The single most important assertion here: a false positive must never
    // strand a student in a paper they are sitting.
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-bbb"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: true })
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: "session1", sebIntegrityFlaggedAt: null },
      data: { sebIntegrityReason: "bek_changed" },
    })
  })

  it("flags bek_disappeared WITHOUT denying when a bound key stops arriving", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers: headersWith(validToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: true })
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: "session1", sebIntegrityFlaggedAt: null },
      data: { sebIntegrityReason: "bek_disappeared" },
    })
  })

  it("ignores SEB's own per-URL x-safeexambrowser-requesthash header entirely", async () => {
    // The header exists and Windows SEB always sends it, but it carries
    // sha256(requestURL + BEK) — a different value on every endpoint, so
    // reading it would flag every session "bek_changed" on its first
    // /api/sessions/* poll.
    const headers = headersWith(validToken, "SEB/3.6.0")
    headers.set("x-safeexambrowser-requesthash", "per-url-hash-for-this-endpoint")

    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers,
      requestUrl: takeUrl,
    })

    // Reading it would have produced bek_changed; not reading it at all reads as
    // an absence, which is the bek_disappeared path — the point is only that the
    // value never reaches the comparison.
    expect(result).toEqual({ ok: true })
    expect(publishMock.mock.calls).not.toContainEqual(
      expect.arrayContaining([
        expect.stringContaining("per-url-hash-for-this-endpoint"),
      ])
    )
    expect(updateManyMock.mock.calls[0][0].data).not.toMatchObject({
      sebBrowserExamKey: "per-url-hash-for-this-endpoint",
    })
  })

  it("does not attest at all on a navigation, so reloading the take page is not a disappearance", async () => {
    // Only sebFetch sets the BEK header; a top-level navigation cannot. Treating
    // that absence as a signal would flag a student who simply reloaded as
    // "SEB nicht mehr gesendet".
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers: headersWith(validToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
      isNavigation: true,
    })
    expect(result).toEqual({ ok: true })
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(publishMock).not.toHaveBeenCalled()
  })

  it("does not bind a BEK on a navigation either", async () => {
    const headers = headersWith(validToken, "SEB/3.6.0", "bek-aaa")
    await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers,
      requestUrl: takeUrl,
      isNavigation: true,
    })
    expect(updateManyMock.mock.calls[0][0].data).not.toHaveProperty(
      "sebBrowserExamKey"
    )
  })

  it("does not publish when a concurrent request already flagged the session first", async () => {
    // updateMany's WHERE sebIntegrityFlaggedAt: null guard is what makes this
    // atomic at the DB level — a count of 0 means another request won the
    // race, so this one must not also publish a (possibly conflicting) flag.
    updateManyMock.mockResolvedValue({ count: 0 })
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-bbb"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: true })
    expect(publishMock).not.toHaveBeenCalled()
  })

  it("publishes the flag to the monitor channel", async () => {
    await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-bbb"),
      requestUrl: takeUrl,
    })
    expect(publishMock).toHaveBeenCalledTimes(1)
    const [channel, payload] = publishMock.mock.calls[0]
    expect(channel).toBe(`exam:${examId}:monitor`)
    expect(JSON.parse(payload as string)).toMatchObject({
      sessionId: "session1",
      patch: { sebIntegrityFlagged: true, sebIntegrityReason: "bek_changed" },
    })
  })

  it("does not re-flag a session that is already flagged", async () => {
    // Otherwise a switched-away client writes to the database and spams the
    // monitor on every single request for the rest of the exam.
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        ...bound,
        sebBrowserExamKey: "bek-aaa",
        sebIntegrityFlaggedAt: new Date(),
      }),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-bbb"),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateMock).not.toHaveBeenCalled()
    expect(updateManyMock).not.toHaveBeenCalled()
    expect(publishMock).not.toHaveBeenCalled()
  })

  it("still admits the student when publishing the signal fails", async () => {
    publishMock.mockRejectedValue(new Error("redis down"))
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ ...bound, sebBrowserExamKey: "bek-aaa" }),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-bbb"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: true })
  })

  it("accepts the BEK via the bekKeyParam escape hatch (parity with the WS handshake)", async () => {
    await verifySebAccess({
      exam: exam(),
      examSession: session(bound),
      headers: headersWith(validToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
      bekKeyParam: "bek-from-ws",
    })
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: "session1",
        OR: [{ sebBrowserExamKey: null }, { sebBrowserExamKey: "" }],
      },
      data: { sebBrowserExamKey: "bek-from-ws" },
    })
  })

  it("still admits the student when the bind write itself fails", async () => {
    // Same invariant as the publish-failure case above, but for the Prisma
    // write itself rather than the Redis notification.
    updateManyMock.mockRejectedValue(new Error("db down"))
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(bound),
      headers: headersWith(validToken, "SEB/3.6.0", "bek-aaa"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: true })
  })
})

describe("verifySebAccess — denial audit logging", () => {
  it("does not audit-log when the request is allowed", async () => {
    await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(validToken),
      requestUrl: takeUrl,
      userId: "user1",
      ip: "203.0.113.1",
    })
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("logs missing_token as SEB_ACCESS_DENIED, with the caller's userId/ip attached", async () => {
    await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(),
      requestUrl: takeUrl,
      userId: "user1",
      ip: "203.0.113.1",
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SEB_ACCESS_DENIED",
        entityType: "ExamSession",
        entityId: "session1",
        userId: "user1",
        examId: examId,
        ipAddress: "203.0.113.1",
        metadata: { reason: "missing_token" },
      }),
    })
  })

  it("logs key_mismatch and ua_mismatch as SEB_INTEGRITY_DENIED — the hijack/clone signals", async () => {
    const bound = { sebKeyHash: validToken, sebUserAgent: "SEB/3.6.0" }

    await verifySebAccess({
      exam: exam(),
      examSession: session(bound),
      headers: headersWith(validToken, "Mozilla/5.0 (plain browser)"),
      requestUrl: takeUrl,
      userId: "user1",
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SEB_INTEGRITY_DENIED",
        metadata: { reason: "ua_mismatch" },
      }),
    })

    auditLogCreateMock.mockClear()
    // key_mismatch now means what it says: the request validated against a
    // Config Key whose identity differs from the one bound to this session.
    // A stale binding stands in for "some other config" here.
    const otherUrl = `${baseUrl}/api/sessions/session1/submit`
    const perUrlToken = configKeyTokenForUrl(otherUrl, configKey)
    await verifySebAccess({
      exam: exam(),
      examSession: session({
        ...bound,
        sebKeyHash: configKeyTokenForUrl(takeUrl, "a-different-config-key"),
      }),
      headers: headersWith(perUrlToken, "SEB/3.6.0"),
      requestUrl: otherUrl,
      userId: "user1",
    })
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "SEB_INTEGRITY_DENIED",
        metadata: { reason: "key_mismatch" },
      }),
    })
  })

  it("does NOT treat a per-URL token for another path as a mismatch — the Windows regression", async () => {
    // SEB 3.10.2 on Windows bound the
    // take-page token, then its native header presented a per-URL hash for
    // /api/sessions/<id>. Comparing raw tokens rejected it, and every
    // autosave answered 403 "Safe Exam Browser erforderlich" 15s apart.
    auditLogCreateMock.mockClear()
    const apiUrl = `${baseUrl}/api/sessions/session1`
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        sebKeyHash: validToken, // bound from the take page
        sebUserAgent: "SEB/3.6.0",
      }),
      headers: headersWith(configKeyTokenForUrl(apiUrl, configKey), "SEB/3.6.0"),
      requestUrl: apiUrl,
      userId: "user1",
    })
    expect(result.ok).toBe(true)
    expect(auditLogCreateMock).not.toHaveBeenCalled()
  })

  it("binds the URL-independent identity, not the per-URL token that happened to arrive first", async () => {
    // Binding the raw token would pin the session to whichever endpoint it
    // first validated on, and every other endpoint would then mismatch.
    const apiUrl = `${baseUrl}/api/sessions/session1`
    await verifySebAccess({
      exam: exam(),
      examSession: session({ sebKeyHash: null, sebUserAgent: null }),
      headers: headersWith(configKeyTokenForUrl(apiUrl, configKey), "SEB/3.6.0"),
      requestUrl: apiUrl,
    })
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "session1", sebKeyHash: null },
      data: { sebKeyHash: validToken, sebUserAgent: "SEB/3.6.0" },
    })
  })

  it("still denies the request even if the audit write itself fails", async () => {
    auditLogCreateMock.mockRejectedValue(new Error("db down"))
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session(),
      headers: headersWith(),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "missing_token" })
  })
})

describe("verifySebAccess — personalized (per-session) Config Key", () => {
  const sessionKey = "the-session-config-key"
  const sessionToken = configKeyTokenForUrl(takeUrl, sessionKey)

  it("accepts a token derived from the session's personalized key", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ sebConfigKey: sessionKey }),
      headers: headersWith(sessionToken),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
  })

  it("still accepts the frozen exam-level key, so a session that never fetched a personalized config keeps working", async () => {
    // The whole point of making this additive: sessions predating auto-login,
    // and teacher previews, carry the anonymous config.
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ sebConfigKey: sessionKey }),
      headers: headersWith(validToken),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
  })

  it("accepts the personalized key even when the exam-level key is absent", async () => {
    const result = await verifySebAccess({
      exam: exam({ sebConfigKey: null }),
      examSession: session({ sebConfigKey: sessionKey }),
      headers: headersWith(sessionToken),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
  })

  it("denies only when BOTH keys are absent", async () => {
    const result = await verifySebAccess({
      exam: exam({ sebConfigKey: null }),
      examSession: session({ sebConfigKey: null }),
      headers: headersWith(validToken),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "seb_not_configured" })
  })

  it("rejects a token derived from some other session's personalized key", async () => {
    const otherToken = configKeyTokenForUrl(takeUrl, "someone-elses-key")
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({ sebConfigKey: sessionKey }),
      headers: headersWith(otherToken),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "invalid_token" })
  })
})

describe("verifySebAccess — rebinding after a Config Key rotation", () => {
  const sessionKey = "rotated-session-key"
  const sessionToken = configKeyTokenForUrl(takeUrl, sessionKey)

  it("rebinds when sebKeyHash was cleared and the User-Agent still matches (the SEB-relaunch path)", async () => {
    // seb-config/route.ts clears sebKeyHash whenever it issues a new
    // personalized config, so a student whose SEB crashed and relaunched can
    // bind the new key instead of being locked out by the superseded hash.
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        sebConfigKey: sessionKey,
        sebKeyHash: null,
        sebUserAgent: "SEB/3.6.0",
      }),
      headers: headersWith(sessionToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateManyMock).toHaveBeenCalled()
  })

  it("refuses to rebind from a different User-Agent, so re-downloading the config in a normal browser is not a way out of SEB mid-exam", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        sebConfigKey: sessionKey,
        sebKeyHash: null,
        sebUserAgent: "SEB/3.6.0",
      }),
      headers: headersWith(sessionToken, "Mozilla/5.0 Chrome/120"),
      requestUrl: takeUrl,
    })
    expect(result).toEqual({ ok: false, reason: "ua_mismatch" })
    // The binding on record must survive the rejected attempt.
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("binds normally on a genuine first request, where no User-Agent is on record yet", async () => {
    const result = await verifySebAccess({
      exam: exam(),
      examSession: session({
        sebConfigKey: sessionKey,
        sebKeyHash: null,
        sebUserAgent: null,
      }),
      headers: headersWith(sessionToken, "SEB/3.6.0"),
      requestUrl: takeUrl,
    })
    expect(result.ok).toBe(true)
    expect(updateManyMock).toHaveBeenCalled()
  })
})
