import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"

/**
 * backHref and backLabel are paired deliberately: the back control is an
 * icon-only link, so its only accessible name is backLabel. Making the two
 * one variant turns "arrow without a label" into a compile error rather than
 * a screen-reader-only defect that no test would catch.
 */
type PageHeaderProps = {
  title: string
  description?: ReactNode
  actions?: ReactNode
} & (
  | { backHref: string; backLabel: string }
  | { backHref?: never; backLabel?: never }
)

export function PageHeader({
  title,
  description,
  actions,
  backHref,
  backLabel,
}: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <SidebarTrigger className="-ml-1" />
          {backHref ? (
            <Button asChild variant="ghost" size="icon" aria-label={backLabel}>
              <Link
                href={backHref}
                className="text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft />
              </Link>
            </Button>
          ) : null}
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        </div>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
