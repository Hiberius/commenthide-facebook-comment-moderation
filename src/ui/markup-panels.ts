import { icon } from "./icons";

// The five working panels. Deliberately not a uniform grid: the connection
// panel is a narrow column, watched posts and the inspector carry the width,
// and the activity log runs quiet and full-bleed underneath.

const connection = `
<section class="panel col-4" id="panel-connection" aria-labelledby="conn-h">
  <div class="panel-head">
    <h2 id="conn-h">Connection</h2>
    <span class="chip" id="conn-chip" data-tone="">Checking</span>
  </div>
  <div class="panel-body">
    <div id="conn-linked" hidden>
      <p class="row-title" id="conn-page-name">—</p>
      <p class="muted small" style="margin-top:2px">Page Access Token stored, encrypted at rest.</p>
      <button type="button" class="btn btn-danger btn-sm" data-action="disconnect" style="margin-top:14px">
        ${icon("close")}<span>Disconnect</span>
      </button>
    </div>
    <form id="token-form" autocomplete="off">
      <div class="field">
        <label for="token-input">Page Access Token</label>
        <input class="input" id="token-input" type="password" autocomplete="off"
               spellcheck="false" placeholder="EAAG…" aria-describedby="token-hint">
      </div>
      <p class="hint" id="token-hint" style="margin-top:8px">
        ${icon("shield")}
        <span>Write-only. The token is encrypted with AES-256-GCM before it reaches the
        database and is never sent back to this page — not even masked.</span>
      </p>
      <button class="btn btn-primary btn-sm" type="submit" style="margin-top:14px">
        ${icon("check")}<span>Save token</span>
      </button>
    </form>
  </div>
</section>`;

const posts = `
<section class="panel col-8" id="panel-posts" aria-labelledby="posts-h">
  <div class="panel-head">
    <div>
      <p class="eyebrow">Targets</p>
      <h2 id="posts-h">Watched posts</h2>
    </div>
    <button type="button" class="btn btn-ghost btn-sm" data-action="recent">
      ${icon("refresh")}<span>Recent posts</span>
    </button>
  </div>
  <div class="panel-body tight">
    <form id="post-form" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
      <div class="field" style="flex:1 1 260px">
        <label for="post-input">Post id or URL</label>
        <input class="input" id="post-input" placeholder="1234567890_9876543210 or a facebook.com post URL"
               spellcheck="false" autocomplete="off" aria-describedby="post-hint">
      </div>
      <button class="btn btn-primary" type="submit">${icon("plus")}<span>Watch post</span></button>
    </form>
    <label class="check" for="post-baseline">
      <input type="checkbox" id="post-baseline" checked>
      <span>Ignore comments already on the post (recommended)</span>
    </label>
    <p class="hint" id="post-hint">
      ${icon("alert")}
      <span>Shortened <code class="mono">pfbid…</code> links cannot be resolved by the Graph API —
      pick the post from Recent posts instead.</span>
    </p>
  </div>
  <div class="recent" id="recent-list" hidden></div>
  <div class="rows" id="post-rows"></div>
</section>`;

const inspector = `
<section class="panel col-8" id="panel-inspector" aria-labelledby="insp-h">
  <div class="panel-head">
    <div>
      <p class="eyebrow">Preview</p>
      <h2 id="insp-h">Comment inspector</h2>
      <p class="muted small" style="margin-top:4px;max-width:46ch">
        Live comments beside the verdict your current rules would reach right now.
      </p>
    </div>
    <div class="insp-tools">
      <label class="sr-only" for="insp-post">Post to inspect</label>
      <select class="input" id="insp-post"></select>
      <div class="search">
        ${icon("search")}
        <label class="sr-only" for="insp-search">Search comments</label>
        <input class="input" id="insp-search" type="search" placeholder="Search text or author">
      </div>
      <button type="button" class="btn btn-ghost btn-icon" data-action="reload-comments"
              aria-label="Reload comments">${icon("refresh")}</button>
    </div>
  </div>
  <div class="chips" id="insp-chips" role="group" aria-label="Filter comments by state">
    <button type="button" class="chip-btn" data-filter="all" aria-pressed="true">All</button>
    <button type="button" class="chip-btn" data-filter="new" aria-pressed="false">Unseen</button>
    <button type="button" class="chip-btn" data-filter="hidden" aria-pressed="false">Hidden</button>
    <button type="button" class="chip-btn" data-filter="flagged" aria-pressed="false">Flagged</button>
    <button type="button" class="chip-btn" data-filter="skipped" aria-pressed="false">Skipped</button>
    <button type="button" class="chip-btn" data-filter="would-hide" aria-pressed="false">Would hide</button>
  </div>
  <div class="insp-scroll" id="insp-body"></div>
  <div class="panel-foot">
    <p id="insp-summary">Select a post to inspect.</p>
    <button type="button" class="btn btn-ghost btn-sm" data-action="restore-all">
      ${icon("eye")}<span>Restore hidden comments</span>
    </button>
  </div>
</section>`;

const rules = `
<section class="panel col-4" id="panel-rules" aria-labelledby="rules-h">
  <div class="panel-head">
    <div>
      <p class="eyebrow">Policy</p>
      <h2 id="rules-h">Rule set</h2>
    </div>
    <span class="chip" id="rules-count">0</span>
  </div>
  <div class="rows" id="rule-rows"></div>
  <div class="panel-body">
    <p class="eyebrow">Add a rule</p>
    <div class="field">
      <label for="rule-kind">Kind</label>
      <select class="input" id="rule-kind">
        <option value="keyword">Keyword list</option>
        <option value="regex">Regular expression</option>
        <option value="link">Contains a link</option>
        <option value="contact">Contains contact details</option>
        <option value="emoji_spam">Emoji flood</option>
        <option value="min_length">Too short</option>
        <option value="author_allow">Author allow list</option>
      </select>
    </div>
    <div class="field" id="rule-pattern-field">
      <label for="rule-pattern" id="rule-pattern-label">Terms</label>
      <input class="input" id="rule-pattern" spellcheck="false" autocomplete="off"
             aria-describedby="rule-pattern-hint">
      <p class="hint" id="rule-pattern-hint">${icon("type")}<span></span></p>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <div class="field" style="flex:1 1 130px">
        <label for="rule-action">Action</label>
        <select class="input" id="rule-action">
          <option value="hide">Hide</option>
          <option value="flag">Flag only</option>
          <option value="allow">Allow (never hide)</option>
        </select>
      </div>
      <div class="field" style="flex:0 1 108px">
        <label for="rule-priority">Priority</label>
        <input class="input" id="rule-priority" type="number" value="100" min="0" max="9999" step="10">
      </div>
    </div>
    <div class="field">
      <label for="rule-label">Label <span class="muted">(optional)</span></label>
      <input class="input" id="rule-label" placeholder="Crypto spam" autocomplete="off">
    </div>
    <button type="button" class="btn btn-primary btn-block" data-action="add-rule">
      ${icon("plus")}<span>Add rule</span>
    </button>
  </div>
</section>`;

const activity = `
<section class="panel col-12" id="panel-activity" aria-labelledby="act-h">
  <div class="panel-head">
    <div>
      <p class="eyebrow">Audit</p>
      <h2 id="act-h">Activity</h2>
    </div>
    <button type="button" class="btn btn-ghost btn-sm" data-action="reload-events">
      ${icon("refresh")}<span>Refresh</span>
    </button>
  </div>
  <div class="table-wrap">
    <table class="log">
      <caption class="sr-only">Recent moderation events, newest first</caption>
      <thead>
        <tr>
          <th scope="col" class="col-time">When</th>
          <th scope="col">Event</th>
          <th scope="col">Post</th>
          <th scope="col">Detail</th>
        </tr>
      </thead>
      <tbody id="event-rows"></tbody>
    </table>
  </div>
</section>`;

export const panelsMarkup: string = `
<div class="grid">
  ${connection}
  ${posts}
  ${inspector}
  ${rules}
  ${activity}
</div>`;
