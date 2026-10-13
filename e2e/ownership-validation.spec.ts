import { test, expect, type APIRequestContext } from "@playwright/test"
import {
  uniqueEmail,
  signUp,
  promoteToTeacher,
  createActiveExam,
} from "./helpers"

// Shares the file-wide auth rate-limit budget with the other spec files
// (see toctou-fixes.spec.ts) — keep this serial so the small number of
// sign-ups/sign-ins below don't race another describe block for it.
test.describe.configure({ mode: "serial" })

// Must match the port playwright.config.ts starts the dev server on.
const ORIGIN_HEADER = {
  origin: new URL(
    process.env.E2E_BASE_URL ??
      process.env.TARGET_BASE_URL ??
      `http://localhost:${Number(process.env.E2E_PORT ?? 3000)}`
  ).origin,
}

/**
 * Every resource here is created by teacherA/studentA. teacherB/studentB are
 * distinct, unrelated accounts that must never be able to read or mutate it —
 * each assertion below is a direct regression test for the ownership check
 * (`creatorId`/`userId` compared against the caller's session) that every
 * REST route is supposed to apply before returning or changing data. Where
 * useful, a matching "owner can access" call sits next to the denial so a
 * broken fixture (e.g. a bad exam id) can't masquerade as a passing check.
 */
test.describe
  .serial("ownership validation — cross-account access is denied", () => {
  let teacherA: APIRequestContext
  let teacherB: APIRequestContext
  let studentA: APIRequestContext
  let studentB: APIRequestContext

  test.beforeAll(async ({ playwright, baseURL }) => {
    teacherA = await playwright.request.newContext({ baseURL })
    const teacherAEmail = uniqueEmail("own-teacherA")
    await signUp(teacherA, { name: "E2E Teacher A", email: teacherAEmail })
    await promoteToTeacher(teacherA, { email: teacherAEmail })

    teacherB = await playwright.request.newContext({ baseURL })
    const teacherBEmail = uniqueEmail("own-teacherB")
    await signUp(teacherB, { name: "E2E Teacher B", email: teacherBEmail })
    await promoteToTeacher(teacherB, { email: teacherBEmail })

    studentA = await playwright.request.newContext({ baseURL })
    await signUp(studentA, {
      name: "E2E Student A",
      email: uniqueEmail("own-studentA"),
    })

    studentB = await playwright.request.newContext({ baseURL })
    await signUp(studentB, {
      name: "E2E Student B",
      email: uniqueEmail("own-studentB"),
    })
  })

  test.afterAll(async () => {
    await teacherA.dispose()
    await teacherB.dispose()
    await studentA.dispose()
    await studentB.dispose()
  })

  test("a teacher cannot read, edit, or manage another teacher's exam", async () => {
    const createRes = await teacherA.post("/api/exams", {
      data: { title: `Ownership Exam ${Date.now()}`, timeLimitMin: 30 },
    })
    expect(createRes.ok(), await createRes.text()).toBe(true)
    const { exam } = await createRes.json()

    // Owner can read its own draft — sanity check the fixture is valid.
    const ownerGet = await teacherA.get(`/api/exams/${exam.id}`)
    expect(ownerGet.ok()).toBe(true)

    expect((await teacherB.get(`/api/exams/${exam.id}`)).status()).toBe(404)
    expect(
      (
        await teacherB.patch(`/api/exams/${exam.id}`, {
          data: { title: "Hijacked" },
        })
      ).status()
    ).toBe(404)
    expect(
      (await teacherB.get(`/api/exams/${exam.id}/questions`)).status()
    ).toBe(404)
    expect(
      (await teacherB.get(`/api/exams/${exam.id}/sessions`)).status()
    ).toBe(404)
    expect((await teacherB.get(`/api/exams/${exam.id}/export`)).status()).toBe(
      404
    )
    expect(
      (await teacherB.post(`/api/exams/${exam.id}/publish`)).status()
    ).toBe(404)
    expect(
      (await teacherB.post(`/api/exams/${exam.id}/duplicate`)).status()
    ).toBe(404)
    expect(
      (
        await teacherB.patch(`/api/exams/${exam.id}/folder`, {
          data: { folderId: null },
        })
      ).status()
    ).toBe(404)
    expect(
      (await teacherB.delete(`/api/exams/${exam.id}`)).status(),
      "a non-owner must not be able to delete another teacher's exam"
    ).toBe(404)

    // The exam must still exist for its real owner after all of the above.
    expect((await teacherA.get(`/api/exams/${exam.id}`)).ok()).toBe(true)
  })

  test("a teacher cannot rename, delete, or file into another teacher's folder", async () => {
    const createRes = await teacherA.post("/api/folders", {
      data: { name: `Ownership Folder ${Date.now()}` },
    })
    expect(createRes.ok(), await createRes.text()).toBe(true)
    const { folder } = await createRes.json()

    expect(
      (
        await teacherB.patch(`/api/folders/${folder.id}`, {
          data: { name: "Hijacked" },
        })
      ).status()
    ).toBe(404)
    expect((await teacherB.delete(`/api/folders/${folder.id}`)).status()).toBe(
      404
    )

    // A teacher also can't file their own exam into someone else's folder.
    const examRes = await teacherB.post("/api/exams", {
      data: { title: `Ownership Move ${Date.now()}`, timeLimitMin: 30 },
    })
    expect(examRes.ok(), await examRes.text()).toBe(true)
    const { exam } = await examRes.json()
    const moveRes = await teacherB.patch(`/api/exams/${exam.id}/folder`, {
      data: { folderId: folder.id },
    })
    expect(moveRes.status()).toBe(404)
  })

  test("a teacher cannot see or grade another teacher's exam sessions", async () => {
    const exam = await createActiveExam(
      teacherA,
      `Ownership Active ${Date.now()}`
    )
    const joinRes = await studentA.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), await joinRes.text()).toBe(true)
    const { sessionId } = await joinRes.json()

    expect(
      (await teacherB.get(`/api/exams/${exam.id}/sessions`)).status()
    ).toBe(404)
    expect(
      (await teacherB.get(`/api/sessions/${sessionId}/review`)).status()
    ).toBe(404)
    expect(
      (
        await teacherB.get(`/api/sessions/${sessionId}/integrity-events`)
      ).status()
    ).toBe(404)
    expect(
      (
        await teacherB.put(`/api/sessions/${sessionId}/grades`, {
          data: { grades: [] },
        })
      ).status()
    ).toBe(404)
    expect(
      (
        await teacherB.post(`/api/sessions/${sessionId}/lock`, {
          data: { locked: true },
        })
      ).status()
    ).toBe(404)
    expect(
      (
        await teacherB.post(`/api/sessions/${sessionId}/extend`, {
          data: { minutes: 5 },
        })
      ).status()
    ).toBe(404)
    expect((await teacherB.post(`/api/exams/${exam.id}/close`)).status()).toBe(
      404
    )

    // The owning teacher's view of the same session is unaffected. The
    // session hasn't been submitted yet, so review 409s rather than 200 —
    // the point here is that it's *not* the 404 a non-owner gets.
    const ownerReview = await teacherA.get(`/api/sessions/${sessionId}/review`)
    expect(ownerReview.status()).not.toBe(404)
  })

  test("a student cannot read, answer, or submit another student's session", async () => {
    const exam = await createActiveExam(
      teacherA,
      `Ownership Student ${Date.now()}`
    )
    const joinRes = await studentA.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), await joinRes.text()).toBe(true)
    const { sessionId } = await joinRes.json()

    // Owner can read its own session — sanity check before probing studentB.
    const ownerGet = await studentA.get(`/api/sessions/${sessionId}`)
    expect(ownerGet.ok(), await ownerGet.text()).toBe(true)
    const { questions } = await ownerGet.json()

    expect((await studentB.get(`/api/sessions/${sessionId}`)).status()).toBe(
      404
    )
    expect(
      (
        await studentB.put(`/api/sessions/${sessionId}/answers`, {
          data: {
            questionId: questions[0].id,
            content: { type: "MULTIPLE_CHOICE", selectedOptionIds: [] },
          },
        })
      ).status()
    ).toBe(404)
    expect(
      (
        await studentB.post(`/api/sessions/${sessionId}/submit`, {
          data: { idempotencyKey: `ownership-${sessionId}` },
        })
      ).status()
    ).toBe(404)
    expect(
      (
        await studentB.get(
          `/api/sessions/${sessionId}/download?questionId=${questions[0].id}`
        )
      ).status()
    ).toBe(404)

    // studentB also can't see studentA's session in their own session list.
    const listRes = await studentB.get("/api/sessions")
    expect(listRes.ok()).toBe(true)
    const { sessions } = await listRes.json()
    expect(
      sessions.find((s: { id: string }) => s.id === sessionId)
    ).toBeUndefined()
  })

  test("an uploaded file is stored in Postgres and served only to its student and teacher", async () => {
    const exam = await createActiveExam(
      teacherA,
      `Ownership Upload ${Date.now()}`,
      undefined,
      {
        withFileUpload: true,
      }
    )
    const joinRes = await studentA.post("/api/sessions", {
      headers: ORIGIN_HEADER,
      data: { accessCode: exam.accessCode },
    })
    expect(joinRes.ok(), await joinRes.text()).toBe(true)
    const { sessionId } = await joinRes.json()
    const { questions } = await (
      await studentA.get(`/api/sessions/${sessionId}`)
    ).json()
    const uploadQ = questions.find(
      (q: { type: string }) => q.type === "FILE_UPLOAD"
    )
    expect(uploadQ).toBeDefined()

    // HTML on purpose: it must come back as a forced download, never rendered.
    const body = Buffer.from("<script>alert(1)</script>")
    const upRes = await studentA.post(`/api/sessions/${sessionId}/upload`, {
      headers: ORIGIN_HEADER,
      multipart: {
        questionId: uploadQ.id,
        file: { name: "lösung.html", mimeType: "text/html", buffer: body },
      },
    })
    expect(upRes.ok(), await upRes.text()).toBe(true)
    const { fileKey, fileName } = await upRes.json()
    const saveRes = await studentA.put(`/api/sessions/${sessionId}/answers`, {
      headers: ORIGIN_HEADER,
      data: {
        questionId: uploadQ.id,
        content: { type: "FILE_UPLOAD", fileKey, fileName },
      },
    })
    expect(saveRes.ok(), await saveRes.text()).toBe(true)

    const url = `/api/sessions/${sessionId}/download?questionId=${uploadQ.id}`
    for (const who of [studentA, teacherA]) {
      const res = await who.get(url)
      expect(res.status(), await res.text()).toBe(200)
      const { url: fileUrl } = await res.json()
      expect(fileUrl).toContain("/download/file?")
      const fileRes = await who.get(fileUrl)
      expect(fileRes.status()).toBe(200)
      expect(Buffer.from(await fileRes.body()).equals(body)).toBe(true)
      expect(fileRes.headers()["content-type"]).toBe("application/octet-stream")
      expect(fileRes.headers()["content-disposition"]).toMatch(/^attachment;/)
      expect(fileRes.headers()["x-content-type-options"]).toBe("nosniff")
      expect(fileRes.headers()["content-security-policy"]).toBe("sandbox")
    }
    expect((await studentB.get(url)).status()).toBe(404)
    expect((await teacherB.get(url)).status()).toBe(404)

    // Over the question's 1 MB limit → rejected before anything is stored.
    const tooBig = await studentA.post(`/api/sessions/${sessionId}/upload`, {
      headers: ORIGIN_HEADER,
      multipart: {
        questionId: uploadQ.id,
        file: {
          name: "gross.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.alloc(1024 * 1024 + 1),
        },
      },
    })
    expect(tooBig.status()).toBe(422)
  })

  test("admin-only routes reject a non-admin caller before touching any target user", async () => {
    // Role check runs before the target lookup, so even a made-up id must
    // still come back 403 (not 404/500) for a non-admin caller.
    const res = await teacherA.patch("/api/admin/users/does-not-exist", {
      data: { role: "ADMIN" },
    })
    expect(res.status()).toBe(403)
  })
})
