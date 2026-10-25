/**
 * Only allow same-site relative paths as post-login targets (no open redirects).
 *
 * The WHATWG URL parser silently strips tab/CR/LF, so "/\t/evil.com" would
 * resolve to "//evil.com". Reject everything but visible ASCII up front,
 * then confirm by parsing that the result stays on our origin.
 */
const PLACEHOLDER = "http://redirect-check.invalid";

export function safeNext(value: string | null | undefined, fallback = "/app"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  // Only visible ASCII (our own paths are all percent-encoded); no backslashes.
  if (/[^\x21-\x7e]|\\/.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER);
  } catch {
    return fallback;
  }
  if (url.origin !== PLACEHOLDER) return fallback;
  return url.pathname + url.search + url.hash;
}
