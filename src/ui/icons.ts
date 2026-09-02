// Inline SVG icon set.
//
// The dashboard is a single self-contained document: no icon font, no sprite
// sheet, no CDN. Every glyph is 24x24 on a 1.5px stroke in `currentColor`, so
// icons inherit the colour of whatever control holds them.

const wrap = (body: string): string =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  body +
  "</svg>";

export const ICONS: Readonly<Record<string, string>> = Object.freeze({
  // Wordmark: a comment bubble struck through.
  logo: wrap(
    '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-6 4.5z"/>' +
      '<path d="m8.2 14.4 7.6-8.8"/>',
  ),
  lock: wrap('<path d="M7.5 10V7a4.5 4.5 0 0 1 9 0v3"/><rect x="4.5" y="10" width="15" height="10" rx="2.6"/><path d="M12 14.2v2"/>'),
  signOut: wrap('<path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="m9 16-4-4 4-4"/><path d="M5 12h10"/>'),
  play: wrap('<path d="M7.5 5.2 18.8 12 7.5 18.8z"/>'),
  pause: wrap('<path d="M9.5 5v14M14.5 5v14"/>'),
  eye: wrap('<path d="M2.6 12S6.2 5.8 12 5.8 21.4 12 21.4 12 17.8 18.2 12 18.2 2.6 12 2.6 12Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: wrap(
    '<path d="m3.5 3.5 17 17"/><path d="M10.4 6.1A9.6 9.6 0 0 1 12 5.8c5.8 0 9.4 6.2 9.4 6.2a16.4 16.4 0 0 1-3.4 4.2"/>' +
      '<path d="M6.7 7.7A16.2 16.2 0 0 0 2.6 12S6.2 18.2 12 18.2a9.4 9.4 0 0 0 3.4-.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  ),
  trash: wrap(
    '<path d="M4.5 7h15"/><path d="M9.5 7V5.6A1.6 1.6 0 0 1 11.1 4h1.8a1.6 1.6 0 0 1 1.6 1.6V7"/>' +
      '<path d="m6.8 7 .8 11.6A1.6 1.6 0 0 0 9.2 20h5.6a1.6 1.6 0 0 0 1.6-1.4L17.2 7"/>',
  ),
  external: wrap('<path d="M14 4h6v6"/><path d="m20 4-8.5 8.5"/><path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5"/>'),
  plus: wrap('<path d="M12 5.5v13M5.5 12h13"/>'),
  search: wrap('<circle cx="11" cy="11" r="6.4"/><path d="m15.8 15.8 4.6 4.6"/>'),
  check: wrap('<path d="m4.8 12.4 4.9 4.9L19.2 7"/>'),
  close: wrap('<path d="m6.5 6.5 11 11M17.5 6.5l-11 11"/>'),
  refresh: wrap('<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4.2v5h-5"/>'),
  alert: wrap('<path d="M12 4.6 20.8 19.6H3.2z"/><path d="M12 10v4.6"/><path d="M12 17.6h.01"/>'),
  beaker: wrap('<path d="M9.2 3.5h5.6"/><path d="M10.2 3.5v6.1L5 18.2a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5.2-8.6V3.5"/><path d="M7.6 15.4h8.8"/>'),
  clock: wrap('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.1 2"/>'),
  link: wrap('<path d="M10.4 13.6a4 4 0 0 0 5.7 0l2.5-2.5a4 4 0 1 0-5.7-5.7l-1.4 1.4"/><path d="M13.6 10.4a4 4 0 0 0-5.7 0l-2.5 2.5a4 4 0 1 0 5.7 5.7l1.4-1.4"/>'),
  at: wrap('<circle cx="12" cy="12" r="3.4"/><path d="M15.4 8.6v4.9a2.7 2.7 0 0 0 5.2.8A9 9 0 1 0 16.9 20"/>'),
  type: wrap('<path d="M5 7V5.2h14V7"/><path d="M12 5.2v13.6"/><path d="M9.2 18.8h5.6"/>'),
  regex: wrap('<path d="M12 4.6v8"/><path d="m8.4 6.6 7.2 4"/><path d="m15.6 6.6-7.2 4"/><circle cx="7.4" cy="17.6" r="1.7"/>'),
  ruler: wrap('<path d="M4.5 7.5h8.5"/><path d="M18.5 7.5h1"/><circle cx="15.7" cy="7.5" r="2.1"/><path d="M4.5 16.5h3.8"/><path d="M13.8 16.5h5.7"/><circle cx="11" cy="16.5" r="2.1"/>'),
  shield: wrap('<path d="M12 3.6 19.4 6v5.5c0 4.4-3 7.7-7.4 9-4.4-1.3-7.4-4.6-7.4-9V6z"/><path d="m9 12 2.2 2.2 4.3-4.4"/>'),
  smile: wrap('<circle cx="12" cy="12" r="8.4"/><path d="M9.2 10h.01M14.8 10h.01"/><path d="M8.6 14a4.6 4.6 0 0 0 6.8 0"/>'),
  flag: wrap('<path d="M6 21V4.2"/><path d="M6 5h10.8l-2 3.6 2 3.6H6z"/>'),
  activity: wrap('<path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1"/><path d="M3.6 5.2v4.2h4.2"/><path d="M12 8.2v4.4l3 1.8"/>'),
  user: wrap('<circle cx="12" cy="8.2" r="3.5"/><path d="M5.2 20a6.8 6.8 0 0 1 13.6 0"/>'),
  inbox: wrap('<path d="M3.6 13.6h4.2l1.5 3h5.4l1.5-3h4.2"/><path d="M6.4 4.8h11.2l2.8 8.8v3.9A1.5 1.5 0 0 1 18.9 19H5.1a1.5 1.5 0 0 1-1.5-1.5v-3.9z"/>'),
  key: wrap('<circle cx="8" cy="12" r="3.6"/><path d="M11.6 12H20"/><path d="M17.4 12v3.2"/><path d="M14.6 12v2.4"/>'),
  chevron: wrap('<path d="m9.5 6 6 6-6 6"/>'),
  bolt: wrap('<path d="M13.4 3 5.6 14h5.6l-1 7 7.8-11h-5.6z"/>'),
  power: wrap('<path d="M12 4v7.4"/><path d="M7.3 6.9a7 7 0 1 0 9.4 0"/>'),
});

/** Server-side icon: returns the span-wrapped SVG for a static markup slot. */
export function icon(name: string, className = "ico"): string {
  const body = ICONS[name];
  if (body === undefined) throw new Error("Unknown icon: " + name);
  return '<span class="' + className + '" aria-hidden="true">' + body + "</span>";
}

/**
 * The same icon set as a JS literal for the client script. `<` is escaped so
 * the literal can never terminate the inline <script> element early.
 */
export function iconsScriptSource(): string {
  return "var ICONS = " + JSON.stringify(ICONS).replace(/</g, "\\u003c") + ";";
}
