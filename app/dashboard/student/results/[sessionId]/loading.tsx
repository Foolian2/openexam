import { Skeleton } from "@/components/ui/skeleton"

export default function StudentResultLoading() {
  return (
    <div
      aria-busy="true"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6"
    >
      <span className="sr-only" role="status">
        Lädt…
      </span>
      <Skeleton className="size-9 rounded-md" />
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-28" />
        </div>
        <Skeleton className="h-4 w-32" />
      </div>

      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex flex-col gap-3 rounded-lg border p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
            <Skeleton className="h-5 w-20 rounded-full" />
          </div>
          <Skeleton className="h-24 w-full rounded-md" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ))}
    </div>
  )
}
