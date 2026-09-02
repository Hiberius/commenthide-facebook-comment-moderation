import { styles } from "./styles";
import { markup } from "./markup";
import { clientScript } from "./client";

// The whole dashboard, as one document.
//
// No build step, no framework, no external request of any kind: no web font, no
// CDN, no analytics, no favicon fetch. Everything the browser needs — styles,
// icons, behaviour — is inline, which is also what lets the Content-Security-
// Policy stay at `'self'` plus `'unsafe-inline'` for style and script and
// nothing else.

const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>" +
  "<rect width='24' height='24' rx='6' fill='#0a0f1c'/>" +
  "<g fill='none' stroke='#5eead4' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>" +
  "<path d='M4.5 7A2.5 2.5 0 0 1 7 4.5h10A2.5 2.5 0 0 1 19.5 7v6a2.5 2.5 0 0 1-2.5 2.5h-7l-5.5 4z'/>" +
  "<path d='m8.4 13.6 7.2-8.2'/>" +
  "</g></svg>";

const FAVICON_HREF = "data:image/svg+xml," + encodeURIComponent(FAVICON_SVG);

const DESCRIPTION =
  "CommentHide — self-hosted Facebook comment moderation running on your own Cloudflare account.";

export function renderDashboard(): string {
  return (
    "<!doctype html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<meta name="color-scheme" content="dark light">\n' +
    '<meta name="robots" content="noindex, nofollow">\n' +
    '<meta name="referrer" content="same-origin">\n' +
    '<meta name="description" content="' + DESCRIPTION + '">\n' +
    "<title>CommentHide</title>\n" +
    '<link rel="icon" href="' + FAVICON_HREF + '">\n' +
    "<style>" + styles + "</style>\n" +
    "</head>\n" +
    "<body>\n" +
    markup +
    "\n<script>" + clientScript + "</script>\n" +
    "</body>\n" +
    "</html>"
  );
}
