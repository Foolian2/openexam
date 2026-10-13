import { Skeleton } from "@/components/ui/skeleton"

export default function TakeExamLoading() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between gap-4 border-b pb-3">
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-3 w-40" />
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="space-y-3 rounded-xl border p-4">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      ))}
    </div>
  )
}
