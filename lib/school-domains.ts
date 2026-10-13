/**
 * School account domains, from SCHOOL_STUDENT_DOMAINS and
 * SCHOOL_TEACHER_DOMAINS (comma-separated, exact match, case-insensitive).
 * An address on a student domain becomes a STUDENT, one on a teacher domain a
 * TEACHER, anything else null. Microsoft logins are only accepted for
 * addresses that match, so leaving both empty rejects every Microsoft login.
 */
type SchoolDomainEnv = {
  SCHOOL_STUDENT_DOMAINS?: string | null
  SCHOOL_TEACHER_DOMAINS?: string | null
}

export function parseDomainList(value: string | null | undefined): string[] {
  if (!value) return []
  return value
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean)
}

export function schoolDomains(
  env: SchoolDomainEnv = process.env as SchoolDomainEnv
): { student: string[]; teacher: string[] } {
  return {
    student: parseDomainList(env.SCHOOL_STUDENT_DOMAINS),
    teacher: parseDomainList(env.SCHOOL_TEACHER_DOMAINS),
  }
}

export function deriveSchoolRole(
  email: string,
  env: SchoolDomainEnv = process.env as SchoolDomainEnv
): "STUDENT" | "TEACHER" | null {
  const domain = email.split("@")[1]?.toLowerCase()
  if (!domain) return null
  const { student, teacher } = schoolDomains(env)
  if (student.includes(domain)) return "STUDENT"
  if (teacher.includes(domain)) return "TEACHER"
  return null
}

/** Error message when the domain lists are unusable, else null. */
export function schoolDomainsIssue(env: SchoolDomainEnv): string | null {
  const { student, teacher } = schoolDomains(env)
  const invalid = [...student, ...teacher].find(
    (d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)
  )
  if (invalid) return `"${invalid}" is not a valid domain`
  const both = student.find((d) => teacher.includes(d))
  if (both) {
    return `"${both}" is listed in both SCHOOL_STUDENT_DOMAINS and SCHOOL_TEACHER_DOMAINS`
  }
  return null
}
