import Link from "next/link"
import { CenteredPage } from "@/components/auth/centered-page"
import { Logo } from "@/components/brand/logo"

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <CenteredPage>
      <div className="flex w-full flex-col items-center gap-6">
        <Link
          href="/"
          className="rounded-md text-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Logo markClassName="size-9" />
        </Link>
        {children}
      </div>
    </CenteredPage>
  )
}
