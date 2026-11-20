/**
 * Replaces the current document with a full page load of `path`.
 *
 * Use this, not router.replace, to enter an SEB-guarded page (/take, /wait).
 * A client-side navigation fetches the page as `?_rsc=…`, and Windows SEB
 * hashes its native Config Key header over that URL, so the guard (which
 * expects the bare page URL) answers invalid_token and redirects to
 * /launch-seb. A history-only navigation also leaves the SEB JS API keys of
 * the previous page in place. A real load sends a clean URL and fresh keys.
 *
 * A module of its own so tests can mock it; happy-dom cannot navigate.
 */
export function replaceDocument(path: string): void {
  window.location.replace(path)
}
