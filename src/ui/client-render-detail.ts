// Client fragment: rule set, comment inspector, activity log.
//
// The rule descriptions are generated here rather than fetched: GET /api/rules
// returns raw RuleRow objects, so the sentence has to be built client-side.
// The wording mirrors describeRule() in src/lib/rules.ts — if the rule-kind
// semantics in the contract change, both have to move together.

export const renderDetailScript: string = `
var RULE_KINDS = {
  keyword: {
    name: "Keyword", icon: "type", label: "Terms",
    placeholder: "free money, follow me, dm me on telegram",
    hint: "Comma-separated terms. Each is matched as a whole word, ignoring case and accents.",
    pattern: true
  },
  regex: {
    name: "Regex", icon: "regex", label: "Pattern",
    placeholder: "(bit\\\\.ly|t\\\\.me)/\\\\S+",
    hint: "JavaScript regular expression source, without the slashes. An invalid pattern is ignored at run time.",
    pattern: true
  },
  link: {
    name: "Link", icon: "link", label: "",
    placeholder: "",
    hint: "Matches any comment containing a URL or a bare domain. No pattern needed.",
    pattern: false
  },
  contact: {
    name: "Contact", icon: "at", label: "",
    placeholder: "",
    hint: "Matches phone numbers, email addresses and @handles. No pattern needed.",
    pattern: false
  },
  emoji_spam: {
    name: "Emoji flood", icon: "smile", label: "Threshold",
    placeholder: "5",
    hint: "Matches when a comment carries at least this many emoji. Defaults to 5.",
    pattern: true
  },
  min_length: {
    name: "Too short", icon: "ruler", label: "Minimum characters",
    placeholder: "3",
    hint: "Matches comments shorter than this once trimmed. Defaults to 3.",
    pattern: true
  },
  author_allow: {
    name: "Author allow", icon: "user", label: "Names or ids",
    placeholder: "Jane Doe, 100001234567890",
    hint: "Comma-separated author names or ids. Pair with Allow so these people are never hidden.",
    pattern: true
  }
};

function ruleKind(kind) { return RULE_KINDS[kind] || { name: kind, icon: "bolt", pattern: true, hint: "" }; }

function actionVerb(action) {
  if (action === "allow") return "Never hide";
  if (action === "flag") return "Flag";
  return "Hide";
}

function terms(pattern) {
  var parts = String(pattern || "").split(",").map(function (part) { return part.trim(); })
    .filter(function (part) { return part.length > 0; });
  if (!parts.length) return "anything";
  var quoted = parts.map(function (part) { return "\\u201c" + part + "\\u201d"; });
  if (quoted.length <= 3) return quoted.join(", ");
  return quoted.slice(0, 3).join(", ") + " and " + (quoted.length - 3) + " more";
}

function intOr(value, fallback) {
  var parsed = parseInt(String(value), 10);
  return isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function describeRule(rule) {
  var verb = actionVerb(rule.action);
  var pattern = String(rule.pattern || "");
  if (rule.kind === "keyword") return verb + " comments containing " + terms(pattern) + ".";
  if (rule.kind === "regex") return verb + " comments matching /" + pattern + "/.";
  if (rule.kind === "link") return verb + " comments that contain a link or a bare domain.";
  if (rule.kind === "contact") return verb + " comments that contain a phone number, email address or @handle.";
  if (rule.kind === "emoji_spam") return verb + " comments with " + intOr(pattern, 5) + " or more emoji.";
  if (rule.kind === "min_length") return verb + " comments shorter than " + intOr(pattern, 3) + " characters.";
  if (rule.kind === "author_allow") return verb + " comments from " + terms(pattern) + ".";
  return verb + " matching comments.";
}

/* --------------------------------------------------------------- rules --- */

function renderRules() {
  var host = byId("rule-rows");
  if (!host) return;

  var countChip = byId("rules-count");
  if (countChip) countChip.textContent = state.loading.rules ? "…" : countLabel(state.rules.length, "rule");

  if (state.loading.rules) { skeletonRows(3, host); return; }

  if (!state.rules.length) {
    var seed = textButton("seed-rules", "Load starter rules", "bolt", "btn-primary");
    emptyState(
      host,
      "shield",
      "No rules yet",
      "Without a rule nothing is hidden in Rules mode. The starter set covers links, contact details, emoji floods and common spam phrasing.",
      seed
    );
    return;
  }

  clear(host);
  state.rules.forEach(function (rule) { host.appendChild(ruleRow(rule)); });
}

function ruleRow(rule) {
  var row = el("div", "row" + (rule.enabled === 1 ? "" : " is-off"));
  row.setAttribute("data-rule", String(rule.id));

  var main = el("div", "row-main");
  main.appendChild(el("p", "row-title", describeRule(rule)));

  var meta = el("div", "row-meta");
  var kind = ruleKind(rule.kind);
  meta.appendChild(chip(kind.name, "info", kind.icon));
  meta.appendChild(chip(
    actionVerb(rule.action),
    rule.action === "allow" ? "ok" : rule.action === "flag" ? "warn" : "danger"
  ));
  if (rule.label) meta.appendChild(el("span", null, rule.label));
  meta.appendChild(el("span", null, "Priority " + num(rule.priority)));
  meta.appendChild(el("span", null, countLabel(rule.hit_count || 0, "hit")));
  if (rule.post_id) meta.appendChild(chip("This post only", "teal"));
  main.appendChild(meta);
  row.appendChild(main);

  var actions = el("div", "row-actions");
  actions.appendChild(toggle("toggle-rule", rule.enabled === 1 ? "On" : "Off", rule.enabled === 1));
  actions.appendChild(iconButton("delete-rule", "Delete rule", "trash", "btn-danger"));
  row.appendChild(actions);
  return row;
}

/* ----------------------------------------------------------- inspector --- */

function matchesFilter(comment, filter) {
  if (filter === "new") return comment.status === null || comment.status === undefined;
  if (filter === "hidden") return comment.isHidden === true || comment.status === "hidden";
  if (filter === "flagged") return comment.status === "flagged";
  if (filter === "skipped") return comment.status === "skipped";
  if (filter === "would-hide") return comment.wouldBe === "hide";
  return true;
}

function commentMatchesFilter(comment) { return matchesFilter(comment, state.filter); }

function commentMatchesQuery(comment) {
  if (!state.query) return true;
  var haystack = ((comment.message || "") + " " + (comment.authorName || "")).toLowerCase();
  return haystack.indexOf(state.query) !== -1;
}

function renderComments() {
  // The clip fade has to be re-evaluated for every branch below, including the
  // empty and skeleton ones, so the wrapper owns it.
  renderCommentList();
  updateInspClip();
}

function renderCommentList() {
  var host = byId("insp-body");
  if (!host) return;

  updateChipCounts();
  updateInspectorSummary();

  if (!state.selected) {
    emptyState(host, "inbox", "Nothing selected",
      "Watch a post first — the inspector shows its live comments beside the verdict your rules would reach.");
    return;
  }
  if (state.loading.comments) { skeletonRows(4, host); return; }

  var visible = state.comments.filter(function (comment) {
    return commentMatchesFilter(comment) && commentMatchesQuery(comment);
  });

  if (!visible.length) {
    emptyState(host, "search", "No comments match",
      state.comments.length ? "Clear the filter or the search box to see the rest."
                            : "This post has no comments the Graph API will return yet.");
    return;
  }

  clear(host);
  visible.forEach(function (comment) { host.appendChild(commentNode(comment)); });
}

/** The bottom fade means "there is more below", so only show it when true. */
function updateInspClip() {
  var host = byId("insp-body");
  if (!host) return;
  var clipped = host.scrollTop + host.clientHeight < host.scrollHeight - 4;
  host.classList.toggle("is-clipped", clipped);
}

function updateChipCounts() {
  var chips = document.querySelectorAll("#insp-chips .chip-btn");
  for (var i = 0; i < chips.length; i++) {
    var button = chips[i];
    var filter = button.getAttribute("data-filter");
    button.setAttribute("aria-pressed", filter === state.filter ? "true" : "false");
    var total = state.comments.filter(function (comment) {
      return matchesFilter(comment, filter);
    }).length;
    var badge = button.querySelector(".n");
    if (!badge) { badge = el("span", "n"); button.appendChild(badge); }
    badge.textContent = String(total);
  }
}

function updateInspectorSummary() {
  var node = byId("insp-summary");
  if (!node) return;
  var post = findPost(state.selected);
  if (!post) { node.textContent = "Select a post to inspect."; return; }
  var stats = state.stats || {};
  node.textContent =
    countLabel(state.comments.length, "comment") + " loaded \\u00b7 " +
    num(stats.hidden || 0) + " hidden \\u00b7 " +
    num(stats.flagged || 0) + " flagged \\u00b7 " +
    postLabel(post);
}

function statusChip(comment) {
  if (comment.status === "hidden") return chip("Hidden", "danger", "eyeOff");
  if (comment.status === "flagged") return chip("Flagged", "warn", "flag");
  if (comment.status === "skipped") return chip("Skipped", null, "close");
  if (comment.status === "error") return chip("Error", "danger", "alert");
  if (comment.status === "restored") return chip("Restored", "ok", "eye");
  if (comment.status === "seen") return chip("Seen", null, "check");
  return chip("Unseen", "teal", "clock");
}

function commentNode(comment) {
  var node = el("article", "comment");
  node.setAttribute("data-comment", comment.id);

  var head = el("div", "comment-head");
  head.appendChild(el("span", "comment-author", comment.authorName || "Unknown author"));
  var when = parseTime(comment.createdTime);
  var time = el("span", "comment-time", when ? relTime(when) : "");
  var absolute = absTime(when);
  if (absolute) time.title = absolute;
  head.appendChild(time);
  node.appendChild(head);

  node.appendChild(el("p", "comment-body", comment.message || "(no text)"));

  var tags = el("div", "comment-tags");
  tags.appendChild(statusChip(comment));
  if (comment.isHidden) tags.appendChild(chip("Hidden on Facebook", "danger", "eyeOff"));
  if (!comment.canHide && !comment.isHidden) tags.appendChild(chip("Cannot be hidden", null, "alert"));
  if (comment.reason) tags.appendChild(el("span", "muted small", comment.reason));
  node.appendChild(tags);

  var side = el("div", "comment-side");
  var verdict = comment.wouldBe || "keep";
  var LABELS = {
    hide: "Would hide", flag: "Would flag", keep: "Would keep", settled: "Already decided",
  };
  var ICONS_BY_VERDICT = {
    hide: "eyeOff", flag: "flag", keep: "check", settled: "check",
  };
  var would = el("span", "would");
  would.setAttribute("data-v", verdict);
  would.appendChild(svgIcon(ICONS_BY_VERDICT[verdict] || "check"));
  would.appendChild(el("span", null, LABELS[verdict] || "Would keep"));
  // "settled" means the poller will not revisit this comment, so no rule
  // outcome can apply to it any more — saying "Would hide" there would promise
  // something that is never going to happen.
  would.title = verdict === "settled"
    ? "This comment already carries a decision; the next check will leave it alone"
    : "What the next check would do to this comment right now";
  side.appendChild(would);

  if (comment.isHidden) {
    side.appendChild(textButton("show-comment", "Show", "eye"));
  } else {
    var hideBtn = textButton("hide-comment", "Hide", "eyeOff", "btn-danger");
    if (!comment.canHide) {
      hideBtn.disabled = true;
      hideBtn.title = "The Graph API reports this comment cannot be hidden";
    }
    side.appendChild(hideBtn);
  }
  node.appendChild(side);
  return node;
}

/* ------------------------------------------------------------ activity --- */

function renderEvents() {
  var host = byId("event-rows");
  if (!host) return;
  clear(host);

  if (state.loading.events) {
    for (var i = 0; i < 3; i++) {
      var skeletonRow = el("tr");
      for (var c = 0; c < 4; c++) {
        var cell = el("td");
        cell.appendChild(el("div", "skel"));
        skeletonRow.appendChild(cell);
      }
      host.appendChild(skeletonRow);
    }
    return;
  }

  if (!state.events.length) {
    var emptyRow = el("tr");
    var emptyCell = el("td", "muted", "Nothing has happened yet. Events appear here as soon as the first check runs.");
    emptyCell.colSpan = 4;
    emptyRow.appendChild(emptyCell);
    host.appendChild(emptyRow);
    return;
  }

  state.events.forEach(function (event) { host.appendChild(eventRow(event)); });
}

function eventRow(event) {
  var row = el("tr");
  row.setAttribute("data-level", event.level || "info");

  var timeCell = el("td", "col-time", relTime(event.ts));
  var absolute = absTime(event.ts);
  if (absolute) timeCell.title = absolute;
  row.appendChild(timeCell);

  var actionCell = el("td");
  actionCell.appendChild(el("span", null, event.action || "event"));
  row.appendChild(actionCell);

  row.appendChild(el("td", "mono", event.post_id ? truncate(event.post_id, 28) : "—"));
  row.appendChild(el("td", "col-detail", truncate(event.error_message || event.detail || "—", 160)));
  return row;
}
`;
