import { Skeleton } from "@/components/ui/skeleton"

function SettingsCardSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-4 rounded-lg border p-6">
      <span className="sr-only" role="status">
        Lädt…
      </span>
      <div className="space-y-1.5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-64" />
      </div>
      <div className="space-y-4">
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-9 w-full" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  )
}

export default function AdminSettingsLoading() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Skeleton className="size-9 rounded-md" />
          <Skeleton className="h-6 w-36" />
        </div>
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="flex max-w-2xl flex-col gap-6">
        <SettingsCardSkeleton />
        <SettingsCardSkeleton />
        <SettingsCardSkeleton />
      </div>

      <div className="flex flex-col gap-4 rounded-lg border p-6">
        <div className="space-y-1.5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-full max-w-xs" />
        <div className="rounded-lg border">
          <div className="flex items-center gap-4 border-b px-4 py-3">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-16" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center justify-between gap-4 border-b px-4 py-3.5 last:border-b-0"
            >
              <div className="flex items-center gap-3">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-32" />
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
