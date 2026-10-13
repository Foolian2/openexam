import { cn } from "@/lib/utils"

// The OpenExam mark: a sheet of paper with a folded corner and three answer
// lines that read as an open "E". The sheet is drawn in currentColor with the
// fold and lines cut out (evenodd), so it adapts to light, dark and
// high-contrast themes; the fold and the middle line are then painted in the
// brand highlighter colour (--brand-accent, see globals.css).
const SHEET_PATH =
  "M18 4H70L96 30V82Q96 96 82 96H18Q4 96 4 82V18Q4 4 18 4Z" +
  "M70 4V22Q70 30 78 30H96Z" +
  "M27 36H61A5 5 0 0 1 61 46H27A5 5 0 0 1 27 36Z" +
  "M27 50H51A5 5 0 0 1 51 60H27A5 5 0 0 1 27 50Z" +
  "M27 64H61A5 5 0 0 1 61 74H27A5 5 0 0 1 27 64Z"

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
      className={cn("size-7 shrink-0", className)}
    >
      <path d={SHEET_PATH} fill="currentColor" fillRule="evenodd" />
      <path d="M70 4V22Q70 30 78 30H96Z" fill="var(--brand-accent)" />
      <rect
        x="22"
        y="50"
        width="34"
        height="10"
        rx="5"
        fill="var(--brand-accent)"
      />
    </svg>
  )
}

export function Logo({
  className,
  markClassName,
  highlight = false,
}: {
  className?: string
  markClassName?: string
  /** Draws the highlighter stripe behind "exam" (hero sizes only). */
  highlight?: boolean
}) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark className={markClassName} />
      <span className="sr-only">OpenExam</span>
      <span aria-hidden="true" className="leading-none tracking-tight">
        <span className="font-normal">open</span>
        {highlight ? (
          <span className="relative px-[0.05em] font-bold">
            {/* On dark backgrounds light text on yellow fails contrast, so the
                stripe is replaced by yellow text there. */}
            <span className="absolute inset-x-0 top-1/2 bottom-[6%] -rotate-1 -skew-x-12 rounded-sm bg-[var(--brand-accent)] dark:hidden" />
            <span className="relative dark:text-[var(--brand-accent)]">
              exam
            </span>
          </span>
        ) : (
          <span className="font-bold">exam</span>
        )}
      </span>
    </span>
  )
}
