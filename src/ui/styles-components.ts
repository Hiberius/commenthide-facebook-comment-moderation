// Component layer: controls, panels, rows, tables, toasts.
// Loaded by ./styles — split only to keep each file under the 400-line ceiling.

export const componentStyles: string = `
/* --- panel chrome ------------------------------------------------------- */

.panel-head {
  display:flex; align-items:flex-start; justify-content:space-between;
  gap:14px; flex-wrap:wrap;
  padding:18px clamp(18px,2vw,24px) 14px;
  border-bottom:1px solid var(--hairline);
}
.panel-head h2 { font-size:1.02rem; font-weight:620; letter-spacing:-.015em; }
.panel-body { padding:clamp(16px,1.9vw,22px); display:flex; flex-direction:column; gap:16px; }
.panel-body.tight { gap:10px; }
.panel-foot {
  padding:12px clamp(18px,2vw,24px); border-top:1px solid var(--hairline);
  display:flex; align-items:center; justify-content:space-between; gap:12px;
  font-size:12.5px; color:var(--text-dim);
}
.eyebrow {
  font-size:10.5px; text-transform:uppercase; letter-spacing:.16em;
  font-weight:620; color:var(--text-dim);
}
.muted { color:var(--text-dim); }
.small { font-size:12.5px; }
.mono { font-family:var(--mono); font-size:12px; letter-spacing:-.01em; }
.ico { display:inline-flex; flex:none; }
.ico svg { width:16px; height:16px; }
.ico.lg svg { width:20px; height:20px; }

/* --- buttons ------------------------------------------------------------ */

.btn {
  position:relative; isolation:isolate;
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  padding:9px 15px;
  border:0; border-radius:var(--r-ctrl);
  background:var(--glass); color:var(--text);
  font-size:13.5px; font-weight:580; letter-spacing:.005em;
  cursor:pointer; white-space:nowrap;
  transition:transform var(--d1) var(--ease), background-color var(--d1) var(--ease),
             filter var(--d1) var(--ease), opacity var(--d1) var(--ease);
}
.btn::before {
  content:""; position:absolute; inset:0; border-radius:inherit; padding:1px;
  background:linear-gradient(170deg,var(--spec-top),var(--spec-mid) 55%,var(--spec-bot));
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  mask-composite:exclude;
  opacity:.7; pointer-events:none;
  transition:opacity var(--d1) var(--ease);
}
.btn:hover { background:var(--glass-hi); transform:translateY(-1px); }
.btn:hover::before { opacity:1; }
.btn:active { transform:translateY(0) scale(.985); }
.btn[disabled],.btn[aria-disabled="true"] { opacity:.42; cursor:not-allowed; transform:none; }
.btn svg { width:16px; height:16px; }

.btn-primary {
  background:linear-gradient(128deg,var(--primary-a),var(--primary-b));
  color:var(--primary-fg); font-weight:620;
  box-shadow:0 12px 30px -16px var(--primary-b);
}
.btn-primary:hover { background:linear-gradient(128deg,var(--primary-a),var(--primary-b)); filter:brightness(1.08); }
.btn-danger { color:var(--danger); background:var(--danger-soft); }
.btn-danger:hover { background:var(--danger-soft); filter:brightness(1.25); }
.btn-ghost { background:transparent; }
.btn-ghost::before { opacity:.35; }
.btn-ghost:hover { background:var(--glass); }
.btn-sm { padding:6px 11px; font-size:12.5px; border-radius:10px; }
.btn-icon { padding:7px; border-radius:10px; }
.btn-icon svg { width:15px; height:15px; }
.btn-block { width:100%; }
.btn.is-busy { pointer-events:none; opacity:.6; }

/* --- fields ------------------------------------------------------------- */

.field { display:flex; flex-direction:column; gap:6px; min-width:0; }
.field > label,.field-label {
  font-size:11px; text-transform:uppercase; letter-spacing:.13em;
  font-weight:620; color:var(--text-dim);
}
.input,select.input,textarea.input {
  width:100%;
  padding:10px 13px;
  border-radius:var(--r-ctrl);
  border:1px solid var(--edge);
  background:var(--ink-900);
  color:var(--text);
  font-size:14px;
  transition:border-color var(--d1) var(--ease), background-color var(--d1) var(--ease);
}
@media (prefers-color-scheme: light) { .input,select.input { background:rgba(255,255,255,.72); } }
.input::placeholder { color:var(--text-dim); opacity:.75; }
.input:hover { border-color:var(--glass-hi); }
.input:focus-visible { outline:2px solid var(--focus); outline-offset:1px; border-color:transparent; }
select.input { appearance:none; padding-right:34px;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 17px) 52%,calc(100% - 12px) 52%;
  background-size:5px 5px,5px 5px; background-repeat:no-repeat; }
.hint { font-size:12px; color:var(--text-dim); display:flex; gap:7px; align-items:flex-start; line-height:1.45; }
.hint svg { width:14px; height:14px; margin-top:2px; opacity:.8; }
.form-error {
  font-size:13px; color:var(--danger);
  background:var(--danger-soft); border-radius:10px; padding:9px 12px;
  display:flex; gap:8px; align-items:flex-start;
}
.check { display:inline-flex; align-items:center; gap:8px; font-size:13px; color:var(--text-dim); cursor:pointer; }
.check input { accent-color:var(--primary-b); width:15px; height:15px; }
.check:hover { color:var(--text); }
.search { position:relative; display:flex; align-items:center; }
.search .ico { position:absolute; left:11px; color:var(--text-dim); pointer-events:none; }
.search .input { padding-left:34px; }

/* --- pills, chips, badges ----------------------------------------------- */

.status-pill {
  display:inline-flex; align-items:center; gap:9px;
  padding:7px 15px 7px 12px; border-radius:var(--r-pill);
  background:var(--glass); font-size:12.5px; font-weight:580; letter-spacing:.01em;
  color:var(--text-dim);
}
.status-pill .dot { position:relative; width:8px; height:8px; border-radius:50%; background:currentColor; flex:none; }
.status-pill[data-tone="active"] { color:var(--ok); }
.status-pill[data-tone="dry"] { color:var(--warn); }
.status-pill[data-tone="paused"] { color:var(--text-dim); }
.status-pill[data-tone="active"] .dot::after {
  content:""; position:absolute; inset:0; border-radius:50%; background:currentColor;
  animation:pulse 2.6s var(--ease) infinite;
}
@keyframes pulse {
  0% { transform:scale(1); opacity:.65; }
  70%,100% { transform:scale(3.2); opacity:0; }
}

.chip {
  display:inline-flex; align-items:center; gap:6px;
  padding:4px 10px; border-radius:var(--r-pill);
  background:var(--glass); color:var(--text-dim);
  font-size:11.5px; font-weight:600; letter-spacing:.02em; white-space:nowrap;
}
.chip svg { width:13px; height:13px; }
.chip[data-tone="ok"] { color:var(--ok); background:var(--ok-soft); }
.chip[data-tone="warn"] { color:var(--warn); background:var(--warn-soft); }
.chip[data-tone="danger"] { color:var(--danger); background:var(--danger-soft); }
.chip[data-tone="info"] { color:var(--indigo); background:var(--indigo-soft); }
.chip[data-tone="teal"] { color:var(--teal); background:var(--teal-soft); }

.chips { display:flex; gap:8px; flex-wrap:wrap; padding:12px clamp(18px,2vw,24px); border-bottom:1px solid var(--hairline); }
.chip-btn {
  border:1px solid var(--edge); background:transparent; color:var(--text-dim);
  padding:5px 12px; border-radius:var(--r-pill);
  font-size:12.5px; font-weight:580; cursor:pointer;
  transition:transform var(--d1) var(--ease), background-color var(--d1) var(--ease), color var(--d1) var(--ease);
}
.chip-btn:hover { color:var(--text); background:var(--glass); transform:translateY(-1px); }
.chip-btn[aria-pressed="true"] { color:var(--primary-fg); background:linear-gradient(128deg,var(--primary-a),var(--primary-b)); border-color:transparent; }
.chip-btn .n { opacity:.7; margin-left:5px; font-variant-numeric:tabular-nums; }

/* --- switch (aria-pressed button) --------------------------------------- */

.switch {
  display:inline-flex; align-items:center; gap:9px;
  background:none; border:0; padding:3px; cursor:pointer;
  color:var(--text-dim); font-size:12.5px; font-weight:560;
  transition:color var(--d1) var(--ease);
}
.switch .track {
  position:relative; width:36px; height:21px; flex:none;
  border-radius:var(--r-pill); background:var(--glass-hi);
  border:1px solid var(--edge);
  transition:background-color var(--d2) var(--ease);
}
.switch .knob {
  position:absolute; top:3px; left:3px; width:13px; height:13px;
  border-radius:50%; background:var(--text-dim);
  transition:transform var(--d2) var(--ease), background-color var(--d2) var(--ease);
}
.switch:hover { color:var(--text); }
.switch[aria-pressed="true"] { color:var(--text); }
.switch[aria-pressed="true"] .track { background:var(--teal-soft); border-color:var(--teal); }
.switch[aria-pressed="true"] .knob { transform:translateX(15px); background:var(--teal); }

/* --- dry-run banner ----------------------------------------------------- */

.dry-banner {
  display:flex; align-items:center; gap:14px;
  padding:14px 20px; border-radius:var(--r-panel);
  background:var(--warn-soft); color:var(--warn);
  border:1px solid transparent;
  box-shadow:inset 0 0 0 1px var(--warn-soft);
}
.dry-banner .ico svg { width:22px; height:22px; }
.dry-banner strong { color:var(--warn); font-weight:640; }
.dry-banner p { color:var(--text); font-size:13.5px; }
.dry-banner p b { color:var(--warn); }

/* --- rows (posts, rules, comments) -------------------------------------- */

.rows { display:flex; flex-direction:column; }
.row {
  display:flex; align-items:center; gap:14px; flex-wrap:wrap;
  padding:14px clamp(16px,2vw,22px);
  border-top:1px solid var(--hairline);
  transition:background-color var(--d1) var(--ease);
}
.rows > .row:first-child { border-top:0; }
.row:hover { background:var(--glass); }
.row-main { flex:1 1 240px; min-width:0; display:flex; flex-direction:column; gap:3px; }
.row-title { font-weight:600; font-size:14.5px; letter-spacing:-.01em; overflow-wrap:anywhere; }
.row-meta { display:flex; gap:10px; flex-wrap:wrap; align-items:center; color:var(--text-dim); font-size:12px; }
.row-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.row.is-off { opacity:.6; }
.row.is-pending { opacity:.55; }

.counts { display:flex; gap:14px; align-items:baseline; }
.counts b { font-size:1.05rem; font-weight:620; font-variant-numeric:tabular-nums; letter-spacing:-.02em; }
.counts span { font-size:10.5px; text-transform:uppercase; letter-spacing:.13em; color:var(--text-dim); margin-left:5px; }

/* --- comment inspector -------------------------------------------------- */

.insp-tools { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.insp-tools .input { min-width:180px; }
/* The inspector stretches to its grid row so the taller rule-set panel beside
   it never leaves a hole, and the scroll area takes the slack. */
#panel-inspector { align-self:stretch; display:flex; flex-direction:column; }
/* Anchors the summary bar to the panel floor when the comment list is shorter
   than the rule set beside it. */
#panel-inspector .panel-foot { margin-top:auto; }
.insp-scroll {
  flex:1 1 auto;
  min-height:260px;
  max-height:min(900px,84vh);
  overflow-y:auto;
  overscroll-behavior:contain;
}
/* Fades the row sitting on the fold so a clipped comment reads as "more below"
   rather than as a broken layout. Applied only while content is actually cut
   off, so the last comment is never dimmed for nothing. */
.insp-scroll.is-clipped {
  -webkit-mask-image:linear-gradient(to bottom,#000 calc(100% - 34px),transparent);
  mask-image:linear-gradient(to bottom,#000 calc(100% - 34px),transparent);
}
.comment {
  display:grid;
  grid-template-columns:minmax(0,1fr) auto;
  gap:6px 18px;
  padding:15px clamp(16px,2vw,22px);
  border-top:1px solid var(--hairline);
  transition:background-color var(--d1) var(--ease);
}
.insp-scroll > .comment:first-child { border-top:0; }
.comment:hover { background:var(--glass); }
.comment-head { display:flex; gap:9px; align-items:baseline; flex-wrap:wrap; grid-column:1; }
.comment-author { font-weight:620; font-size:13.5px; }
.comment-time { font-size:11.5px; color:var(--text-dim); }
.comment-body { grid-column:1; font-size:14px; line-height:1.5; overflow-wrap:anywhere; }
.comment-tags { grid-column:1; display:flex; gap:7px; flex-wrap:wrap; align-items:center; margin-top:4px; }
.comment-side {
  grid-column:2; grid-row:1 / span 3;
  display:flex; flex-direction:column; align-items:flex-end; gap:8px; justify-content:flex-start;
}
.would {
  display:inline-flex; align-items:center; gap:6px;
  padding:5px 11px; border-radius:var(--r-pill);
  font-size:11.5px; font-weight:620; letter-spacing:.02em;
  border:1px dashed currentColor;
}
.would[data-v="hide"] { color:var(--danger); }
.would[data-v="flag"] { color:var(--warn); }
.would[data-v="keep"] { color:var(--text-dim); }
.would[data-v="settled"] { color:var(--text-dim); opacity:.65; border-style:solid; }
.would svg { width:13px; height:13px; }
@media (max-width:640px) {
  .comment { grid-template-columns:minmax(0,1fr); }
  .comment-side { grid-column:1; grid-row:auto; align-items:flex-start; flex-direction:row; flex-wrap:wrap; }
}

/* --- activity table ----------------------------------------------------- */

.table-wrap { overflow-x:auto; }
table.log { width:100%; border-collapse:collapse; font-size:13px; }
table.log th {
  text-align:left; font-size:10.5px; text-transform:uppercase; letter-spacing:.14em;
  color:var(--text-dim); font-weight:620; padding:10px clamp(16px,2vw,22px);
  border-bottom:1px solid var(--hairline); white-space:nowrap;
}
table.log td { padding:11px clamp(16px,2vw,22px); border-bottom:1px solid var(--hairline); vertical-align:top; }
table.log tr:last-child td { border-bottom:0; }
table.log tbody tr { transition:background-color var(--d1) var(--ease); }
table.log tbody tr:hover { background:var(--glass); }
table.log tbody tr td:first-child { border-left:2px solid transparent; }
table.log tr[data-level="warn"] td:first-child { border-left-color:var(--warn); }
table.log tr[data-level="error"] td:first-child { border-left-color:var(--danger); }
table.log tr[data-level="info"] td:first-child { border-left-color:var(--teal); }
table.log .col-time { white-space:nowrap; color:var(--text-dim); font-variant-numeric:tabular-nums; }
table.log .col-detail { color:var(--text-dim); overflow-wrap:anywhere; }

/* --- recent posts picker ------------------------------------------------ */

.recent { display:flex; flex-direction:column; gap:8px; padding:0 clamp(16px,2vw,22px) 14px; }
.recent-item {
  display:flex; gap:12px; align-items:center; justify-content:space-between;
  width:100%; text-align:left; cursor:pointer;
  padding:10px 13px; border-radius:var(--r-ctrl);
  border:1px solid var(--edge); background:transparent; color:inherit;
  transition:transform var(--d1) var(--ease), background-color var(--d1) var(--ease);
}
.recent-item:hover { background:var(--glass); transform:translateY(-1px); }
.recent-item span { font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* --- empty + skeleton --------------------------------------------------- */

.empty {
  display:flex; flex-direction:column; align-items:center; gap:10px;
  padding:36px 24px; text-align:center; color:var(--text-dim);
}
.empty .ico { color:var(--text-dim); opacity:.7; }
.empty .ico svg { width:30px; height:30px; }
.empty h3 { font-size:14.5px; font-weight:620; color:var(--text); }
.empty p { font-size:13px; max-width:42ch; }

.skel { position:relative; overflow:hidden; background:var(--glass); border-radius:9px; height:13px; }
.skel::after {
  content:""; position:absolute; inset:0;
  background:linear-gradient(90deg,transparent,var(--glass-hi),transparent);
  transform:translateX(-100%);
  animation:sweep 1.6s var(--ease) infinite;
}
@keyframes sweep { to { transform:translateX(100%); } }
.skel-row { display:flex; flex-direction:column; gap:9px; padding:16px clamp(16px,2vw,22px); border-top:1px solid var(--hairline); }
.skel-row:first-child { border-top:0; }
.skel.w-40 { width:40%; } .skel.w-60 { width:60%; } .skel.w-85 { width:85%; }
.skel.tall { height:22px; }

/* --- toast -------------------------------------------------------------- */

.toast-region {
  position:fixed; z-index:60;
  right:clamp(12px,2vw,26px); bottom:clamp(12px,2vw,26px);
  width:min(370px,calc(100vw - 24px));
  display:flex; flex-direction:column; gap:10px;
  pointer-events:none;
}
.toast {
  pointer-events:auto;
  display:flex; gap:11px; align-items:flex-start;
  padding:13px 15px; border-radius:14px;
  background:var(--ink-800); color:var(--text);
  border:1px solid var(--edge);
  box-shadow:var(--shadow-panel);
  backdrop-filter:blur(20px) saturate(160%);
  -webkit-backdrop-filter:blur(20px) saturate(160%);
  font-size:13.5px;
  animation:toast-in var(--d3) var(--ease) both;
}
.toast .ico { margin-top:1px; }
.toast[data-tone="error"] .ico { color:var(--danger); }
.toast[data-tone="ok"] .ico { color:var(--ok); }
.toast[data-tone="info"] .ico { color:var(--teal); }
.toast.is-out { animation:toast-out var(--d2) var(--ease) both; }
@keyframes toast-in { from { opacity:0; transform:translateY(12px) scale(.97); } }
@keyframes toast-out { to { opacity:0; transform:translateY(6px) scale(.98); } }

/* --- colophon ----------------------------------------------------------- */

.colophon {
  margin-top:auto; padding-top:12px;
  display:flex; gap:12px; flex-wrap:wrap; justify-content:space-between;
  font-size:12px; color:var(--text-dim);
}
`;
