import { auth } from "@/lib/auth"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

export default async function DashboardPage() {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session) redirect("/login")

  const role = (session.user as { role?: string }).role

  if (role === "ADMIN") redirect("/dashboard/admin")
  if (role === "TEACHER") redirect("/dashboard/teacher")
  redirect("/dashboard/student")
}
