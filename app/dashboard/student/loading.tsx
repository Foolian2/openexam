import { Skeleton } from "@/components/ui/skeleton"

export default function StudentDashboardLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6 p-4 sm:p-6">
      <span className="sr-only" role="status">
        Lädt…
      </span>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="h-6 w-44" />
        </div>
        <Skeleton className="h-4 w-64" />
      </div>

      <div className="flex flex-col items-center gap-4 py-6 sm:py-8">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex flex-col items-center gap-4 sm:flex-row">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>

      <div>
        <Skeleton className="mb-3 h-4 w-28" />
        <div className="hidden rounded-lg border md:block">
          <div className="flex items-center gap-4 border-b px-4 py-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-10" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 border-b px-4 py-3.5 last:border-b-0"
            >
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-5 w-16 rounded-full" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-3 md:hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-lg border p-4">
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-8 w-20" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
