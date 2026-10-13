import { describe, expect, it } from "vitest"
import {
  buildFileKey,
  fileKeyBelongsTo,
  FILE_EXTENSION_RE,
  FILE_KEY_RE,
} from "@/lib/answer-file-key"
import { answerContentSchema } from "@/lib/validators/answer"

const uuid = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
const sessionId = "clx1session"
const questionId = "clx1question"
const validKey = `sessions/${sessionId}/${questionId}/${uuid}.pdf`

describe("buildFileKey", () => {
  it("produces a key that its own validators accept", () => {
    const key = buildFileKey(sessionId, questionId, uuid, ".pdf")
    expect(key).toBe(validKey)
    expect(FILE_KEY_RE.test(key)).toBe(true)
    expect(fileKeyBelongsTo(key, sessionId, questionId)).toBe(true)
  })
})

describe("fileKeyBelongsTo", () => {
  it("accepts a key minted for this session and question", () => {
    expect(fileKeyBelongsTo(validKey, sessionId, questionId)).toBe(true)
  })

  it("rejects another session's key — the IDOR this check exists for", () => {
    const otherSession = `sessions/clx1other/${questionId}/${uuid}.pdf`
    expect(fileKeyBelongsTo(otherSession, sessionId, questionId)).toBe(false)
  })

  it("rejects another question's key within the same session", () => {
    const otherQuestion = `sessions/${sessionId}/clx1other/${uuid}.pdf`
    expect(fileKeyBelongsTo(otherQuestion, sessionId, questionId)).toBe(false)
  })

  it("rejects traversal out of the session prefix", () => {
    expect(
      fileKeyBelongsTo(`sessions/${sessionId}/${questionId}/../../x/${uuid}.pdf`, sessionId, questionId)
    ).toBe(false)
  })

  it("rejects a non-UUID filename, so guessable keys can't be named", () => {
    expect(
      fileKeyBelongsTo(`sessions/${sessionId}/${questionId}/backup.sql`, sessionId, questionId)
    ).toBe(false)
  })

  it("rejects a key with extra path segments", () => {
    expect(
      fileKeyBelongsTo(`sessions/${sessionId}/${questionId}/nested/${uuid}.pdf`, sessionId, questionId)
    ).toBe(false)
  })

  it("rejects a bare object name with no prefix", () => {
    expect(fileKeyBelongsTo("secret.pdf", sessionId, questionId)).toBe(false)
  })

  it("rejects an empty key", () => {
    expect(fileKeyBelongsTo("", sessionId, questionId)).toBe(false)
  })
})

describe("answerContentSchema FILE_UPLOAD", () => {
  it("accepts a well-formed key", () => {
    const parsed = answerContentSchema.safeParse({
      type: "FILE_UPLOAD",
      fileKey: validKey,
      fileName: "essay.pdf",
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a key shape the upload route could never have minted", () => {
    for (const fileKey of [
      "../../etc/passwd",
      "/etc/passwd",
      "sessions/a/b/not-a-uuid.pdf",
      `sessions/a/b/${uuid}.pdf/../../x`,
      `backups/${uuid}.sql`,
    ]) {
      const parsed = answerContentSchema.safeParse({
        type: "FILE_UPLOAD",
        fileKey,
        fileName: "x.pdf",
      })
      expect(parsed.success, `expected ${fileKey} to be rejected`).toBe(false)
    }
  })
})

describe("FILE_EXTENSION_RE", () => {
  it("accepts plain lowercase extensions", () => {
    for (const ext of [".pdf", ".png", ".tar", ".7z"]) {
      expect(FILE_EXTENSION_RE.test(ext)).toBe(true)
    }
  })

  it("rejects extensions that could inject path segments or case-fold surprises", () => {
    for (const ext of [".", ".a/b", "./x", ".PDF", ".pdf/", ".p df", "..pdf", ""]) {
      expect(FILE_EXTENSION_RE.test(ext), `expected ${ext} to be rejected`).toBe(false)
    }
  })
})
