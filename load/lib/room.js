// Shared setup() steps for the WS scenarios: create teachers + active exams
// and pre-join seed students, so the timed portion of a run is pure
// connect/answer-save load rather than REST join overhead or the 10/60s
// join-session rate limit.
//
// Two shapes:
//   provisionRoom       — one exam, one teacher, N students. What scenarios
//                         03/04/05 and the stress scripts were written
//                         against.
//   provisionClassrooms — M exams each with its own teacher and its own
//                         slice of students, modelling a school running many
//                         classes in parallel. This is the shape the capacity
//                         benchmark measures, because it exercises room
//                         count, Redis pub/sub breadth and the DB pool rather
//                         than a single room goroutine's fan-out.
import { seedUsers } from "./seedUsers.js"
import { seedTeachers } from "./seedTeachers.js"
import { authHeadersForUser } from "./auth.js"
import { createActiveExam, joinSession, REALISTIC_QUESTION_TYPES } from "./exam.js"

export function provisionRoom(prefix, vuCount) {
  if (seedUsers.length < vuCount) {
    throw new Error(
      `Only ${seedUsers.length} seeded students but ${vuCount} were requested — ` +
        `run "pnpm load:seed -- --count ${vuCount}" first.`
    )
  }

  const teacherHeaders = authHeadersForUser(seedTeachers[0])
  const exam = createActiveExam(teacherHeaders, `k6 ${prefix} ${Date.now()}`)

  const sessionIdByEmail = {}
  for (let i = 0; i < vuCount; i++) {
    const user = seedUsers[i]
    const joined = joinSession(authHeadersForUser(user), exam.accessCode)
    sessionIdByEmail[user.email] = joined.sessionId
  }

  return { examId: exam.id, questionId: exam.questionId, sessionIdByEmail, teacherHeaders }
}

// opts.classes            — number of parallel exams (default 1)
// opts.studentsPerClass   — students pre-joined per exam (default 25)
// opts.questionTypes      — question shapes each exam carries
//                           (default REALISTIC_QUESTION_TYPES)
//
// Students are assigned to classes in contiguous blocks, so student i lands
// in class floor(i / studentsPerClass) — the same arithmetic roomForVU()
// below uses to map a VU back to its room without a lookup table.
//
// Needs one seeded teacher per class: seedTeachers is indexed modulo its
// length, but two classes sharing a teacher also share that teacher's
// /ws/monitor connection budget, so seed at least `classes` teachers for a
// clean run.
// opts.timeLimitMin — the exam's own countdown. MUST exceed the run's
// duration: once it elapses (plus the 30s submit grace), ws-backend answers
// every answer:save with EXPIRED and the run measures the rejection path
// instead of the save path. A 60-minute soak against the 30-minute default
// produced 5.9 million EXPIRED errors and zero usable samples in its second
// half, which is why long-running scenarios now pass this explicitly.
export function provisionClassrooms(prefix, opts = {}) {
  const classes = opts.classes || 1
  const studentsPerClass = opts.studentsPerClass || 25
  const questionTypes = opts.questionTypes || REALISTIC_QUESTION_TYPES
  const timeLimitMin = opts.timeLimitMin
  const needed = classes * studentsPerClass

  if (seedUsers.length < needed) {
    throw new Error(
      `Only ${seedUsers.length} seeded students but ${classes} classes x ` +
        `${studentsPerClass} = ${needed} were requested — ` +
        `run "pnpm load:seed -- --count ${needed}" first.`
    )
  }
  if (seedTeachers.length < classes) {
    console.warn(
      `Only ${seedTeachers.length} seeded teachers for ${classes} classes — ` +
        `teachers will be reused across exams. Run ` +
        `"pnpm load:seed -- --count ${needed} --teachers ${classes}" for one each.`
    )
  }

  const stamp = Date.now()
  const rooms = []
  const sessionIdByEmail = {}

  for (let c = 0; c < classes; c++) {
    const teacherHeaders = authHeadersForUser(seedTeachers[c % seedTeachers.length])
    const exam = createActiveExam(teacherHeaders, `k6 ${prefix} c${c} ${stamp}`, {
      questionTypes,
      timeLimitMin,
    })

    for (let i = 0; i < studentsPerClass; i++) {
      const user = seedUsers[c * studentsPerClass + i]
      const joined = joinSession(authHeadersForUser(user), exam.accessCode)
      sessionIdByEmail[user.email] = joined.sessionId
    }

    rooms.push({
      examId: exam.id,
      accessCode: exam.accessCode,
      questionId: exam.questionId,
      questionIdsByType: exam.questionIdsByType,
      teacherHeaders,
    })
  }

  return { rooms, classes, studentsPerClass, sessionIdByEmail }
}

// Maps the running VU to the student it drives and the room that student was
// pre-joined to. Mirrors the `(__VU - 1) % seedUsers.length` assignment
// auth.js's getStudentAuthHeaders() uses, so a VU's cookie and its session
// always belong to the same identity.
//
// Returns null when the VU falls outside the provisioned set — callers should
// return early rather than driving an unprovisioned session.
export function roomForVU(data, vu) {
  const index = (vu - 1) % seedUsers.length
  const user = seedUsers[index]
  const sessionId = data.sessionIdByEmail[user.email]
  if (!sessionId) return null

  const roomIndex = Math.floor(index / data.studentsPerClass)
  const room = data.rooms[roomIndex]
  if (!room) return null

  return { user, sessionId, room, roomIndex }
}
