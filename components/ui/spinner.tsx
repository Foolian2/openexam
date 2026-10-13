import { cn } from "@/lib/utils"
import { Loader2Icon } from "lucide-react"

function Spinner({
  className,
  label = "Lädt…",
  ...props
}: React.ComponentProps<"svg"> & { label?: string }) {
  return (
    <Loader2Icon
      data-slot="spinner"
      role="status"
      aria-label={label}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
