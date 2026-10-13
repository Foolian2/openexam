import type { Metadata } from "next"
import { HomeActions } from "@/components/auth/home-actions"
import { Logo } from "@/components/brand/logo"

export const metadata: Metadata = {
  title: "OpenExam",
}

// Heads up before adding anything per-visitor here: nginx micro-caches this
// page for 30 s and shares it across every anonymous visitor (`location = /`
// in nginx/nginx.conf). That is safe because the page is static — the
// signed-in buttons are resolved client-side in HomeActions. Anything that
// varies per request server-side (a session read, an A/B split, a nonce)
// would be served to the wrong people, so it needs the cache block relaxed
// (or a Vary the cache key respects) in the same change.

export default function HomePage() {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-8 p-8 text-center">
      <div className="space-y-2">
        <h1 className="text-5xl">
          <Logo highlight className="gap-4" markClassName="size-14" />
        </h1>
        <p className="text-lg text-muted-foreground">
          Datenschutzfreundliche, selbst gehostete Prüfungsplattform für
          Schulen.
        </p>
      </div>

      <HomeActions />
    </div>
  )
}
