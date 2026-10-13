"use client"

import { cn } from "@/lib/utils"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"

interface DataTablePaginationProps {
  page: number
  totalPages: number
  total: number
  limit: number
  label: string
  onPageChange: (page: number) => void
}

export function DataTablePagination({
  page,
  totalPages,
  total,
  limit,
  label,
  onPageChange,
}: DataTablePaginationProps) {
  if (totalPages <= 1) return null

  // The page now comes straight from the URL, so out-of-range values
  // (e.g. ?page=99 after items were deleted) must be clamped for display.
  const safePage = Math.min(Math.max(1, page), totalPages)
  const from = (safePage - 1) * limit + 1
  const to = Math.min(safePage * limit, total)
  const prevDisabled = safePage <= 1
  const nextDisabled = safePage >= totalPages

  return (
    <div className="flex items-center justify-between text-sm text-muted-foreground">
      <span className="tabular-nums">
        {from}–{to} von {total} {label}
      </span>
      <Pagination className="w-auto justify-end">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              text=""
              size="sm"
              aria-label="Vorherige Seite"
              aria-disabled={prevDisabled}
              tabIndex={prevDisabled ? -1 : undefined}
              className={cn(prevDisabled && "pointer-events-none opacity-50")}
              onClick={(e) => {
                e.preventDefault()
                if (!prevDisabled) onPageChange(safePage - 1)
              }}
              href="#"
            />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext
              text=""
              size="sm"
              aria-label="Nächste Seite"
              aria-disabled={nextDisabled}
              tabIndex={nextDisabled ? -1 : undefined}
              className={cn(nextDisabled && "pointer-events-none opacity-50")}
              onClick={(e) => {
                e.preventDefault()
                if (!nextDisabled) onPageChange(safePage + 1)
              }}
              href="#"
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  )
}
