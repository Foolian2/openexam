import { CircleHelp } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface HelpTipProps {
  content: string
  side?: "top" | "right" | "bottom" | "left"
  className?: string
}

export function HelpTip({ content, side = "top", className }: HelpTipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={content}
          className={cn(
            "inline-flex cursor-help align-middle text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground",
            className
          )}
        >
          <CircleHelp className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-64 font-normal">
        {content}
      </TooltipContent>
    </Tooltip>
  )
}
