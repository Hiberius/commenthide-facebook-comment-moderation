import { componentStyles } from "./styles-components";

// Foundation: design tokens, the aurora ground, the glass material and the
// page skeleton. Component-level rules live in ./styles-components.
//
// Every colour is a token so the light theme is a token swap, never a second
// stylesheet. Motion is restricted to transform / opacity / filter so nothing
// here can trigger layout during an animation.

const foundation = `
:root {
  color-scheme: dark;

  --ink-950:#05070d;
  --ink-900:#090d18;
  --ink-800:#0e1424;

  --glass:rgba(255,255,255,.055);
  --glass-hi:rgba(255,255,255,.10);
  --edge:rgba(255,255,255,.14);

  --text:#e8ecf7;
  --text-dim:#8f9bb8;

  --teal:#5eead4;
  --indigo:#818cf8;
  --violet:#c084fc;
  --ok:#34d399;
  --warn:#fbbf24;
  --danger:#fb7185;

  --teal-soft:rgba(94,234,212,.18);
  --warn-soft:rgba(251,191,36,.16);
  --danger-soft:rgba(251,113,133,.16);
  --ok-soft:rgba(52,211,153,.16);
  --indigo-soft:rgba(129,140,248,.16);

  --primary-a:#5eead4;
  --primary-b:#818cf8;
  --primary-fg:#04121c;
  --focus:#a5b4fc;

  --spec-top:rgba(255,255,255,.42);
  --spec-mid:rgba(255,255,255,.08);
  --spec-bot:rgba(255,255,255,.13);
  --shadow-panel:0 28px 70px -30px rgba(0,0,0,.85), 0 2px 8px -4px rgba(0,0,0,.6);
  --aurora-alpha:.50;
  --grain-alpha:.03;
  --hairline:rgba(255,255,255,.07);

  --r-panel:18px;
  --r-ctrl:12px;
  --r-pill:999px;

  --ease:cubic-bezier(.16,1,.3,1);
  --d1:180ms;
  --d2:240ms;
  --d3:320ms;

  --font:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
}

@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --ink-950:#f3f0ea;
    --ink-900:#efebe3;
    --ink-800:#e8e2d8;
    --glass:rgba(255,255,255,.58);
    --glass-hi:rgba(255,255,255,.86);
    --edge:rgba(22,26,44,.12);
    --text:#111726;
    --text-dim:#586180;
    --teal:#0d7c70;
    --indigo:#4a49d8;
    --violet:#7c3aed;
    --ok:#047857;
    --warn:#a45a06;
    --danger:#be123c;
    --teal-soft:rgba(13,124,112,.14);
    --warn-soft:rgba(164,90,6,.14);
    --danger-soft:rgba(190,18,60,.12);
    --ok-soft:rgba(4,120,87,.13);
    --indigo-soft:rgba(74,73,216,.13);
    --primary-a:#0f766e;
    --primary-b:#4338ca;
    --primary-fg:#ffffff;
    --focus:#4338ca;
    --spec-top:rgba(255,255,255,.95);
    --spec-mid:rgba(255,255,255,.35);
    --spec-bot:rgba(22,26,44,.10);
    --shadow-panel:0 26px 60px -34px rgba(28,26,48,.45), 0 1px 3px rgba(28,26,48,.06);
    --aurora-alpha:.34;
    --grain-alpha:.035;
    --hairline:rgba(22,26,44,.08);
  }
}

*,*::before,*::after { box-sizing:border-box; }

/* An author display value on .view / .dry-banner / .recent would otherwise beat
   the UA [hidden] rule, so every hidden panel would still paint. */
[hidden] { display:none !important; }

html { -webkit-text-size-adjust:100%; scroll-behavior:smooth; }

body {
  margin:0;
  min-height:100dvh;
  background:var(--ink-950);
  color:var(--text);
  font-family:var(--font);
  font-size:15px;
  line-height:1.55;
  -webkit-font-smoothing:antialiased;
  text-rendering:optimizeLegibility;
}

h1,h2,h3,p,dl,dd,figure { margin:0; }
ul,ol { margin:0; padding:0; list-style:none; }
button,input,select,textarea { font:inherit; color:inherit; }
a { color:var(--teal); text-decoration-thickness:1px; text-underline-offset:3px; }

::selection { background:var(--indigo-soft); }

:focus-visible {
  outline:2px solid var(--focus);
  outline-offset:2px;
  border-radius:4px;
}

.sr-only {
  position:absolute; width:1px; height:1px; padding:0; margin:-1px;
  overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0;
}

.skip-link {
  position:fixed; top:10px; left:10px; z-index:100;
  padding:10px 16px; border-radius:var(--r-ctrl);
  background:var(--ink-800); color:var(--text);
  border:1px solid var(--edge); text-decoration:none; font-weight:600;
  transform:translateY(-160%);
  transition:transform var(--d2) var(--ease);
}
.skip-link:focus-visible { transform:translateY(0); }

/* --- aurora ground ------------------------------------------------------ */

.aurora {
  position:fixed; inset:0; z-index:-2; overflow:hidden; pointer-events:none;
  background:
    radial-gradient(130% 90% at 50% -20%, var(--ink-800), transparent 62%),
    var(--ink-950);
}
.aurora span {
  position:absolute; display:block; border-radius:50%;
  filter:blur(96px);
  opacity:var(--aurora-alpha);
  will-change:transform;
}
.aurora-a {
  width:54vw; height:54vw; min-width:420px; min-height:420px;
  left:-14vw; top:-18vw;
  background:radial-gradient(circle,var(--teal) 0%,transparent 66%);
  animation:drift-a 34s var(--ease) infinite alternate;
}
.aurora-b {
  width:62vw; height:62vw; min-width:460px; min-height:460px;
  right:-20vw; top:-12vw;
  background:radial-gradient(circle,var(--indigo) 0%,transparent 66%);
  animation:drift-b 41s var(--ease) infinite alternate;
}
.aurora-c {
  width:58vw; height:58vw; min-width:440px; min-height:440px;
  left:24vw; bottom:-34vw;
  background:radial-gradient(circle,var(--violet) 0%,transparent 68%);
  animation:drift-c 47s var(--ease) infinite alternate;
}
@keyframes drift-a { to { transform:translate3d(7vw,4vw,0) scale(1.12); } }
@keyframes drift-b { to { transform:translate3d(-6vw,6vw,0) scale(1.08); } }
@keyframes drift-c { to { transform:translate3d(-8vw,-5vw,0) scale(1.14); } }

/* Grain keeps large dark fields from banding on 8-bit displays. */
.grain {
  position:fixed; inset:0; z-index:-1; pointer-events:none;
  opacity:var(--grain-alpha);
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E");
  background-size:180px 180px;
}

/* --- glass material ----------------------------------------------------- */

.panel {
  position:relative;
  border-radius:var(--r-panel);
  background:var(--glass);
  backdrop-filter:blur(28px) saturate(180%);
  -webkit-backdrop-filter:blur(28px) saturate(180%);
  box-shadow:var(--shadow-panel);
}

/*
 * The specular edge. A flat rgba border reads as a drawn outline; a masked
 * gradient ring that is bright along the top and dim along the bottom reads as
 * a lit surface. This one pseudo-element is what makes the glass look like
 * material rather than a translucent rectangle.
 */
.panel::before,
.spec::before {
  content:"";
  position:absolute; inset:0;
  border-radius:inherit;
  padding:1px;
  background:linear-gradient(
    170deg,
    var(--spec-top) 0%,
    var(--spec-mid) 26%,
    var(--spec-mid) 62%,
    var(--spec-bot) 100%
  );
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  mask-composite:exclude;
  pointer-events:none;
  transition:opacity var(--d2) var(--ease);
}

.spec { position:relative; }

/* --- page skeleton ------------------------------------------------------ */

.shell {
  width:min(1240px,100%);
  margin-inline:auto;
  padding:clamp(20px,3vw,40px) clamp(16px,3vw,32px) clamp(40px,6vw,72px);
  display:flex;
  flex-direction:column;
  gap:clamp(20px,2.4vw,32px);
  min-height:100dvh;
}

.masthead {
  display:flex; align-items:center; justify-content:space-between;
  gap:20px; flex-wrap:wrap;
}
.wordmark { display:flex; align-items:center; gap:14px; }
.wordmark .mark {
  display:grid; place-items:center;
  width:46px; height:46px; flex:none;
  border-radius:14px;
  background:linear-gradient(155deg,var(--teal-soft),var(--indigo-soft));
  color:var(--teal);
  box-shadow:0 10px 30px -14px var(--teal);
}
.wordmark .mark svg { width:24px; height:24px; }
.wordmark h1 {
  font-size:clamp(1.22rem,1rem+.6vw,1.55rem);
  font-weight:640;
  letter-spacing:-.025em;
  line-height:1.1;
}
.wordmark h1 b { font-weight:640; color:var(--text-dim); }
.tagline {
  font-size:12.5px; color:var(--text-dim); letter-spacing:.005em;
  margin-top:2px; max-width:44ch;
}
.masthead-tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

.view { display:flex; flex-direction:column; gap:clamp(16px,2vw,26px); }

/* --- login -------------------------------------------------------------- */

.view-login {
  flex:1;
  align-items:center;
  justify-content:center;
  padding:clamp(24px,7vh,84px) 0;
}
.login-card {
  width:min(408px,100%);
  padding:clamp(26px,3.4vw,38px);
  display:flex; flex-direction:column; gap:16px;
}
.login-card .lock {
  width:44px; height:44px; display:grid; place-items:center;
  border-radius:13px; background:var(--glass-hi); color:var(--teal);
}
.login-card .lock svg { width:22px; height:22px; }
.login-card h2 { font-size:1.4rem; letter-spacing:-.02em; font-weight:620; }

/* --- hero --------------------------------------------------------------- */

.hero {
  display:grid;
  grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);
  gap:clamp(24px,3.4vw,52px);
  align-items:center;
  padding:clamp(26px,3.2vw,44px);
  overflow:hidden;
}
.hero::after {
  content:""; position:absolute; inset:auto -20% -60% 45%;
  height:70%; border-radius:50%;
  background:radial-gradient(circle,var(--teal-soft),transparent 70%);
  pointer-events:none;
}
.hero-copy { position:relative; z-index:1; min-width:0; }
.hero-headline {
  font-size:clamp(1.85rem,1.1rem+2.5vw,3.05rem);
  line-height:1.05;
  letter-spacing:-.035em;
  font-weight:600;
  margin:.3em 0 .34em;
  text-wrap:balance;
}
.hero-headline .accent {
  background:linear-gradient(96deg,var(--teal),var(--indigo) 55%,var(--violet));
  -webkit-background-clip:text; background-clip:text;
  -webkit-text-fill-color:transparent; color:transparent;
}
.hero-sub { color:var(--text-dim); font-size:14.5px; max-width:52ch; }
.hero-actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:22px; }

.stat-rail {
  position:relative; z-index:1;
  display:grid;
  grid-template-columns:repeat(2,minmax(0,1fr));
  gap:1px;
  background:var(--hairline);
  border-radius:var(--r-ctrl);
  overflow:hidden;
}
.stat { background:var(--ink-900); padding:16px 18px; }
.stat dt {
  font-size:10.5px; text-transform:uppercase; letter-spacing:.15em;
  color:var(--text-dim); font-weight:620;
}
.stat dd {
  font-size:clamp(1.6rem,1rem+1.7vw,2.35rem);
  font-weight:600; letter-spacing:-.04em; line-height:1.15;
  font-variant-numeric:tabular-nums; margin-top:2px;
}
.stat dd.small { font-size:1rem; letter-spacing:-.01em; font-weight:560; padding-block:6px; }

@media (prefers-color-scheme: light) { .stat { background:rgba(255,255,255,.62); } }

/* --- responsive grid ---------------------------------------------------- */

.grid {
  display:grid;
  grid-template-columns:repeat(12,minmax(0,1fr));
  gap:clamp(16px,1.7vw,24px);
  align-items:start;
}
.col-4 { grid-column:span 4; }
.col-5 { grid-column:span 5; }
.col-7 { grid-column:span 7; }
.col-8 { grid-column:span 8; }
.col-12 { grid-column:1 / -1; }

@media (max-width:1040px) {
  .hero { grid-template-columns:1fr; }
  .col-4,.col-5,.col-7,.col-8 { grid-column:1 / -1; }
}
@media (max-width:560px) {
  .stat-rail { grid-template-columns:1fr; }
  .masthead { align-items:flex-start; }
}

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior:auto; }
  *,*::before,*::after {
    animation-duration:.001ms !important;
    animation-iteration-count:1 !important;
    transition-duration:.001ms !important;
  }
}
`;

export const styles: string = foundation + componentStyles;
