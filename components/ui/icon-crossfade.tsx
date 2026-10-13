"use client"

import {
  type AnimationEvent,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

import { cn } from "@/lib/utils"

/**
 * Holds a swappable icon in a fixed-size box so the surrounding layout never
 * shifts when the icon appears, disappears, or turns into a spinner, and
 * fades the incoming icon in instead of hard-cutting.
 *
 * An outgoing icon stays mounted only through its exit animation. An outgoing
 * spinner is paused during that brief fade, so monitor rows do not keep a
 * hidden spinner running.
 *
 * `active` identifies the current icon; changing it remounts the inner span so
 * the fade replays. The fade is plain CSS, so the app's `.reduce-motion` class
 * and the OS `prefers-reduced-motion` query already collapse it — no JS
 * preference check needed.
 */
type IconSnapshot = {
  active: string
  children?: ReactNode
}

export function IconCrossfade({
  active,
  className,
  children,
}: {
  active: string
  className?: string
  children?: ReactNode
}): ReactElement {
  const previousRef = useRef<IconSnapshot>({ active, children })
  const [exiting, setExiting] = useState<IconSnapshot | null>(null)

  // useLayoutEffect adds the prior icon before the browser paints the new
  // state, so both layers are present for the whole crossfade.
  useLayoutEffect(() => {
    const previous = previousRef.current

    if (previous.active !== active) {
      setExiting(previous.children != null ? previous : null)
    }

    previousRef.current = { active, children }
  }, [active, children])

  const handleExitEnd = (event: AnimationEvent<HTMLSpanElement>) => {
    if (event.target === event.currentTarget) {
      setExiting(null)
    }
  }

  return (
    <span
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center",
        className
      )}
    >
      {exiting?.children != null && (
        <span
          key={exiting.active}
          aria-hidden="true"
          onAnimationEnd={handleExitEnd}
          className="pointer-events-none absolute inset-0 flex animate-out items-center justify-center duration-[var(--duration-fast)] fade-out-0 [&_.animate-spin]:[animation-play-state:paused]"
        >
          {exiting.children}
        </span>
      )}
      {children != null && (
        <span
          key={active}
          className="absolute inset-0 flex animate-in items-center justify-center duration-[var(--duration-fast)] fade-in-0"
        >
          {children}
        </span>
      )}
    </span>
  )
}
