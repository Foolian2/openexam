"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"

// Same SSR-safe "is this client-rendered yet" pattern as
// components/theme-toggle.tsx's useMounted.
function useMounted() {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
}

declare module "react" {
  // Module augmentation for a custom element requires the `namespace` form —
  // there's no ES2015-module equivalent for extending JSX.IntrinsicElements.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      "cap-widget": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "data-cap-api-endpoint"?: string
        },
        HTMLElement
      >
    }
  }
}

/**
 * Cap (trycap.dev) invisible proof-of-work widget. Renders nothing visible
 * on success — `onSolve` fires with the token to attach as the
 * `x-captcha-response` header on the next request. NEXT_PUBLIC_CAP_WIDGET_ENDPOINT
 * already has the site key baked in (see .env.example) — it's public, unlike
 * the server-side secret key.
 */
export function CapWidget({ onSolve }: { onSolve: (token: string) => void }) {
  const ref = useRef<HTMLElement>(null)
  // The custom element upgrades itself post-mount and injects a hidden
  // <input name="cap-token">, which the server never rendered — mounting it
  // only after the client's first paint keeps it out of the SSR diff
  // entirely instead of causing a hydration mismatch.
  const mounted = useMounted()

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const handleSolve = (e: Event) => {
      const token = (e as CustomEvent<{ token: string }>).detail?.token
      if (token) onSolve(token)
    }
    el.addEventListener("solve", handleSolve)
    return () => el.removeEventListener("solve", handleSolve)
  }, [onSolve, mounted])

  if (!mounted || process.env.NEXT_PUBLIC_CAPTCHA_DISABLED === "true") return null

  return (
    <>
      {/* Pinned version — see .env.example note on rebuilding when it changes.
          Regenerate the hash on every version bump:
          curl -fsSL <url> | openssl dgst -sha384 -binary | openssl base64 -A */}
      <script
        src="https://cdn.jsdelivr.net/npm/@cap.js/widget@0.1.56"
        integrity="sha384-3XYrD0wPJOSDE3gyujsOnx3hLyGU764cN7C6sfwVd8aL7UP4xNhPooe35mFK8wFP"
        crossOrigin="anonymous"
        async
      />
      <cap-widget
        ref={ref}
        data-cap-api-endpoint={process.env.NEXT_PUBLIC_CAP_WIDGET_ENDPOINT}
      />
    </>
  )
}
