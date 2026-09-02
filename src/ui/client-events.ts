// Client fragment: view switching, polling, event wiring and boot.
// One delegated click listener drives every [data-action] control, so rows can
// be redrawn freely without rebinding anything.

export const eventsScript: string = `
/* ---------------------------------------------------------------- views --- */

function showLogin() {
  var login = byId("view-login");
  if (login && !login.hidden) return; // already there — do not steal focus twice
  stopPolling();
  setState({
    authed: false, status: null, rules: [], events: [],
    comments: [], stats: null, recent: null, selected: null, offline: false
  });
  show(byId("view-app"), false);
  show(byId("masthead-tools"), false);
  show(login, true);
  var field = byId("login-password");
  if (field) field.focus();
}

function showApp() {
  show(byId("view-login"), false);
  show(byId("view-app"), true);
  show(byId("masthead-tools"), true);
  startPolling();
}

function onUnauthorized() { showLogin(); }

/* -------------------------------------------------------------- polling --- */

function startPolling() {
  stopPolling();
  if (document.hidden || !state.authed) return;
  pollTimer = setInterval(function () {
    loadStatus().catch(function (error) {
      if (error && error.unauthorized) return;
      // A background poll must not spam toasts; the pill carries the bad news.
      setState({ offline: true });
      renderStatus();
    });
  }, POLL_MS);
}

function stopPolling() {
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
}

/* --------------------------------------------------------------- rules --- */

function syncRuleKind() {
  var kindNode = byId("rule-kind");
  var meta = ruleKind(kindNode ? kindNode.value : "keyword");
  var label = byId("rule-pattern-label");
  var input = byId("rule-pattern");
  var hint = byId("rule-pattern-hint");

  if (label) { label.textContent = meta.label || "Pattern"; label.hidden = !meta.pattern; }
  if (input) {
    input.placeholder = meta.placeholder || "";
    input.hidden = !meta.pattern;
    input.disabled = !meta.pattern;
    if (!meta.pattern) input.value = "";
  }
  if (hint) {
    clear(hint);
    hint.appendChild(svgIcon(meta.icon || "type"));
    hint.appendChild(el("span", null, meta.hint || ""));
  }
}

/* ------------------------------------------------------------- actions --- */

function closestValue(node, attribute) {
  var host = node.closest("[" + attribute + "]");
  return host ? host.getAttribute(attribute) : null;
}

function handleAction(action, target) {
  var pressed = target.getAttribute("aria-pressed") === "true";
  var postId = closestValue(target, "data-post");
  var ruleId = closestValue(target, "data-rule");
  var commentId = closestValue(target, "data-comment");

  if (action === "signout") { doLogout(); return; }
  if (action === "run") { runNow({ button: target }); return; }
  if (action === "run-dry") { runNow({ dryRun: true, button: target }); return; }
  if (action === "recent") { loadRecent(target); return; }
  if (action === "disconnect") { disconnectToken(); return; }
  if (action === "reload-events") { loadEvents(); return; }
  if (action === "reload-comments") { loadComments(); return; }
  if (action === "restore-all") { restoreAll(); return; }
  if (action === "seed-rules") { seedRules(target); return; }
  if (action === "add-rule") { addRule(target); return; }

  if (action === "pick-recent" && postId) {
    var input = byId("post-input");
    if (input) { input.value = postId; input.focus(); }
    toast("Post id copied into the form — review it, then Watch post.", "info");
    return;
  }
  if (action === "toggle-active" && postId) { patchPost(postId, { active: !pressed }); return; }
  if (action === "toggle-dry" && postId) { patchPost(postId, { dryRun: !pressed }); return; }
  if (action === "run-post" && postId) { runNow({ postId: postId, button: target }); return; }
  if (action === "test-post" && postId) { testPost(postId, target); return; }
  if (action === "remove-post" && postId) { removePost(postId); return; }

  if (action === "toggle-rule" && ruleId) { patchRule(parseInt(ruleId, 10), { enabled: !pressed }); return; }
  if (action === "delete-rule" && ruleId) { deleteRule(parseInt(ruleId, 10)); return; }

  if (action === "hide-comment" && commentId) { setCommentHidden(commentId, true); return; }
  if (action === "show-comment" && commentId) { setCommentHidden(commentId, false); return; }
}

/* --------------------------------------------------------------- wiring --- */

function wire() {
  document.addEventListener("click", function (event) {
    var node = event.target;
    if (!node || !node.closest) return;

    var filterButton = node.closest("[data-filter]");
    if (filterButton) {
      setState({ filter: filterButton.getAttribute("data-filter") || "all" });
      renderComments();
      return;
    }

    var actionHost = node.closest("[data-action]");
    if (!actionHost) return;
    var action = actionHost.getAttribute("data-action");
    if (!action) return;
    event.preventDefault();
    handleAction(action, actionHost);
  });

  var loginForm = byId("login-form");
  if (loginForm) {
    loginForm.addEventListener("submit", function (event) {
      event.preventDefault();
      var field = byId("login-password");
      doLogin(field ? field.value : "", byId("login-submit"));
    });
  }

  var tokenForm = byId("token-form");
  if (tokenForm) {
    tokenForm.addEventListener("submit", function (event) {
      event.preventDefault();
      saveToken(tokenForm);
    });
  }

  var postForm = byId("post-form");
  if (postForm) {
    postForm.addEventListener("submit", function (event) {
      event.preventDefault();
      addPost(postForm);
    });
  }

  var kindNode = byId("rule-kind");
  if (kindNode) kindNode.addEventListener("change", syncRuleKind);

  var rulePanel = byId("panel-rules");
  if (rulePanel) {
    rulePanel.addEventListener("keydown", function (event) {
      if (event.key !== "Enter") return;
      var node = event.target;
      if (!node || node.tagName !== "INPUT") return;
      event.preventDefault();
      var button = rulePanel.querySelector('[data-action="add-rule"]');
      if (button) addRule(button);
    });
  }

  var select = byId("insp-post");
  if (select) {
    select.addEventListener("change", function () {
      setState({ selected: select.value || null, comments: [], stats: null });
      loadComments();
    });
  }

  var inspBody = byId("insp-body");
  if (inspBody) inspBody.addEventListener("scroll", updateInspClip, { passive: true });

  var search = byId("insp-search");
  if (search) {
    search.addEventListener("input", function () {
      if (searchTimer !== null) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        setState({ query: search.value.trim().toLowerCase() });
        renderComments();
      }, 140);
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { stopPolling(); return; }
    if (!state.authed) return;
    startPolling();
    loadStatus().catch(function (error) { if (!error || !error.unauthorized) fail(error); });
  });
}

/* ------------------------------------------------------------------ boot --- */

function bootData() {
  loadStatus()
    .then(function () { return Promise.all([loadRules(), loadEvents()]); })
    .catch(function (error) {
      // A 401 has already swapped in the login card. Anything else (the Worker
      // is down, the network dropped) must still paint the shell rather than
      // leaving the page blank behind a toast.
      if (error && error.unauthorized) return;
      setState({ offline: true });
      showApp();
      renderStatus();
      renderConnection();
      renderPosts();
      renderPostSelect();
      renderComments();
      setLoading({ rules: false, events: false });
      renderRules();
      renderEvents();
      fail(error);
    });
}

function init() {
  wire();
  syncRuleKind();
  renderRecent();

  var clock = byId("colophon-clock");
  if (clock) {
    var zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (zoneError) { zone = ""; }
    clock.textContent = "Checked every minute" + (zone ? " \\u00b7 times shown in " + zone : "");
  }

  bootData();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
`;
