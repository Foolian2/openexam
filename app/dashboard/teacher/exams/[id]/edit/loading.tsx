import { Skeleton } from "@/components/ui/skeleton"

export default function EditExamLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6 p-4 sm:p-6">
      <span className="sr-only" role="status">
        Lädt…
      </span>
      <div className="flex items-center gap-2">
        <Skeleton className="size-9 rounded-md" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-3" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>

      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-48" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-9 w-28" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>

        <div className="flex flex-col gap-4 rounded-lg border p-6">
          <div className="space-y-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-24 w-full" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-3 rounded-lg border p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-5 w-8 rounded-full" />
                  <Skeleton className="h-4 w-48" />
                </div>
                <Skeleton className="h-8 w-8" />
              </div>
              <Skeleton className="h-16 w-full rounded-md" />
            </div>
          ))}
          <div className="flex justify-center">
            <Skeleton className="h-9 w-40" />
          </div>
        </div>
      </div>
    </div>
  )
}
