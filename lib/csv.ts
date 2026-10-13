/**
 * CSV field encoding shared by the export routes (results, audit log).
 *
 * Two separate concerns:
 *
 * 1. RFC 4180 quoting, so a value containing the delimiter, a quote or a
 *    newline doesn't break the row.
 * 2. Spreadsheet formula neutralisation (CWE-1236). Exports carry
 *    attacker-controlled text — student names and, in the audit log, the
 *    User-Agent every client picks for itself — and Excel/LibreOffice
 *    evaluate any cell starting with `=`, `+`, `-`, `@` or a tab as a
 *    formula when the teacher opens the file. Spreadsheet apps skip leading
 *    whitespace and control characters when making that call, so the check
 *    looks past them rather than at the literal first character. A leading
 *    apostrophe forces the cell to be read as text and is stripped again on
 *    import.
 */
export function csvField(
  value: string | number | null | undefined,
  delimiter: "," | ";" = ","
): string {
  let s = value === null || value === undefined ? "" : String(value)
  // Spreadsheet apps also discard invisible format characters (U+200B zero
  // width space, U+200C/U+200D, U+2060 word joiner, U+FEFF, bidi controls)
  // before deciding whether a cell is a formula, so they must not be allowed
  // to hide a formula lead-in either.
  if (
    /^[\s\x00-\x1f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]*[=+\-@\t\r]/.test(
      s
    )
  )
    s = `'${s}`
  const needsQuotes = s.includes(delimiter) || /["\n\r]/.test(s)
  return needsQuotes ? `"${s.replace(/"/g, '""')}"` : s
}
