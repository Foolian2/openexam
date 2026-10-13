"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import { useTheme } from "next-themes"

import { EXAM_TAKE_PATH_RE, takePreExamTheme } from "@/lib/pre-exam-theme"

// Consumed by exam-runner.tsx's session-only theme handling: while the exam
// runs, the runner pins the pre-exam theme under this key. This component
// restores it on the first page that isn't the exam itself (submit, back
// navigation, reload after a tab closed mid-exam) and clears the pin. The
// pin is tab-owned (see lib/pre-exam-theme.ts), so a second tab browsing the
// dashboard mid-exam does not consume it out from under the exam tab.
export function SessionThemeRestore() {
  const { setTheme } = useTheme()
  const pathname = usePathname()

  useEffect(() => {
    // The exam page itself keeps its in-exam choice (incl. across reloads).
    if (pathname && EXAM_TAKE_PATH_RE.test(pathname)) return
    const original = takePreExamTheme()
    if (original === null) return
    setTheme(original)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname])

  return null
}
