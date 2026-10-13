// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { expect, it } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ExamStatusBadge } from "@/components/exams/exam-status-badge"
import type { ExamStatus } from "@/generated/prisma/client"

const labels: Record<ExamStatus, string> = {
  DRAFT: "Entwurf",
  PUBLISHED: "Veröffentlicht",
  ACTIVE: "Aktiv",
  CLOSED: "Beendet",
  GRADED: "Bewertet",
  ARCHIVED: "Archiviert",
}

function renderBadge(status: ExamStatus) {
  return render(
    <TooltipProvider delayDuration={0}>
      <ExamStatusBadge status={status} />
    </TooltipProvider>
  )
}

it.each(Object.entries(labels))("labels %s as %s", (status, label) => {
  renderBadge(status as ExamStatus)
  expect(screen.getByText(label)).toBeInTheDocument()
})

it("explains the status in a tooltip reachable by keyboard", async () => {
  renderBadge("PUBLISHED")
  await userEvent.tab()
  expect(
    (await screen.findAllByText(/erst nach «Starten»/)).length
  ).toBeGreaterThan(0)
})
