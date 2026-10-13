import { Skeleton } from "@/components/ui/skeleton"

export default function QuestionGraderLoading() {
  return (
    <div aria-busy="true" className="mx-auto flex max-w-3xl flex-col gap-6 p-6">
      <span className="sr-only" role="status">
        Lädt…
      </span>
      <div className="flex items-center gap-2">
        <Skeleton className="size-9 rounded-md" />
        <Skeleton className="h-6 w-72" />
      </div>
      <Skeleton className="h-24 w-full rounded-lg" />
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-32 w-full rounded-lg" />
      ))}
    </div>
  )
}
