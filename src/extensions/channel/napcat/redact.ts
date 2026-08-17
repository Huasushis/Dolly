/**
 * Defensive redaction for the NapCatQQ Channel slice.
 *
 * The slice never emits chat content structurally, so this module is the
 * defensive last line for arbitrary diagnostic strings (for example an
 * exception thrown by a real adapter). It removes the categories napcatqq.md §4
 * forbids from logs and diagnostics: credentials and tokens, URL query/fragment
 * strings, authorization/cookie headers, base64 payloads, and local/UNC paths.
 * The detectors are fixed, so no caller can configure secrets into the redactor.
 */

const BEARER_PATTERN = /(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*[:=]\s*[^\s,;]+/gi;
const QUERY_OR_FRAGMENT_PATTERN = /[?#][^\s"']*/g;
const ABSOLUTE_PATH_PATTERN = /(?:\/(?:home|tmp|var|usr|opt|etc|root|mnt)\/)[^\s"']*|(?:[A-Za-z]:\\|\\\\[^\\\s"']+\\)[^\s"']*/g;
const LONG_TOKEN_PATTERN = /[A-Za-z0-9_\-.]{20,}/g;
const BASE64_PATTERN = /[A-Za-z0-9+/]{40,}={0,2}/g;

export function redactDiagnosticString(input: string): string {
  return input
    .replace(BEARER_PATTERN, "$1: <redacted>")
    .replace(QUERY_OR_FRAGMENT_PATTERN, (m) => (m.startsWith("#") ? "#<fragment-redacted>" : "?<query-redacted>"))
    .replace(ABSOLUTE_PATH_PATTERN, "<path-redacted>")
    .replace(BASE64_PATTERN, "<base64-redacted>")
    .replace(LONG_TOKEN_PATTERN, "<token-redacted>");
}
