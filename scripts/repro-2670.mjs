#!/usr/bin/env node
/**
 * Issue #2670 — startup and first-use latency contract harness.
 *
 * Fresh-process measurement matrix over the built plugin (dist/index.js),
 * driving the real host journey per rep in a child `node` process:
 *   import dist -> server(ctx) -> real experimental.chat.messages.transform
 *   (first turn) -> first registered tool execute (first tool) -> bounded
 *   wait for the plugin's own STARTUP-CONTRACT queue_settled marker ->
 *   natural process exit (leaked-handle check).
 *
 * The plugin emits its own stage rows under OPENCODE_SWARM_DEBUG=1
 * (src/observability/startup-contract.ts):
 *   init / optional_task / queue_settled / first_turn / first_tool.
 * This harness ADDS the externally-measured import/server intervals, the
 * config-churn columns (filesystem before/after), the readiness-warning
 * columns (debug-stream line counts), and the environment block — kept
 * SEPARATE from the latency intervals per the issue's report contract.
 *
 * Modes:
 *   --ci             matrix with hard budgets evaluated min-of-reps per cell
 *                    (a single cold-runner transient cannot block; the full
 *                    distribution with outliers is printed and retained).
 *                    Sentinel: `2670-MATRIX: OK|FAIL`.
 *   --expect-report  one healthy cold-Git rep; validates the report contract
 *                    (distinct stage keys, churn columns, warning columns).
 *                    Sentinel: `2670-REPORT: OK <json>|FAIL`.
 *   --churn-fixture  degraded cells (pre-existing config backup + status
 *                    artifact as directory; .swarm as a regular file) with a
 *                    malformed project config and opt-in automation.
 *                    Sentinel: `2670-CHURN: OK <json>|FAIL`.
 *   (default)        full distribution report across both cells.
 *
 * Env: REPRO_2670_REPS (default 3), REPRO_2670_SKIP_BUILD=1 (skip build when
 * dist exists), REPRO_2670_NODE_MODULES (junction source for node_modules).
 *
 * Hard budgets (ms): server<=4000, import<=8000, first_turn<=8000,
 * first_tool<=8000, queue_settled<=45000. These deliberately sit far above
 * the tight repro-704 T1 400ms server deadline (which stays authoritative
 * for that control; this harness measures the full first-use journey).
 *
 * Subprocess discipline: array-form spawns only, explicit cwd, timeouts,
 * stdin ignored, bounded output capture, temp dirs under os.tmpdir().
 */
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { release as osRelease, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist', 'index.js');
const CAPTURE_CAP = 4 * 1024 * 1024;
const REPS = Math.max(1, Number.parseInt(process.env.REPRO_2670_REPS ?? '3', 10) || 3);
const CHILD_SPAWN_TIMEOUT_MS = 90_000;
const SETTLE_WAIT_MS = 45_000;
const INNER_TIMEOUT_MS = 20_000;
const BUDGETS = {
	importMs: 8000,
	serverMs: 4000,
	firstTurnMs: 8000,
	firstToolMs: 8000,
	settleMs: 45000,
};
const WARNING_LINE_RE = /Config load exceeded|running with default configuration|advisory/i;

const mode = process.argv.includes('--ci')
	? 'ci'
	: process.argv.includes('--expect-report')
		? 'report'
		: process.argv.includes('--churn-fixture')
			? 'churn'
			: 'full';
const PREFIX =
	mode === 'report' ? '2670-REPORT' : mode === 'churn' ? '2670-CHURN' : '2670-MATRIX';

function fail(reason, detail) {
	console.log(`${PREFIX}: FAIL ${reason}`);
	if (detail) console.log(String(detail).slice(-4000));
	process.exit(1);
}

function tail(...chunks) {
	const s = chunks.filter(Boolean).join('\n').trim();
	return s.length > 2400 ? s.slice(-2400) : s;
}

// ---------------------------------------------------------------------------
// Build bootstrap (repro-2669 pattern)
// ---------------------------------------------------------------------------

const SAVED_ENV = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

function ensureNodeModules() {
	const target = join(ROOT, 'node_modules');
	if (existsSync(target)) return;
	if (process.env.REPRO_2670_NODE_MODULES) {
		try {
			symlinkSync(process.env.REPRO_2670_NODE_MODULES, target, 'junction');
		} catch {
			/* junctions need no admin rights; best effort */
		}
		if (existsSync(target)) {
			console.log('[repro-2670] node_modules junctioned from REPRO_2670_NODE_MODULES');
			return;
		}
	}
	// bun's install cache lives under the real user profile; the isolated
	// homes below are for plugin-init hermeticity, not dependency install.
	const installEnv = { ...process.env };
	if (SAVED_ENV.HOME !== undefined) installEnv.HOME = SAVED_ENV.HOME;
	if (SAVED_ENV.USERPROFILE !== undefined) installEnv.USERPROFILE = SAVED_ENV.USERPROFILE;
	const res = spawnSync('bun', ['install', '--frozen-lockfile'], {
		cwd: ROOT,
		timeout: 240_000,
		encoding: 'utf8',
		maxBuffer: CAPTURE_CAP,
		env: installEnv,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	console.log(`[repro-2670] bootstrapped node_modules via bun install (status=${res.status})`);
	if (!existsSync(target)) {
		fail(
			`build failed: node_modules unavailable (REPRO_2670_NODE_MODULES not set or junction failed; bun install status=${res.status})`,
			tail(res.error ? String(res.error) : null, res.stdout, res.stderr),
		);
	}
}

function buildDist() {
	if (process.env.REPRO_2670_SKIP_BUILD === '1' && existsSync(DIST)) {
		console.log('[repro-2670] build skipped (REPRO_2670_SKIP_BUILD=1, dist present)');
		return;
	}
	ensureNodeModules();
	console.log('[repro-2670] building dist via "bun run build" (timeout 300s)...');
	const res = spawnSync('bun', ['run', 'build'], {
		cwd: ROOT,
		timeout: 300_000,
		encoding: 'utf8',
		maxBuffer: CAPTURE_CAP,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (res.error || res.status !== 0) {
		fail(
			`build failed (status=${res.status}${res.error ? ` err=${res.error.code}` : ''})`,
			tail(res.stdout, res.stderr),
		);
	}
	if (!existsSync(DIST)) fail('build reported success but dist/index.js is missing');
	console.log('[repro-2670] build complete');
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

function makeBaseWorkspace(home) {
	const ws = mkdtempSync(join(tmpdir(), 'repro-2670-ws-'));
	mkdirSync(join(ws, 'src'), { recursive: true });
	writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
	writeFileSync(join(ws, 'src', 'b.ts'), 'export const b = 2;\n');
	mkdirSync(join(home, '.config'), { recursive: true });
	return ws;
}

function initGitWorkspace(ws, home) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, '.config'),
	};
	const run = (args, what) => {
		const res = spawnSync('git', ['-C', ws, ...args], {
			cwd: ws,
			timeout: 60_000,
			encoding: 'utf8',
			maxBuffer: CAPTURE_CAP,
			stdio: ['ignore', 'pipe', 'pipe'],
			env,
		});
		if (res.error || res.status !== 0) {
			fail(
				`git ${what} failed (status=${res.status}${res.error ? ` err=${res.error.code}` : ''})`,
				tail(res.stdout, res.stderr),
			);
		}
	};
	run(['init'], 'init');
	run(['add', '.'], 'add');
	run(
		['-c', 'user.email=repro@local', '-c', 'user.name=repro', 'commit', '-m', 'init'],
		'commit',
	);
	return ws;
}

const OPTIN_AUTOMATION_CONFIG = {
	automation: {
		mode: 'hybrid',
		capabilities: {
			plan_sync: false,
			phase_preflight: false,
			config_doctor_on_startup: false,
			config_doctor_autofix: false,
			evidence_auto_summaries: false,
			decision_drift_detection: false,
		},
	},
};

// ---------------------------------------------------------------------------
// Child journey (mirrors the frozen acceptance checks' child; see
// .agents trace repro/check-2670-matrix.mjs — same flow, kept in sync)
// ---------------------------------------------------------------------------

function childScript(distUrl, settleWaitMs) {
	return `
const DIST_URL = ${JSON.stringify(distUrl)};
const SETTLE_WAIT_MS = ${Math.floor(settleWaitMs)};
const INNER_TIMEOUT_MS = ${Math.floor(INNER_TIMEOUT_MS)};
const PREFIX = 'STARTUP-CONTRACT ';
const rows = [];
let settledSeen = false;
function scan(chunk) {
  const s = typeof chunk === 'string' ? chunk : String(chunk);
  const lines = s.split(String.fromCharCode(10));
  for (const raw of lines) {
    const line = raw.length && raw.charCodeAt(raw.length - 1) === 13 ? raw.slice(0, -1) : raw;
    if (line.indexOf(PREFIX) === 0) {
      rows.push(line.slice(PREFIX.length));
      if (line.indexOf('"stage":"queue_settled"') !== -1) settledSeen = true;
    }
  }
}
const origOut = process.stdout.write.bind(process.stdout);
process.stdout.write = function (c, e, cb) { try { scan(c); } catch (err) {} return origOut(c, e, cb); };
const origErr = process.stderr.write.bind(process.stderr);
process.stderr.write = function (c, e, cb) { try { scan(c); } catch (err) {} return origErr(c, e, cb); };
function synthesizeArgs(def) {
  const args = {};
  try {
    const shape = def && def.args && typeof def.args === 'object' ? def.args : null;
    if (!shape) return args;
    for (const key of Object.keys(shape)) {
      const schema = shape[key];
      const outerType = schema && schema._def && schema._def.typeName ? schema._def.typeName : '';
      const inner = outerType === 'ZodOptional' && schema._def.innerType ? schema._def.innerType : schema;
      const it = inner && inner._def ? inner._def.typeName : '';
      let v;
      if (it === 'ZodString') v = 'repro-2670';
      else if (it === 'ZodNumber') v = 1;
      else if (it === 'ZodBoolean') v = false;
      else if (it === 'ZodEnum' && inner._def.values && inner._def.values.length) v = inner._def.values[0];
      else if (it === 'ZodArray') v = [];
      else if (it === 'ZodObject') v = {};
      else if (it === 'ZodDefault' && typeof inner._def.defaultValue === 'function') v = inner._def.defaultValue();
      else continue;
      args[key] = v;
    }
  } catch (err) { }
  return args;
}
function sampleMessage() {
  return { info: { id: 'repro-2670-m1' }, role: 'user', parts: [{ type: 'text', text: 'repro-2670 first turn probe' }] };
}
try {
  const perfMod = await import('node:perf_hooks');
  const performance = perfMod.performance;
  const tImport0 = performance.now();
  const mod = await import(DIST_URL);
  const importMs = performance.now() - tImport0;
  console.log('CHILD-IMPORT-MS ' + importMs.toFixed(1));
  const plugin = mod.default;
  if (!plugin || typeof plugin.id !== 'string' || typeof plugin.server !== 'function') {
    throw new Error('dist does not export a v1 plugin shape { id, server }');
  }
  const ws = process.cwd();
  const ctx = {
    directory: ws,
    project: { id: 'repro-2670', root: ws },
    worktree: { directory: ws },
    client: { app: {}, config: { get: async function () { return {}; } } },
    experimental_workspace: { register: function () {} },
    get serverUrl() { return new URL('http://localhost:4096'); },
    $: undefined,
  };
  const tServer0 = performance.now();
  const hooks = await plugin.server(ctx, {});
  const serverMs = performance.now() - tServer0;
  console.log('CHILD-SERVER-MS ' + serverMs.toFixed(1));
  const toolMap = hooks && hooks.tool && typeof hooks.tool === 'object' ? hooks.tool : {};
  const agentMap = hooks && hooks.agent && typeof hooks.agent === 'object' ? hooks.agent : {};
  console.log('MANIFEST tools=' + Object.keys(toolMap).length + ' agents=' + Object.keys(agentMap).length);
  const sessionID = 'repro-2670-session';
  const transform = hooks['experimental.chat.messages.transform'];
  if (typeof transform === 'function') {
    const tTurn0 = performance.now();
    const turnPromise = Promise.resolve().then(function () {
      return transform({ sessionID: sessionID, agent: 'swarm_architect', messages: [sampleMessage()] }, { messages: [sampleMessage()] });
    }).catch(function (e) {
      console.error('CHILD-FIRST-TURN-ERR ' + String(e && e.message ? e.message : e).slice(0, 200));
    });
    const turnGuard = new Promise(function (resolve) {
      const t = setTimeout(resolve, INNER_TIMEOUT_MS);
      if (t.unref) t.unref();
    });
    await Promise.race([turnPromise, turnGuard]);
    console.log('CHILD-FIRST-TURN-MS ' + (performance.now() - tTurn0).toFixed(1));
  } else {
    console.log('CHILD-FIRST-TURN-MS missing-transform');
  }
  const toolKeys = Object.keys(toolMap);
  let firstKey = null;
  for (const k of toolKeys) {
    if (toolMap[k] && typeof toolMap[k].execute === 'function') { firstKey = k; break; }
  }
  if (firstKey === null) throw new Error('tool map has no entry with an execute function');
  console.log('CHILD-FIRST-TOOL ' + firstKey);
  const toolCtx = {
    sessionID: sessionID,
    messageID: 'repro-2670-m1',
    agent: 'swarm_architect',
    directory: ws,
    worktree: ws,
    abort: AbortSignal.timeout(20000),
    metadata: function () {},
    ask: async function () {},
  };
  const sampleArgs = synthesizeArgs(toolMap[firstKey]);
  const tTool0 = performance.now();
  const toolPromise = Promise.resolve().then(function () {
    return toolMap[firstKey].execute(sampleArgs, toolCtx);
  }).catch(function (e) {
    console.error('CHILD-FIRST-TOOL-ERR ' + String(e && e.message ? e.message : e).slice(0, 200));
  });
  const toolGuard = new Promise(function (resolve) {
    const t = setTimeout(resolve, INNER_TIMEOUT_MS);
    if (t.unref) t.unref();
  });
  await Promise.race([toolPromise, toolGuard]);
  console.log('CHILD-FIRST-TOOL-MS ' + (performance.now() - tTool0).toFixed(1));
  const tSettle0 = performance.now();
  while (!settledSeen && performance.now() - tSettle0 < SETTLE_WAIT_MS) {
    await new Promise(function (resolve) { setTimeout(resolve, 250); });
  }
  console.log('CHILD-SETTLED ' + settledSeen);
  console.log('CHILD-ROWS ' + rows.length);
  for (const r of rows) console.log('CHILD-ROW ' + r);
} catch (err) {
  console.error('CHILD-FATAL ' + String(err && err.message ? err.message : err).slice(0, 400));
  process.exitCode = 1;
}
`;
}

function parseChildOutput(output) {
	const rep = {
		importMs: null,
		serverMs: null,
		firstTurnMs: null,
		firstToolMs: null,
		firstToolName: null,
		tools: 0,
		agents: 0,
		settled: false,
		contractRows: [],
		warningLines: [],
		childFatal: null,
	};
	for (const raw of output.split(/\r?\n/)) {
		if (raw.startsWith('CHILD-IMPORT-MS ')) rep.importMs = Number.parseFloat(raw.slice(16));
		else if (raw.startsWith('CHILD-SERVER-MS ')) rep.serverMs = Number.parseFloat(raw.slice(16));
		else if (raw.startsWith('CHILD-FIRST-TURN-MS ')) {
			const v = raw.slice(20);
			rep.firstTurnMs = v === 'missing-transform' ? null : Number.parseFloat(v);
		} else if (raw.startsWith('CHILD-FIRST-TOOL-MS ')) rep.firstToolMs = Number.parseFloat(raw.slice(20));
		else if (raw.startsWith('CHILD-FIRST-TOOL ')) rep.firstToolName = raw.slice(17);
		else if (raw.startsWith('CHILD-SETTLED ')) rep.settled = raw.slice(14) === 'true';
		else if (raw.startsWith('CHILD-ROW ')) rep.contractRows.push(raw.slice(10));
		else if (raw.startsWith('CHILD-FATAL ')) rep.childFatal = raw.slice(12);
		else if (/^MANIFEST tools=\d+ agents=\d+$/.test(raw)) {
			const m = /tools=(\d+) agents=(\d+)/.exec(raw);
			rep.tools = Number.parseInt(m[1], 10);
			rep.agents = Number.parseInt(m[2], 10);
		}
	}
	for (const line of output.split(/\r?\n/)) {
		if (WARNING_LINE_RE.test(line)) {
			rep.warningLines.push(line.slice(0, 160));
			if (rep.warningLines.length >= 3) break;
		}
	}
	return rep;
}

function contractRowsByStage(rep) {
	const byStage = {};
	for (const text of rep.contractRows) {
		try {
			const obj = JSON.parse(text);
			if (obj && typeof obj.stage === 'string') {
				(byStage[obj.stage] ??= []).push(obj);
			}
		} catch {
			/* skip malformed */
		}
	}
	return byStage;
}

function runRep(cellName, ws, home, { debug = true } = {}) {
	const env = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: join(home, '.config'),
	};
	if (debug) env.OPENCODE_SWARM_DEBUG = '1';
	else delete env.OPENCODE_SWARM_DEBUG;
	const res = spawnSync(
		process.execPath,
		['--input-type=module', '-e', childScript(pathToFileURL(DIST).href, SETTLE_WAIT_MS)],
		{
			cwd: ws,
			timeout: CHILD_SPAWN_TIMEOUT_MS,
			encoding: 'utf8',
			maxBuffer: CAPTURE_CAP,
			stdio: ['ignore', 'pipe', 'pipe'],
			env,
		},
	);
	if (res.error) {
		return { spawnError: String(res.error), output: '', rep: null, status: null };
	}
	const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
	return { spawnError: null, output, rep: parseChildOutput(output), status: res.status };
}

// ---------------------------------------------------------------------------
// Churn columns (harness-side, distinct from latency intervals)
// ---------------------------------------------------------------------------

function snapshotChurn(ws) {
	const backups = [];
	const swarmDir = join(ws, '.swarm');
	try {
		for (const entry of readdirSync(swarmDir)) {
			if (/^config-backup-.*\.json$/.test(entry)) backups.push(entry);
		}
	} catch {
		/* no .swarm or not a directory */
	}
	let projectConfig = null;
	try {
		const p = join(ws, '.opencode', 'opencode-swarm.json');
		if (existsSync(p)) {
			const st = statSize(p);
			projectConfig = { exists: true, size: st };
		} else {
			projectConfig = { exists: false, size: 0 };
		}
	} catch {
		projectConfig = { exists: false, size: 0 };
	}
	return { backups: backups.sort(), projectConfig };
}

function statSize(p) {
	return statSync(p).size;
}

// ---------------------------------------------------------------------------
// Environment block (report metadata — separate from intervals)
// ---------------------------------------------------------------------------

function environmentBlock() {
	let release = null;
	try {
		release = osRelease();
	} catch {
		release = null;
	}
	return {
		platform: process.platform,
		arch: process.arch,
		node: process.version,
		osRelease: release,
		argv: process.argv.slice(2),
		fsType: null,
		fsTypeNote:
			'filesystem type not portably detectable from Node on this platform; reported as unknown',
	};
}

// ---------------------------------------------------------------------------
// Rep validation shared by all modes
// ---------------------------------------------------------------------------

function validateRep(cellName, repNo, result) {
	if (result.spawnError) return `rep spawn failed: ${result.spawnError}`;
	if (result.status !== 0) {
		return `child exit=${result.status}${result.rep?.childFatal ? ` (${result.rep.childFatal})` : ''}`;
	}
	const rep = result.rep;
	if (!rep) return 'no parsed child output';
	if (rep.tools < 50) return `manifest tools=${rep.tools} < 50`;
	if (rep.agents < 1) return `manifest agents=${rep.agents} < 1`;
	const byStage = contractRowsByStage(rep);
	const init = byStage.init ?? [];
	if (init.length !== 1) return `expected 1 init row, got ${init.length}`;
	if (typeof init[0].serverMs !== 'number') return 'init row missing numeric serverMs';
	const settle = byStage.queue_settled ?? [];
	if (settle.length !== 1) return `expected 1 queue_settled row, got ${settle.length}`;
	const tasks = byStage.optional_task ?? [];
	if (tasks.length < 1) return 'no optional_task outcome rows';
	for (const t of tasks) {
		if (t.outcome !== 'completed' && t.outcome !== 'failed') {
			return `optional_task row has invalid outcome: ${JSON.stringify(t)}`;
		}
		if (t.outcome === 'failed' && typeof t.error === 'string' && t.error.length > 200) {
			return `failed optional_task error exceeds 200 chars (${t.error.length})`;
		}
	}
	if ((byStage.first_turn ?? []).length !== 1) return 'expected exactly 1 first_turn row';
	const ft = byStage.first_tool ?? [];
	if (ft.length !== 1) return 'expected exactly 1 first_tool row';
	if (typeof ft[0].tool !== 'string' || !ft[0].tool) return 'first_tool row missing tool name';
	return null;
}

function repIntervals(rep) {
	const byStage = contractRowsByStage(rep);
	return {
		importMs: rep.importMs,
		serverMs: rep.serverMs ?? byStage.init?.[0]?.serverMs ?? null,
		firstTurnMs: byStage.first_turn?.[0]?.ms ?? rep.firstTurnMs,
		firstToolMs: byStage.first_tool?.[0]?.ms ?? rep.firstToolMs,
		settleMs: byStage.queue_settled?.[0]?.ms ?? null,
	};
}

function distribution(values) {
	const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
	if (nums.length === 0) return null;
	const median = nums[Math.floor(nums.length / 2)];
	return {
		min: nums[0],
		median,
		max: nums[nums.length - 1],
		n: nums.length,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
	buildDist();
	if (mode === 'churn') return churnMode();
	if (mode === 'report') return reportMode();
	return matrixMode();
}

function makeHome() {
	const home = mkdtempSync(join(tmpdir(), 'repro-2670-home-'));
	mkdirSync(join(home, '.config'), { recursive: true });
	return home;
}

function makeCell(kind) {
	const home = makeHome();
	let ws;
	if (kind === 'cold-git') {
		ws = initGitWorkspace(makeBaseWorkspace(home), home);
	} else {
		ws = makeBaseWorkspace(home);
	}
	return { home, ws };
}

function cleanupCell(cell) {
	try {
		rmSync(cell.ws, { recursive: true, force: true });
		rmSync(cell.home, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
}

function matrixMode() {
	const cells = ['cold-non-git', 'cold-git'];
	const perCell = {};
	let matrixFail = null;
	for (const cellName of cells) {
		const reps = [];
		for (let i = 1; i <= REPS; i++) {
			const cell = makeCell(cellName);
			try {
				const result = runRep(cellName, cell.ws, cell.home);
				const problem = validateRep(cellName, i, result);
				const intervals = result.rep ? repIntervals(result.rep) : {};
				console.log(
					`2670-CELL ${cellName} rep${i}` +
						` import_ms=${fmt(intervals.importMs)}` +
						` server_ms=${fmt(intervals.serverMs)}` +
						` first_turn_ms=${fmt(intervals.firstTurnMs)}` +
						` first_tool_ms=${fmt(intervals.firstToolMs)}` +
						` settle_ms=${fmt(intervals.settleMs)}` +
						` tasks=${result.rep ? (contractRowsByStage(result.rep).optional_task ?? []).length : 0}` +
						` tools=${result.rep?.tools ?? 0}`,
				);
				if (problem && !matrixFail) {
					matrixFail = `${cellName} rep${i}: ${problem}`;
				}
				reps.push({ result, intervals });
			} finally {
				cleanupCell(cell);
			}
		}
		perCell[cellName] = reps;
	}
	// Debug-off probe: with the env var unset, ZERO contract rows may appear.
	{
		const cell = makeCell('cold-git');
		try {
			const probe = runRep('debug-off', cell.ws, cell.home, { debug: false });
			const rows = probe.rep ? probe.rep.contractRows.length : -1;
			console.log(`2670-DEBUG-OFF contract_rows=${rows}`);
			if (rows !== 0 && !matrixFail) {
				matrixFail = `debug-off probe emitted ${rows} contract rows (must be zero)`;
			}
		} finally {
			cleanupCell(cell);
		}
	}
	// Budgets are evaluated min-of-reps per cell: a single cold-runner
	// transient cannot fail the matrix, while the distribution (with
	// outliers) is printed above and retained in the report.
	const report = { mode: 'matrix', reps: REPS, environment: environmentBlock(), cells: {} };
	for (const [cellName, reps] of Object.entries(perCell)) {
		const dist = {};
		for (const key of ['importMs', 'serverMs', 'firstTurnMs', 'firstToolMs', 'settleMs']) {
			dist[key] = distribution(reps.map((r) => r.intervals[key]));
		}
		report.cells[cellName] = dist;
		for (const [key, d] of Object.entries(dist)) {
			if (d && d.min > BUDGETS[key] && !matrixFail) {
				matrixFail = `${cellName}: min-of-reps ${key} ${d.min}ms exceeds budget ${BUDGETS[key]}ms`;
			}
		}
	}
	console.log(`2670-DISTRIBUTION ${JSON.stringify(report)}`);
	if (matrixFail) fail(matrixFail);
	console.log(`2670-MATRIX: OK (${REPS} reps x ${cells.length} cells, min-of-reps budget policy)`);
}

function reportMode() {
	const cell = makeCell('cold-git');
	try {
		const churnBefore = snapshotChurn(cell.ws);
		const result = runRep('report', cell.ws, cell.home);
		const problem = validateRep('report', 1, result);
		if (problem) fail(problem);
		const rep = result.rep;
		const byStage = contractRowsByStage(rep);
		const churnAfter = snapshotChurn(cell.ws);
		// Stage separation contract: distinct rows/keys per stage, churn and
		// warnings carried as separate harness-side columns.
		const stages = {
			init: { importMs: byStage.init?.[0]?.importMs, serverMs: byStage.init?.[0]?.serverMs },
			first_turn: { ms: byStage.first_turn?.[0]?.ms },
			first_tool: { tool: byStage.first_tool?.[0]?.tool, ms: byStage.first_tool?.[0]?.ms },
			queue_settled: byStage.queue_settled?.[0] ?? null,
			optional_tasks: (byStage.optional_task ?? []).map((t) => ({
				task: t.task,
				outcome: t.outcome,
				ms: t.ms,
			})),
		};
		const report = {
			stages,
			config_churn: {
				backups_before: churnBefore.backups.length,
				backups_after: churnAfter.backups.length,
				project_config_before: churnBefore.projectConfig,
				project_config_after: churnAfter.projectConfig,
			},
			readiness_warnings: {
				advisories_in_settled_row:
					typeof byStage.queue_settled?.[0]?.advisories === 'number'
						? byStage.queue_settled[0].advisories
						: null,
				warning_lines: rep.warningLines,
				warning_line_count: rep.warningLines.length,
			},
			environment: environmentBlock(),
		};
		// Validate the separation contract itself before printing OK.
		if (typeof stages.init.serverMs !== 'number') fail('init stage missing numeric serverMs');
		if (typeof stages.first_turn.ms !== 'number') fail('first_turn stage missing numeric ms');
		if (typeof stages.first_tool.tool !== 'string' || !stages.first_tool.tool) {
			fail('first_tool stage missing tool name');
		}
		const q = stages.queue_settled;
		if (
			!q ||
			typeof q.tasks !== 'number' ||
			typeof q.completed !== 'number' ||
			typeof q.failed !== 'number' ||
			typeof q.ms !== 'number' ||
			typeof q.advisories !== 'number'
		) {
			fail('queue_settled row missing tasks/completed/failed/ms/advisories');
		}
		if (report.config_churn.backups_after !== 0) {
			fail(`healthy fixture produced ${report.config_churn.backups_after} config backups (churn)`);
		}
		console.log(`2670-REPORT: OK ${JSON.stringify(report)}`);
	} finally {
		cleanupCell(cell);
	}
}

function churnMode() {
	const results = [];
	// Cell A: pre-existing backup + status artifact as directory (#2669 class)
	{
		const cell = makeCell('cold-git');
		try {
			mkdirSync(join(cell.ws, '.swarm'), { recursive: true });
			writeFileSync(
				join(cell.ws, '.swarm', 'config-backup-20260101T000000Z.json'),
				'{"backed_up": true}\n',
			);
			mkdirSync(join(cell.ws, '.swarm', 'automation-status.json'), { recursive: true });
			mkdirSync(join(cell.ws, '.opencode'), { recursive: true });
			writeFileSync(
				join(cell.ws, '.opencode', 'opencode-swarm.json'),
				'{"automation":',
			);
			mkdirSync(join(cell.home, '.config', 'opencode'), { recursive: true });
			writeFileSync(
				join(cell.home, '.config', 'opencode', 'opencode-swarm.json'),
				JSON.stringify(OPTIN_AUTOMATION_CONFIG),
			);
			const before = snapshotChurn(cell.ws);
			const result = runRep('churn-a', cell.ws, cell.home);
			const problem = validateRep('churn-a', 1, result);
			if (problem) fail(`cell A: ${problem}`);
			const after = snapshotChurn(cell.ws);
			if (after.backups.length !== before.backups.length || after.backups.length !== 1) {
				fail(
					`cell A: config-backup churn (before=${before.backups.length} after=${after.backups.length})`,
				);
			}
			results.push({ cell: 'backup+writer-failure', before, after, rep: summarize(result.rep) });
		} finally {
			cleanupCell(cell);
		}
	}
	// Cell B: .swarm occupied by a regular file (#2669 class)
	{
		const cell = makeCell('cold-git');
		try {
			writeFileSync(join(cell.ws, '.swarm'), 'occupied');
			mkdirSync(join(cell.ws, '.opencode'), { recursive: true });
			writeFileSync(
				join(cell.ws, '.opencode', 'opencode-swarm.json'),
				'{"automation":',
			);
			mkdirSync(join(cell.home, '.config', 'opencode'), { recursive: true });
			writeFileSync(
				join(cell.home, '.config', 'opencode', 'opencode-swarm.json'),
				JSON.stringify(OPTIN_AUTOMATION_CONFIG),
			);
			const before = snapshotChurn(cell.ws);
			const result = runRep('churn-b', cell.ws, cell.home);
			const problem = validateRep('churn-b', 1, result);
			if (problem) fail(`cell B: ${problem}`);
			const after = snapshotChurn(cell.ws);
			if (after.backups.length !== before.backups.length) {
				fail(
					`cell B: config-backup churn (before=${before.backups.length} after=${after.backups.length})`,
				);
			}
			results.push({ cell: 'swarm-is-file', before, after, rep: summarize(result.rep) });
		} finally {
			cleanupCell(cell);
		}
	}
	console.log(`2670-CHURN: OK ${JSON.stringify({ cells: results, environment: environmentBlock() })}`);
}

function summarize(rep) {
	const byStage = contractRowsByStage(rep);
	return {
		tools: rep.tools,
		agents: rep.agents,
		settled: rep.settled,
		settleMs: byStage.queue_settled?.[0]?.ms ?? null,
		advisories: byStage.queue_settled?.[0]?.advisories ?? null,
		optional_tasks: (byStage.optional_task ?? []).map((t) => ({
			task: t.task,
			outcome: t.outcome,
			ms: t.ms,
			error: t.error,
		})),
		warning_lines: rep.warningLines,
	};
}

function fmt(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : 'n/a';
}

main();
