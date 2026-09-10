#!/usr/bin/env node
/**
 * Issue #2669 reproduction harness (non-fatal automation-status startup).
 * Drives the REAL built plugin entry (dist/index.js) and asserts REQUIRED
 * post-fix BEHAVIOR only:
 *   optin       — opt-in status path (hybrid mode, all other capabilities off):
 *                 server() must resolve with the mandatory manifest shape under
 *                 a healthy workspace AND corrupt .swarm fixtures (.swarm as a
 *                 regular file, automation-status.json as a directory, POSIX
 *                 read-only .swarm). Also verifies the bundle loads under Bun.
 *   default     — same fixtures with no automation config (plus an explicit
 *                 manual-mode scenario): default path independent of the writer.
 *   artifact    — healthy opt-in workspace: .swarm/automation-status.json must
 *                 exist after init settles (valid JSON with a "mode" field) and
 *                 the process must exit on its own (leaked-handle check).
 *   diagnostics — with OPENCODE_SWARM_DEBUG=1 and a corrupt fixture, a child
 *                 run must exit 0, print no FATAL banner, and emit at least one
 *                 non-fatal diagnostic line referencing the status artifact.
 * Usage: node check-2669-matrix.mjs <optin|default|artifact|diagnostics>
 * Targets the tree at process.cwd() (base worktree or live root — the script
 * itself may live elsewhere). Builds dist via `bun run build` first (skip with
 * REPRO_2669_SKIP_BUILD=1 when dist/index.js exists); bootstraps node_modules
 * when absent (junction from REPRO_2669_NODE_MODULES, else bun install).
 * Success: `2669-*: OK` + exit 0. Failure: exactly one `2669-*: FAIL <reason>`
 * summary line (detail after) + exit 1.
 */
import { spawnSync } from 'node:child_process';
import {
	chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist', 'index.js');
const IS_WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPTIN_CONFIG = {
	automation: {
		mode: 'hybrid',
		capabilities: {
			plan_sync: false, phase_preflight: false, config_doctor_on_startup: false,
			config_doctor_autofix: false, evidence_auto_summaries: false, decision_drift_detection: false,
		},
	},
};

// Hermetic env (repro-704 precedent): keep the invoking user's global OpenCode
// config out. Applied to every mode, including the diagnostics child.
const SAVED_ENV = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};
const isolatedHome = mkdtempSync(join(tmpdir(), 'check-2669-home-'));
mkdirSync(join(isolatedHome, '.config'), { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = join(isolatedHome, '.config');
process.once('exit', () => {
	for (const k of Object.keys(SAVED_ENV)) {
		if (SAVED_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = SAVED_ENV[k];
	}
	rmSync(isolatedHome, { recursive: true, force: true });
});

const mode = process.argv[2] ?? 'optin';
const PREFIX =
	mode === 'artifact' ? '2669-ARTIFACT'
		: mode === 'diagnostics' || mode === 'diagnostics-child' ? '2669-DIAG'
			: '2669-MATRIX';

function fail(reason, detail) {
	console.log(`${PREFIX}: FAIL ${reason}`);
	if (detail) console.log(detail);
	process.exit(1);
}

function tail(...chunks) {
	const s = chunks.filter(Boolean).join('\n').trim();
	return s.length > 2400 ? s.slice(-2400) : s;
}

function stackTail(err) {
	return err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n') : String(err);
}

function ensureNodeModules() {
	const target = join(ROOT, 'node_modules');
	if (existsSync(target)) return;
	if (process.env.REPRO_2669_NODE_MODULES) {
		try {
			symlinkSync(process.env.REPRO_2669_NODE_MODULES, target, 'junction');
		} catch {
			/* best effort — junctions need no admin rights; fall through */
		}
		if (existsSync(target)) {
			console.log('[check-2669] node_modules junctioned from REPRO_2669_NODE_MODULES');
			return;
		}
	}
	// bun's install cache lives under the real user profile; the isolated home
	// above is for plugin-init hermeticity, not for dependency installation.
	const installEnv = { ...process.env };
	if (SAVED_ENV.HOME !== undefined) installEnv.HOME = SAVED_ENV.HOME;
	if (SAVED_ENV.USERPROFILE !== undefined) installEnv.USERPROFILE = SAVED_ENV.USERPROFILE;
	const res = spawnSync('bun', ['install', '--frozen-lockfile'], {
		cwd: ROOT, timeout: 240_000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: installEnv,
	});
	console.log(`[check-2669] bootstrapped node_modules via bun install (status=${res.status})`);
	if (!existsSync(target)) {
		fail(
			`build failed: node_modules unavailable (none at ${ROOT}; REPRO_2669_NODE_MODULES not set or junction failed; bun install status=${res.status})`,
			tail(res.error ? String(res.error) : null, res.stdout, res.stderr),
		);
	}
}

function buildDist() {
	if (process.env.REPRO_2669_SKIP_BUILD === '1' && existsSync(DIST)) {
		console.log('[check-2669] build skipped (REPRO_2669_SKIP_BUILD=1, dist present)');
		return;
	}
	ensureNodeModules();
	console.log('[check-2669] building dist via "bun run build" (timeout 300s)...');
	const res = spawnSync('bun', ['run', 'build'], {
		cwd: ROOT, timeout: 300_000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
	});
	if (res.error || res.status !== 0) {
		fail(`build failed (status=${res.status}${res.error ? ` err=${res.error.code}` : ''})`, tail(res.stdout, res.stderr));
	}
	if (!existsSync(DIST)) fail('build reported success but dist/index.js is missing');
	console.log('[check-2669] build complete');
}

async function loadPlugin() {
	let mod;
	try {
		mod = await import(pathToFileURL(DIST).href);
	} catch (err) {
		fail(`failed to import ${relative(ROOT, DIST)}: ${err?.message ?? String(err)}`, stackTail(err));
	}
	const plugin = mod.default;
	if (!plugin || typeof plugin !== 'object' || typeof plugin.id !== 'string' || typeof plugin.server !== 'function') {
		fail('dist does not export a v1 plugin shape { id, server }');
	}
	return plugin;
}

function makeWorkspace(fixture, config) {
	const dir = mkdtempSync(join(tmpdir(), 'check-2669-ws-'));
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(join(dir, '.opencode', 'opencode-swarm.json'), JSON.stringify(config));
	if (fixture === 'swarm-is-file') writeFileSync(join(dir, '.swarm'), 'not a directory');
	else if (fixture === 'status-is-dir') mkdirSync(join(dir, '.swarm', 'automation-status.json'), { recursive: true });
	else if (fixture === 'readonly-swarm') {
		mkdirSync(join(dir, '.swarm'));
		chmodSync(join(dir, '.swarm'), 0o500);
	}
	return dir;
}

function cleanupWorkspace(dir) {
	try {
		chmodSync(join(dir, '.swarm'), 0o700); // best effort (readonly fixture)
	} catch {
		/* .swarm may not exist */
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* best effort — tmp dir */
	}
}

function makeCtx(directory) {
	return {
		directory,
		project: { id: 'check-2669', root: directory },
		worktree: { directory },
		client: { app: {}, config: { get: async () => ({}) } },
		experimental_workspace: { register() {} },
		get serverUrl() {
			return new URL('http://localhost:4096');
		},
		$: undefined,
	};
}

function manifestShape(hooks) {
	if (!hooks || typeof hooks !== 'object') throw new Error('server() resolved without a manifest object');
	const tools = hooks.tool && typeof hooks.tool === 'object' ? Object.keys(hooks.tool).length : 0;
	const agents = hooks.agent && typeof hooks.agent === 'object' ? Object.keys(hooks.agent).length : 0;
	if (tools < 50) throw new Error(`manifest tool map too small: ${tools} keys (<50)`);
	if (agents < 1) throw new Error('manifest agent map empty (0 keys)');
	return { tools, agents };
}

async function runScenario(plugin, label, fixture, config) {
	const dir = makeWorkspace(fixture, config);
	let outcome;
	const t0 = performance.now();
	try {
		const hooks = await plugin.server(makeCtx(dir), {});
		outcome = { ok: true, ms: performance.now() - t0, shape: manifestShape(hooks) };
	} catch (err) {
		outcome = { ok: false, ms: performance.now() - t0, err };
	} finally {
		cleanupWorkspace(dir);
	}
	if (!outcome.ok) {
		const err = outcome.err;
		fail(
			`scenario "${label}" (fixture=${fixture}): server() rejected after ${outcome.ms.toFixed(1)}ms: ` +
				`${err?.code ? `${err.code}: ` : ''}${err?.message ?? String(err)}`,
			stackTail(err),
		);
	}
	console.log(
		`[check-2669] ${label} (fixture=${fixture}): resolved in ${outcome.ms.toFixed(1)}ms ` +
			`tools=${outcome.shape.tools} agents=${outcome.shape.agents}`,
	);
}

function checkBunLoad() {
	const script =
		`import(${JSON.stringify(pathToFileURL(DIST).href)}).then((mod) => {` +
		` const p = mod.default;` +
		` if (!p || typeof p.id !== 'string' || typeof p.server !== 'function') {` +
		` console.error('bun-load: bad default export shape'); process.exit(1); }` +
		` console.log('bun-load: OK id=' + p.id); process.exit(0);` +
		`}).catch((err) => { console.error('bun-load: import failed: ' + (err && err.message)); process.exit(1); });`;
	const res = spawnSync('bun', ['-e', script], { cwd: ROOT, timeout: 120_000, encoding: 'utf8' });
	if (res.error && res.error.code === 'ENOENT') {
		console.log('[check-2669] bun-load: SKIP (bun not found on PATH)');
		return;
	}
	if (res.error || res.status !== 0) {
		fail(`bun bundle load failed (status=${res.status}${res.error ? ` err=${res.error.code}` : ''})`, tail(res.stdout, res.stderr));
	}
	console.log(`[check-2669] bun-load: ${(res.stdout ?? '').trim()}`);
}

async function runMatrixScenarios(plugin, config) {
	for (const fixture of ['normal', 'swarm-is-file', 'status-is-dir']) {
		await runScenario(plugin, `${mode}/${fixture}`, fixture, config);
	}
	if (IS_WIN) console.log('[check-2669] optin/readonly-swarm: SKIP (win32 host; POSIX-only fixture)');
	else await runScenario(plugin, `${mode}/readonly-swarm`, 'readonly-swarm', config);
}

async function runOptin(plugin) {
	await runMatrixScenarios(plugin, OPTIN_CONFIG);
	checkBunLoad();
	console.log('2669-MATRIX: OK');
	process.exit(0);
}

async function runDefault(plugin) {
	await runMatrixScenarios(plugin, {});
	await runScenario(plugin, 'default/manual-mode', 'normal', { automation: { mode: 'manual' } });
	console.log('2669-MATRIX: OK');
	process.exit(0);
}

async function runArtifact(plugin) {
	const dir = makeWorkspace('normal', OPTIN_CONFIG);
	try {
		const t0 = performance.now();
		const shape = manifestShape(await plugin.server(makeCtx(dir), {}));
		console.log(`[check-2669] artifact: server() resolved in ${(performance.now() - t0).toFixed(1)}ms tools=${shape.tools} agents=${shape.agents}`);
		const artifactPath = join(dir, '.swarm', 'automation-status.json');
		let exists = existsSync(artifactPath);
		for (let i = 0; !exists && i < 30; i++) {
			await sleep(100);
			exists = existsSync(artifactPath);
		}
		if (!exists) fail('artifact missing: automation-status.json not present within 3000ms after init settled');
		let parsed;
		try {
			parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
		} catch (err) {
			fail(`artifact is not valid JSON: ${err?.message ?? String(err)}`);
		}
		if (!parsed || typeof parsed !== 'object' || !('mode' in parsed)) fail('artifact JSON parsed but has no "mode" field');
		console.log(`[check-2669] artifact: present, valid JSON, mode=${JSON.stringify(parsed.mode)}`);
		console.log('2669-ARTIFACT: OK');
		// Deliberately NO process.exit here: the event loop must drain on its
		// own. A leaked pending init handle hangs this process and the outer
		// harness timeout catches it — that is the leak check.
	} finally {
		cleanupWorkspace(dir);
	}
}

async function runDiagnosticsChild(plugin) {
	const dir = makeWorkspace('swarm-is-file', OPTIN_CONFIG);
	try {
		await plugin.server(makeCtx(dir), {});
		// Bounded yield: the deferred status-artifact write runs as a
		// post-resolution task on an unref'd 0ms timer (#2669 — completion is
		// not needed before manifest return). This ref'd 500ms timer keeps the
		// event loop alive so that unref'd timer fires and the bounded
		// non-fatal diagnostic is emitted before the child exits.
		await new Promise((resolve) => setTimeout(resolve, 500));
		console.log('CHILD-RESOLVED');
		process.exit(0);
	} catch (err) {
		// Immediate failure path (no yield) — this is what keeps the check RED
		// at base, where server() rejects before any yield.
		console.error(`CHILD-REJECTED: ${stackTail(err)}`);
		process.exit(1);
	} finally {
		cleanupWorkspace(dir);
	}
}

async function runDiagnostics() {
	const self = fileURLToPath(import.meta.url);
	const res = spawnSync(process.execPath, [self, 'diagnostics-child'], {
		cwd: process.cwd(), timeout: 120_000, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
		env: { ...process.env, OPENCODE_SWARM_DEBUG: '1' },
	});
	if (res.error) fail(`diagnostics child failed to run: ${res.error.code}`);
	const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
	if (res.status !== 0) fail(`diagnostics child exit code ${res.status} (expected 0)`, tail(output));
	if (!output.includes('CHILD-RESOLVED')) fail('diagnostics child did not print CHILD-RESOLVED', tail(output));
	if (output.includes('FATAL: plugin initialization failed')) {
		fail('diagnostics child printed the FATAL initialization banner', tail(output));
	}
	const diagLine = output
		.split(/\r?\n/)
		.find((line) => /status[ -_]artifact|automation-status/i.test(line) && !line.includes('FATAL'));
	if (!diagLine) fail('no non-fatal diagnostic line referencing the status artifact', tail(output));
	console.log(`[check-2669] diagnostics: non-fatal diagnostic line: ${diagLine.trim().slice(0, 200)}`);
	console.log('2669-DIAG: OK');
	process.exit(0);
}

async function main() {
	if (mode === 'diagnostics-child') {
		// Parent guarantees dist is built before spawning the child.
		await runDiagnosticsChild(await loadPlugin());
		return;
	}
	buildDist();
	const plugin = await loadPlugin();
	if (mode === 'optin') await runOptin(plugin);
	else if (mode === 'default') await runDefault(plugin);
	else if (mode === 'artifact') await runArtifact(plugin);
	else if (mode === 'diagnostics') await runDiagnostics();
	else {
		console.error('usage: node check-2669-matrix.mjs <optin|default|artifact|diagnostics>');
		process.exit(2);
	}
}

main().catch((err) => {
	fail(`unexpected harness error: ${err?.message ?? String(err)}`, stackTail(err));
});
