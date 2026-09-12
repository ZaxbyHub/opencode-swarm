/**
 * Inline dashboard assets (issue #2509).
 *
 * The HTML/JS below is served verbatim from this TS string module — the
 * inline-asset architecture credited to opencode-ensemble by ADR 0002
 * (REIMPLEMENT decision: ideas adopted, no upstream code/strings/UI assets
 * ported). No frontend build step, no framework dependency, no external
 * requests: the page is a static shell that fetches the read-only JSON API
 * on the same token-scoped origin path it was served from.
 */

const DASHBOARD_PAGE_TITLE = 'opencode-swarm dashboard';

/** Static HTML shell for the mission-control view. */
export function renderDashboardHtml(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${DASHBOARD_PAGE_TITLE}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  margin: 0 auto; max-width: 68rem; padding: 1rem 1.25rem 3rem;
  line-height: 1.45; }
h1 { font-size: 1.25rem; margin: 0.5rem 0 0.25rem; }
h2 { font-size: 1rem; margin: 1.5rem 0 0.5rem; border-bottom: 1px solid
  color-mix(in srgb, currentColor 25%, transparent); padding-bottom: 0.25rem; }
table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
th, td { text-align: left; padding: 0.3rem 0.55rem; vertical-align: top;
  border-bottom: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  overflow-wrap: anywhere; }
td.num { text-align: right; }
.muted { opacity: 0.7; }
.pill { display: inline-block; padding: 0 0.45em; border-radius: 0.6em;
  border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
  font-size: 0.75rem; }
footer { margin-top: 2.5rem; opacity: 0.65; font-size: 0.8rem; }
</style>
</head>
<body>
<h1>opencode-swarm · mission control</h1>
<p class="muted" id="dbline" role="status" aria-live="polite">loading…</p>

<h2>Gates &amp; circuits</h2>
<div id="gates" role="status" aria-live="polite">loading…</div>

<h2>Pending delegations (age bands)</h2>
<div id="delegations" role="status" aria-live="polite">loading…</div>

<h2>Lane liveness</h2>
<div id="lanes" role="status" aria-live="polite">loading…</div>

<h2>Task board</h2>
<div id="tasks" role="status" aria-live="polite">loading…</div>

<h2>Activity timeline</h2>
<div id="timeline" role="status" aria-live="polite">loading…</div>

<footer>Read-only view. Abort/recover actions live in the swarm commands and
tools (<code>/swarm status</code>, <code>/swarm report</code>,
<code>/swarm recover</code>) — this page performs no mutations.</footer>

<script>
(function () {
  'use strict';
  // API base: same token-scoped path/query this shell was served under.
  var base = location.pathname.replace(/\\/+$/, '');
  var api = function (name) { return base + '/api/' + name + location.search; };
  var esc = function (v) {
    return String(v ?? '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var cell = function (v, cls) {
    return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(v) + '</td>';
  };
  var table = function (head, rows) {
    return '<table><thead><tr>' + head.map(function (h) {
      return '<th>' + esc(h) + '</th>';
    }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  };
  // Bounded client-side timeout (review round 2, C5): if the host wedges
  // after serving this shell, fail visibly instead of hanging on "loading…".
  var fetchWithTimeout = function (url, ms) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return fetch(url, { signal: controller.signal }).finally(function () {
      clearTimeout(timer);
    });
  };
  fetchWithTimeout(api('overview'), 15000).then(function (r) { return r.json(); }).then(function (d) {
    var db = document.getElementById('dbline');
    if (db) { db.textContent = 'swarm.db: ' + esc(String(JSON.stringify(d.dbHealth))); }
    var gates = d.gates || {};
    var gateRows = Object.keys(gates.enabledCounts || {}).sort().map(function (k) {
      return '<tr>' + cell(k) + cell(gates.enabledCounts[k], 'num') +
        cell((gates.circuits || [])[0] ? 'see circuits' : '') + '</tr>';
    });
    (gates.circuits || []).forEach(function (c) {
      gateRows.push('<tr>' + cell('circuit ' + c.label) + cell(c.state) +
        cell('gen ' + c.generation) + cell(c.since) + '</tr>');
    });
    var g = document.getElementById('gates');
    if (g) { g.innerHTML = gateRows.length
      ? table(['gate / circuit', 'state / plans', 'gen', 'since'], gateRows)
      : '<p class="muted">no QA gate profiles or circuit state on disk yet</p>'; }
    var del = d.delegations || {};
    var delRows = (del.bands || []).map(function (b) {
      return '<tr>' + cell(b.band) + cell(b.count, 'num') + cell(b.oldestAgeMs, 'num') + '</tr>';
    });
    (del.recent || []).forEach(function (r2) {
      delRows.push('<tr>' + cell(r2.correlationId) + cell(r2.agent) +
        cell(r2.status) + cell(r2.ageMinutes + 'm') + '</tr>');
    });
    var de = document.getElementById('delegations');
    if (de) { de.innerHTML = delRows.length
      ? table(['correlation / band', 'agent', 'status', 'age'], delRows)
      : '<p class="muted">no delegations recorded</p>'; }
    var lanes = d.lanes || {};
    var laneRows = (lanes.lanes || []).map(function (l) {
      return '<tr>' + cell(l.laneId || l.correlationId) + cell(l.batchId || '') +
        cell(l.status) + cell(l.pendingMinutes + 'm') +
        cell(l.staleSuspect ? 'stale?' : 'live') + '</tr>';
    });
    var la = document.getElementById('lanes');
    if (la) { la.innerHTML = laneRows.length
      ? table(['lane', 'batch', 'status', 'pending', 'liveness'], laneRows)
      : '<p class="muted">no lanes in flight</p>'; }
    var tasks = d.tasks || {};
    var taskRows = (tasks.tasks || []).map(function (t) {
      return '<tr>' + cell(t.id) + cell(t.phase, 'num') + cell(t.status) +
        cell(t.description) + '</tr>';
    });
    var ta = document.getElementById('tasks');
    if (ta) { ta.innerHTML = taskRows.length
      ? table(['task', 'phase', 'status', 'description'], taskRows)
      : '<p class="muted">no plan tasks (no approved plan on disk)</p>'; }
    var tl = d.timeline || {};
    var tlRows = (tl.events || []).map(function (e) {
      return '<tr>' + cell(e.occurredAt) + cell(e.kind) + cell(e.severity) +
        cell(e.taskId || '') + cell(e.payload) + '</tr>';
    });
    var ti = document.getElementById('timeline');
    if (ti) {
      var tlNote = (tl.totalMatching > (tl.events || []).length)
        ? '<p class="muted">showing the newest ' + tlRows.length + ' of ' +
          esc(tl.totalMatching) + ' events</p>'
        : '';
      ti.innerHTML = tlNote + (tlRows.length
        ? table(['occurred', 'kind', 'severity', 'task', 'payload'], tlRows)
        : '<p class="muted">no observability events recorded</p>');
    }
  }).catch(function (err) {
    // Per-panel error states (review round 2, C12): never leave a panel
    // stuck on "loading…" — every region announces the failure.
    var PANEL_IDS = ['dbline', 'gates', 'delegations', 'lanes', 'tasks', 'timeline'];
    for (var i = 0; i < PANEL_IDS.length; i++) {
      var el = document.getElementById(PANEL_IDS[i]);
      if (el) { el.textContent = 'unavailable: ' + err; }
    }
  });
})();
</script>
</body>
</html>
`;
}
