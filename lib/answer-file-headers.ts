/**
 * The file is served from the application's own origin, so it must never be
 * rendered: a student-uploaded HTML or SVG opened inline would run as script
 * in the teacher's session. Forced download, no sniffing, and a sandbox CSP
 * in case a browser renders it anyway. Not cached anywhere — these are
 * exam answers.
 */
export function downloadHeaders(fileName: string | undefined, size: number): Headers {
  // fileName is student-supplied: keep a plain-ASCII fallback for old clients
  // and the exact name in RFC 5987 form. The fallback drops quotes,
  // backslashes and control/non-ASCII characters so it can't break out of
  // the quoted string.
  const name = fileName && fileName.length > 0 ? fileName : "datei"
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
  // RFC 5987 attr-chars exclude ' ( ) * — encodeURIComponent leaves them
  // alone, and ' is the delimiter of filename*.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  )
  return new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
    "Content-Length": String(size),
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
    "Cache-Control": "private, no-store",
  })
}
