import type { Metadata } from "next"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { CenteredPage } from "@/components/auth/centered-page"

export const metadata: Metadata = {
  title: "Kein Zugriff — OpenExam",
}

export default function UnauthorizedPage() {
  return (
    <CenteredPage>
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="contents">Kein Zugriff</h1>
          </CardTitle>
          <CardDescription>
            Sie haben keine Berechtigung für diese Seite.
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button asChild className="w-full">
            <Link href="/dashboard">Zum Dashboard</Link>
          </Button>
        </CardFooter>
      </Card>
    </CenteredPage>
  )
}
