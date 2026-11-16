#!/usr/bin/env node
/**
 * Issue #2910 residual scope item 1 — the v2 CI lane's repro script (the
 * repro-704 class for the OpenCode 2 plugin path).
 *
 * Loads the compiled `dist/index.js` under Node and drives the plugin's v2
 * `setup` entry — the entry OpenCode 2 hosts call — against a recording fake
 * v2 Context:
 *
 *   Test 1 — Dual shape: `mod.default` must carry { id, server, setup }.
 *     The v1 repro (scripts/repro-704.mjs) asserts only { id, server };
 *     `setup` being a function (`hasSetup`) is THE v2 delta of this repro.
 *   Test 2 — Bounded init, MIN-of-2: `setup()` runs TWICE (fresh recording
 *     ctx + fresh 500-file workspace each) and the MIN of the two
 *     resolutions must be <= TIMING_DEADLINE_MS = 400 — the SAME deadline as
 *     scripts/repro-704.mjs (critic mandate; the old 1000 ms constant is
 *     gone). Min-of-2 tolerates one cold-FS/GC outlier rep, but the #704
 *     regression class (an unbounded init-path await re-introduced on the v2
 *     adapter) blows BOTH reps and fails loudly.
 *   Test 3 — Registration engagement: the recording ctx must observe the
 *     agent, command, and tool registration surfaces touched.
 *   Test 4 — Clean cleanup: the returned cleanup must resolve within
 *     BUDGET_MS (a hung dispose would wedge the host's plugin unload).
 *
 * AUTO-BUILD: if dist/index.js is missing at the repo root, `bun run build`
 * runs first, mirroring the build leg of spikes/v2-dual-shape/run-spike.mjs
 * (array-form spawn, cwd = repo root derived from this script's own
 * location, stdin 'ignore', 300 s timeout, bounded fd-backed output capture,
 * best-effort kill on every exit path). The script NEVER depends on a
 * pre-existing dist.
 *
 * Environment isolation mirrors repro-704 (HOME/USERPROFILE/XDG_CONFIG_HOME
 * scratch) so the run exercises repository defaults, not the invoking user's
 * global OpenCode config. The only child process this script launches is the
 * auto-build above (skipped when dist already exists).
 *
 * Clear tokens for CI greppability: `v2-setup: min=<n> ms (deadline=400ms)`,
 * `result=PASS` / `result=FAIL` (exit 0 / 1).
 */

import { spawn } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	writeFileSync,
	readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const DIST = resolve(ROOT, 'dist', 'index.js');

// Test 2 deadline — the MIN of 2 reps must beat it. 400 ms is the SAME
// deadline as scripts/repro-704.mjs (the #704 regression class); the v2
// adapter is the dual-shape twin of that path and gets no extra slack.
// Measured locally (Windows, warm FS): ~235 ms per rep over a 500-file
// workspace; min-of-2 leaves headroom for one slow rep while an unbounded
// init-path await (the #704/#1920 class) still fails both reps.
const TIMING_DEADLINE_MS = 400;
const TIMING_REPS = 2;

// Per-rep unbounded-hang guard for the setup() await. NOT the assert (the
// assert is min-of-2 vs TIMING_DEADLINE_MS): a rep that cannot resolve
// within this race is the true #704 class and fails the run outright.
const SETUP_RACE_MS = 10_000;

// Test 4 overall budget for the cleanup() resolution.
const BUDGET_MS = 10_000;

// Auto-build leg (mirrors run-spike.mjs: BUILD_TIMEOUT_MS + MAX_CAPTURE).
const BUILD_TIMEOUT_MS = 300_000;
const MAX_CAPTURE = 400_000;

// Isolation: repository defaults, never the invoking user's global config
// (a hybrid automation config could legitimately start persistent workers
// and turn a timing assertion into a hung harness). Mirrors repro-704.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
const isolatedHome = mkdtempSync(join(tmpdir(), 'opencode-swarm-2910-home-'));
const isolatedConfigHome = join(isolatedHome, '.config');
mkdirSync(isolatedConfigHome, { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = isolatedConfigHome;

const tempDirs = [isolatedHome];
process.once('exit', () => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Best-effort child-tree kill (direct kill + Windows taskkill /T walk). */
function killTree(child) {
	try {
		child.kill();
	} catch {
		/* best effort */
	}
	if (process.platform === 'win32' && child.pid) {
		try {
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
				cwd: tmpdir(),
				stdio: 'ignore',
				windowsHide: true,
			}).on('error', () => {});
		} catch {
			/* best effort */
		}
	}
}

/**
 * `bun run build` with fd-backed bounded capture (mirrors the run() helper
 * of spikes/v2-dual-shape/run-spike.mjs): output is captured through file
 * descriptors, never Node pipes, and truncated to MAX_CAPTURE bytes.
 */
function runBuild() {
	return new Promise((resolveRun) => {
		const outPath = join(
			tmpdir(),
			`repro-2910-v2-build-${process.pid}-${Math.random().toString(36).slice(2)}.out`,
		);
		const errPath = `${outPath}.err`;
		let outFd;
		let errFd;
		try {
			outFd = openSync(outPath, 'a');
			errFd = openSync(errPath, 'a');
		} catch (err) {
			resolveRun({
				code: -1,
				out: '',
				err: `capture setup failed: ${String(err)}`,
				timedOut: false,
			});
			return;
		}
		let killed = false;
		const finish = (code, note) => {
			let out = '';
			let err = note ?? '';
			try {
				out = readFileSync(outPath, 'utf8').slice(0, MAX_CAPTURE);
				const errText = readFileSync(errPath, 'utf8');
				err = note
					? `${note}\n${errText}`.slice(0, MAX_CAPTURE)
					: errText.slice(0, MAX_CAPTURE);
			} catch {
				/* nothing written */
			}
			try {
				closeSync(outFd);
			} catch {
				/* already closed */
			}
			try {
				closeSync(errFd);
			} catch {
				/* already closed */
			}
			try {
				rmSync(outPath, { force: true, maxRetries: 3, retryDelay: 100 });
			} catch {
				/* best effort */
			}
			try {
				rmSync(errPath, { force: true, maxRetries: 3, retryDelay: 100 });
			} catch {
				/* best effort */
			}
			resolveRun({ code, out, err, timedOut: killed });
		};
		let child;
		try {
			child = spawn('bun', ['run', 'build'], {
				cwd: ROOT,
				env: process.env,
				stdin: 'ignore',
				stdio: ['ignore', outFd, errFd],
				windowsHide: true,
			});
		} catch (err) {
			finish(-1, `spawn failed: ${String(err)}`);
			return;
		}
		const timer = setTimeout(() => {
			killed = true;
			killTree(child);
		}, BUILD_TIMEOUT_MS);
		child.on('error', (err) => {
			clearTimeout(timer);
			killTree(child);
			finish(-1, `spawn error: ${String(err)}`);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			killTree(child);
			finish(code ?? -1);
		});
	});
}

/** Auto-build: never depend on a pre-existing dist (run-spike build leg). */
async function ensureDist() {
	if (existsSync(DIST)) return;
	console.log(
		'[repro-2910-v2] dist/index.js missing — auto-build (bun run build, 300s budget)',
	);
	const build = await runBuild();
	if (build.code !== 0 || !existsSync(DIST)) {
		console.error(
			`[repro-2910-v2] FAILED auto-build: exit=${build.code} timedOut=${build.timedOut}`,
		);
		console.error((build.err || build.out || '').slice(-2000));
		console.error('result=FAIL');
		process.exit(1);
	}
	console.log('[repro-2910-v2] auto-build complete');
}

function makeLargeWorkspace(fileCount = 500) {
	const dir = mkdtempSync(join(tmpdir(), 'opencode-swarm-2910-large-'));
	tempDirs.push(dir);
	const src = join(dir, 'src');
	mkdirSync(src, { recursive: true });
	for (let i = 0; i < fileCount; i++) {
		writeFileSync(join(src, `file${i}.ts`), `export const v${i} = ${i};\n`);
	}
	return dir;
}

/**
 * Recording fake v2 Context: every domain the adapter touches is a no-op
 * fake that returns a disposable Registration and records the touch, so the
 * script can assert WHICH registration surfaces setup() actually engaged.
 */
function makeRecordingCtx(directory) {
	const touched = new Map(); // surface name -> call count
	const registration = { dispose: async () => {} };
	const touch = (name) => {
		touched.set(name, (touched.get(name) ?? 0) + 1);
	};
	const asyncIterableDone = {
		[Symbol.asyncIterator]() {
			return { next: async () => ({ done: true, value: undefined }) };
		},
	};
	return {
		ctx: {
			app: { name: 'repro-2910-v2', version: '2.0.0', channel: 'stable' },
			location: { directory },
			options: {},
			tool: {
				transform: async (cb) => {
					touch('tool.transform');
					cb({ add: () => {}, list: () => [], get: () => undefined, update: () => {}, remove: () => {}, namespace: () => {} });
					return registration;
				},
				reload: async () => {},
				hook: async () => registration,
			},
			agent: {
				transform: async (cb) => {
					touch('agent.transform');
					cb({ update: () => {}, remove: () => {}, list: () => [], get: () => undefined, default: () => {} });
					return registration;
				},
				reload: async () => {},
			},
			command: {
				transform: async (cb) => {
					touch('command.transform');
					cb({ add: () => {} });
					return registration;
				},
				reload: async () => {},
			},
			session: {
				hook: async (name) => {
					touch(`session.hook:${name}`);
					return registration;
				},
				prompt: async () => {},
				create: async () => ({ id: 'ses-repro-2910', projectID: 'proj', location: { directory } }),
				get: async () => ({ id: 'ses-repro-2910', projectID: 'proj', location: { directory } }),
				wait: async () => {},
				context: async () => [],
			},
			event: {
				subscribe: async () => {
					touch('event.subscribe');
					return asyncIterableDone;
				},
			},
		},
		touched,
	};
}

function fail(message) {
	console.error(`[repro-2910-v2] FAILED: ${message}`);
	console.error('result=FAIL');
	process.exit(1);
}

async function main() {
	await ensureDist();

	let mod;
	try {
		mod = await import(pathToFileURL(DIST).href);
	} catch (err) {
		console.error('[repro-2910-v2] FAILED to import dist/index.js:', err);
		console.error('result=FAIL');
		process.exit(1);
	}

	// Test 1 — dual shape: { id, server, setup }. hasSetup is the v2 delta.
	const plugin = mod.default;
	const hasId =
		!!plugin && typeof plugin === 'object' && typeof plugin.id === 'string';
	const hasServer =
		!!plugin && typeof plugin === 'object' && typeof plugin.server === 'function';
	const hasSetup =
		!!plugin && typeof plugin === 'object' && typeof plugin.setup === 'function';
	console.log(
		`[repro-2910-v2] dual shape: id=${hasId} server=${hasServer} setup=${hasSetup}`,
	);
	if (!hasId || !hasServer) {
		fail('dist/index.js does not export the v1 plugin shape { id, server }');
	}
	if (!hasSetup) {
		fail(
			'dist/index.js default export carries no setup() function — the v2 ' +
				'entry (ADR-0003 dual shape) is missing from the bundle',
		);
	}

	// Test 2 — bounded init over a 500-file workspace, MIN of TIMING_REPS reps
	// (the #704 class). Every rep gets a FRESH recording ctx and workspace.
	const reps = [];
	for (let rep = 1; rep <= TIMING_REPS; rep += 1) {
		const workspace = makeLargeWorkspace(500);
		const { ctx, touched } = makeRecordingCtx(workspace);
		let cleanup;
		const start = performance.now();
		try {
			cleanup = await Promise.race([
				plugin.setup(ctx),
				new Promise((resolveFn, rejectFn) => {
					const timer = setTimeout(
						() => rejectFn(new Error('setup() did not resolve within the race')),
						SETUP_RACE_MS,
					);
					timer.unref?.();
				}),
			]);
		} catch (err) {
			console.error(
				`v2-setup: rep=${rep} did not resolve within SETUP_RACE_MS=${SETUP_RACE_MS}ms`,
			);
			fail(
				`setup() rep ${rep} hung past the ${SETUP_RACE_MS}ms race ` +
					`(${err instanceof Error ? err.message : String(err)}); the v2 adapter ` +
					'has an unbounded init-path await (issue #704 class on the v2 path).',
			);
			return;
		}
		const elapsedMs = performance.now() - start;
		reps.push({ rep, elapsedMs, touched, cleanup });
		console.log(`v2-setup: rep=${rep} resolved in ${elapsedMs.toFixed(1)} ms`);
	}
	const minMs = Math.min(...reps.map((r) => r.elapsedMs));
	console.log(
		`v2-setup: min=${minMs.toFixed(1)} ms (deadline=${TIMING_DEADLINE_MS}ms)`,
	);
	if (minMs > TIMING_DEADLINE_MS) {
		fail(
			`min-of-${TIMING_REPS} setup() resolution ${minMs.toFixed(1)}ms exceeds ` +
				`TIMING_DEADLINE_MS=${TIMING_DEADLINE_MS}ms (the repro-704 deadline); ` +
				`per-rep ms: ${reps.map((r) => `rep${r.rep}=${r.elapsedMs.toFixed(1)}`).join(' ')}`,
		);
	}

	// Tests 3 + 4 use the LAST rep (the one still live); earlier reps are
	// disposed best-effort now so only one registration set remains live.
	const last = reps[reps.length - 1];
	for (const early of reps.slice(0, -1)) {
		if (typeof early.cleanup === 'function') {
			try {
				await Promise.race([
					Promise.resolve(early.cleanup()),
					new Promise((resolveFn, rejectFn) => {
						const timer = setTimeout(
							() => rejectFn(new Error('cleanup() did not resolve within the race')),
							BUDGET_MS,
						);
						timer.unref?.();
					}),
				]);
			} catch {
				/* best effort — the budget assert below covers the live rep */
			}
		}
	}

	// Test 3 — registration engagement: the recording ctx observed the three
	// core registration surfaces.
	const touched = last.touched;
	for (const surface of [
		'agent.transform',
		'command.transform',
		'tool.transform',
	]) {
		if (!touched.has(surface)) {
			fail(
				`setup() never touched the '${surface}' registration surface — the v2 ` +
					`adapter registered nothing (touched: ${[...touched.keys()].join(', ') || 'none'})`,
			);
		}
	}
	const sessionHooks = [...touched.keys()].filter((k) =>
		k.startsWith('session.hook:'),
	);
	if (sessionHooks.length === 0) {
		fail(
			'setup() registered no session hook (context/compaction/prompt) — ' +
				'guidance delivery is unwired on the v2 path',
		);
	}
	console.log(
		`[repro-2910-v2] registration surfaces engaged: ${[...touched.keys()].sort().join(', ')}`,
	);

	// Test 4 — clean cleanup.
	const cleanup = last.cleanup;
	if (typeof cleanup !== 'function') {
		fail('setup() did not return a cleanup function');
	}
	const cleanupStart = performance.now();
	try {
		await Promise.race([
			Promise.resolve(cleanup()),
			new Promise((resolveFn, rejectFn) => {
				const timer = setTimeout(
					() => rejectFn(new Error('cleanup() did not resolve within the race')),
					BUDGET_MS,
				);
				timer.unref?.();
			}),
		]);
	} catch (err) {
		fail(
			`cleanup() did not resolve within BUDGET_MS=${BUDGET_MS}ms ` +
				`${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}
	console.log(
		`[repro-2910-v2] cleanup resolved in ${(performance.now() - cleanupStart).toFixed(1)} ms`,
	);

	console.log('result=PASS');
}

main().catch((err) => {
	console.error('[repro-2910-v2] uncaught:', err);
	console.error('result=FAIL');
	process.exit(1);
});
