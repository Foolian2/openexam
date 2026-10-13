import { Geist, Geist_Mono } from "next/font/google"
import localFont from "next/font/local"
import type { Viewport } from "next"

import "./globals.css"
import { NuqsAdapter } from "nuqs/adapters/next/app"
import { ThemeProvider } from "@/components/theme-provider"
import { SessionThemeRestore } from "@/components/session-theme-restore"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

// Dyslexia mode is opt-in per user; the fonts load on demand (preload: false)
// instead of on every page load. WOFF2 keeps them ~40% smaller than the
// original OTF sources.
const openDyslexic = localFont({
  preload: false,
  variable: "--font-dyslexic",
  src: [
    {
      path: "./fonts/opendyslexic/OpenDyslexic-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/opendyslexic/OpenDyslexic-Bold.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "./fonts/opendyslexic/OpenDyslexic-Italic.woff2",
      weight: "400",
      style: "italic",
    },
    {
      path: "./fonts/opendyslexic/OpenDyslexic-BoldItalic.woff2",
      weight: "700",
      style: "italic",
    },
  ],
})

// Concrete hex values: browsers can't resolve CSS variables in the
// theme-color meta tag, so the previous `hsl(var(--background))` emitted a
// dead tag. These mirror the light/dark --background values in globals.css.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  viewportFit: "cover",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="de"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        fontMono.variable,
        "font-sans",
        geist.variable,
        openDyslexic.variable
      )}
    >
      <body>
        <ThemeProvider>
          <SessionThemeRestore />
          <TooltipProvider>
            <NuqsAdapter>
              {children}
              <Toaster />
            </NuqsAdapter>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
