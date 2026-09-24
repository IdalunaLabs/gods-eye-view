/** Response headers shared with the Vite dev server, plus type and referrer policy. */
export const SECURITY_HEADERS = Object.freeze({
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

/** Apply the production document headers without replacing ones already set. */
export function applySecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.hasHeader(name)) response.setHeader(name, value);
  }
}
