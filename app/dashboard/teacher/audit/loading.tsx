import { Skeleton } from "@/components/ui/skeleton"

export default function AuditLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-6 p-4 sm:p-6">
      <span className="sr-only" role="status">
        Lädt…
      </span>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="h-6 w-36" />
        </div>
        <Skeleton className="h-4 w-80" />
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Skeleton className="h-9 w-[220px]" />
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-40" />
        </div>

        <div className="rounded-lg border">
          <div className="flex items-center gap-4 border-b px-4 py-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-24" />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 border-b px-4 py-3.5 last:border-b-0"
            >
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-5 w-24 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-24" />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <Skeleton className="h-4 w-24" />
          <div className="flex gap-2">
            <Skeleton className="size-8 rounded-md" />
            <Skeleton className="size-8 rounded-md" />
          </div>
        </div>
      </div>
    </div>
  )
}
