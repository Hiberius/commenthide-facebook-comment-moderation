// Client fragment: data loading and every mutation the dashboard performs.
// Optimistic updates are used only where a rollback is exact — a boolean flip
// on a post, a rule or a comment. Anything that creates or destroys a row waits
// for the server before it redraws.

export const actionsScript: string = `
/* ------------------------------------------------------------- loaders --- */

function ensureSelected() {
  var posts = statusPosts();
  var stillThere = posts.some(function (post) { return post.post_id === state.selected; });
  if (stillThere) return;
  setState({
    selected: posts.length && posts[0] ? posts[0].post_id : null,
    comments: [],
    stats: null
  });
}

function loadStatus() {
  return api("GET", "/api/status").then(function (data) {
    var previous = state.selected;
    setState({ csrf: data.csrfToken || state.csrf, authed: true, status: data, offline: false });
    setLoading({ posts: false });
    showApp();
    ensureSelected();
    renderStatus();
    renderConnection();
    renderPosts();
    renderPostSelect();
    renderComments();
    if (state.selected && state.selected !== previous) return loadComments();
    return null;
  });
}

function loadRules() {
  setLoading({ rules: true });
  renderRules();
  return api("GET", "/api/rules").then(function (data) {
    setState({ rules: Array.isArray(data.rules) ? data.rules : [] });
    setLoading({ rules: false });
    renderRules();
  }).catch(function (error) {
    setLoading({ rules: false });
    renderRules();
    fail(error);
  });
}

function loadEvents() {
  setLoading({ events: true });
  renderEvents();
  return api("GET", "/api/events?limit=25").then(function (data) {
    setState({ events: Array.isArray(data.events) ? data.events : [] });
    setLoading({ events: false });
    renderEvents();
  }).catch(function (error) {
    setLoading({ events: false });
    renderEvents();
    fail(error);
  });
}

function loadComments() {
  var requested = state.selected;
  if (!requested) {
    setState({ comments: [], stats: null });
    setLoading({ comments: false });
    renderComments();
    return Promise.resolve();
  }
  setLoading({ comments: true });
  renderComments();
  return api("GET", "/api/posts/" + encodeURIComponent(requested) + "/comments").then(function (data) {
    // A newer selection may have landed while this request was in flight.
    if (state.selected !== requested) return;
    setState({
      comments: Array.isArray(data.comments) ? data.comments : [],
      stats: data.stats || null
    });
    setLoading({ comments: false });
    renderComments();
  }).catch(function (error) {
    setLoading({ comments: false });
    renderComments();
    fail(error);
  });
}

function loadRecent(button) {
  busy(button, true);
  return api("GET", "/api/page/posts").then(function (data) {
    setState({ recent: Array.isArray(data.posts) ? data.posts : [] });
    renderRecent();
  }).catch(fail).then(function () { busy(button, false); });
}

/* --------------------------------------------------------------- auth --- */

function doLogin(password, submitButton) {
  var errorNode = byId("login-error");
  show(errorNode, false);
  busy(submitButton, true);

  return fetch("/api/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: password })
  }).then(function (res) {
    return res.text().then(function (raw) {
      var data = {};
      if (raw) { try { data = JSON.parse(raw); } catch (parseError) { data = {}; } }
      return { res: res, data: data };
    });
  }).then(function (result) {
    busy(submitButton, false);
    if (!result.res.ok) {
      var message = result.data.error || "Incorrect password.";
      var wait = result.data.retryAfterSec;
      if (typeof wait === "number" && wait > 0) {
        var minutes = Math.ceil(wait / 60);
        message = "Too many attempts. Locked for " + minutes + " more " +
          (minutes === 1 ? "minute" : "minutes") + ".";
      }
      if (errorNode) { errorNode.textContent = message; show(errorNode, true); }
      var field = byId("login-password");
      if (field) { field.value = ""; field.focus(); }
      return;
    }
    setState({ csrf: result.data.csrfToken || null, authed: true });
    var input = byId("login-password");
    if (input) input.value = "";
    bootData();
  }).catch(function (error) {
    busy(submitButton, false);
    if (errorNode) {
      errorNode.textContent = error && error.message ? error.message : "Sign-in failed.";
      show(errorNode, true);
    }
  });
}

function doLogout() {
  return api("DELETE", "/api/session")
    .then(function () { showLogin(); })
    .catch(function (error) { showLogin(); fail(error); });
}

/* --------------------------------------------------------------- page --- */

function saveToken(form) {
  var input = byId("token-input");
  var value = input ? input.value.trim() : "";
  if (!value) { toast("Paste a Page Access Token first.", "error"); return Promise.resolve(); }
  var submit = form ? form.querySelector('button[type="submit"]') : null;
  busy(submit, true);
  return api("PUT", "/api/page/token", { token: value }).then(function (data) {
    if (input) input.value = "";
    var name = data.page && data.page.name ? data.page.name : "your Page";
    toast("Connected to " + name + ".", "ok");
    return loadStatus();
  }).catch(fail).then(function () { busy(submit, false); });
}

function disconnectToken() {
  if (!window.confirm("Remove the stored Page Access Token? Moderation stops until you add a new one.")) return;
  api("DELETE", "/api/page/token").then(function () {
    setState({ recent: null });
    renderRecent();
    toast("Token removed.", "ok");
    return loadStatus();
  }).catch(fail);
}

/* -------------------------------------------------------------- posts --- */

function addPost(form) {
  var input = byId("post-input");
  var baseline = byId("post-baseline");
  var value = input ? input.value.trim() : "";
  if (!value) { toast("Enter a post id or a Facebook post URL.", "error"); return Promise.resolve(); }

  var submit = form ? form.querySelector('button[type="submit"]') : null;
  busy(submit, true);
  return api("POST", "/api/posts", {
    postId: value,
    baseline: baseline ? baseline.checked : true
  }).then(function (data) {
    if (input) input.value = "";
    setState({ recent: null });
    renderRecent();
    if (data.test && data.test.ok === false && data.test.error) {
      toast(data.test.error, "error");
    } else {
      toast("Now watching " + postLabel(data.post) + ".", "ok");
    }
    if (data.post && data.post.post_id) setState({ selected: data.post.post_id });
    // loadStatus only refetches comments when the selection changes, and we
    // just changed it ourselves — so ask for the new post's comments directly.
    return loadStatus().then(loadEvents).then(loadComments);
  }).catch(fail).then(function () { busy(submit, false); });
}

function applyPostPatch(postId, patch) {
  var posts = statusPosts().map(function (post) {
    if (post.post_id !== postId) return post;
    var next = Object.assign({}, post);
    if (patch.active !== undefined) next.active = patch.active ? 1 : 0;
    if (patch.dryRun !== undefined) next.dry_run = patch.dryRun ? 1 : 0;
    if (patch.includeReplies !== undefined) next.include_replies = patch.includeReplies ? 1 : 0;
    if (patch.mode !== undefined) next.mode = patch.mode;
    if (patch.label !== undefined) next.label = patch.label;
    return next;
  });
  setState({ status: Object.assign({}, state.status, { posts: posts }) });
}

function patchPost(postId, patch) {
  var before = statusPosts();
  applyPostPatch(postId, patch);
  renderStatus();
  renderPosts();
  return api("PATCH", "/api/posts/" + encodeURIComponent(postId), patch)
    .then(function () { return loadStatus(); })
    .catch(function (error) {
      setState({ status: Object.assign({}, state.status, { posts: before }) });
      renderStatus();
      renderPosts();
      fail(error);
    });
}

function removePost(postId) {
  var post = findPost(postId);
  if (!window.confirm("Stop watching " + postLabel(post) + "? Already hidden comments stay hidden.")) return;
  api("DELETE", "/api/posts/" + encodeURIComponent(postId))
    .then(function () { toast("Post removed.", "ok"); return loadStatus().then(loadEvents); })
    .catch(fail);
}

function testPost(postId, button) {
  busy(button, true);
  api("POST", "/api/posts/" + encodeURIComponent(postId) + "/test", {}).then(function (test) {
    if (test && test.ok) {
      toast("Connection fine — " + num(test.sampleComments || 0) + " comments visible.", "ok");
    } else {
      toast((test && test.error) || "The Graph API refused that post.", "error");
    }
  }).catch(fail).then(function () { busy(button, false); });
}

function restoreAll() {
  if (!state.selected) return;
  var post = findPost(state.selected);
  if (!window.confirm("Unhide every comment CommentHide hid on " + postLabel(post) + "?")) return;
  api("POST", "/api/posts/" + encodeURIComponent(state.selected) + "/restore", {}).then(function (data) {
    toast(num(data.restored || 0) + " restored, " + num(data.errors || 0) + " failed.",
      data.errors ? "error" : "ok");
    return loadStatus().then(loadEvents).then(loadComments);
  }).catch(fail);
}

function runNow(options) {
  var body = {};
  if (options && options.postId) body.postId = options.postId;
  if (options && options.dryRun) body.dryRun = true;
  busy(options && options.button, true);
  return api("POST", "/api/run", body).then(function (data) {
    var summary = data.summary || {};
    toast(
      "Checked " + num(summary.fetched || 0) + " comments \\u2014 " +
      num(summary.hidden || 0) + " hidden, " + num(summary.flagged || 0) + " flagged, " +
      num(summary.errors || 0) + " errors" + (summary.dryRun ? " (dry run)" : "") + ".",
      summary.errors ? "error" : "ok"
    );
    return loadStatus().then(loadEvents).then(loadComments);
  }).catch(fail).then(function () { busy(options && options.button, false); });
}

/* -------------------------------------------------------------- rules --- */

function addRule(button) {
  var kindNode = byId("rule-kind");
  var kind = kindNode ? kindNode.value : "keyword";
  var meta = ruleKind(kind);
  var patternNode = byId("rule-pattern");
  var pattern = patternNode ? patternNode.value.trim() : "";
  if (meta.pattern && !pattern) {
    toast("This rule kind needs a pattern.", "error");
    if (patternNode) patternNode.focus();
    return;
  }
  var actionNode = byId("rule-action");
  var priorityNode = byId("rule-priority");
  var labelNode = byId("rule-label");

  busy(button, true);
  api("POST", "/api/rules", {
    kind: kind,
    pattern: meta.pattern ? pattern : "",
    action: actionNode ? actionNode.value : "hide",
    priority: priorityNode ? intOr(priorityNode.value, 100) : 100,
    label: labelNode && labelNode.value.trim() ? labelNode.value.trim() : null
  }).then(function () {
    if (patternNode) patternNode.value = "";
    if (labelNode) labelNode.value = "";
    toast("Rule added.", "ok");
    return loadRules();
  }).catch(fail).then(function () { busy(button, false); });
}

function patchRule(id, patch) {
  var before = state.rules;
  var next = before.map(function (rule) {
    if (rule.id !== id) return rule;
    var updated = Object.assign({}, rule);
    if (patch.enabled !== undefined) updated.enabled = patch.enabled ? 1 : 0;
    if (patch.priority !== undefined) updated.priority = patch.priority;
    return updated;
  });
  setState({ rules: next });
  renderRules();
  api("PATCH", "/api/rules/" + encodeURIComponent(String(id)), patch).catch(function (error) {
    setState({ rules: before });
    renderRules();
    fail(error);
  });
}

function deleteRule(id) {
  if (!window.confirm("Delete this rule? Comments it already hid stay hidden.")) return;
  api("DELETE", "/api/rules/" + encodeURIComponent(String(id)))
    .then(function () { toast("Rule deleted.", "ok"); return loadRules(); })
    .catch(fail);
}

function seedRules(button) {
  busy(button, true);
  api("POST", "/api/rules/seed", {}).then(function (data) {
    toast(countLabel(data.created || 0, "starter rule") + " loaded.", "ok");
    return loadRules();
  }).catch(fail).then(function () { busy(button, false); });
}

/* ----------------------------------------------------------- comments --- */

function setCommentHidden(commentId, hidden) {
  var before = state.comments;
  var next = before.map(function (comment) {
    if (comment.id !== commentId) return comment;
    return Object.assign({}, comment, {
      isHidden: hidden,
      status: hidden ? "hidden" : "restored"
    });
  });
  setState({ comments: next });
  renderComments();

  var path = "/api/comments/" + encodeURIComponent(commentId) + "/" + (hidden ? "hide" : "show");
  api("POST", path, { postId: state.selected }).then(function () {
    toast(hidden ? "Comment hidden." : "Comment restored.", "ok");
    return loadEvents();
  }).catch(function (error) {
    setState({ comments: before });
    renderComments();
    fail(error);
  });
}
`;
