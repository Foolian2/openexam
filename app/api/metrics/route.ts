import { NextResponse } from "next/server"
import { registry } from "@/lib/metrics"

export const dynamic = "force-dynamic"

/**
 * Prometheus scrape target. Reachable only over the Docker `internal`
 * network (Prometheus scrapes web:3000/api/metrics directly, not through
 * nginx) — nginx.conf additionally denies this path outright as
 * defense-in-depth so it's never internet-reachable even by accident. Do
 * not add auth here: the nginx block is what keeps this private.
 */
export async function GET() {
  const body = await registry.metrics()
  return new NextResponse(body, {
    headers: { "Content-Type": registry.contentType },
  })
}
