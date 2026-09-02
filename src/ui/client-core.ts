// Client fragment: state container, transport, DOM primitives, formatting.
//
// Every fragment in this directory is a slice of ONE function body — they are
// concatenated inside a single IIFE by ./client, so `var` declarations here are
// visible to the render and action fragments and nothing leaks to `window`.
//
// Security note that governs this whole script: Facebook comments, author
// names, rule patterns and event details are untrusted. They are written to the
// DOM with `textContent` only. The single `innerHTML` assignment in the file is
// `svgIcon()`, which reads from the build-time ICONS constant.

export const coreScript: string = `
/* ---------------------------------------------------------------- state -- */

var POLL_MS = 20000;
var pollTimer = null;
var searchTimer = null;

var state = {
  csrf: null,
  authed: false,
  status: null,
  rules: [],
  events: [],
  recent: null,
  selected: null,
  comments: [],
  stats: null,
  filter: "all",
  query: "",
  offline: false,
  loading: { posts: true, rules: true, events: true, comments: false }
};

/** State is replaced, never mutated in place, so renders always see a snapshot. */
function setState(patch) { state = Object.assign({}, state, patch); }
function setLoading(patch) { setState({ loading: Object.assign({}, state.loading, patch) }); }
function statusPosts() { return state.status && state.status.posts ? state.status.posts : []; }
function noop() {}

/* ------------------------------------------------------------ transport -- */

function api(method, path, body) {
  var opts = { method: method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  // Double-submit CSRF: the cookie is set by the Worker, the header by us.
  if (method !== "GET" && state.csrf) opts.headers["x-csrf-token"] = state.csrf;

  return fetch(path, opts).then(
    function (res) {
      return res.text().then(function (raw) {
        var data = {};
        if (raw) {
          try { data = JSON.parse(raw); } catch (parseError) { data = {}; }
        }
        if (res.status === 401) {
          var expired = new Error(data.error || "Your session has expired.");
          expired.unauthorized = true;
          onUnauthorized();
          throw expired;
        }
        if (!res.ok) {
          var failed = new Error(data.error || ("Request failed (" + res.status + ")"));
          failed.status = res.status;
          failed.payload = data;
          throw failed;
        }
        return data;
      });
    },
    function (networkError) {
      var message = networkError && networkError.message ? networkError.message : "request failed";
      throw new Error("Network error — " + message);
    }
  );
}

/** Single funnel for surfacing an error. Never swallows one silently. */
function fail(error) {
  if (!error) return;
  if (error.unauthorized) return; // the login view is already showing
  toast(error.message || "Something went wrong.", "error");
}

/* ----------------------------------------------------------------- DOM --- */

function byId(id) { return document.getElementById(id); }

function el(tag, cls, text) {
  var node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/** ICONS is a build-time constant — the only trusted markup in this script. */
function svgIcon(name, cls) {
  var span = document.createElement("span");
  span.className = cls || "ico";
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = ICONS[name] || "";
  return span;
}

function clear(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function show(node, on) { if (node) node.hidden = !on; }

function busy(node, on) {
  if (!node) return;
  node.classList.toggle("is-busy", !!on);
  node.disabled = !!on;
}

function chip(text, tone, iconName) {
  var node = el("span", "chip");
  if (tone) node.setAttribute("data-tone", tone);
  if (iconName) node.appendChild(svgIcon(iconName));
  node.appendChild(el("span", null, text));
  return node;
}

function iconButton(action, label, iconName, cls) {
  var btn = el("button", "btn " + (cls || "btn-ghost") + " btn-icon");
  btn.type = "button";
  btn.setAttribute("data-action", action);
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.appendChild(svgIcon(iconName));
  return btn;
}

function textButton(action, label, iconName, cls) {
  var btn = el("button", "btn " + (cls || "btn-ghost") + " btn-sm");
  btn.type = "button";
  btn.setAttribute("data-action", action);
  btn.appendChild(svgIcon(iconName));
  btn.appendChild(el("span", null, label));
  return btn;
}

function toggle(action, label, on) {
  var btn = el("button", "switch");
  btn.type = "button";
  btn.setAttribute("data-action", action);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  var track = el("span", "track");
  track.appendChild(el("span", "knob"));
  btn.appendChild(track);
  btn.appendChild(el("span", null, label));
  return btn;
}

function skeletonRows(count, host) {
  clear(host);
  for (var i = 0; i < count; i++) {
    var row = el("div", "skel-row");
    row.appendChild(el("div", "skel tall w-40"));
    row.appendChild(el("div", "skel w-85"));
    row.appendChild(el("div", "skel w-60"));
    host.appendChild(row);
  }
}

function emptyState(host, iconName, title, body, actionNode) {
  clear(host);
  var box = el("div", "empty");
  box.appendChild(svgIcon(iconName, "ico"));
  box.appendChild(el("h3", null, title));
  box.appendChild(el("p", null, body));
  if (actionNode) box.appendChild(actionNode);
  host.appendChild(box);
}

/* --------------------------------------------------------------- toast --- */

function toast(message, tone) {
  var region = byId("toast-region");
  if (!region) return;
  var node = el("div", "toast");
  node.setAttribute("data-tone", tone || "info");
  node.appendChild(svgIcon(tone === "error" ? "alert" : tone === "ok" ? "check" : "activity"));
  node.appendChild(el("p", null, message));
  region.appendChild(node);

  var timer = setTimeout(dismiss, tone === "error" ? 9000 : 5000);
  function dismiss() {
    clearTimeout(timer);
    node.classList.add("is-out");
    setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 280);
  }
  node.addEventListener("click", dismiss);
}

/* ---------------------------------------------------------- formatting --- */

function num(value) {
  return typeof value === "number" && isFinite(value) ? value.toLocaleString() : "0";
}

function relTime(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "never";
  var diff = Date.now() - ms;
  if (diff < 0) diff = 0;
  var seconds = Math.round(diff / 1000);
  if (seconds < 45) return "just now";
  var minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  var hours = Math.round(minutes / 60);
  if (hours < 24) return hours + "h ago";
  var days = Math.round(hours / 24);
  if (days < 30) return days + "d ago";
  return new Date(ms).toISOString().slice(0, 10);
}

function absTime(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "";
  try { return new Date(ms).toLocaleString(); } catch (formatError) { return ""; }
}

function parseTime(value) {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string") {
    var parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : null;
  }
  return null;
}

function truncate(value, max) {
  var text = value === null || value === undefined ? "" : String(value);
  return text.length > max ? text.slice(0, max - 1) + "\\u2026" : text;
}

/** Only http(s) survives — a permalink is server data and lands in an href. */
function safeUrl(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    var url = new URL(value, window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch (urlError) {
    return null;
  }
}

function postLabel(post) {
  if (!post) return "Unknown post";
  return post.label || post.post_id || "Untitled post";
}

function findPost(postId) {
  var posts = statusPosts();
  for (var i = 0; i < posts.length; i++) {
    if (posts[i] && posts[i].post_id === postId) return posts[i];
  }
  return null;
}
`;
