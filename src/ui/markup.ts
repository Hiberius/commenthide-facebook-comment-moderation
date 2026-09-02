import { icon } from "./icons";
import { panelsMarkup } from "./markup-panels";

// The static shell. Everything the client fills in ships as a skeleton or an
// empty state so the first paint is never a blank rectangle.
//
// There is exactly one <h1> in the document: the wordmark in the masthead,
// which is present in both the locked and unlocked views.

const masthead = `
<header class="masthead">
  <div class="wordmark">
    <span class="mark">${icon("logo", "ico lg")}</span>
    <div>
      <h1>Comment<b>Hide</b></h1>
      <p class="tagline">Self-hosted comment moderation for Facebook Pages.</p>
    </div>
  </div>
  <div class="masthead-tools" id="masthead-tools" hidden>
    <p class="status-pill" id="status-pill" data-tone="paused">
      <span class="dot"></span><span id="status-pill-text">Loading</span>
    </p>
    <button type="button" class="btn btn-ghost btn-sm" data-action="signout">
      ${icon("signOut")}<span>Sign out</span>
    </button>
  </div>
</header>`;

const loginView = `
<section class="view view-login" id="view-login" hidden aria-labelledby="login-heading">
  <form class="panel login-card" id="login-form" novalidate autocomplete="on">
    <span class="lock">${icon("lock", "ico lg")}</span>
    <div>
      <h2 id="login-heading">Sign in</h2>
      <p class="muted small" style="margin-top:6px">
        The dashboard is protected by the <code class="mono">ADMIN_PASSWORD</code> secret
        you set on this Worker. Nothing else can reach the moderation API.
      </p>
    </div>
    <div class="field">
      <label for="login-password">Password</label>
      <input class="input" id="login-password" name="password" type="password"
             autocomplete="current-password" required autocapitalize="off" spellcheck="false">
    </div>
    <p class="form-error" id="login-error" role="alert" hidden></p>
    <button class="btn btn-primary btn-block" type="submit" id="login-submit">
      ${icon("key")}<span>Unlock dashboard</span>
    </button>
  </form>
</section>`;

const hero = `
<section class="panel hero" aria-labelledby="hero-heading">
  <div class="hero-copy">
    <p class="eyebrow">Moderation status</p>
    <h2 class="hero-headline" id="hero-heading">
      <span id="hero-headline-text">Reading your <span class="accent">configuration</span></span>
    </h2>
    <p class="hero-sub" id="hero-sub">
      One moment — pulling the current state of every watched post.
    </p>
    <div class="hero-actions">
      <button type="button" class="btn btn-primary" data-action="run" id="btn-run">
        ${icon("bolt")}<span>Run now</span>
      </button>
      <button type="button" class="btn" data-action="run-dry" id="btn-run-dry">
        ${icon("beaker")}<span>Preview run</span>
      </button>
    </div>
  </div>
  <dl class="stat-rail">
    <div class="stat"><dt>Hidden</dt><dd id="stat-hidden">—</dd></div>
    <div class="stat"><dt>Flagged</dt><dd id="stat-flagged">—</dd></div>
    <div class="stat"><dt>Watching</dt><dd id="stat-watched">—</dd></div>
    <div class="stat"><dt>Last check</dt><dd class="small" id="stat-last">—</dd></div>
  </dl>
</section>`;

const dryBanner = `
<div class="dry-banner" id="dry-banner" role="status" hidden>
  ${icon("beaker", "ico lg")}
  <p>
    <strong>Dry run.</strong>
    <span id="dry-banner-text">Decisions are recorded but nothing is hidden on Facebook.</span>
  </p>
</div>`;

const colophon = `
<footer class="colophon">
  <p>CommentHide — open source, self-hosted, running entirely on your own Cloudflare account.</p>
  <p class="mono" id="colophon-clock">—</p>
</footer>`;

export const markup: string = `
<a class="skip-link" href="#main">Skip to content</a>
<div class="aurora" aria-hidden="true"><span class="aurora-a"></span><span class="aurora-b"></span><span class="aurora-c"></span></div>
<div class="grain" aria-hidden="true"></div>

<div class="shell">
  ${masthead}
  <main id="main">
    ${loginView}
    <div class="view view-app" id="view-app" hidden>
      ${dryBanner}
      ${hero}
      ${panelsMarkup}
    </div>
  </main>
  ${colophon}
</div>

<div class="toast-region" id="toast-region" role="status" aria-live="polite" aria-atomic="false"></div>`;
