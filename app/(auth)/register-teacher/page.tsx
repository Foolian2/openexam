import type { Metadata } from "next"
import { connection } from "next/server"
import { RegisterTeacherForm } from "@/components/auth/register-teacher-form"
import { microsoftConfigured } from "@/lib/env"
import { schoolDomains } from "@/lib/school-domains"

export const metadata: Metadata = {
  title: "Lehrperson registrieren — OpenExam",
}

export default async function RegisterTeacherPage() {
  // Request-time render for the same reason as /register — see that page.
  await connection()
  return (
    <RegisterTeacherForm
      microsoftEnabled={microsoftConfigured()}
      teacherDomains={schoolDomains().teacher}
    />
  )
}
