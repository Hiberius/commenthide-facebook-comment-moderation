// CommentHide — response hardening.
//
// The dashboard is a single self-contained document with an inline <style> and
// an inline <script>, so 'unsafe-inline' is unavoidable for those two
// directives. Everything else is denied outright: the app loads no fonts, no
// CDN scripts and no third-party images, so there is nothing legitimate to
// allow and nothing an injected tag could usefully reach.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "interest-cohort=()",
].join(", ");

const HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Content-Security-Policy", CONTENT_SECURITY_POLICY],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["Permissions-Policy", PERMISSIONS_POLICY],
];

/** CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  // Applied after the handler so every response — including error responses
  // produced downstream — carries the same policy.
  for (const entry of HEADERS) {
    c.res.headers.set(entry[0], entry[1]);
  }
};
