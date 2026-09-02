// Client fragment: the status hero, the dry-run banner, the connection panel
// and the watched-posts list. Continued in ./client-render-detail.

export const renderScript: string = `
/* -------------------------------------------------------------- header --- */

function renderStatus() {
  var status = state.status;
  var posts = statusPosts();
  var active = posts.filter(function (post) { return post.active === 1; });
  var dry = active.filter(function (post) { return post.dry_run === 1; });
  var hasToken = !!(status && status.hasToken);

  var tone = "paused";
  var label = "Paused";
  if (!hasToken) { tone = "paused"; label = "Not connected"; }
  else if (active.length && dry.length === active.length) { tone = "dry"; label = "Dry run"; }
  else if (active.length) { tone = "active"; label = "Active"; }
  if (state.offline) { tone = "paused"; label = "Reconnecting"; }

  var pill = byId("status-pill");
  if (pill) pill.setAttribute("data-tone", tone);
  var pillText = byId("status-pill-text");
  if (pillText) pillText.textContent = label;

  renderHero(hasToken, posts, active, dry);
  renderDryBanner(dry);

  var totals = (status && status.totals) || { hidden: 0, flagged: 0, watched: 0 };
  setText("stat-hidden", num(totals.hidden));
  setText("stat-flagged", num(totals.flagged));
  setText("stat-watched", num(totals.watched));

  var last = status ? status.lastCheckedAt : null;
  var lastNode = byId("stat-last");
  if (lastNode) {
    lastNode.textContent = relTime(last);
    var absolute = absTime(last);
    if (absolute) lastNode.title = absolute;
  }

  var runBtn = byId("btn-run");
  if (runBtn) runBtn.disabled = !hasToken || posts.length === 0;
  var dryBtn = byId("btn-run-dry");
  if (dryBtn) dryBtn.disabled = !hasToken || posts.length === 0;
}

function setText(id, value) {
  var node = byId(id);
  if (node) node.textContent = value;
}

function renderHero(hasToken, posts, active, dry) {
  var headline = byId("hero-headline-text");
  var sub = byId("hero-sub");
  if (!headline || !sub) return;

  var lead = "";
  var accent = "";
  var trail = "";
  var subtitle = "";

  if (!hasToken) {
    lead = "Connect a ";
    accent = "Page";
    trail = " to begin";
    subtitle = "Paste a Page Access Token in the Connection panel. It is encrypted before it is stored and never leaves your Cloudflare account.";
  } else if (posts.length === 0) {
    lead = "Choose a ";
    accent = "post";
    trail = " to watch";
    subtitle = "Add a post by id or URL, or pick one from Recent posts. Existing comments are ignored by default, so switching on is always safe.";
  } else if (active.length === 0) {
    lead = "Everything is ";
    accent = "paused";
    trail = "";
    subtitle = "Nothing is being moderated. Resume a post below to hand it back to the one-minute cron.";
  } else if (dry.length === active.length) {
    lead = "Rehearsing on ";
    accent = countLabel(active.length, "post");
    trail = "";
    subtitle = "Decisions are recorded and shown in the inspector, but no comment is touched on Facebook. Turn off Dry run when the verdicts look right.";
  } else {
    lead = "Guarding ";
    accent = countLabel(active.length, "post");
    trail = "";
    subtitle = "Checked every minute by a Cloudflare cron trigger. New comments are matched against your rule set the moment they appear.";
  }

  clear(headline);
  if (lead) headline.appendChild(document.createTextNode(lead));
  headline.appendChild(el("span", "accent", accent));
  if (trail) headline.appendChild(document.createTextNode(trail));
  sub.textContent = subtitle;
}

function countLabel(count, word) {
  return count + " " + word + (count === 1 ? "" : "s");
}

function renderDryBanner(dryPosts) {
  var banner = byId("dry-banner");
  var text = byId("dry-banner-text");
  if (!banner || !text) return;
  if (!dryPosts.length) { banner.hidden = true; return; }
  var names = dryPosts.map(postLabel).join(", ");
  text.textContent =
    countLabel(dryPosts.length, "watched post") +
    " running in dry run (" + truncate(names, 90) + "). " +
    "Verdicts are recorded, nothing is hidden on Facebook.";
  banner.hidden = false;
}

/* ---------------------------------------------------------- connection --- */

function renderConnection() {
  var status = state.status;
  var hasToken = !!(status && status.hasToken);

  var chipNode = byId("conn-chip");
  if (chipNode) {
    chipNode.textContent = hasToken ? "Connected" : "Not connected";
    chipNode.setAttribute("data-tone", hasToken ? "ok" : "");
  }

  show(byId("conn-linked"), hasToken);
  setText("conn-page-name", (status && status.pageName) || "Connected Page");

  var label = document.querySelector('label[for="token-input"]');
  if (label) label.textContent = hasToken ? "Replace token" : "Page Access Token";
}

/* --------------------------------------------------------------- posts --- */

function renderPosts() {
  var host = byId("post-rows");
  if (!host) return;
  if (state.loading.posts) { skeletonRows(2, host); return; }

  var posts = statusPosts();
  if (!posts.length) {
    emptyState(
      host,
      "inbox",
      "No posts watched yet",
      "Add the post you want moderated. CommentHide only ever touches posts listed here."
    );
    return;
  }

  clear(host);
  posts.forEach(function (post) { host.appendChild(postRow(post)); });
}

function postRow(post) {
  var row = el("div", "row" + (post.active === 1 ? "" : " is-off"));
  row.setAttribute("data-post", post.post_id);

  var main = el("div", "row-main");
  main.appendChild(el("p", "row-title", postLabel(post)));

  var meta = el("div", "row-meta");
  meta.appendChild(el("span", "mono", post.post_id));
  meta.appendChild(chip(post.mode === "hide_all" ? "Hide all" : "Rules", post.mode === "hide_all" ? "danger" : "info"));
  if (post.include_replies === 1) meta.appendChild(chip("Replies", "teal"));
  if (post.dry_run === 1) meta.appendChild(chip("Dry run", "warn", "beaker"));
  var checked = el("span", null, "Checked " + relTime(post.last_checked_at));
  var checkedAbs = absTime(post.last_checked_at);
  if (checkedAbs) checked.title = checkedAbs;
  meta.appendChild(checked);
  main.appendChild(meta);
  row.appendChild(main);

  var counts = el("div", "counts");
  counts.appendChild(countPair(post.total_hidden, "hidden"));
  counts.appendChild(countPair(post.total_flagged, "flagged"));
  row.appendChild(counts);

  var actions = el("div", "row-actions");
  actions.appendChild(toggle("toggle-active", post.active === 1 ? "Active" : "Paused", post.active === 1));
  actions.appendChild(toggle("toggle-dry", "Dry run", post.dry_run === 1));
  actions.appendChild(iconButton("run-post", "Run now on this post", "bolt"));
  actions.appendChild(iconButton("test-post", "Test connection", "shield"));

  var href = safeUrl(post.permalink_url);
  if (href) {
    var link = el("a", "btn btn-ghost btn-icon");
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("aria-label", "Open on Facebook");
    link.title = "Open on Facebook";
    link.appendChild(svgIcon("external"));
    actions.appendChild(link);
  }

  actions.appendChild(iconButton("remove-post", "Stop watching this post", "trash", "btn-danger"));
  row.appendChild(actions);
  return row;
}

function countPair(value, word) {
  var box = el("div");
  box.appendChild(el("b", null, num(value)));
  box.appendChild(el("span", null, word));
  return box;
}

/* ------------------------------------------------------- recent picker --- */

function renderRecent() {
  var host = byId("recent-list");
  if (!host) return;
  if (state.recent === null) { host.hidden = true; clear(host); return; }

  clear(host);
  host.hidden = false;

  if (!state.recent.length) {
    host.appendChild(el("p", "hint", "No recent posts came back for this Page."));
    return;
  }

  state.recent.forEach(function (post) {
    var item = el("button", "recent-item");
    item.type = "button";
    item.setAttribute("data-action", "pick-recent");
    item.setAttribute("data-post", post.id);
    var text = el("span", null, truncate(post.message || post.id, 78));
    item.appendChild(text);
    var when = parseTime(post.created_time);
    item.appendChild(el("span", "muted small", when ? relTime(when) : ""));
    host.appendChild(item);
  });
}

/* -------------------------------------------------- inspector selector --- */

function renderPostSelect() {
  var select = byId("insp-post");
  if (!select) return;
  var posts = statusPosts();
  clear(select);

  if (!posts.length) {
    var none = el("option", null, "No posts watched");
    none.value = "";
    select.appendChild(none);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  posts.forEach(function (post) {
    var option = el("option", null, truncate(postLabel(post), 60));
    option.value = post.post_id;
    if (post.post_id === state.selected) option.selected = true;
    select.appendChild(option);
  });
}
`;
