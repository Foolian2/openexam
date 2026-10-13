"use client"

import Link from "next/link"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

const STATUS_TABS = [
  { value: "ALL", label: "Alle" },
  { value: "CLOSED", label: "Zu bewerten" },
  { value: "GRADED", label: "Bewertet" },
  { value: "ARCHIVED", label: "Archiviert" },
]

export function GradeStatusTabs({ current }: { current: string }) {
  const active = STATUS_TABS.some((tab) => tab.value === current)
    ? current
    : "ALL"

  return (
    <Tabs value={active}>
      <TabsList>
        {STATUS_TABS.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} asChild>
            <Link href={`/dashboard/teacher/grades?status=${tab.value}`}>
              {tab.label}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
