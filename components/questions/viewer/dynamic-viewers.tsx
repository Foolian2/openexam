"use client"

import dynamic from "next/dynamic"
import { Skeleton } from "@/components/ui/skeleton"

// The dnd-kit drag & drop viewers are the heaviest question renderers (on
// top of the lazy Monaco editor). Read-only pages — results, grading, editor
// preview — load them only when a question of that type actually renders.
// ssr: false keeps their code out of the initial HTML payload entirely; a
// short fallback covers the fetch.
function viewerFallback() {
  return <Skeleton className="h-24 w-full" />
}

export const DynamicMatchingViewer = dynamic(
  () => import("./matching-viewer").then((m) => m.MatchingViewer),
  { ssr: false, loading: viewerFallback }
)

export const DynamicOrderingViewer = dynamic(
  () => import("./ordering-viewer").then((m) => m.OrderingViewer),
  { ssr: false, loading: viewerFallback }
)
