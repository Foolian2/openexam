import { Skeleton } from "@/components/ui/skeleton"

export default function GradeSessionLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex max-w-3xl flex-col gap-6 p-6 pb-24"
    >
      <span className="sr-only" role="status">
        Lädt…
      </span>
      <div className="sticky top-0 z-10 -mx-6 flex flex-wrap items-center justify-between gap-3 border-b bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Skeleton className="size-9 rounded-md" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex items-center gap-2">
              <Skeleton className="size-4" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-4 w-12" />
            </div>
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>

      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-4 rounded-lg border p-6">
          <div className="flex flex-row items-start justify-between gap-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-8 w-20" />
            </div>
          </div>
          <Skeleton className="h-28 w-full rounded-md" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        </div>
      ))}
    </div>
  )
}
