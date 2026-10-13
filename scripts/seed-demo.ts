/**
 * Provisions the two DEMO login accounts (one STUDENT, one TEACHER), a demo
 * class behind the teacher, and a full spread of exam states, so every screen
 * in the app has something real to show during a demo.
 *
 * Unlike scripts/load-seed.ts this mints NO sessions and NO cookies: it only
 * creates users plus a `credential` account row for the two login accounts,
 * with passwords printed once at the end of an --apply run. Signing in goes
 * through the normal login page like any other account, which is why this is
 * safe to run against production (load-seed.ts is not, and refuses to).
 *
 * The class (CLASS below) are user rows WITHOUT credential accounts: they
 * exist so the teacher's monitor, grading queue and statistics have a real
 * cohort, but nobody can sign in as them. Exactly two accounts can log in.
 *
 * All demo users live on example.com (RFC 2606 — never deliverable, and can
 * never be confused with a real @stud.example-school.ch / @example-school.ch account). They are
 * written with emailVerified=true because prod has requireEmailVerification
 * on and no mail can ever reach that domain.
 *
 * Idempotent: every write is keyed on a unique constraint (user email, folder
 * (creatorId,name), exam accessCode, question (examId,order), session
 * (examId,userId), answer/grade (sessionId,questionId)), and the derived rows
 * that have no unique key (integrity events, audit log) are cleared and
 * rewritten. Re-running never duplicates and never resets an already-set
 * password — and it DOES re-anchor the live session's clock to "now", which
 * is how you refresh the dashboard demo after the exam window has run out.
 *
 * Runs inside the `migrate` image, which carries node_modules, lib/ and the
 * generated Prisma client (see Dockerfile's migrate stage). The script itself
 * is bind-mounted rather than baked in, so the deployed images stay untouched:
 *
 *   docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm \
 *     --no-deps -v "$PWD/scripts/seed-demo.ts:/app/scripts/seed-demo.ts:ro" \
 *     -e MATCHING_ID_SECRET \
 *     migrate pnpm tsx scripts/seed-demo.ts --apply
 *
 * MATCHING_ID_SECRET is required: MATCHING right-side ids and the ORDERING
 * display permutation are HMACs keyed with it (lib/exam-session.ts), so a
 * demo answer minted under a different key would grade as wrong.
 *
 *   --apply    write (default is a dry run that only reports what it would do)
 *   --remove   delete every demo row and every demo account
 */
import crypto from "node:crypto"
import { hashPassword } from "better-auth/crypto"
import { prisma } from "@/lib/prisma"
import { matchingRightId } from "@/lib/exam-session"
import { autoGradeSession } from "@/lib/grading/grade-session"
import type { QuestionType } from "@/lib/validators/question"

const STUDENT_EMAIL = "demo.student@example.com"
const TEACHER_EMAIL = "demo.teacher@example.com"

/** The cohort behind the teacher. User rows only — no credential accounts. */
const CLASS = [
  { email: "demo.lena@example.com", name: "Lena Bachmann" },
  { email: "demo.nino@example.com", name: "Nino Steiner" },
  { email: "demo.yara@example.com", name: "Yara Frei" },
  { email: "demo.jonas@example.com", name: "Jonas Widmer" },
  { email: "demo.alina@example.com", name: "Alina Roth" },
  { email: "demo.samuel@example.com", name: "Samuel Keller" },
] as const

const ALL_EMAILS = [STUDENT_EMAIL, TEACHER_EMAIL, ...CLASS.map((c) => c.email)]

// Fixed so the codes are stable across re-runs and can be printed on a
// slide. Alphabet matches lib/access-code.ts (no I/O/0/1).
const CODES = {
  kurven: "DEMOA2",
  python: "DEMOB3",
  vektor: "DEMOC4",
  stochastik: "DEMOD5",
  trigo: "DEMOE6",
  algebra: "DEMOF7",
} as const
const ALL_CODES = Object.values(CODES)

const FOLDER_MATH = "Demo — Mathematik"
const FOLDER_INFO = "Demo — Informatik"
const FOLDER_ARCHIV = "Demo — Archiv"

const apply = process.argv.includes("--apply")
const remove = process.argv.includes("--remove")

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000
const now = Date.now()
const ago = (days: number) => new Date(now - days * DAY)
const agoMin = (days: number, minutes: number) =>
  new Date(now - days * DAY + minutes * MIN)
const minsAgo = (minutes: number) => new Date(now - minutes * MIN)
const minsAhead = (minutes: number) => new Date(now + minutes * MIN)

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value)
    throw new Error(
      `${name} must be set (pass it through with \`-e ${name}\`).`
    )
  return value
}

/** Password policy is better-auth's default (min 8); this is 24 chars of base64url. */
function generatePassword(): string {
  return crypto.randomBytes(18).toString("base64url")
}

// ─── QUESTION AUTHORING ──────────────────────────────────────
// Config shapes are the ones lib/validators/question.ts accepts. Each
// question also carries the answer a student would submit when they get it
// right and (where it can be got wrong mechanically) when they don't, so one
// authored question serves every seeded session.

interface AnswerCtx {
  sessionId: string
  questionId: string
}
interface QDef {
  order: number
  type: QuestionType
  title: string
  points: number
  config: unknown
  /** Omitted for types nobody in the demo answers (e.g. FILE_UPLOAD). */
  ok?: (ctx: AnswerCtx) => unknown
  bad?: (ctx: AnswerCtx) => unknown
}

/** MATCHING right-side ids are per-session HMACs — see lib/exam-session.ts. */
const rid = (ctx: AnswerCtx, pairId: string) =>
  matchingRightId(`${ctx.sessionId}:${ctx.questionId}`, pairId)

const kurvenQuestions: QDef[] = [
  {
    order: 1,
    type: "MULTIPLE_CHOICE",
    title: "Welche Ableitung von f(x) = x³ − 3x ist korrekt?",
    points: 2,
    config: {
      multiSelect: false,
      options: [
        { id: "q1a", text: "f'(x) = 3x² − 3", isCorrect: true },
        { id: "q1b", text: "f'(x) = 3x² − 3x", isCorrect: false },
        { id: "q1c", text: "f'(x) = x² − 3", isCorrect: false },
        { id: "q1d", text: "f'(x) = 3x − 3", isCorrect: false },
      ],
    },
    ok: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["q1a"] }),
    bad: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["q1b"] }),
  },
  {
    order: 2,
    type: "TRUE_FALSE",
    title: "Jede differenzierbare Funktion ist stetig.",
    points: 1,
    config: { isCorrect: true },
    ok: () => ({ type: "TRUE_FALSE", selected: true }),
    bad: () => ({ type: "TRUE_FALSE", selected: false }),
  },
  {
    order: 3,
    type: "SHORT_ANSWER",
    title: "Wie lautet die Nullstelle von f(x) = 2x − 8?",
    points: 1,
    config: {
      acceptedAnswers: ["4", "x = 4", "x=4"],
      caseSensitive: false,
      maxLength: 50,
    },
    ok: () => ({ type: "SHORT_ANSWER", text: "x = 4" }),
    bad: () => ({ type: "SHORT_ANSWER", text: "x = −4" }),
  },
  {
    order: 4,
    type: "FILL_IN_THE_BLANK",
    title: "Ergänze die Begriffe zur Kurvendiskussion.",
    points: 3,
    config: {
      template:
        "An einer Stelle mit f'(x) = 0 und f''(x) < 0 liegt ein {1} vor. Ist f''(x) > 0, handelt es sich um ein {2}. Wechselt f'' das Vorzeichen, spricht man von einem {3}.",
      blanks: [
        {
          id: "1",
          acceptedAnswers: ["Maximum", "Hochpunkt"],
          caseSensitive: false,
        },
        {
          id: "2",
          acceptedAnswers: ["Minimum", "Tiefpunkt"],
          caseSensitive: false,
        },
        { id: "3", acceptedAnswers: ["Wendepunkt"], caseSensitive: false },
      ],
    },
    ok: () => ({
      type: "FILL_IN_THE_BLANK",
      blanks: [
        { id: "1", value: "Maximum" },
        { id: "2", value: "Minimum" },
        { id: "3", value: "Wendepunkt" },
      ],
    }),
    bad: () => ({
      type: "FILL_IN_THE_BLANK",
      blanks: [
        { id: "1", value: "Maximum" },
        { id: "2", value: "Minimum" },
        { id: "3", value: "Sattelpunkt" },
      ],
    }),
  },
  {
    order: 5,
    type: "MATCHING",
    title: "Ordne jeder Funktion ihre Ableitung zu.",
    points: 4,
    config: {
      shuffleSides: true,
      pairs: [
        { id: "m1", left: "sin(x)", right: "cos(x)" },
        { id: "m2", left: "eˣ", right: "eˣ" },
        { id: "m3", left: "ln(x)", right: "1/x" },
        { id: "m4", left: "x²", right: "2x" },
      ],
    },
    ok: (ctx) => ({
      type: "MATCHING",
      matches: ["m1", "m2", "m3", "m4"].map((id) => ({
        leftId: id,
        rightId: rid(ctx, id),
      })),
    }),
    bad: (ctx) => ({
      type: "MATCHING",
      matches: [
        { leftId: "m1", rightId: rid(ctx, "m1") },
        { leftId: "m2", rightId: rid(ctx, "m2") },
        { leftId: "m3", rightId: rid(ctx, "m4") },
        { leftId: "m4", rightId: rid(ctx, "m3") },
      ],
    }),
  },
  {
    order: 6,
    type: "ORDERING",
    title:
      "Bringe die Schritte einer Kurvendiskussion in die richtige Reihenfolge.",
    points: 5,
    config: {
      shuffle: true,
      items: [
        { id: "o1", text: "Definitionsbereich bestimmen" },
        { id: "o2", text: "Nullstellen berechnen" },
        { id: "o3", text: "Erste Ableitung bilden und Extrema bestimmen" },
        { id: "o4", text: "Zweite Ableitung bilden und Wendepunkte bestimmen" },
        { id: "o5", text: "Graphen skizzieren" },
      ],
    },
    ok: () => ({
      type: "ORDERING",
      orderedIds: ["o1", "o2", "o3", "o4", "o5"],
    }),
    bad: () => ({
      type: "ORDERING",
      orderedIds: ["o1", "o3", "o2", "o4", "o5"],
    }),
  },
  {
    order: 7,
    type: "FREE_TEXT",
    title:
      "Erkläre in eigenen Worten, warum die Ableitung die Steigung der Tangente beschreibt.",
    points: 6,
    config: {
      maxLength: 2000,
      richText: false,
      expectedKeywords: [
        "Differenzenquotient",
        "Grenzwert",
        "Tangente",
        "Steigung",
      ],
      rubric: [
        {
          id: "r1",
          criterion: "Differenzenquotient korrekt beschrieben",
          points: 2,
        },
        { id: "r2", criterion: "Grenzwertübergang h → 0 erklärt", points: 2 },
        {
          id: "r3",
          criterion: "Bezug zur Tangentensteigung hergestellt",
          points: 2,
        },
      ],
    },
    ok: () => ({
      type: "FREE_TEXT",
      text:
        "Die Ableitung an einer Stelle x0 ist der Grenzwert des Differenzenquotienten " +
        "(f(x0+h) − f(x0)) / h für h → 0. Der Differenzenquotient ist die Steigung der " +
        "Sekante durch (x0, f(x0)) und (x0+h, f(x0+h)). Lässt man h gegen null gehen, " +
        "rücken die beiden Punkte zusammen und die Sekante geht in die Tangente über. " +
        "Der Grenzwert ist damit genau die Steigung dieser Tangente.",
    }),
    bad: () => ({
      type: "FREE_TEXT",
      text:
        "Die Ableitung gibt die Steigung an. Man rechnet f(x+h) minus f(x) geteilt durch h " +
        "und lässt h klein werden. Dann bekommt man die Tangente.",
    }),
  },
]

const pythonQuestions: QDef[] = [
  {
    order: 1,
    type: "MULTIPLE_CHOICE",
    title: "Welche Datentypen in Python sind unveränderlich (immutable)?",
    points: 3,
    config: {
      multiSelect: true,
      options: [
        { id: "p1a", text: "tuple", isCorrect: true },
        { id: "p1b", text: "str", isCorrect: true },
        { id: "p1c", text: "list", isCorrect: false },
        { id: "p1d", text: "dict", isCorrect: false },
      ],
    },
    ok: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["p1a", "p1b"] }),
    bad: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["p1a"] }),
  },
  {
    order: 2,
    type: "TRUE_FALSE",
    title: "In Python beginnt die Indizierung einer Liste bei 1.",
    points: 1,
    config: { isCorrect: false },
    ok: () => ({ type: "TRUE_FALSE", selected: false }),
    bad: () => ({ type: "TRUE_FALSE", selected: true }),
  },
  {
    order: 3,
    type: "SHORT_ANSWER",
    title: "Welche eingebaute Funktion gibt die Länge einer Liste zurück?",
    points: 1,
    config: {
      acceptedAnswers: ["len", "len()"],
      caseSensitive: false,
      maxLength: 30,
    },
    ok: () => ({ type: "SHORT_ANSWER", text: "len()" }),
    bad: () => ({ type: "SHORT_ANSWER", text: "size()" }),
  },
  {
    order: 4,
    type: "CODE",
    title:
      "Schreibe eine Funktion `fizzbuzz(n)`, die für 1..n die FizzBuzz-Ausgabe als Liste zurückgibt.",
    points: 8,
    config: {
      language: "python",
      starterCode: "def fizzbuzz(n):\n    # Deine Lösung hier\n    pass\n",
      testCases: [
        {
          input: "3",
          expectedOutput: "['1', '2', 'Fizz']",
          hidden: false,
          points: 2,
        },
        {
          input: "5",
          expectedOutput: "['1', '2', 'Fizz', '4', 'Buzz']",
          hidden: false,
          points: 3,
        },
        {
          input: "15",
          expectedOutput: "FizzBuzz an Position 15",
          hidden: true,
          points: 3,
        },
      ],
    },
    ok: () => ({
      type: "CODE",
      language: "python",
      code:
        "def fizzbuzz(n):\n" +
        "    out = []\n" +
        "    for i in range(1, n + 1):\n" +
        "        if i % 15 == 0:\n" +
        "            out.append('FizzBuzz')\n" +
        "        elif i % 3 == 0:\n" +
        "            out.append('Fizz')\n" +
        "        elif i % 5 == 0:\n" +
        "            out.append('Buzz')\n" +
        "        else:\n" +
        "            out.append(str(i))\n" +
        "    return out\n",
    }),
  },
  {
    order: 5,
    type: "FILE_UPLOAD",
    title: "Lade dein kommentiertes Python-Skript als Datei hoch.",
    points: 4,
    config: {
      allowedExtensions: [".py", ".txt", ".pdf"],
      maxFileSizeMB: 10,
      instructions:
        "Eine Datei, maximal 10 MB. Der Dateiname soll deinen Nachnamen enthalten.",
    },
  },
]

const vektorQuestions: QDef[] = [
  {
    order: 1,
    type: "MULTIPLE_CHOICE",
    title: "Wann stehen zwei Vektoren senkrecht aufeinander?",
    points: 2,
    config: {
      multiSelect: false,
      options: [
        { id: "v1a", text: "Wenn ihr Skalarprodukt null ist", isCorrect: true },
        { id: "v1b", text: "Wenn ihr Kreuzprodukt null ist", isCorrect: false },
        { id: "v1c", text: "Wenn sie gleich lang sind", isCorrect: false },
      ],
    },
    ok: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["v1a"] }),
    bad: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["v1b"] }),
  },
  {
    order: 2,
    type: "SHORT_ANSWER",
    title: "Berechne den Betrag des Vektors (3, 4).",
    points: 2,
    config: {
      acceptedAnswers: ["5", "|v| = 5"],
      caseSensitive: false,
      maxLength: 50,
    },
    ok: () => ({ type: "SHORT_ANSWER", text: "5" }),
    bad: () => ({ type: "SHORT_ANSWER", text: "7" }),
  },
  {
    order: 3,
    type: "TRUE_FALSE",
    title:
      "Das Kreuzprodukt zweier Vektoren im ℝ³ steht senkrecht auf beiden Vektoren.",
    points: 1,
    config: { isCorrect: true },
    ok: () => ({ type: "TRUE_FALSE", selected: true }),
    bad: () => ({ type: "TRUE_FALSE", selected: false }),
  },
  {
    order: 4,
    type: "FILL_IN_THE_BLANK",
    title: "Ergänze die Begriffe zur Geradengleichung.",
    points: 2,
    config: {
      template:
        "Eine Gerade in Parameterform lautet g: x⃗ = a⃗ + t · u⃗. Dabei heisst a⃗ der {1} und u⃗ der {2}.",
      blanks: [
        {
          id: "1",
          acceptedAnswers: ["Stützvektor", "Ortsvektor"],
          caseSensitive: false,
        },
        { id: "2", acceptedAnswers: ["Richtungsvektor"], caseSensitive: false },
      ],
    },
    ok: () => ({
      type: "FILL_IN_THE_BLANK",
      blanks: [
        { id: "1", value: "Stützvektor" },
        { id: "2", value: "Richtungsvektor" },
      ],
    }),
    bad: () => ({
      type: "FILL_IN_THE_BLANK",
      blanks: [
        { id: "1", value: "Stützvektor" },
        { id: "2", value: "Normalenvektor" },
      ],
    }),
  },
  {
    order: 5,
    type: "ORDERING",
    title:
      "Ordne die Schritte zur Berechnung des Schnittpunkts zweier Geraden.",
    points: 4,
    config: {
      shuffle: true,
      items: [
        { id: "w1", text: "Beide Geraden gleichsetzen" },
        { id: "w2", text: "Gleichungssystem für die Parameter aufstellen" },
        { id: "w3", text: "Gleichungssystem lösen" },
        { id: "w4", text: "Parameter in eine Gerade einsetzen" },
      ],
    },
    ok: () => ({ type: "ORDERING", orderedIds: ["w1", "w2", "w3", "w4"] }),
    bad: () => ({ type: "ORDERING", orderedIds: ["w2", "w1", "w3", "w4"] }),
  },
  {
    order: 6,
    type: "FREE_TEXT",
    title:
      "Erkläre, wie man den Abstand eines Punktes von einer Ebene bestimmt.",
    points: 6,
    config: {
      maxLength: 2000,
      richText: false,
      expectedKeywords: ["Normalenvektor", "Hesse", "Abstand"],
      rubric: [
        { id: "vr1", criterion: "Hessesche Normalform genannt", points: 3 },
        {
          id: "vr2",
          criterion: "Einsetzen des Punktes korrekt beschrieben",
          points: 3,
        },
      ],
    },
    ok: () => ({
      type: "FREE_TEXT",
      text:
        "Man bringt die Ebene in die Hessesche Normalform, indem man die Koordinatenform " +
        "durch den Betrag des Normalenvektors teilt. Setzt man die Koordinaten des Punktes " +
        "in diese Form ein, ergibt der Betrag des Ergebnisses den Abstand.",
    }),
  },
]

const stochastikQuestions: QDef[] = [
  {
    order: 1,
    type: "MULTIPLE_CHOICE",
    title:
      "Ein fairer Würfel wird einmal geworfen. Wie gross ist P(Augenzahl > 4)?",
    points: 2,
    config: {
      multiSelect: false,
      options: [
        { id: "s1a", text: "1/3", isCorrect: true },
        { id: "s1b", text: "1/2", isCorrect: false },
        { id: "s1c", text: "1/6", isCorrect: false },
        { id: "s1d", text: "2/3", isCorrect: false },
      ],
    },
    ok: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["s1a"] }),
    bad: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["s1c"] }),
  },
  {
    order: 2,
    type: "SHORT_ANSWER",
    title:
      "Wie viele verschiedene Reihenfolgen gibt es für 4 unterscheidbare Bücher?",
    points: 2,
    config: {
      acceptedAnswers: ["24", "4!"],
      caseSensitive: false,
      maxLength: 30,
    },
    ok: () => ({ type: "SHORT_ANSWER", text: "24" }),
    bad: () => ({ type: "SHORT_ANSWER", text: "16" }),
  },
  {
    order: 3,
    type: "TRUE_FALSE",
    title:
      "Bei einer Binomialverteilung sind die Einzelversuche voneinander unabhängig.",
    points: 1,
    config: { isCorrect: true },
    ok: () => ({ type: "TRUE_FALSE", selected: true }),
    bad: () => ({ type: "TRUE_FALSE", selected: false }),
  },
  {
    order: 4,
    type: "MATCHING",
    title: "Ordne jeder Kennzahl ihre Bedeutung zu.",
    points: 3,
    config: {
      shuffleSides: true,
      pairs: [
        {
          id: "n1",
          left: "Erwartungswert",
          right: "Mittlerer Wert auf lange Sicht",
        },
        {
          id: "n2",
          left: "Varianz",
          right: "Mittlere quadratische Abweichung",
        },
        { id: "n3", left: "Standardabweichung", right: "Wurzel der Varianz" },
      ],
    },
    ok: (ctx) => ({
      type: "MATCHING",
      matches: ["n1", "n2", "n3"].map((id) => ({
        leftId: id,
        rightId: rid(ctx, id),
      })),
    }),
    bad: (ctx) => ({
      type: "MATCHING",
      matches: [
        { leftId: "n1", rightId: rid(ctx, "n1") },
        { leftId: "n2", rightId: rid(ctx, "n3") },
        { leftId: "n3", rightId: rid(ctx, "n2") },
      ],
    }),
  },
  {
    order: 5,
    type: "FREE_TEXT",
    title:
      "Erkläre den Unterschied zwischen Laplace-Wahrscheinlichkeit und relativer Häufigkeit.",
    points: 5,
    config: {
      maxLength: 1500,
      richText: false,
      expectedKeywords: ["Laplace", "gleich wahrscheinlich", "Versuch"],
      rubric: [
        {
          id: "sr1",
          criterion: "Laplace-Annahme korrekt beschrieben",
          points: 3,
        },
        {
          id: "sr2",
          criterion: "Empirischer Charakter der relativen Häufigkeit erkannt",
          points: 2,
        },
      ],
    },
    ok: () => ({
      type: "FREE_TEXT",
      text:
        "Die Laplace-Wahrscheinlichkeit wird theoretisch bestimmt und setzt voraus, dass alle " +
        "Elementarereignisse gleich wahrscheinlich sind: P = günstige / mögliche Fälle. Die " +
        "relative Häufigkeit wird dagegen aus tatsächlich durchgeführten Versuchen berechnet " +
        "und nähert sich der Wahrscheinlichkeit erst bei vielen Wiederholungen an.",
    }),
  },
]

const trigoQuestions: QDef[] = [
  {
    order: 1,
    type: "SHORT_ANSWER",
    title: "Wie lautet der Wert von sin(30°)?",
    points: 1,
    config: {
      acceptedAnswers: ["0.5", "1/2", "0,5"],
      caseSensitive: false,
      maxLength: 30,
    },
  },
  {
    order: 2,
    type: "TRUE_FALSE",
    title: "Es gilt sin²(x) + cos²(x) = 1 für alle x.",
    points: 1,
    config: { isCorrect: true },
  },
  {
    order: 3,
    type: "MULTIPLE_CHOICE",
    title: "Welche Periode hat die Funktion f(x) = sin(2x)?",
    points: 2,
    config: {
      multiSelect: false,
      options: [
        { id: "t3a", text: "π", isCorrect: true },
        { id: "t3b", text: "2π", isCorrect: false },
        { id: "t3c", text: "π/2", isCorrect: false },
      ],
    },
  },
]

const algebraQuestions: QDef[] = [
  {
    order: 1,
    type: "MULTIPLE_CHOICE",
    title: "Welche Lösungen hat x² − 5x + 6 = 0?",
    points: 2,
    config: {
      multiSelect: true,
      options: [
        { id: "a1a", text: "x = 2", isCorrect: true },
        { id: "a1b", text: "x = 3", isCorrect: true },
        { id: "a1c", text: "x = −2", isCorrect: false },
        { id: "a1d", text: "x = 6", isCorrect: false },
      ],
    },
    ok: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["a1a", "a1b"] }),
    bad: () => ({ type: "MULTIPLE_CHOICE", selectedOptionIds: ["a1a", "a1d"] }),
  },
  {
    order: 2,
    type: "SHORT_ANSWER",
    title: "Faktorisiere: x² − 9",
    points: 2,
    config: {
      acceptedAnswers: ["(x-3)(x+3)", "(x+3)(x-3)", "(x − 3)(x + 3)"],
      caseSensitive: false,
      maxLength: 60,
    },
    ok: () => ({ type: "SHORT_ANSWER", text: "(x-3)(x+3)" }),
    bad: () => ({ type: "SHORT_ANSWER", text: "(x-3)²" }),
  },
  {
    order: 3,
    type: "TRUE_FALSE",
    title:
      "Eine quadratische Gleichung mit negativer Diskriminante hat keine reelle Lösung.",
    points: 1,
    config: { isCorrect: true },
    ok: () => ({ type: "TRUE_FALSE", selected: true }),
    bad: () => ({ type: "TRUE_FALSE", selected: false }),
  },
  {
    order: 4,
    type: "FILL_IN_THE_BLANK",
    title: "Ergänze die Lösungsformel.",
    points: 2,
    config: {
      template: "Für ax² + bx + c = 0 gilt x = (−b ± √({1})) / (2{2}).",
      blanks: [
        {
          id: "1",
          acceptedAnswers: ["b²-4ac", "b^2-4ac", "b² − 4ac"],
          caseSensitive: false,
        },
        { id: "2", acceptedAnswers: ["a"], caseSensitive: false },
      ],
    },
    ok: () => ({
      type: "FILL_IN_THE_BLANK",
      blanks: [
        { id: "1", value: "b²-4ac" },
        { id: "2", value: "a" },
      ],
    }),
    bad: () => ({
      type: "FILL_IN_THE_BLANK",
      blanks: [
        { id: "1", value: "b²+4ac" },
        { id: "2", value: "a" },
      ],
    }),
  },
]

const bankItems = [
  {
    folder: FOLDER_MATH,
    type: "SHORT_ANSWER" as const,
    title: "Wie lautet die Ableitung von cos(x)?",
    points: 1,
    config: {
      acceptedAnswers: ["-sin(x)", "−sin(x)", "-sin x"],
      caseSensitive: false,
      maxLength: 50,
    },
  },
  {
    folder: FOLDER_MATH,
    type: "TRUE_FALSE" as const,
    title: "Jede stetige Funktion ist differenzierbar.",
    points: 1,
    config: { isCorrect: false },
  },
  {
    folder: FOLDER_INFO,
    type: "MULTIPLE_CHOICE" as const,
    title: "Welche Aussage über Python-Dictionaries trifft zu?",
    points: 2,
    config: {
      multiSelect: false,
      options: [
        { id: "bi3a", text: "Schlüssel müssen hashbar sein", isCorrect: true },
        { id: "bi3b", text: "Schlüssel müssen Strings sein", isCorrect: false },
        {
          id: "bi3c",
          text: "Dictionaries sind immer sortiert nach Schlüssel",
          isCorrect: false,
        },
      ],
    },
  },
  {
    folder: FOLDER_MATH,
    type: "ORDERING" as const,
    title: "Ordne die Rechenschritte beim Lösen einer linearen Gleichung.",
    points: 3,
    config: {
      shuffle: true,
      items: [
        { id: "bo1", text: "Klammern auflösen" },
        { id: "bo2", text: "Gleichartige Terme zusammenfassen" },
        { id: "bo3", text: "Variablen auf eine Seite bringen" },
        { id: "bo4", text: "Durch den Koeffizienten teilen" },
      ],
    },
  },
  {
    folder: FOLDER_MATH,
    type: "FILL_IN_THE_BLANK" as const,
    title: "Ergänze: Ableitungsregeln",
    points: 2,
    config: {
      template:
        "Die Ableitung eines Produkts folgt der {1}, die einer Verkettung der {2}.",
      blanks: [
        { id: "1", acceptedAnswers: ["Produktregel"], caseSensitive: false },
        { id: "2", acceptedAnswers: ["Kettenregel"], caseSensitive: false },
      ],
    },
  },
  {
    folder: FOLDER_INFO,
    type: "CODE" as const,
    title:
      "Schreibe eine Funktion, die die Summe einer Zahlenliste zurückgibt.",
    points: 4,
    config: {
      language: "python",
      starterCode: "def summe(zahlen):\n    pass\n",
      testCases: [
        { input: "[1, 2, 3]", expectedOutput: "6", hidden: false, points: 2 },
        { input: "[]", expectedOutput: "0", hidden: true, points: 2 },
      ],
    },
  },
  {
    folder: FOLDER_INFO,
    type: "TRUE_FALSE" as const,
    title: "Ein Set in Python kann doppelte Elemente enthalten.",
    points: 1,
    config: { isCorrect: false },
  },
  {
    folder: FOLDER_INFO,
    type: "MATCHING" as const,
    title: "Ordne jedem Python-Operator seine Bedeutung zu.",
    points: 3,
    // Shared via link — the only bank item with a share token, so the
    // "geteilt" state is visible in the demo.
    shared: true,
    config: {
      shuffleSides: true,
      pairs: [
        { id: "bm1", left: "//", right: "Ganzzahlige Division" },
        { id: "bm2", left: "%", right: "Rest der Division" },
        { id: "bm3", left: "**", right: "Potenzierung" },
      ],
    },
  },
]

// ─── HELPERS ─────────────────────────────────────────────────

/** Upserts questions for an exam and returns order → questionId. */
async function upsertQuestions(examId: string, defs: QDef[]) {
  const ids: Record<number, string> = {}
  for (const q of defs) {
    const row = await prisma.question.upsert({
      where: { examId_order: { examId, order: q.order } },
      update: {
        type: q.type,
        title: q.title,
        points: q.points,
        config: q.config as never,
      },
      create: {
        examId,
        order: q.order,
        type: q.type,
        title: q.title,
        points: q.points,
        required: true,
        config: q.config as never,
      },
    })
    ids[q.order] = row.id
  }
  return ids
}

interface SessionSpec {
  userId: string
  /** Question orders this student got wrong; the rest are answered correctly. */
  wrong?: number[]
  /** Question orders left unanswered (a partially finished session). */
  skip?: number[]
  status: "IN_PROGRESS" | "SUBMITTED"
  startedAt: Date
  submittedAt?: Date
  effectiveEndTime: Date
  lastSeenAt: Date
  reconnectCount?: number
  timeExtensionMin?: number
  namApplied?: boolean
}

/** Creates/refreshes one session and writes its answers. Returns the session id. */
async function upsertSession(
  examId: string,
  defs: QDef[],
  questionIds: Record<number, string>,
  spec: SessionSpec
) {
  const shared = {
    status: spec.status,
    startedAt: spec.startedAt,
    submittedAt: spec.submittedAt ?? null,
    effectiveEndTime: spec.effectiveEndTime,
    submissionType: spec.status === "SUBMITTED" ? ("MANUAL" as const) : null,
    lastSeenAt: spec.lastSeenAt,
    reconnectCount: spec.reconnectCount ?? 0,
    timeExtensionMin: spec.timeExtensionMin ?? 0,
    namApplied: spec.namApplied ?? false,
  }
  // `update` carries the same clock fields as `create`, so re-running the
  // script re-anchors an in-progress session to the current time instead of
  // leaving a long-expired one behind.
  const session = await prisma.examSession.upsert({
    where: { examId_userId: { examId, userId: spec.userId } },
    update: shared,
    create: { examId, userId: spec.userId, ...shared },
  })

  const wrong = new Set(spec.wrong ?? [])
  const skip = new Set(spec.skip ?? [])
  for (const q of defs) {
    const questionId = questionIds[q.order]
    if (skip.has(q.order)) {
      await prisma.answer.deleteMany({
        where: { sessionId: session.id, questionId },
      })
      continue
    }
    const build = wrong.has(q.order) ? (q.bad ?? q.ok) : q.ok
    if (!build) continue
    const content = build({ sessionId: session.id, questionId })
    await prisma.answer.upsert({
      where: { sessionId_questionId: { sessionId: session.id, questionId } },
      update: { content: content as never },
      create: {
        sessionId: session.id,
        questionId,
        content: content as never,
        createdAt: new Date(spec.startedAt.getTime() + q.order * 3 * MIN),
        updatedAt: new Date(spec.startedAt.getTime() + q.order * 3 * MIN + MIN),
      },
    })
  }
  return session.id
}

/** Manual grade for a type autoGrade() cannot score (FREE_TEXT / CODE). */
async function manualGrade(
  sessionId: string,
  questionId: string,
  points: number,
  maxPoints: number,
  feedback: string,
  teacherId: string,
  gradedAt: Date
) {
  await prisma.grade.upsert({
    where: { sessionId_questionId: { sessionId, questionId } },
    update: {
      points,
      maxPoints,
      feedback,
      autoGraded: false,
      gradedById: teacherId,
      gradedAt,
    },
    create: {
      sessionId,
      questionId,
      points,
      maxPoints,
      feedback,
      autoGraded: false,
      gradedById: teacherId,
      gradedAt,
    },
  })
}

async function report() {
  const users = await prisma.user.findMany({
    where: { email: { in: ALL_EMAILS } },
    select: { email: true, role: true },
  })
  const exams = await prisma.exam.findMany({
    where: { accessCode: { in: ALL_CODES } },
    select: {
      accessCode: true,
      title: true,
      status: true,
      creator: { select: { email: true } },
    },
  })
  console.log("── current state ──")
  console.log(
    `users: ${users.length ? users.map((u) => `${u.email} (${u.role})`).join(", ") : "none"}`
  )
  console.log(
    `exams: ${exams.length ? exams.map((e) => `${e.accessCode} ${e.status}`).join(", ") : "none"}`
  )

  // An access code we intend to claim must not already belong to somebody
  // else's exam — upserting on it would silently hijack a real exam.
  const foreign = exams.filter((e) => e.creator.email !== TEACHER_EMAIL)
  if (foreign.length > 0) {
    throw new Error(
      `access code(s) ${foreign.map((e) => e.accessCode).join(", ")} already belong to an exam not owned by ${TEACHER_EMAIL} — refusing to touch them.`
    )
  }
}

async function seed() {
  requireEnv("MATCHING_ID_SECRET")

  // ── users ──────────────────────────────────────────────────
  const teacher = await prisma.user.upsert({
    where: { email: TEACHER_EMAIL },
    update: { role: "TEACHER", emailVerified: true },
    create: {
      email: TEACHER_EMAIL,
      name: "Demo Lehrperson",
      role: "TEACHER",
      emailVerified: true,
      onboardingDismissed: true,
      createdAt: ago(30),
    },
  })
  const student = await prisma.user.upsert({
    where: { email: STUDENT_EMAIL },
    update: { role: "STUDENT", emailVerified: true },
    create: {
      email: STUDENT_EMAIL,
      name: "Demo Schüler",
      role: "STUDENT",
      emailVerified: true,
      onboardingDismissed: true,
      createdAt: ago(28),
    },
  })
  const klasse = []
  for (const c of CLASS) {
    klasse.push(
      await prisma.user.upsert({
        where: { email: c.email },
        update: { role: "STUDENT", emailVerified: true },
        create: {
          email: c.email,
          name: c.name,
          role: "STUDENT",
          emailVerified: true,
          onboardingDismissed: true,
          createdAt: ago(28),
        },
      })
    )
  }

  // ── credential accounts (login accounts only) ──────────────
  const passwords: Record<string, string> = {}
  for (const user of [teacher, student]) {
    const existing = await prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
      select: { id: true },
    })
    if (existing) {
      passwords[user.email] = "(unverändert — bereits gesetzt)"
      continue
    }
    const password = generatePassword()
    await prisma.account.create({
      data: {
        userId: user.id,
        // better-auth keys a credential account by (providerId, accountId),
        // where the account key is the linked user's stable id.
        accountId: user.id,
        providerId: "credential",
        password: await hashPassword(password),
      },
    })
    passwords[user.email] = password
  }

  // ── folders ────────────────────────────────────────────────
  const folders: Record<string, string> = {}
  for (const [name, daysAgo] of [
    [FOLDER_MATH, 30],
    [FOLDER_INFO, 29],
    [FOLDER_ARCHIV, 200],
  ] as const) {
    const f = await prisma.folder.upsert({
      where: { creatorId_name: { creatorId: teacher.id, name } },
      update: {},
      create: { name, creatorId: teacher.id, createdAt: ago(daysAgo) },
    })
    folders[name] = f.id
  }

  // ── exams ──────────────────────────────────────────────────
  const kurven = await prisma.exam.upsert({
    where: { accessCode: CODES.kurven },
    update: { status: "GRADED", folderId: folders[FOLDER_MATH] },
    create: {
      title: "Demo-Prüfung: Kurvendiskussion (Musterprüfung)",
      description:
        "Abgeschlossene Musterprüfung — zeigt Korrektur, Punkte und Rückmeldung.",
      status: "GRADED",
      accessCode: CODES.kurven,
      timeLimitMin: 60,
      shuffleOptions: true,
      showResults: true,
      creatorId: teacher.id,
      folderId: folders[FOLDER_MATH],
      createdAt: ago(14),
      activatedAt: ago(10),
      closedAt: agoMin(10, 75),
    },
  })
  const python = await prisma.exam.upsert({
    where: { accessCode: CODES.python },
    update: { status: "PUBLISHED", folderId: folders[FOLDER_INFO] },
    create: {
      title: "Demo-Prüfung: Python-Grundlagen",
      description:
        "Veröffentlichte Prüfung, bereit zum Starten — mit Code- und Datei-Upload-Aufgabe.",
      status: "PUBLISHED",
      accessCode: CODES.python,
      timeLimitMin: 90,
      shuffleQuestions: true,
      shuffleOptions: true,
      creatorId: teacher.id,
      folderId: folders[FOLDER_INFO],
      createdAt: ago(3),
      scheduledStart: new Date(now + 2 * DAY),
      scheduledEnd: new Date(now + 2 * DAY + 90 * MIN),
    },
  })
  // The live one. A long window so the dashboard demo keeps working for
  // hours; re-running the script resets the clock (see upsertSession).
  const vektor = await prisma.exam.upsert({
    where: { accessCode: CODES.vektor },
    update: {
      status: "ACTIVE",
      folderId: folders[FOLDER_MATH],
      activatedAt: minsAgo(35),
    },
    create: {
      title: "Demo-Prüfung: Vektorgeometrie (läuft gerade)",
      description: "Laufende Prüfung — offen im Live-Monitor.",
      status: "ACTIVE",
      accessCode: CODES.vektor,
      timeLimitMin: 240,
      showResults: true,
      creatorId: teacher.id,
      folderId: folders[FOLDER_MATH],
      createdAt: ago(6),
      activatedAt: minsAgo(35),
    },
  })
  const stochastik = await prisma.exam.upsert({
    where: { accessCode: CODES.stochastik },
    update: { status: "CLOSED", folderId: folders[FOLDER_MATH] },
    create: {
      title: "Demo-Prüfung: Stochastik",
      description:
        "Beendet, aber noch nicht bewertet — füllt die Korrekturliste.",
      status: "CLOSED",
      accessCode: CODES.stochastik,
      timeLimitMin: 45,
      creatorId: teacher.id,
      folderId: folders[FOLDER_MATH],
      createdAt: ago(5),
      activatedAt: ago(2),
      closedAt: agoMin(2, 55),
    },
  })
  const trigo = await prisma.exam.upsert({
    where: { accessCode: CODES.trigo },
    update: { status: "DRAFT", folderId: folders[FOLDER_MATH] },
    create: {
      title: "Demo-Prüfung: Trigonometrie (Entwurf)",
      description:
        "Unfertiger Entwurf — zeigt den Editor mit halbfertiger Prüfung.",
      status: "DRAFT",
      accessCode: CODES.trigo,
      timeLimitMin: 45,
      creatorId: teacher.id,
      folderId: folders[FOLDER_MATH],
      createdAt: ago(1),
    },
  })
  const algebra = await prisma.exam.upsert({
    where: { accessCode: CODES.algebra },
    update: { status: "ARCHIVED", folderId: folders[FOLDER_ARCHIV] },
    create: {
      title: "Demo-Prüfung: Algebra (Vorjahr)",
      description: "Archivierte Prüfung aus dem letzten Schuljahr.",
      status: "ARCHIVED",
      statusBeforeArchive: "GRADED",
      accessCode: CODES.algebra,
      timeLimitMin: 50,
      showResults: true,
      creatorId: teacher.id,
      folderId: folders[FOLDER_ARCHIV],
      createdAt: ago(190),
      activatedAt: ago(180),
      closedAt: ago(180),
      archivedAt: ago(120),
    },
  })

  const qKurven = await upsertQuestions(kurven.id, kurvenQuestions)
  // Python and Trigonometrie carry no sessions, so their question ids are
  // never needed to seed answers.
  await upsertQuestions(python.id, pythonQuestions)
  const qVektor = await upsertQuestions(vektor.id, vektorQuestions)
  const qStoch = await upsertQuestions(stochastik.id, stochastikQuestions)
  await upsertQuestions(trigo.id, trigoQuestions)
  const qAlgebra = await upsertQuestions(algebra.id, algebraQuestions)

  // ── question bank ──────────────────────────────────────────
  for (const item of bankItems) {
    const folderId = folders[item.folder]
    const existing = await prisma.questionBankItem.findFirst({
      where: { creatorId: teacher.id, title: item.title },
      select: { id: true, shareToken: true },
    })
    const shareToken =
      "shared" in item && item.shared
        ? (existing?.shareToken ?? crypto.randomBytes(16).toString("hex"))
        : null
    if (existing) {
      await prisma.questionBankItem.update({
        where: { id: existing.id },
        data: {
          type: item.type,
          points: item.points,
          config: item.config as never,
          folderId,
          shareToken,
        },
      })
    } else {
      await prisma.questionBankItem.create({
        data: {
          creatorId: teacher.id,
          folderId,
          type: item.type,
          title: item.title,
          points: item.points,
          required: true,
          config: item.config as never,
          shareToken,
          createdAt: ago(20),
        },
      })
    }
  }

  // ── sessions ───────────────────────────────────────────────
  // Kurvendiskussion (GRADED): the demo student plus the whole class, with
  // spread-out results so the statistics view shows a real distribution.
  const kurvenSpecs: { user: string; wrong: number[] }[] = [
    { user: student.id, wrong: [4, 5, 6] },
    { user: klasse[0].id, wrong: [] },
    { user: klasse[1].id, wrong: [5] },
    { user: klasse[2].id, wrong: [1, 4, 6] },
    { user: klasse[3].id, wrong: [2, 3, 5, 6] },
    { user: klasse[4].id, wrong: [1, 2, 3, 4, 5, 6] },
    { user: klasse[5].id, wrong: [3, 6] },
  ]
  const kurvenSessions: string[] = []
  for (const [i, spec] of kurvenSpecs.entries()) {
    kurvenSessions.push(
      await upsertSession(kurven.id, kurvenQuestions, qKurven, {
        userId: spec.user,
        wrong: spec.wrong,
        status: "SUBMITTED",
        startedAt: ago(10),
        submittedAt: agoMin(10, 38 + i),
        effectiveEndTime: agoMin(10, 60),
        lastSeenAt: agoMin(10, 38 + i),
        reconnectCount: i % 3,
        // One student with Nachteilsausgleich, so the +15% badge is visible.
        ...(i === 3 ? { namApplied: true, timeExtensionMin: 9 } : {}),
      })
    )
  }

  // Vektorgeometrie (ACTIVE): exactly ONE open session — the demo student's,
  // still running — plus three classmates who already handed in.
  const liveSessionId = await upsertSession(
    vektor.id,
    vektorQuestions,
    qVektor,
    {
      userId: student.id,
      wrong: [],
      // Three of six answered so the monitor shows real progress, not a
      // finished-looking row.
      skip: [4, 5, 6],
      status: "IN_PROGRESS",
      startedAt: minsAgo(28),
      effectiveEndTime: minsAhead(212),
      lastSeenAt: minsAgo(1),
      reconnectCount: 2,
    }
  )
  for (const [i, u] of [klasse[0], klasse[1], klasse[2]].entries()) {
    await upsertSession(vektor.id, vektorQuestions, qVektor, {
      userId: u.id,
      wrong: i === 1 ? [2, 5] : i === 2 ? [1] : [],
      status: "SUBMITTED",
      startedAt: minsAgo(33),
      submittedAt: minsAgo(6 - i),
      effectiveEndTime: minsAhead(207),
      lastSeenAt: minsAgo(6 - i),
    })
  }
  // klasse[3..5] deliberately have no session — "noch nicht gestartet".

  // The live student flagged a question to come back to — visible both to
  // them and (as progress) in the monitor.
  await prisma.questionBookmark.upsert({
    where: {
      sessionId_questionId: {
        sessionId: liveSessionId,
        questionId: qVektor[5],
      },
    },
    update: {},
    create: { sessionId: liveSessionId, questionId: qVektor[5] },
  })

  // Stochastik (CLOSED, ungraded): fills the correction queue.
  const stochSpecs = [
    { user: student.id, wrong: [2] },
    { user: klasse[0].id, wrong: [] },
    { user: klasse[1].id, wrong: [1, 4] },
    { user: klasse[3].id, wrong: [2, 3] },
    { user: klasse[4].id, wrong: [1, 2, 4] },
  ]
  for (const [i, spec] of stochSpecs.entries()) {
    await upsertSession(stochastik.id, stochastikQuestions, qStoch, {
      userId: spec.user,
      wrong: spec.wrong,
      status: "SUBMITTED",
      startedAt: ago(2),
      submittedAt: agoMin(2, 40 + i),
      effectiveEndTime: agoMin(2, 45),
      lastSeenAt: agoMin(2, 40 + i),
    })
  }

  // Algebra (ARCHIVED, graded last year).
  const algebraSessions: string[] = []
  for (const [i, u] of [student, klasse[0], klasse[1], klasse[2]].entries()) {
    algebraSessions.push(
      await upsertSession(algebra.id, algebraQuestions, qAlgebra, {
        userId: u.id,
        wrong: [[], [2], [1, 4], [3]][i],
        status: "SUBMITTED",
        startedAt: ago(180),
        submittedAt: ago(180),
        effectiveEndTime: ago(180),
        lastSeenAt: ago(180),
      })
    )
  }

  // ── integrity events (no unique key: rewrite) ──────────────
  const allSessions = [...kurvenSessions, liveSessionId]
  await prisma.integrityEvent.deleteMany({
    where: { sessionId: { in: allSessions } },
  })
  await prisma.integrityEvent.createMany({
    data: [
      {
        sessionId: kurvenSessions[0],
        kind: "TAB_HIDDEN",
        detail: "12s",
        clientTime: agoMin(10, 8),
      },
      {
        sessionId: kurvenSessions[0],
        kind: "WINDOW_BLUR",
        detail: null,
        clientTime: agoMin(10, 9),
      },
      {
        sessionId: kurvenSessions[0],
        kind: "COPY_BLOCKED",
        detail: "Frage 7",
        clientTime: agoMin(10, 31),
      },
      {
        sessionId: kurvenSessions[0],
        kind: "TAB_HIDDEN",
        detail: "4s",
        clientTime: agoMin(10, 33),
      },
      {
        sessionId: kurvenSessions[3],
        kind: "PASTE_BLOCKED",
        detail: "Frage 7",
        clientTime: agoMin(10, 27),
      },
      // The live session — these are what raises it into the monitor's
      // "attention" list while the exam is running.
      {
        sessionId: liveSessionId,
        kind: "TAB_HIDDEN",
        detail: "21s",
        clientTime: minsAgo(19),
      },
      {
        sessionId: liveSessionId,
        kind: "WINDOW_BLUR",
        detail: null,
        clientTime: minsAgo(18),
      },
      {
        sessionId: liveSessionId,
        kind: "SHORTCUT_BLOCKED",
        detail: "Ctrl+P",
        clientTime: minsAgo(11),
      },
      {
        sessionId: liveSessionId,
        kind: "CONTEXT_MENU_BLOCKED",
        detail: null,
        clientTime: minsAgo(4),
      },
    ],
  })

  // ── grades ─────────────────────────────────────────────────
  // Auto-gradable types go through the real grader, so the points are exactly
  // what the app would compute. Stochastik is left ungraded on purpose.
  const gradedAt = agoMin(9, 0)
  for (const [i, sessionId] of kurvenSessions.entries()) {
    await autoGradeSession(sessionId)
    const freeTextPoints = [5, 6, 5, 4, 3, 2, 4][i]
    await manualGrade(
      sessionId,
      qKurven[7],
      freeTextPoints,
      6,
      freeTextPoints >= 5
        ? "Differenzenquotient und Grenzwertübergang sind sauber erklärt. Der Übergang von der Sekante zur Tangente könnte noch etwas präziser begründet werden."
        : "Die Grundidee stimmt, aber der Grenzwertübergang h → 0 wird nicht wirklich begründet. Bitte den Zusammenhang Sekante → Tangente ausführen.",
      teacher.id,
      gradedAt
    )
  }
  await prisma.grade.updateMany({
    where: { sessionId: { in: kurvenSessions }, autoGraded: true },
    data: {
      gradedById: teacher.id,
      reviewedAt: agoMin(9, 5),
      reviewedById: teacher.id,
    },
  })
  for (const sessionId of algebraSessions) {
    await autoGradeSession(sessionId)
  }

  // ── audit log (no unique key: rewrite the demo's own rows) ──
  const examIds = [
    kurven.id,
    python.id,
    vektor.id,
    stochastik.id,
    trigo.id,
    algebra.id,
  ]
  await prisma.auditLog.deleteMany({ where: { examId: { in: examIds } } })
  await prisma.auditLog.createMany({
    data: [
      {
        action: "EXAM_CREATED",
        entityType: "Exam",
        entityId: kurven.id,
        examId: kurven.id,
        userId: teacher.id,
        timestamp: ago(14),
        metadata: { title: kurven.title },
      },
      {
        action: "QUESTION_ADDED",
        entityType: "Question",
        entityId: qKurven[1],
        examId: kurven.id,
        userId: teacher.id,
        timestamp: ago(13),
        metadata: { order: 1 },
      },
      {
        action: "EXAM_PUBLISHED",
        entityType: "Exam",
        entityId: kurven.id,
        examId: kurven.id,
        userId: teacher.id,
        timestamp: ago(12),
      },
      {
        action: "EXAM_ACTIVATED",
        entityType: "Exam",
        entityId: kurven.id,
        examId: kurven.id,
        userId: teacher.id,
        timestamp: ago(10),
      },
      {
        action: "SESSION_SUBMITTED",
        entityType: "ExamSession",
        entityId: kurvenSessions[0],
        examId: kurven.id,
        userId: student.id,
        timestamp: agoMin(10, 38),
        metadata: { submissionType: "MANUAL" },
      },
      {
        action: "EXAM_CLOSED",
        entityType: "Exam",
        entityId: kurven.id,
        examId: kurven.id,
        userId: teacher.id,
        timestamp: agoMin(10, 75),
      },
      {
        action: "SESSION_GRADED",
        entityType: "ExamSession",
        entityId: kurvenSessions[0],
        examId: kurven.id,
        userId: teacher.id,
        timestamp: gradedAt,
      },
      {
        action: "BULK_GRADE_APPLIED",
        entityType: "Exam",
        entityId: kurven.id,
        examId: kurven.id,
        userId: teacher.id,
        timestamp: agoMin(9, 5),
      },
      {
        action: "EXAM_GRADED",
        entityType: "Exam",
        entityId: kurven.id,
        examId: kurven.id,
        userId: teacher.id,
        timestamp: agoMin(9, 10),
      },
      {
        action: "RESULTS_EXPORTED",
        entityType: "Exam",
        entityId: kurven.id,
        examId: kurven.id,
        userId: teacher.id,
        timestamp: agoMin(9, 20),
        metadata: { format: "csv" },
      },
      {
        action: "EXAM_CREATED",
        entityType: "Exam",
        entityId: python.id,
        examId: python.id,
        userId: teacher.id,
        timestamp: ago(3),
        metadata: { title: python.title },
      },
      {
        action: "EXAM_PUBLISHED",
        entityType: "Exam",
        entityId: python.id,
        examId: python.id,
        userId: teacher.id,
        timestamp: ago(2),
      },
      {
        action: "EXAM_CREATED",
        entityType: "Exam",
        entityId: vektor.id,
        examId: vektor.id,
        userId: teacher.id,
        timestamp: ago(6),
        metadata: { title: vektor.title },
      },
      {
        action: "EXAM_PUBLISHED",
        entityType: "Exam",
        entityId: vektor.id,
        examId: vektor.id,
        userId: teacher.id,
        timestamp: ago(1),
      },
      {
        action: "EXAM_ACTIVATED",
        entityType: "Exam",
        entityId: vektor.id,
        examId: vektor.id,
        userId: teacher.id,
        timestamp: minsAgo(35),
      },
      {
        action: "EXAM_CREATED",
        entityType: "Exam",
        entityId: stochastik.id,
        examId: stochastik.id,
        userId: teacher.id,
        timestamp: ago(5),
        metadata: { title: stochastik.title },
      },
      {
        action: "EXAM_ACTIVATED",
        entityType: "Exam",
        entityId: stochastik.id,
        examId: stochastik.id,
        userId: teacher.id,
        timestamp: ago(2),
      },
      {
        action: "EXAM_CLOSED",
        entityType: "Exam",
        entityId: stochastik.id,
        examId: stochastik.id,
        userId: teacher.id,
        timestamp: agoMin(2, 55),
      },
      {
        action: "EXAM_CREATED",
        entityType: "Exam",
        entityId: trigo.id,
        examId: trigo.id,
        userId: teacher.id,
        timestamp: ago(1),
        metadata: { title: trigo.title },
      },
      {
        action: "EXAM_CREATED",
        entityType: "Exam",
        entityId: algebra.id,
        examId: algebra.id,
        userId: teacher.id,
        timestamp: ago(190),
        metadata: { title: algebra.title },
      },
      {
        action: "EXAM_GRADED",
        entityType: "Exam",
        entityId: algebra.id,
        examId: algebra.id,
        userId: teacher.id,
        timestamp: ago(179),
      },
      {
        action: "EXAM_ARCHIVED",
        entityType: "Exam",
        entityId: algebra.id,
        examId: algebra.id,
        userId: teacher.id,
        timestamp: ago(120),
      },
    ],
  })

  // ── summary ────────────────────────────────────────────────
  const kurvenGrades = await prisma.grade.groupBy({
    by: ["sessionId"],
    where: { sessionId: { in: kurvenSessions } },
    _sum: { points: true, maxPoints: true },
  })
  const live = await prisma.examSession.findUnique({
    where: { id: liveSessionId },
    select: {
      effectiveEndTime: true,
      _count: { select: { answers: true, integrityEvents: true } },
    },
  })

  console.log("")
  console.log("── login accounts ──")
  console.log(
    `Lehrperson : ${TEACHER_EMAIL}   Passwort: ${passwords[TEACHER_EMAIL]}`
  )
  console.log(
    `Schüler    : ${STUDENT_EMAIL}   Passwort: ${passwords[STUDENT_EMAIL]}`
  )
  console.log(
    `Klasse     : ${CLASS.length} weitere Schüler:innen (keine Anmeldung möglich)`
  )
  console.log("")
  console.log("── exams ──")
  for (const [e, code, n] of [
    [kurven, CODES.kurven, kurvenQuestions.length],
    [python, CODES.python, pythonQuestions.length],
    [vektor, CODES.vektor, vektorQuestions.length],
    [stochastik, CODES.stochastik, stochastikQuestions.length],
    [trigo, CODES.trigo, trigoQuestions.length],
    [algebra, CODES.algebra, algebraQuestions.length],
  ] as const) {
    const sessions = await prisma.examSession.count({ where: { examId: e.id } })
    console.log(
      `${code}  ${String(e.status).padEnd(9)} ${String(n).padStart(2)} Fragen  ${String(sessions).padStart(2)} Sitzungen  "${e.title}"`
    )
  }
  console.log("")
  console.log("── live session ──")
  console.log(
    `${STUDENT_EMAIL} in ${CODES.vektor}: IN_PROGRESS, ${live?._count.answers}/${vektorQuestions.length} beantwortet, ` +
      `${live?._count.integrityEvents} Integritätsereignisse, läuft bis ${live?.effectiveEndTime?.toISOString()}`
  )
  console.log("")
  console.log("── results (Kurvendiskussion) ──")
  console.log(
    kurvenGrades
      .map((g) => `${g._sum.points}/${g._sum.maxPoints}`)
      .sort()
      .join("  ")
  )
}

async function teardown() {
  const users = await prisma.user.findMany({
    where: { email: { in: ALL_EMAILS } },
    select: { id: true, email: true },
  })
  if (users.length === 0) {
    console.log("Nothing to remove — no demo account exists.")
    return
  }
  const userIds = users.map((u) => u.id)
  const exams = await prisma.exam.findMany({
    where: { accessCode: { in: ALL_CODES }, creatorId: { in: userIds } },
    select: { id: true },
  })
  const examIds = exams.map((e) => e.id)
  const sessions = await prisma.examSession.findMany({
    where: { OR: [{ examId: { in: examIds } }, { userId: { in: userIds } }] },
    select: { id: true },
  })
  const sessionIds = sessions.map((s) => s.id)

  // Order matters: Grade and Question hold restrict-style FKs (no cascade),
  // so they go before the rows they point at.
  await prisma.grade.deleteMany({ where: { sessionId: { in: sessionIds } } })
  await prisma.questionBookmark.deleteMany({
    where: { sessionId: { in: sessionIds } },
  })
  await prisma.answer.deleteMany({ where: { sessionId: { in: sessionIds } } })
  await prisma.integrityEvent.deleteMany({
    where: { sessionId: { in: sessionIds } },
  })
  await prisma.examSession.deleteMany({ where: { id: { in: sessionIds } } })
  await prisma.auditLog.deleteMany({
    where: { OR: [{ examId: { in: examIds } }, { userId: { in: userIds } }] },
  })
  await prisma.question.deleteMany({ where: { examId: { in: examIds } } })
  await prisma.questionBankItem.deleteMany({
    where: { creatorId: { in: userIds } },
  })
  await prisma.exam.deleteMany({ where: { id: { in: examIds } } })
  await prisma.folder.deleteMany({ where: { creatorId: { in: userIds } } })
  // session/account/passkey cascade off User.
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })

  console.log(
    `Removed ${users.length} demo user(s), ${examIds.length} exam(s), ${sessionIds.length} session(s) and their dependent rows.`
  )
}

async function main() {
  await report()
  if (remove) {
    if (!apply) {
      console.log(
        "\nDry run — pass --apply together with --remove to actually delete."
      )
      return
    }
    await teardown()
    return
  }
  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply.")
    return
  }
  await seed()
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
